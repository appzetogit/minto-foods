import { prisma } from '../../../../config/prisma.js';
import { makeBannerService } from './bannerService.factory.js';
import { isId } from '../../../../utils/helpers.js';

const banners = makeBannerService(prisma.foodHeroBanner, 'food/hero-banners', (meta) => ({
    linkedRestaurantIds: meta.linkedRestaurantIds || [],
    // Blank is every zone.
    zoneId: isId(meta.zoneId) ? String(meta.zoneId) : null,
}));

export const listHeroBanners = banners.list;
export const createHeroBannersFromFiles = banners.createFromFiles;
export const deleteHeroBanner = banners.remove;
export const updateHeroBannerOrder = banners.setOrder;
export const toggleHeroBannerStatus = banners.setActive;
