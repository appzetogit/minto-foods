import { parseDayBound } from '../../../../utils/timezone.js';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { saveImageFile } from '../../../../services/storage.service.js';
import { makeBannerService } from './bannerService.factory.js';
import {
    resolveBannerLink,
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

/** What the app shows: live banners, minus those for a restaurant switched off. */
export const getPublicHomePromotionBanners = async (zoneId = null) => {
    const now = new Date();
    const list = await prisma.homePromotionBanner.findMany({
        where: {
            isActive: true,
            // An open-ended window is the common case: most banners set neither
            // date and must still show. The Mongo filter also had to match
            // startDate: "" — a string sitting in a date field. The column is
            // typed now, so that case cannot exist.
            AND: [
                { OR: [{ startDate: null }, { startDate: { lte: now } }] },
                { OR: [{ endDate: null }, { endDate: { gte: now } }] },
            ],
            // Banners for every zone (no zone set) show everywhere; a zone
            // banner only in its zone. Matching the zone alone hid every
            // all-zones banner from anyone whose app sent a zone.
            ...(isId(zoneId) ? { OR: [{ zoneId: null }, { zoneId: String(zoneId) }] } : {}),
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

    try {
        const saved = await saveImageFile(file, BANNER_FOLDER);
        return await prisma.homePromotionBanner.create({
            data: {
                imageUrl: saved.url,
                publicId: saved.path,
                title: meta.title,
                ctaLink: link.ctaLink ?? meta.ctaLink,
                restaurantId: link.restaurantId ?? null,
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
    const { startDate, endDate, zoneId, ctaLink, restaurantId, ...rest } = data;
    const updates = { ...rest, ...(await resolveBannerLink({ ctaLink, restaurantId })) };

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
