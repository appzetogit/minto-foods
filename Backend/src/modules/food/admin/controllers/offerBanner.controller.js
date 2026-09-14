import { sendResponse } from '../../../../utils/response.js';
import * as svc from '../services/offerBanner.service.js';

// ── Admin ──
export async function listOfferBannersController(_req, res, next) {
    try {
        return sendResponse(res, 200, 'Offer banners fetched', await svc.listBannersAdmin());
    } catch (e) { next(e); }
}

export async function createOfferBannerController(req, res, next) {
    try {
        const banner = await svc.createBanner(req.file, req.body || {});
        return sendResponse(res, 201, 'Offer banner created', { banner });
    } catch (e) { next(e); }
}

export async function updateOfferBannerController(req, res, next) {
    try {
        const banner = await svc.updateBanner(req.params.id, req.body || {}, req.file);
        return sendResponse(res, 200, 'Offer banner updated', { banner });
    } catch (e) { next(e); }
}

export async function deleteOfferBannerController(req, res, next) {
    try {
        return sendResponse(res, 200, 'Offer banner deleted', await svc.deleteBanner(req.params.id));
    } catch (e) { next(e); }
}

export async function toggleOfferBannerStatusController(req, res, next) {
    try {
        const banner = await svc.toggleBannerStatus(req.params.id, req.body?.isActive);
        return sendResponse(res, 200, 'Offer banner status updated', { banner });
    } catch (e) { next(e); }
}

export async function reorderOfferBannersController(req, res, next) {
    try {
        return sendResponse(res, 200, 'Offer banners reordered', await svc.reorderBanners(req.body?.banners));
    } catch (e) { next(e); }
}

// ── The apps, no login ──
export async function listLiveOfferBannersController(_req, res, next) {
    try {
        return sendResponse(res, 200, 'Offer banners fetched', await svc.listLiveBanners());
    } catch (e) { next(e); }
}
