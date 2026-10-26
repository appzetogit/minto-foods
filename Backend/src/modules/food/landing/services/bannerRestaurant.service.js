import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    restaurantKeyFromLink,
    restaurantLink,
    slugifyRestaurantName,
} from '../../shared/restaurantSlug.js';
import { findZoneForPoint } from '../../shared/zone.service.js';
import { attachOutletTimingsToRestaurants } from '../../restaurant/services/outletTimings.service.js';
import { withOpenStatus } from '../../restaurant/helpers/restaurantAvailability.helper.js';

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

/**
 * Restaurants for a set of keys (ids or slugs), indexed by both. A slug a
 * restaurant had before a rename finds it too.
 */
const loadRestaurantsByKey = async (keys, select = {}) => {
    const ids = keys.filter(isId);
    const slugs = [...new Set(keys.filter((k) => !isId(k)).map(slugifyRestaurantName).filter(Boolean))];
    if (!ids.length && !slugs.length) return new Map();

    const former = slugs.length
        ? await prisma.foodRestaurantSlugHistory.findMany({
            where: { slug: { in: slugs } },
            select: { slug: true, restaurantId: true },
        })
        : [];
    const allIds = [...ids, ...former.map((f) => f.restaurantId)];

    const rows = await prisma.foodRestaurant.findMany({
        where: {
            OR: [
                ...(allIds.length ? [{ id: { in: allIds } }] : []),
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
    // A current slug beats a former one.
    for (const { slug, restaurantId } of former) {
        if (!byKey.has(slug) && byKey.has(restaurantId)) byKey.set(slug, byKey.get(restaurantId));
    }
    return byKey;
};

const NOT_APPROVED = 'That restaurant is not approved, so a banner cannot open it';

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
        const exists = await prisma.foodRestaurant.findUnique({ where: { id }, select: { id: true, status: true } });
        if (!exists) throw new ValidationError('That restaurant was not found');
        if (exists.status !== 'approved') throw new ValidationError(NOT_APPROVED);
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
    if (match.status !== 'approved') throw new ValidationError(NOT_APPROVED);
    return { restaurantId: match.id, ctaLink: restaurantLink(match.id) };
};

/**
 * The public list, as the app should get it.
 *
 * Dropped: a banner for a restaurant that is switched off, deleted, or no
 * longer approved -- tapping it would only open "Restaurant not found" or a
 * shop that cannot take the order. Banners that open no restaurant stay.
 *
 * A restaurant closed by its hours keeps its banner, and the banner says so
 * (restaurantIsOpen, restaurantOpenStatusReason, restaurantNextOpenAt) so the
 * app can show when it opens. Each kept banner gains restaurantId.
 */
export const withoutOfflineRestaurants = async (banners = []) => {
    const keys = [...new Set(banners.map(bannerRestaurantKey).filter(Boolean))];
    if (!keys.length) return banners;

    const byKey = await loadRestaurantsByKey(keys, { openingTime: true, closingTime: true, openDays: true });
    const usable = [...new Map(
        [...byKey.values()]
            .filter((r) => r.status === 'approved' && r.isAcceptingOrders !== false)
            .map((r) => [r.id, r]),
    ).values()];
    const statusById = new Map(
        (await attachOutletTimingsToRestaurants(usable)).map((r) => [r.id, withOpenStatus(r)]),
    );

    return banners.flatMap((banner) => {
        const key = bannerRestaurantKey(banner);
        if (!key) return [banner];
        const match = lookup(byKey, key);
        const status = match ? statusById.get(match.id) : null;
        if (!status) return [];
        return [{
            ...banner,
            restaurantId: match.id,
            restaurantIsOpen: status.isOpenNow,
            restaurantOpenStatusReason: status.openStatusReason,
            restaurantNextOpenAt: status.nextOpeningAt,
        }];
    });
};

/**
 * The zone a public banner request is for: the zoneId the app sent, else the
 * zone the lat/lng falls in. Null when the location is in no zone; undefined
 * when the request said nothing about where the customer is.
 */
export const resolveBannerZoneId = async ({ zoneId, lat, lng } = {}) => {
    if (isId(zoneId)) return String(zoneId);
    if (lat === undefined || lat === null || lat === '' || lng === undefined || lng === null || lng === '') return undefined;
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const zone = await findZoneForPoint(latitude, longitude);
    return zone?.id || null;
};

/**
 * Prisma filter for zone-wise banners: the all-zones banners (zoneId null)
 * plus, when the customer's zone is known, that zone's own. A zone-2 banner
 * never shows in zone 1.
 *
 * A request that says nothing about where the customer is (undefined) gets
 * every banner, as before zone-wise banners existed. The customer app sends
 * no zone or location for banners, so treating that as "in no zone" showed
 * only the all-zones ones -- none, when every banner was set to one zone.
 */
export const bannerZoneWhere = (zoneId) => {
    if (zoneId === undefined) return {};
    return zoneId ? { OR: [{ zoneId: null }, { zoneId }] } : { zoneId: null };
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
