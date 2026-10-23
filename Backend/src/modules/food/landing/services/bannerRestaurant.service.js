import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    restaurantKeyFromLink,
    restaurantLink,
    slugifyRestaurantName,
} from '../../shared/restaurantSlug.js';

/**
 * Banners that open a restaurant.
 *
 * A banner used to remember its restaurant only as a name slug in ctaLink, so
 * renaming the restaurant ("sdad" -> "saad") left the banner opening
 * "Restaurant not found". It now stores the restaurant's id and the link is
 * built from it.
 */

/** The restaurant a banner points at: its stored id, else the id or slug in its link. */
const bannerRestaurantKey = (banner) =>
    (isId(banner?.restaurantId) ? String(banner.restaurantId) : null) ||
    restaurantKeyFromLink(banner?.ctaLink);

/** Restaurants for a set of keys (ids or slugs), indexed by both. */
const loadRestaurantsByKey = async (keys, select = {}) => {
    const ids = keys.filter(isId);
    const slugs = [...new Set(keys.filter((k) => !isId(k)).map(slugifyRestaurantName).filter(Boolean))];
    if (!ids.length && !slugs.length) return new Map();

    const rows = await prisma.foodRestaurant.findMany({
        where: {
            OR: [
                ...(ids.length ? [{ id: { in: ids } }] : []),
                ...(slugs.length ? [{ nameSlug: { in: slugs } }] : []),
            ],
        },
        select: { id: true, nameSlug: true, status: true, isAcceptingOrders: true, ...select },
        // An approved restaurant wins a slug two of them share.
        orderBy: { createdAt: 'asc' },
    });
    const byKey = new Map();
    for (const row of rows) {
        byKey.set(row.id, row);
        if (row.nameSlug) {
            const current = byKey.get(row.nameSlug);
            if (!current || (current.status !== 'approved' && row.status === 'approved')) {
                byKey.set(row.nameSlug, row);
            }
        }
    }
    return byKey;
};

const lookup = (byKey, key) => (key ? byKey.get(isId(key) ? key : slugifyRestaurantName(key)) : null);

/**
 * The link fields to save for a banner.
 *
 * An admin may send restaurantId, or only a ctaLink with a restaurant's id or
 * slug in it (older admin builds). Either way the id is stored and the link
 * rebuilt from it. A restaurant link that matches nothing is refused rather
 * than saved broken. A link that is not a restaurant link is kept as it is.
 *
 * Returns only the fields to write, so an update that sent neither leaves the
 * banner's link alone.
 */
export const resolveBannerLink = async ({ ctaLink, restaurantId } = {}) => {
    const sentId = restaurantId !== undefined && restaurantId !== null && String(restaurantId).trim() !== '';
    if (sentId) {
        const id = String(restaurantId).trim();
        if (!isId(id)) throw new ValidationError('Invalid restaurant');
        const exists = await prisma.foodRestaurant.findUnique({ where: { id }, select: { id: true } });
        if (!exists) throw new ValidationError('That restaurant was not found');
        return { restaurantId: id, ctaLink: restaurantLink(id) };
    }
    if (ctaLink === undefined) {
        // restaurantId sent empty clears it; nothing sent changes nothing.
        return restaurantId === undefined ? {} : { restaurantId: null };
    }

    const key = restaurantKeyFromLink(ctaLink);
    if (!key) return { ctaLink, restaurantId: null };

    const match = lookup(await loadRestaurantsByKey([key]), key);
    if (!match) {
        throw new ValidationError(`The link points to a restaurant that does not exist ("${key}"). Pick the restaurant again.`);
    }
    return { restaurantId: match.id, ctaLink: restaurantLink(match.id) };
};

/**
 * The public list without banners for a restaurant that is switched off.
 * Banners linking to no restaurant, or to one that cannot be found, stay.
 * Each banner gains restaurantId when its restaurant is known.
 */
export const withoutOfflineRestaurants = async (banners = []) => {
    const keys = [...new Set(banners.map(bannerRestaurantKey).filter(Boolean))];
    if (!keys.length) return banners;

    const byKey = await loadRestaurantsByKey(keys);
    return banners
        .filter((banner) => lookup(byKey, bannerRestaurantKey(banner))?.isAcceptingOrders !== false)
        .map((banner) => {
            const match = lookup(byKey, bannerRestaurantKey(banner));
            return match ? { ...banner, restaurantId: match.id } : banner;
        });
};

/**
 * For the admin list: which restaurant each banner opens, and whether its
 * restaurant link is broken (points at a restaurant that does not exist).
 */
export const withRestaurantLinkStatus = async (banners = []) => {
    const keys = [...new Set(banners.map(bannerRestaurantKey).filter(Boolean))];
    const byKey = keys.length ? await loadRestaurantsByKey(keys, { restaurantName: true }) : new Map();
    return banners.map((banner) => {
        const key = bannerRestaurantKey(banner);
        const match = lookup(byKey, key);
        return {
            ...banner,
            restaurantName: match?.restaurantName || null,
            restaurantLinkBroken: Boolean(key) && !match,
        };
    });
};
