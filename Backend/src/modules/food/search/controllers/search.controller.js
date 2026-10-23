import { searchUnified, getAdminCategories } from '../services/search.service.js';
import { sendResponse, sendError } from '../../../../utils/response.js';

/**
 * Unified Search for Restaurants, Food Items, and Cuisines
 */
export const searchController = async (req, res, next) => {
    try {
        // A zoneId the app sends is ignored: search goes by distance.
        const { q, lat, lng, radiusKm, categoryId, minRating, maxDeliveryTime, isVeg, page, limit } = req.query;

        const results = await searchUnified({
            q,
            lat,
            lng,
            radiusKm,
            categoryId,
            minRating,
            maxDeliveryTime,
            isVeg,
            page: parseInt(page, 10) || 1,
            limit: parseInt(limit, 10) || 20,
        });

        return sendResponse(res, 200, 'Search results fetched successfully', results.data);
    } catch (error) {
        next(error);
    }
};

/**
 * Fetch List of Admin-only Categories
 */
export const listAdminCategoriesController = async (req, res, next) => {
    try {
        const { lat, lng, radiusKm } = req.query;
        const categories = await getAdminCategories({ lat, lng, radiusKm });
        
        return sendResponse(res, 200, 'Admin categories fetched successfully', { categories });
    } catch (error) {
        next(error);
    }
};
