import { parseDayBound } from '../../../../utils/timezone.js';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { saveImageFile } from '../../../../services/storage.service.js';
import { makeBannerService } from './bannerService.factory.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    bannerZoneWhere,
    resolveBannerLink,
    resolveBannerZoneId,
    withoutOfflineRestaurants,
    withRestaurantLinkStatus,
} from './bannerRestaurant.service.js';

const BANNER_FOLDER = 'food/home-promotion-banners';
const banners = makeBannerService(prisma.homePromotionBanner, BANNER_FOLDER);

/** '' and undefined both mean "no bound"; a bare day is the whole day in India time. */
const toDate = (value, edge) => {
    const date = parseDayBound(value, edge);
    if (date === null) throw new Error('Dates must be valid, or left blank');
    return date ?? null;
};

const byOrder = [{ sortOrder: 'asc' }, { createdAt: 'desc' }];

/** Admin list, with each banner's restaurant and whether its restaurant link is broken. */
export const listHomePromotionBanners = async () =>
    withRestaurantLinkStatus(await prisma.homePromotionBanner.findMany({ orderBy: byOrder }));

/** Where a home promotion banner shows: the home screen, or the order tracking page (paid ads). */
export const BANNER_PLACEMENTS = ['home', 'tracking'];
const toPlacement = (value, fallback = 'home') => {
    const placement = String(value ?? '').trim().toLowerCase();
    if (!placement) return fallback;
    if (!BANNER_PLACEMENTS.includes(placement)) throw new ValidationError('Show on must be Home or Order tracking page');
    return placement;
};

/**
 * What the app shows: live banners for the customer's zone and placement,
 * minus those for a restaurant switched off.
 *
 * @param {string|{zoneId?: string, lat?: number, lng?: number, placement?: string}} query
 *   the zone (or the customer's lat/lng to find it) and where the banners go;
 *   a bare string is a zoneId, as older callers pass it.
 */
export const getPublicHomePromotionBanners = async (query = {}) => {
    const { zoneId, lat, lng, placement } = typeof query === 'object' && query !== null ? query : { zoneId: query };
    const now = new Date();
    const zone = await resolveBannerZoneId({ zoneId, lat, lng });
    const list = await prisma.homePromotionBanner.findMany({
        where: {
            isActive: true,
            // No placement is the home screen, which is all older apps ask for.
            placement: BANNER_PLACEMENTS.includes(String(placement || '').toLowerCase())
                ? String(placement).toLowerCase()
                : 'home',
            // An open-ended window is the common case: most banners set neither
            // date and must still show. The Mongo filter also had to match
            // startDate: "" — a string sitting in a date field. The column is
            // typed now, so that case cannot exist.
            AND: [
                { OR: [{ startDate: null }, { startDate: { lte: now } }] },
                { OR: [{ endDate: null }, { endDate: { gte: now } }] },
                // Every-zone banners, plus the customer's zone's own: a zone-2
                // banner never shows in zone 1.
                bannerZoneWhere(zone),
            ],
        },
        orderBy: byOrder,
    });
    return withoutOfflineRestaurants(list);
};

export const createHomePromotionBanner = async (file, meta = {}) => {
    if (!file) return null;
    // Before the upload, so a bad restaurant link is a clear 400 and no
    // orphaned image is left behind.
    const link = await resolveBannerLink({ ctaLink: meta.ctaLink, restaurantId: meta.restaurantId });
    const placement = toPlacement(meta.placement);

    try {
        const saved = await saveImageFile(file, BANNER_FOLDER);
        return await prisma.homePromotionBanner.create({
            data: {
                imageUrl: saved.url,
                publicId: saved.path,
                title: meta.title,
                ctaLink: link.ctaLink ?? meta.ctaLink,
                restaurantId: link.restaurantId ?? null,
                placement,
                zoneId: isId(meta.zoneId) ? String(meta.zoneId) : null,
                startDate: toDate(meta.startDate, 'start'),
                endDate: toDate(meta.endDate, 'end'),
                sortOrder: Number(meta.sortOrder) || 0,
                isActive: true,
            },
        });
    } catch (error) {
        throw new Error(`Banner creation failed: ${error.message}`);
    }
};

export const updateHomePromotionBanner = async (id, data = {}) => {
    const { startDate, endDate, zoneId, ctaLink, restaurantId, placement, ...rest } = data;
    const updates = { ...rest, ...(await resolveBannerLink({ ctaLink, restaurantId })) };
    if (placement !== undefined) updates.placement = toPlacement(placement);

    // Only touch a field the caller actually sent — a PATCH that changes the
    // title must not clear the schedule.
    if (startDate !== undefined) updates.startDate = toDate(startDate, 'start');
    if (endDate !== undefined) updates.endDate = toDate(endDate, 'end');
    if (zoneId !== undefined) updates.zoneId = isId(zoneId) ? String(zoneId) : null;

    return prisma.homePromotionBanner
        .update({ where: { id }, data: updates })
        .catch((error) => {
            if (error?.code === 'P2025') return null;
            throw error;
        });
};

export const deleteHomePromotionBanner = banners.remove;
export const toggleHomePromotionBannerStatus = banners.setActive;
export const updateHomePromotionBannerOrder = banners.setOrder;
