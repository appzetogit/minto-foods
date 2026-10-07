import * as service from './priceRulesAdmin.service.js';

const ok = (res, data, message = 'OK', status = 200) => res.status(status).json({ success: true, message, data });
const adminIdOf = (req) => req.user?.userId || null;

export async function listPriceRules(req, res, next) {
    try {
        ok(res, await service.listPriceRules(req.query || {}), 'Price rules fetched');
    } catch (err) {
        next(err);
    }
}

export async function getPriceRule(req, res, next) {
    try {
        ok(res, await service.getPriceRule(req.params.id), 'Price rule fetched');
    } catch (err) {
        next(err);
    }
}

export async function createPriceRule(req, res, next) {
    try {
        ok(res, await service.createPriceRule(req.body || {}, adminIdOf(req)), 'Price rule created', 201);
    } catch (err) {
        next(err);
    }
}

export async function updatePriceRule(req, res, next) {
    try {
        ok(res, await service.updatePriceRule(req.params.id, req.body || {}, adminIdOf(req)), 'Price rule updated');
    } catch (err) {
        next(err);
    }
}

export async function togglePriceRule(req, res, next) {
    try {
        ok(res, await service.togglePriceRule(req.params.id, req.body?.isActive, adminIdOf(req)), 'Price rule updated');
    } catch (err) {
        next(err);
    }
}

export async function deletePriceRule(req, res, next) {
    try {
        ok(res, await service.deletePriceRule(req.params.id, adminIdOf(req)), 'Price rule deleted');
    } catch (err) {
        next(err);
    }
}

export async function previewPriceRule(req, res, next) {
    try {
        ok(res, await service.previewPriceRule(req.body || {}, req.query || {}), 'Preview ready');
    } catch (err) {
        next(err);
    }
}

export async function effectivePrices(req, res, next) {
    try {
        ok(res, await service.effectivePrices(req.query?.restaurantId), 'Prices fetched');
    } catch (err) {
        next(err);
    }
}
