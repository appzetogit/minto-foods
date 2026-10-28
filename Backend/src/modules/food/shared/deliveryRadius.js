import { prisma } from '../../../config/prisma.js';
import { checkDeliveryRadius, serviceableRadiusKm } from '../orders/services/order-pricing.service.js';
import { calculateDistanceKm } from './geo.utils.js';
import { restaurantsNearPoint } from './restaurantQuery.util.js';

/**
 * Who may see a restaurant, for every list a customer browses.
 *
 * The rule itself is checkDeliveryRadius -- a restaurant's own radius replaces
 * the platform's, and no radius anywhere means no limit. What lives here is
 * applying it to lists. The feed used to apply it only when the app asked for
 * "nearest" or sent a radius, and search and the dishes list never did, so a
 * customer browsing normally saw every restaurant in the zone and only met the
 * radius at checkout, on a restaurant they had already chosen.
 */

const positiveKm = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The platform radius, and whether any radius is in force at all.
 *
 * `inForce` is true when the platform has a radius or any restaurant has its
 * own. When it is false nothing is filtered, so a platform that has not set one
 * behaves exactly as it did before this existed.
 *
 * `outerBoundKm` is a safe spatial pre-filter: the farthest any restaurant can
 * reach. It only exists when the platform has a radius, because without one a
 * restaurant with no override has no limit to bound by.
 */
export async function loadRadiusSettings() {
    const [settings, widest] = await Promise.all([
        prisma.foodBusinessSettings.findFirst({ select: { discoveryRadiusKm: true } }),
        prisma.foodRestaurant.aggregate({
            where: { status: 'approved', deliveryRadiusKm: { not: null } },
            _max: { deliveryRadiusKm: true },
        }),
    ]);
    const platformRadiusKm = positiveKm(settings?.discoveryRadiusKm);
    const widestOverrideKm = positiveKm(widest?._max?.deliveryRadiusKm);
    return {
        platformRadiusKm,
        inForce: platformRadiusKm !== null || widestOverrideKm !== null,
        outerBoundKm: platformRadiusKm === null ? null : Math.max(platformRadiusKm, widestOverrideKm ?? 0),
    };
}

/**
 * How far each zone's delivery fee bands reach, in km.
 *
 * A zone with bands of its own uses them; one without falls back to the global
 * fee settings, as pricing does. Null means no bands anywhere: no limit.
 */
async function loadServiceableRadii() {
    const rows = await prisma.foodFeeSettings.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
        select: {
            zoneId: true,
            deliveryFeeBands: { select: { minDistanceKm: true, maxDistanceKm: true, fee: true } },
        },
    });
    const kmOf = (row) => serviceableRadiusKm({
        deliveryFeeRanges: (row?.deliveryFeeBands || []).map((b) => ({
            min: Number(b.minDistanceKm), max: Number(b.maxDistanceKm), fee: Number(b.fee),
        })),
    });
    // Newest active row wins, the same row loadActiveFeeSettings would use.
    const globalRow = rows.find((r) => r.zoneId === null) || null;
    const globalKm = kmOf(globalRow);
    const byZone = new Map();
    for (const row of rows) {
        if (row.zoneId === null || byZone.has(row.zoneId)) continue;
        byZone.set(row.zoneId, kmOf(row) ?? globalKm);
    }
    const all = [globalKm, ...byZone.values()];
    return {
        forZone: (zoneId) => (zoneId && byZone.has(zoneId) ? byZone.get(zoneId) : globalKm),
        widestKm: all.includes(null) || !all.length ? null : Math.max(...all),
    };
}

/** Bound for the spatial pre-filter when nothing configures one. */
const UNCONFIGURED_REACH_KM = 100;

/**
 * The restaurants a customer at lat/lng can order from, by distance -- not by
 * zone.
 *
 * Every discovery list (restaurants, search, dishes, categories) used to show
 * one zone: the one the app sent, or the one the point fell in. A customer at
 * an address just outside a zone's polygon saw nothing, though restaurants
 * 5 km away deliver there. Zones still decide delivery fees, COD and
 * zone-targeted banners; they no longer decide what a customer can see.
 *
 * A restaurant is in reach when it is approved, placed on the map, and within:
 *  - `radiusKm`, when the app passes one -- a customer may narrow the search,
 *    never widen it past what is configured;
 *  - the widest delivery fee band of its zone's fee settings, so everything
 *    listed can actually be priced at checkout;
 *  - its own delivery radius, else the platform's (checkDeliveryRadius).
 *
 * Returns { requiresLocation: true } without a usable point, else
 * { distanceById: Map(id -> km) }.
 */
export async function restaurantsInReach({ lat, lng, radiusKm } = {}) {
    const latitude = lat === undefined || lat === null || lat === '' ? NaN : Number(lat);
    const longitude = lng === undefined || lng === null || lng === '' ? NaN : Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return { requiresLocation: true, distanceById: new Map() };
    }

    const [serviceable, radius] = await Promise.all([loadServiceableRadii(), loadRadiusSettings()]);
    const asked = positiveKm(radiusKm);
    const boundKm = Math.min(
        asked ?? Infinity,
        serviceable.widestKm ?? Infinity,
        radius.outerBoundKm ?? Infinity,
    );
    const near = await restaurantsNearPoint(
        latitude, longitude, Number.isFinite(boundKm) ? boundKm : UNCONFIGURED_REACH_KM,
    );
    if (!near.length) return { requiresLocation: false, distanceById: new Map() };

    const distanceById = new Map();
    for (const row of near) {
        const { id, distanceInKm } = row;
        if (asked !== null && distanceInKm > asked) continue;
        const bandKm = serviceable.forZone(row.zoneId);
        if (bandKm !== null && distanceInKm > bandKm) continue;
        const { withinRadius } = checkDeliveryRadius({
            distanceKm: distanceInKm,
            restaurantRadiusKm: row.deliveryRadiusKm,
            platformRadiusKm: radius.platformRadiusKm,
        });
        if (withinRadius) distanceById.set(id, distanceInKm);
    }
    return { requiresLocation: false, distanceById };
}

/**
 * Whether a customer at lat/lng is inside this restaurant's delivery radius.
 *
 * Straight-line distance, as the feed has always measured it. A restaurant with
 * no coordinates passes: an unknown distance is not evidence of a long trip.
 */
export function withinDeliveryRadius(restaurant, lat, lng, platformRadiusKm) {
    const hasPoint = restaurant?.latitude != null && restaurant?.longitude != null;
    const distanceKm = hasPoint
        ? calculateDistanceKm(
            { latitude: Number(restaurant.latitude), longitude: Number(restaurant.longitude) },
            { latitude: Number(lat), longitude: Number(lng) },
        )
        : null;
    return checkDeliveryRadius({
        distanceKm,
        restaurantRadiusKm: restaurant?.deliveryRadiusKm,
        platformRadiusKm,
    }).withinRadius;
}
