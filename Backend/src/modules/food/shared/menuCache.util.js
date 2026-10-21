import { logger } from '../../../utils/logger.js';
/**
 * Drop a restaurant's cached menu after its dishes change.
 *
 * Imported lazily because the cache module opens a Redis connection, and a
 * failure here must never fail the write that already succeeded — a stale menu
 * for one TTL beats a rejected approval.
 */
export const dropMenuCache = async (restaurantId) => {
    if (!restaurantId) return;
    try {
        const { invalidateCache } = await import('../../../middleware/cache.js');
        // Keys are "restaurant_menu:GET:/v1/food/restaurant/restaurants/<id or
        // slug>/menu", so the old "restaurant_menu:<id>" pattern matched
        // nothing and admin edits stayed hidden until the 10-minute TTL ran
        // out. The menu may be cached under the slug too, so every menu goes;
        // it is rebuilt on the next request. The dish feed and restaurant
        // cards carry prices as well.
        await Promise.all([
            invalidateCache('restaurant_menu:*'),
            invalidateCache('restaurant_addons:*'),
            invalidateCache('public_foods:*'),
            invalidateCache('restaurants:*'),
            invalidateCache('restaurant_detail:*'),
        ]);
    } catch (cacheErr) {
        logger.error('Failed to invalidate menu cache:', cacheErr);
    }
};
