import express from 'express';
import {
    calculateOrderController,
    createOrderController,
    verifyPaymentController,
    abandonOnlinePaymentController,
    listOrdersUserController,
    getOrderPaymentsUserController,
    getOrderByIdUserController,
    cancelOrderController,
    submitOrderRatingsController,
    getOrderDropOtpUserController,
    updateOrderInstructionsController,
    getOrderRouteUserController,
    tipOrderAfterDeliveryController,
    getOrderInvoiceController,
    getOrderInvoiceHtmlController,
} from '../controllers/order.controller.js';

const router = express.Router();

router.post('/calculate', calculateOrderController);
router.post('/', createOrderController);

// Tipping after the food arrived. Separate from the tip at checkout, which is
// part of the order total and paid with it.
router.post('/:orderId/tip', tipOrderAfterDeliveryController);
router.post('/verify-payment', verifyPaymentController);
router.delete('/:orderId/pending-payment', abandonOnlinePaymentController);
router.get('/', listOrdersUserController);
router.get('/:orderId/payments', getOrderPaymentsUserController);
router.get('/:orderId/drop-otp', getOrderDropOtpUserController);
// Live route from the rider's current position to their next stop, for the tracking map.
// The customer's bill. Both before `/:orderId`, which would swallow them.
router.get('/:orderId/invoice', getOrderInvoiceController);
router.get('/:orderId/invoice.html', getOrderInvoiceHtmlController);
router.get('/:orderId/route', getOrderRouteUserController);
router.get('/:orderId', getOrderByIdUserController);
router.patch('/:orderId/cancel', cancelOrderController);
router.patch('/:orderId/ratings', submitOrderRatingsController);
router.patch('/:orderId/instructions', updateOrderInstructionsController);

export default router;
