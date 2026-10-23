import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { slugifyRestaurantName } from '../../shared/restaurantSlug.js';

/**
 * Resolve an approved restaurant from either its id or its name-slug.
 *
 * The same id-or-slug branch was copy-pasted across the public menu, addon and
 * food endpoints; keeping one copy means a change to slug normalisation cannot
 * apply to two of the three.
 *
 * @returns the restaurant row, or null when nothing approved matches
 */
export async function findApprovedRestaurant(restaurantIdOrSlug, select = { id: true, status: true }) {
    const value = String(restaurantIdOrSlug || '').trim();
    if (!value) return null;

    if (isId(value)) {
        return prisma.foodRestaurant.findFirst({
            where: { id: value, status: 'approved' },
            select,
        });
    }

    // nameSlug is derived from the name by the database, so every restaurant
    // has one -- restaurantNameNormalized is empty on admin-created ones and
    // keeps punctuation, which is why slugs used to miss.
    const slug = slugifyRestaurantName(value);
    if (!slug) return null;
    return prisma.foodRestaurant.findFirst({
        where: { nameSlug: slug, status: 'approved' },
        orderBy: { createdAt: 'asc' },
        select,
    });
}

/**
 * The add-on grouping rules were a nested `group` subdocument and are four flat
 * columns now. Callers and the API still speak the nested shape.
 */
export const toAddonGroup = (addon) => ({
    name: addon.groupName || '',
    minSelect: Number(addon.groupMinSelect) || 0,
    maxSelect: Number(addon.groupMaxSelect) || 1,
    sortOrder: Number(addon.groupSortOrder) || 0,
});
