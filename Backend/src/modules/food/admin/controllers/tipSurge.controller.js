import { sendResponse } from '../../../../utils/response.js';
import * as surge from '../services/surgeRule.service.js';
import * as tips from '../services/tip.service.js';

// ── Surge ──
export async function listSurgeRulesController(_req, res, next) {
    try { return sendResponse(res, 200, 'Surge rules fetched', await surge.listSurgeRules()); }
    catch (e) { next(e); }
}

export async function createSurgeRuleController(req, res, next) {
    try { return sendResponse(res, 201, 'Surge rule created', { rule: await surge.createSurgeRule(req.body || {}) }); }
    catch (e) { next(e); }
}

export async function updateSurgeRuleController(req, res, next) {
    try { return sendResponse(res, 200, 'Surge rule updated', { rule: await surge.updateSurgeRule(req.params.id, req.body || {}) }); }
    catch (e) { next(e); }
}

export async function deleteSurgeRuleController(req, res, next) {
    try { return sendResponse(res, 200, 'Surge rule deleted', await surge.deleteSurgeRule(req.params.id)); }
    catch (e) { next(e); }
}

// ── Tips ──
export async function getTipSettingsController(_req, res, next) {
    try { return sendResponse(res, 200, 'Tip settings fetched', await tips.getTipSettings()); }
    catch (e) { next(e); }
}

export async function updateTipSettingsController(req, res, next) {
    try { return sendResponse(res, 200, 'Tip settings updated', await tips.updateTipSettings(req.body || {})); }
    catch (e) { next(e); }
}

export async function getTipReportController(req, res, next) {
    try { return sendResponse(res, 200, 'Tip report fetched', await tips.getTipReport({ days: req.query?.days })); }
    catch (e) { next(e); }
}

// ── The apps, no login ──
export async function getPublicTipConfigController(_req, res, next) {
    try { return sendResponse(res, 200, 'Tip options fetched', await tips.getPublicTipConfig()); }
    catch (e) { next(e); }
}
