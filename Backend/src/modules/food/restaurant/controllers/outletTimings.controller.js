import { sendResponse } from '../../../../utils/response.js';
import { getOutletTimingsForRestaurant, upsertOutletTimingsForRestaurant } from '../services/outletTimings.service.js';
import { findApprovedRestaurant } from '../services/restaurantLookup.helper.js';

export const getOutletTimingsByRestaurantIdController = async (req, res, next) => {
    try {
        // The id or a slug, current or from before a rename, like the other
        // public restaurant routes.
        const restaurant = await findApprovedRestaurant(req.params.id);
        if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found' });
        const data = await getOutletTimingsForRestaurant(restaurant.id);
        return sendResponse(res, 200, 'Outlet timings fetched successfully', data);
    } catch (error) {
        next(error);
    }
};

export const getCurrentRestaurantOutletTimingsController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const data = await getOutletTimingsForRestaurant(restaurantId);
        return sendResponse(res, 200, 'Outlet timings fetched successfully', data);
    } catch (error) {
        next(error);
    }
};

export const upsertCurrentRestaurantOutletTimingsController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const data = await upsertOutletTimingsForRestaurant(restaurantId, req.body?.outletTimings);
        return sendResponse(res, 200, 'Outlet timings saved successfully', data);
    } catch (error) {
        next(error);
    }
};

