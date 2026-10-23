import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * A restaurant's and a rider's rating, from their orders.
 *
 * Kept as a running average before, rounded at every step, which drifted (a
 * rider at 4.89 showed 4.8) and could not be corrected. Now every saved rating
 * recomputes the average and the count from the orders themselves, so they
 * always agree with what customers actually left.
 */

const round1 = (n) => Math.round(Number(n) * 10) / 10;

/** rating = AVG(restaurantRating), totalRatings = COUNT, over the restaurant's orders. */
export async function recomputeRestaurantRating(restaurantId) {
    if (!isId(restaurantId)) return null;
    const agg = await prisma.foodOrder.aggregate({
        where: { restaurantId: String(restaurantId), restaurantRating: { not: null } },
        _avg: { restaurantRating: true },
        _count: { restaurantRating: true },
    });
    const totalRatings = agg._count.restaurantRating || 0;
    const rating = totalRatings ? round1(agg._avg.restaurantRating) : 0;
    await prisma.foodRestaurant.updateMany({ where: { id: String(restaurantId) }, data: { rating, totalRatings } });
    return { rating, totalRatings };
}

/** The same for the rider who delivered the orders. */
export async function recomputePartnerRating(partnerId) {
    if (!isId(partnerId)) return null;
    const agg = await prisma.foodOrder.aggregate({
        where: { dispatchDeliveryPartnerId: String(partnerId), partnerRating: { not: null } },
        _avg: { partnerRating: true },
        _count: { partnerRating: true },
    });
    const totalRatings = agg._count.partnerRating || 0;
    const rating = totalRatings ? round1(agg._avg.partnerRating) : 0;
    await prisma.foodDeliveryPartner.updateMany({ where: { id: String(partnerId) }, data: { rating, totalRatings } });
    return { rating, totalRatings };
}

/**
 * GET /food/restaurant/reviews: what customers said about this restaurant,
 * newest first, with the overall average and count.
 */
export async function listRestaurantReviews(restaurantId, { page = 1, limit = 20 } = {}) {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const where = { restaurantId: String(restaurantId), restaurantRating: { not: null } };

    const [rows, agg] = await Promise.all([
        prisma.foodOrder.findMany({
            where,
            orderBy: [{ restaurantRatedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
            skip: (p - 1) * l,
            take: l,
            select: {
                id: true, order_id: true, restaurantRating: true, restaurantRatingComment: true,
                restaurantRatedAt: true, createdAt: true, customerName: true,
                user: { select: { name: true } },
            },
        }),
        prisma.foodOrder.aggregate({ where, _avg: { restaurantRating: true }, _count: { restaurantRating: true } }),
    ]);

    const total = agg._count.restaurantRating || 0;
    return {
        reviews: rows.map((row) => ({
            orderId: row.id,
            order_id: row.order_id || row.id,
            rating: row.restaurantRating,
            comment: row.restaurantRatingComment || '',
            // The person who ordered and rated it; only their name.
            customerName: row.user?.name || row.customerName || 'Customer',
            ratedAt: row.restaurantRatedAt || row.createdAt,
        })),
        meta: {
            total,
            average: total ? round1(agg._avg.restaurantRating) : 0,
            page: p,
            limit: l,
            totalPages: Math.max(1, Math.ceil(total / l)),
        },
    };
}
