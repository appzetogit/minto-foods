import * as restaurantService from '../services/restaurant.service.js';
import { sendResponse, sendError } from '../../../../utils/response.js';
import { validateCreateOfferDto } from '../../admin/validators/offer.validator.js';

/**
 * A restaurant's offer is always scoped to that restaurant. The id comes from
 * the token, never the body, so a restaurant cannot create or move an offer
 * onto someone else's menu.
 */
const validateForRestaurant = (req) => validateCreateOfferDto({
    ...req.body,
    restaurantScope: 'selected',
    restaurantId: req.user.userId,
    restaurantIds: undefined,
    adminBearPercentage: 0,
    restaurantBearPercentage: 100,
});

export const createRestaurantOfferController = async (req, res) => {
    try {
        const payload = validateForRestaurant(req);
        const doc = await restaurantService.createRestaurantOffer(req.user.userId, payload);
        return sendResponse(res, 201, 'Offer created successfully', { doc });
    } catch (err) {
        return sendError(res, err.statusCode || 400, err.message);
    }
};

export const listRestaurantOffersController = async (req, res) => {
    try {
        const list = await restaurantService.listRestaurantOffers(req.user.userId);
        return sendResponse(res, 200, 'Offers fetched successfully', { offers: list });
    } catch (err) {
        return sendError(res, err.statusCode || 400, err.message);
    }
};

export const getRestaurantOfferController = async (req, res) => {
    try {
        const doc = await restaurantService.getRestaurantOffer(req.user.userId, req.params.id);
        return sendResponse(res, 200, 'Offer fetched successfully', { doc });
    } catch (err) {
        return sendError(res, err.statusCode || 400, err.message);
    }
};

export const updateRestaurantOfferController = async (req, res) => {
    try {
        const payload = validateForRestaurant(req);
        const doc = await restaurantService.updateRestaurantOffer(req.user.userId, req.params.id, payload);
        return sendResponse(res, 200, 'Offer updated successfully', { doc });
    } catch (err) {
        return sendError(res, err.statusCode || 400, err.message);
    }
};

export const deleteRestaurantOfferController = async (req, res) => {
    try {
        await restaurantService.deleteRestaurantOffer(req.user.userId, req.params.id);
        return sendResponse(res, 200, 'Offer deleted successfully');
    } catch (err) {
        return sendError(res, err.statusCode || 400, err.message);
    }
};

export const updateRestaurantOfferStatusController = async (req, res) => {
    try {
        const doc = await restaurantService.updateRestaurantOfferStatus(req.user.userId, req.params.id, req.body?.status);
        return sendResponse(res, 200, 'Offer status updated successfully', { doc });
    } catch (err) {
        return sendError(res, err.statusCode || 400, err.message);
    }
};
