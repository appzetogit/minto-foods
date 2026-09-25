import { logger } from '../../../../utils/logger.js';
import { sendResponse } from '../../../../utils/response.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import {
    getPublicPageByKey,
    getAdminPageByKey,
    upsertLegalPage,
    upsertAboutPage
} from '../services/pageContent.service.js';

const PAGE_KEYS = new Set(['terms', 'privacy', 'refund', 'shipping', 'cancellation', 'about', 'support']);
const PAGE_MODULES = new Set(['ALL', 'USER', 'RESTAURANT', 'DELIVERY']);

/**
 * The page and app named in the request, checked against the ones that exist.
 * Both went straight into the query, so an unknown one (or a typo in an app's
 * link) was a database error and a 500 -- on a page anyone can open.
 */
const parseKeyFromParam = (req) => {
    const key = String(req.params?.key || '').trim().toLowerCase();
    if (!PAGE_KEYS.has(key)) throw new NotFoundError('Page not found');
    const module = String(req.query?.module || 'ALL').trim().toUpperCase();
    if (!PAGE_MODULES.has(module)) throw new ValidationError('Unknown app for this page');
    return key;
};

export const getPublicPageController = async (req, res, next) => {
    try {
        const key = parseKeyFromParam(req);
        const module = req.query.module || 'ALL';
        logger.info(`[CMS] Public Request - Key: ${key}, Module: ${module}`);
        const result = await getPublicPageByKey(key, module);
        logger.info(`[CMS] Result found: ${!!result.data}`);
        return sendResponse(res, 200, 'Page fetched successfully', result.data);
    } catch (error) {
        logger.error(`[CMS] Error:`, error);
        next(error);
    }
};

export const getAdminPageController = async (req, res, next) => {
    try {
        const key = parseKeyFromParam(req);
        const module = req.query.module || 'ALL';
        const result = await getAdminPageByKey(key, module);
        return sendResponse(res, 200, 'Page fetched successfully', result.data);
    } catch (error) {
        next(error);
    }
};

export const upsertAdminPageController = async (req, res, next) => {
    try {
        const key = parseKeyFromParam(req);
        const module = req.body.module || 'ALL';
        const updatedBy = req.user?.userId || null;

        if (key === 'about') {
            const result = await upsertAboutPage(req.body ?? {}, updatedBy, module);
            return sendResponse(res, 200, 'Page updated successfully', result.data);
        }
        if (['terms', 'privacy', 'refund', 'shipping', 'cancellation', 'support'].includes(key)) {
            const result = await upsertLegalPage(key, req.body ?? {}, updatedBy, module);
            return sendResponse(res, 200, 'Page updated successfully', result.data);
        }
        throw new ValidationError('Invalid page key');
    } catch (error) {
        next(error);
    }
};

