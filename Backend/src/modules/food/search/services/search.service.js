import { prisma } from '../../../../config/prisma.js';
import { restaurantsInReach } from '../../shared/deliveryRadius.js';
import { isId } from '../../../../utils/helpers.js';
import { toRestaurant } from '../../restaurant/restaurant.mapper.js';
import { restaurantIdsMatchingCuisine } from '../../shared/restaurantQuery.util.js';
import { attachOutletTimingsToRestaurants } from '../../restaurant/services/outletTimings.service.js';
import { withOpenStatus } from '../../restaurant/helpers/restaurantAvailability.helper.js';
import { restoreExpiredFoodAvailability } from '../../restaurant/services/foodAvailability.service.js';

/** Columns the search cards need, plus the address columns toRestaurant() rebuilds `location` from. */
const RESTAURANT_SEARCH_SELECT = {
    id: true, restaurantName: true, restaurantNameNormalized: true,
    cuisines: true, profileImage: true, coverImages: true,
    estimatedDeliveryTime: true, estimatedDeliveryTimeMinutes: true,
    offer: true, featuredDish: true, featuredPrice: true,
    rating: true, totalRatings: true, isAcceptingOrders: true,
    status: true, pureVegRestaurant: true, createdAt: true,
    zoneId: true, area: true, city: true,
    latitude: true, longitude: true, formattedAddress: true,
    addressLine1: true, addressLine2: true, state: true, pincode: true, landmark: true,
    // The open-now fields, worked out the same way as the restaurant list.
    openingTime: true, closingTime: true, openDays: true, nameSlug: true,
};

const FOOD_MATCH_SELECT = { id: true, restaurantId: true, name: true, image: true };

const toFiniteNumber = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
};

/**
 * Unified search: matches restaurants by name or cuisine, and also matches
 * dishes, surfacing the restaurant that serves them.
 */
export const searchUnified = async (query = {}, options = {}) => {
    const {
        q, lat, lng, radiusKm, categoryId, minRating, maxDeliveryTime,
        isVeg, page = 1, limit = 20,
    } = query;

    const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
    const limitNumber = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const skip = (pageNumber - 1) * limitNumber;
    const term = String(q || '').trim();
    const userLat = toFiniteNumber(lat);
    const userLng = toFiniteNumber(lng);
    const fetchLimit = Math.min(limitNumber * 3, 120);

    // Search covers what the customer can order from, by distance -- never one
    // zone, which hid restaurants a few km away across a zone line. With no
    // location there is nothing to measure from.
    const reach = await restaurantsInReach({ lat: userLat, lng: userLng, radiusKm });
    const empty = (extra = {}) => ({
        success: true,
        data: { restaurants: [], total: 0, page: pageNumber, limit: limitNumber, ...extra },
    });
    if (reach.requiresLocation) return empty({ outOfService: false, requiresLocation: true });
    const reachIds = [...reach.distanceById.keys()];
    if (!reachIds.length) return empty();
    const categoryFiltered = isId(categoryId);

    // 1. Base filter
    const where = { status: 'approved', id: { in: reachIds } };
    if (isVeg === 'true') where.pureVegRestaurant = true;
    // Filters from the URL are only applied when they are real numbers. A value
    // like `minRating=abc` used to reach the query as NaN, which the database
    // rejects, so the whole search failed instead of ignoring one bad filter.
    const rating = Number.parseFloat(minRating);
    if (Number.isFinite(rating) && rating > 0) where.rating = { gte: Math.min(rating, 5) };
    const minutes = Number.parseInt(maxDeliveryTime, 10);
    if (Number.isFinite(minutes) && minutes > 0) {
        where.estimatedDeliveryTimeMinutes = { lte: Math.min(minutes, 1440) };
    }

    // Dishes whose timed out-of-stock has run out come back before matching,
    // and anything still out of stock never matches: a customer must not be
    // sent to a restaurant for a dish they cannot order.
    if (term || categoryFiltered) await restoreExpiredFoodAvailability();

    // 2. Category filter — restaurants have no category, their dishes do.
    if (categoryFiltered) {
        const catFoodItems = await prisma.foodItem.findMany({
            where: {
                categoryId: String(categoryId),
                approvalStatus: 'approved',
                isAvailable: true,
                restaurantId: { in: reachIds },
            },
            select: { restaurantId: true },
            distinct: ['restaurantId'],
        });

        if (!catFoodItems.length) return empty();
        where.id = { in: catFoodItems.map((food) => food.restaurantId) };
    }

    // Kept separately: the dish-match branch below needs to intersect with it
    // rather than replace it.
    const categoryRestaurantIds = categoryFiltered ? new Set(where.id.in) : null;

    const found = new Map();

    // 3. Matching
    if (term) {
        const cuisineIds = await restaurantIdsMatchingCuisine(term, fetchLimit);

        const matchedRestaurants = await prisma.foodRestaurant.findMany({
            where: {
                ...where,
                OR: [
                    { restaurantName: { contains: term, mode: 'insensitive' } },
                    ...(cuisineIds.length ? [{ id: { in: cuisineIds } }] : []),
                ],
            },
            select: RESTAURANT_SEARCH_SELECT,
            orderBy: [{ rating: 'desc' }, { createdAt: 'desc' }],
            take: fetchLimit,
        });

        for (const restaurant of matchedRestaurants) {
            found.set(restaurant.id, { ...restaurant, matchType: 'restaurant' });
        }

        const matchedFoods = await prisma.foodItem.findMany({
            where: {
                approvalStatus: 'approved',
                isAvailable: true,
                restaurantId: { in: reachIds },
                name: { contains: term, mode: 'insensitive' },
                ...(isVeg === 'true' ? { foodType: 'Veg' } : {}),
            },
            select: FOOD_MATCH_SELECT,
            orderBy: { createdAt: 'desc' },
            take: fetchLimit,
        });

        // One dish per restaurant — the first (newest) is the one shown.
        const foodByRestaurant = new Map();
        for (const food of matchedFoods) {
            const restaurantId = String(food.restaurantId || '');
            if (restaurantId && !foodByRestaurant.has(restaurantId)) {
                foodByRestaurant.set(restaurantId, food);
            }
        }

        const remainingIds = [...foodByRestaurant.keys()].filter(
            (id) =>
                !found.has(id) &&
                // Overwriting where.id here would have let a dish match pull in a
                // restaurant the category filter had already excluded, which is
                // what the Mongo version did.
                (!categoryRestaurantIds || categoryRestaurantIds.has(id)),
        );
        if (remainingIds.length) {
            const rsForFoods = await prisma.foodRestaurant.findMany({
                where: { ...where, id: { in: remainingIds } },
                select: RESTAURANT_SEARCH_SELECT,
                take: fetchLimit,
            });

            for (const restaurant of rsForFoods) {
                const matchedFood = foodByRestaurant.get(restaurant.id);
                found.set(restaurant.id, {
                    ...restaurant,
                    matchType: 'food',
                    matchedDish: matchedFood?.name,
                    matchedDishImage: matchedFood?.image,
                    matchedDishId: matchedFood?.id,
                });
            }
        }
    } else {
        const allMatching = await prisma.foodRestaurant.findMany({
            where,
            select: RESTAURANT_SEARCH_SELECT,
            orderBy: [{ rating: 'desc' }, { createdAt: 'desc' }],
            take: fetchLimit,
        });
        for (const restaurant of allMatching) found.set(restaurant.id, restaurant);
    }

    // Nearest first, by the distance the reach check measured.
    const results = [...found.values()]
        .map((restaurant) => ({
            ...restaurant,
            distanceScore: reach.distanceById.get(restaurant.id) ?? 999,
            distanceInKm: reach.distanceById.get(restaurant.id) ?? null,
        }))
        .sort((a, b) => a.distanceScore - b.distanceScore);

    // toRestaurant rebuilds the nested `location` the cards read; withOpenStatus
    // adds isOpenNow, openStatusReason and nextOpeningAt, as the list has them.
    const pageRows = await attachOutletTimingsToRestaurants(
        results
            .slice(skip, skip + limitNumber)
            .map(({ nameSlug, ...restaurant }) => ({
                ...toRestaurant(restaurant),
                slug: nameSlug || null,
            })),
    );

    const finalResult = {
        success: true,
        data: {
            restaurants: pageRows.map((restaurant) => withOpenStatus(restaurant)),
            total: results.length,
            page: pageNumber,
            limit: limitNumber,
        },
    };

    return finalResult;
};

/**
 * Admin-owned (global) categories — those with no restaurant attached.
 */
export const getAdminCategories = async (query = {}) => {
    const where = {
        isActive: true,
        isApproved: true,
        restaurantId: null,
    };

    // Not by zone. With a location: every-zone categories, plus a zone's own
    // ones when a restaurant the customer can order from (by distance) has a
    // dish in them. The zone the app sends is ignored.
    const reach = await restaurantsInReach({ lat: query.lat, lng: query.lng, radiusKm: query.radiusKm });
    if (!reach.requiresLocation) {
        where.OR = [
            { zoneId: null },
            {
                foodItems: {
                    some: {
                        approvalStatus: 'approved',
                        isAvailable: true,
                        restaurantId: { in: [...reach.distanceById.keys()] },
                    },
                },
            },
        ];
    }

    return prisma.foodCategory.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
};
