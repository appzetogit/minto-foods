import { sendResponse } from '../../../../utils/response.js';
import {
    listHighlightBadges,
    createHighlightBadge,
    updateHighlightBadge,
    deleteHighlightBadge,
} from '../services/highlightBadge.service.js';

const handle = (fn) => async (req, res, next) => {
    try {
        return await fn(req, res);
    } catch (error) {
        return next(error);
    }
};

export const listBadges = handle(async (_req, res) =>
    sendResponse(res, 200, 'Tags fetched', { badges: await listHighlightBadges() }));

/** Active tags only, for the apps and the restaurant forms. */
export const listPublicBadges = handle(async (_req, res) =>
    sendResponse(res, 200, 'Tags fetched', { badges: await listHighlightBadges({ activeOnly: true }) }));

export const createBadge = handle(async (req, res) =>
    sendResponse(res, 201, 'Tag created', { badge: await createHighlightBadge(req.body || {}) }));

export const updateBadge = handle(async (req, res) =>
    sendResponse(res, 200, 'Tag updated', { badge: await updateHighlightBadge(req.params.id, req.body || {}) }));

export const deleteBadge = handle(async (req, res) =>
    sendResponse(res, 200, 'Tag deleted', await deleteHighlightBadge(req.params.id)));
