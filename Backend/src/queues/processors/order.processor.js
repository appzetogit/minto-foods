import { logger } from '../../utils/logger.js';

/**
 * BullMQ processor for order lifecycle jobs: the rider offer window closing
 * (DISPATCH_TIMEOUT_CHECK, re-offers the order) and the restaurant's acceptance
 * window closing (ORDER_ACCEPTANCE_TIMEOUT_CHECK, cancels it if still unaccepted).
 *
 * Both imports pointed one directory too high (../../../modules), outside src/,
 * so every job failed with "Cannot find module" and neither ever ran: an
 * order nobody took was only re-offered when something else nudged it.
 * @param {import('bullmq').Job} job
 */
export const processOrderJob = async (job) => {
    const data = job?.data || {};
    const action = data.action || 'unknown';
    const orderId = data.orderId || '';
    const orderMongoId = data.orderMongoId || '';

    logger.info(
        `[BullMQ:order] action=${action} jobId=${job.id} orderId=${orderId} orderMongoId=${orderMongoId}`
    );

    // Handle Smart Dispatch Timeout
    if (action === 'DISPATCH_TIMEOUT_CHECK') {
        try {
            const { processDispatchTimeout } = await import('../../modules/food/orders/services/order.service.js');
            // Pass full data object to allow attempt count and other options
            await processDispatchTimeout(orderMongoId, data.partnerId, data);
        } catch (err) {
            logger.error(`[BullMQ:order] DISPATCH_TIMEOUT_CHECK failed: ${err.message}`);
        }
    }

    if (action === 'ORDER_ACCEPTANCE_TIMEOUT_CHECK') {
        try {
            const { expireUnacceptedOrderById } = await import('../../modules/food/orders/services/order.service.js');
            await expireUnacceptedOrderById(orderMongoId);
        } catch (err) {
            logger.error(`[BullMQ:order] ORDER_ACCEPTANCE_TIMEOUT_CHECK failed: ${err.message}`);
        }
    }


    return { processed: true, action, jobId: job.id };
};
