import { prisma } from '../../../config/prisma.js';
import { checkDeliveryRadius } from '../orders/services/order-pricing.service.js';
import { calculateDistanceKm } from './geo.utils.js';

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
