import { sendResponse } from '../../../utils/response.js';
import { invalidateCache } from '../../../middleware/cache.js';
import * as deals from './itemDeal.service.js';

/** Menus and dish lists are cached; a deal changes what they show. */
const clearDealCaches = () =>
    Promise.all(['public_foods:*', 'restaurant_menu:*', 'restaurants:*', 'restaurant_detail:*'].map(invalidateCache));

const handle = (fn) => async (req, res, next) => {
    try {
        await fn(req, res);
    } catch (err) {
        next(err);
    }
};

// Restaurant: its own deals.
export const listMine = handle(async (req, res) =>
    sendResponse(res, 200, 'Deals', { deals: await deals.listDeals(req.user?.userId) }));
export const createMine = handle(async (req, res) => {
    const deal = await deals.createDeal(req.user?.userId, req.body || {}, 'RESTAURANT');
    await clearDealCaches();
    sendResponse(res, 201, 'Deal created', { deal });
});
export const setMineStatus = handle(async (req, res) => {
    const deal = await deals.setDealStatus(req.params.id, req.body?.status, { restaurantId: req.user?.userId });
    await clearDealCaches();
    sendResponse(res, 200, 'Deal updated', { deal });
});
export const deleteMine = handle(async (req, res) => {
    await deals.deleteDeal(req.params.id, { restaurantId: req.user?.userId });
    await clearDealCaches();
    sendResponse(res, 200, 'Deal deleted', { deleted: true });
});

// Admin: any restaurant's deals.
export const adminList = handle(async (req, res) =>
    sendResponse(res, 200, 'Deals', { deals: await deals.listDeals(req.query?.restaurantId) }));
export const adminCreate = handle(async (req, res) => {
    const deal = await deals.createDeal(req.body?.restaurantId, req.body || {}, 'ADMIN');
    await clearDealCaches();
    sendResponse(res, 201, 'Deal created', { deal });
});
export const adminSetStatus = handle(async (req, res) => {
    const deal = await deals.setDealStatus(req.params.id, req.body?.status);
    await clearDealCaches();
    sendResponse(res, 200, 'Deal updated', { deal });
});
export const adminDelete = handle(async (req, res) => {
    await deals.deleteDeal(req.params.id);
    await clearDealCaches();
    sendResponse(res, 200, 'Deal deleted', { deleted: true });
});

// Customers: every live flash deal, for the Flash Deals page.
export const publicFlashDeals = handle(async (req, res) =>
    sendResponse(res, 200, 'Flash deals', { deals: await deals.listLiveFlashDeals({ zoneId: req.query?.zoneId }) }));
