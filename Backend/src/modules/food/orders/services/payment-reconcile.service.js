import { prisma } from '../../../../config/prisma.js';
import { logger } from '../../../../utils/logger.js';
import { getRazorpayInstance } from '../helpers/razorpay.helper.js';

/**
 * Asking Razorpay what actually happened to an order's payment.
 *
 * The webhook and the app's verify call are the two ways an order learns it
 * was paid, and both can miss: the customer closes the app before verify, the
 * webhook is delayed, misconfigured or rejected. An unpaid order is removed
 * after 30 minutes -- and before this, removed without asking, so a customer
 * who had paid could be charged and left with no order. Anything that would
 * give up on an online order checks with the gateway first.
 *
 * Returns what the gateway says:
 *   'paid'    captured for the right amount; the order is now marked paid and finalised
 *   'pending' authorised or still processing; leave it alone
 *   'unpaid'  no successful payment; safe to give up on
 *   'unknown' the gateway could not be asked; never give up on this basis
 */
export async function reconcileOrderPayment(order) {
    const rzOrderId = order?.razorpayOrderId;
    if (!rzOrderId) return 'unpaid';

    const razorpay = getRazorpayInstance();
    if (!razorpay) return 'unknown';

    let payments;
    try {
        const res = await razorpay.orders.fetchPayments(rzOrderId);
        payments = Array.isArray(res?.items) ? res.items : [];
    } catch (err) {
        logger.warn(`Payment reconcile: could not ask Razorpay about ${rzOrderId}: ${err?.error?.description || err?.message || err}`);
        return 'unknown';
    }

    const expectedPaise = Math.round(Number(order.total || 0) * 100);

    // An authorised payment is the customer's money held but not taken. With
    // manual capture turned on in the dashboard it stays that way -- and is
    // refunded to them after a few days -- unless someone captures it.
    for (const p of payments.filter((x) => x.status === 'authorized')) {
        if (Number(p.amount) !== expectedPaise) continue;
        try {
            await razorpay.payments.capture(p.id, p.amount, p.currency || 'INR');
            p.status = 'captured';
            logger.info(`Payment reconcile: captured authorised payment ${p.id} for ${rzOrderId}`);
        } catch (err) {
            logger.warn(`Payment reconcile: capture of ${p.id} failed: ${err?.error?.description || err?.message || err}`);
            return 'pending';
        }
    }

    const captured = payments.find((p) => p.status === 'captured');
    if (captured) {
        if (Number(captured.amount) !== expectedPaise) {
            // Paid, but not what the order says: a person has to look.
            logger.error(
                `Payment reconcile: AMOUNT MISMATCH for ${rzOrderId} -- captured ${captured.amount} paise, expected ${expectedPaise}. Left for review.`,
            );
            return 'pending';
        }
        const { count } = await prisma.foodOrder.updateMany({
            where: { id: order.id, paymentStatus: { not: 'paid' } },
            data: { paymentStatus: 'paid', razorpayPaymentId: captured.id },
        });
        if (count) {
            // Imported here: order.service imports this module.
            const { finalizeOrderPayment } = await import('./order.service.js');
            try {
                await finalizeOrderPayment(order.id, { source: 'SYSTEM' });
            } catch (err) {
                logger.error(`Payment reconcile: finalize failed for ${order.id}: ${err?.message || err}`);
            }
            logger.warn(`Payment reconcile: recovered a paid order the app and webhook both missed (${rzOrderId})`);
        }
        return 'paid';
    }

    if (payments.some((p) => p.status === 'created' || p.status === 'pending')) return 'pending';
    return 'unpaid';
}
