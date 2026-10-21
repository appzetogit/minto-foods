import { sendError, sendResponse } from '../../../../utils/response.js';
import { isId } from '../../../../utils/helpers.js';
import {
    createRestaurantSupportTicket,
    listRestaurantSupportTickets,
    getRestaurantSupportTicket,
} from '../services/restaurantSupportTicket.service.js';

export const createRestaurantSupportTicketController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Unauthorized');

        const ticket = await createRestaurantSupportTicket(restaurantId, req.body || {});
        return sendResponse(res, 201, 'Support ticket created successfully', { ticket });
    } catch (error) {
        next(error);
    }
};

export const listRestaurantSupportTicketsController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Unauthorized');

        const data = await listRestaurantSupportTickets(restaurantId, req.query || {});
        return sendResponse(res, 200, 'Support tickets fetched successfully', data);
    } catch (error) {
        next(error);
    }
};

export const getRestaurantSupportTicketController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Unauthorized');

        const ticket = await getRestaurantSupportTicket(restaurantId, req.params.id);
        if (!ticket) return sendError(res, 404, 'Ticket not found');
        return sendResponse(res, 200, 'Support ticket fetched successfully', { ticket });
    } catch (error) {
        next(error);
    }
};
