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
    const current = await prisma.foodRestaurant.findFirst({
        where: { nameSlug: slug, status: 'approved' },
        orderBy: { createdAt: 'asc' },
        select,
    });
    if (current) return current;

    const formerId = await restaurantIdForFormerSlug(slug);
    return formerId
        ? prisma.foodRestaurant.findFirst({ where: { id: formerId, status: 'approved' }, select })
        : null;
}

/**
 * The restaurant that used to have this slug before it was renamed, or null.
 *
 * A rename changes nameSlug, and links already out there -- banners, shared
 * links, an app's cache -- still carry the old one ("sdad" after the rename to
 * "saad"). The database records each replaced slug in
 * food_restaurant_slug_history.
 */
export async function restaurantIdForFormerSlug(slug) {
    if (!slug) return null;
    const row = await prisma.foodRestaurantSlugHistory.findUnique({
        where: { slug },
        select: { restaurantId: true },
    });
    return row?.restaurantId || null;
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
