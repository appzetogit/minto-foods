import crypto from 'crypto';
import { prisma } from '../../../config/prisma.js';
import { finalizeOrderPayment } from '../../../modules/food/orders/services/order.service.js';
import { config } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { reconcileOrderPayment } from '../../../modules/food/orders/services/payment-reconcile.service.js';
import {
    applyGatewayRefundUpdate,
    onlineAmountDuePaise,
} from '../../../modules/food/orders/services/order-refund.service.js';
import { getRazorpayInstance } from '../../../modules/food/orders/helpers/razorpay.helper.js';

/**
 * A payment was captured for a food order we no longer have -- the customer
 * paid after the order was given up (the app closed the sheet, the 30-minute
 * cleanup ran). Nobody will ever deliver it, so the money goes straight back.
 *
 * Only Razorpay orders this server marked `purpose: food_order` qualify, so a
 * wallet top-up or a restaurant's subscription payment is never touched.
 */
async function refundOrphanPayment(paymentObj) {
    const razorpay = getRazorpayInstance();
    if (!razorpay) return 'razorpay not configured';
    const rzOrder = await razorpay.orders.fetch(paymentObj.order_id);
    if (rzOrder?.notes?.purpose !== 'food_order') return 'not a food order';

    const refundable = Number(paymentObj.amount) - Number(paymentObj.amount_refunded || 0);
    if (!(refundable > 0)) return 'already refunded';

    await razorpay.payments.refund(paymentObj.id, {
        amount: refundable,
        speed: 'normal',
        notes: { reason: 'order_no_longer_exists', orderId: String(rzOrder.notes.orderId || '') },
    });
    return `refunded ${refundable} paise`;
}

/**
 * Razorpay webhook handler.
 *
 * Razorpay retries a webhook until it gets a 2xx, so every branch here has to be
 * idempotent. Mongo got that from findOneAndUpdate with the "not already paid"
 * clause in the filter — one atomic statement that both claims the transition
 * and reports whether this call was the one that made it.
 *
 * Prisma has no returning-update, so it is updateMany with the same condition
 * (which compiles to one conditional UPDATE) followed by a read. `count` is what
 * decides whether to run the follow-up work, so a duplicate delivery updates
 * nothing and posts nothing to the ledger.
 */
export const handleRazorpayWebhook = async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const secret = config.razorpayWebhookSecret;

    // 1. Verify the signature against the raw body buffer.
    if (!signature || !secret || !req.rawBody) {
        logger.warn('Razorpay Webhook: Missing signature or rawBody buffer.');
        return res.status(400).send('Invalid signature');
    }

    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');

    // timingSafeEqual, not !==: a plain string compare returns as soon as it
    // finds a differing byte, which leaks how much of a forged signature was
    // right. Length is checked first because timingSafeEqual throws on a mismatch.
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(String(signature), 'utf8');
    const signatureValid =
        expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

    if (!signatureValid) {
        logger.warn('Razorpay Webhook: Signature verification failed.');
        return res.status(400).send('Invalid signature');
    }

    const { event, payload } = req.body;
    logger.info(`Razorpay Webhook Received: ${event}`);

    try {
        // --- Payment captured ---
        if (event === 'payment.captured') {
            const paymentObj = payload.payment.entity;
            const rzOrderId = paymentObj.order_id;
            const rzPaymentId = paymentObj.id;

            const existingOrder = await prisma.foodOrder.findFirst({
                where: { razorpayOrderId: rzOrderId },
                select: { id: true, orderId: true, total: true, onlineAmount: true, paymentStatus: true },
            });

            if (!existingOrder) {
                try {
                    const outcome = await refundOrphanPayment(paymentObj);
                    logger.warn(`Webhook [payment.captured]: no order for RZ-Order ${rzOrderId}; ${outcome}`);
                } catch (orphanErr) {
                    // Retried by Razorpay; the amount_refunded check keeps it to one refund.
                    logger.error(`Webhook [payment.captured]: refunding orphan payment ${rzPaymentId} failed: ${orphanErr?.error?.description || orphanErr?.message || orphanErr}`);
                    return res.status(500).json({ message: 'Retry' });
                }
                return res.status(200).json({ status: 'ok' });
            }

            // Cross-check the captured amount before marking anything paid: a
            // gateway callback is not proof of the right amount. On a split
            // order Razorpay only took the online part.
            if (existingOrder) {
                const expectedPaise = onlineAmountDuePaise(existingOrder);
                const paidPaise = Number(paymentObj.amount);

                if (!Number.isFinite(paidPaise) || paidPaise !== expectedPaise) {
                    logger.error(
                        `Webhook [payment.captured]: AMOUNT MISMATCH for RZ-Order ${rzOrderId} — paid ${paidPaise} paise, expected ${expectedPaise} paise. Order NOT marked paid.`,
                    );
                    await prisma.foodOrder.updateMany({
                        where: { id: existingOrder.id, paymentStatus: { not: 'paid' } },
                        data: { paymentStatus: 'failed', razorpayPaymentId: rzPaymentId },
                    });
                    return res.status(200).json({ status: 'ok' });
                }
            }

            // Claim the transition. count is 1 only for the delivery that won.
            const { count } = await prisma.foodOrder.updateMany({
                where: { razorpayOrderId: rzOrderId, paymentStatus: { not: 'paid' } },
                data: { paymentStatus: 'paid', razorpayPaymentId: rzPaymentId },
            });

            if (count) {
                const order = await prisma.foodOrder.findFirst({
                    where: { razorpayOrderId: rzOrderId },
                    select: { id: true, orderId: true },
                });

                // Everything that used to happen only in verifyPayment — moving
                // the order out of pending_payment, the acceptance deadline, the
                // ledger entry, the restaurant push — has to happen here too. A
                // customer who pays and then closes the browser before the app
                // gets a chance to poll never calls verifyPayment; the webhook is
                // the only caller left. finalizeOrderPayment guards on
                // orderStatus itself, so it does not matter if verifyPayment
                // already ran for this order — this just returns null then.
                //
                // Must not fail the webhook response — Razorpay would retry, and
                // the retry would find paymentStatus already 'paid' and never
                // reach this line again, leaving the order stuck mid-finalize.
                try {
                    await finalizeOrderPayment(order.id, { source: 'SYSTEM' });
                } catch (finalizeErr) {
                    logger.error(`Webhook finalize error (Order ${order.orderId}): ${finalizeErr.message}`);
                }
                logger.info(`Webhook [payment.captured]: Synced Order ${order.orderId} (Status=paid)`);
            } else {
                logger.warn(
                    `Webhook [payment.captured]: Order not found or already paid for RZ-Order: ${rzOrderId}`,
                );
            }
        }

        // --- Money held but not taken, or the order reported paid ---
        // Both mean "check the gateway": an authorised payment is captured
        // there (with manual capture on in the dashboard it would otherwise be
        // returned to the customer after a few days, with the order never
        // confirmed), and order.paid is the same news payment.captured brings.
        if (event === 'payment.authorized' || event === 'order.paid') {
            const rzOrderId = payload?.payment?.entity?.order_id || payload?.order?.entity?.id;
            const order = rzOrderId
                ? await prisma.foodOrder.findFirst({
                    where: { razorpayOrderId: rzOrderId },
                    select: { id: true, orderId: true, total: true, onlineAmount: true, razorpayOrderId: true },
                })
                : null;
            if (order) {
                const result = await reconcileOrderPayment(order);
                logger.info(`Webhook [${event}]: Order ${order.orderId} is ${result}`);
            }
        }

        // --- Payment failed ---
        // The customer can try again, so the order stays open for them; it is
        // only recorded, and the 30-minute cleanup (which asks Razorpay first)
        // closes it if they never do. A later success still wins: the update
        // skips an order already paid.
        if (event === 'payment.failed') {
            const paymentObj = payload.payment.entity;
            const { count } = await prisma.foodOrder.updateMany({
                where: { razorpayOrderId: paymentObj.order_id, paymentStatus: { notIn: ['paid', 'refunded'] } },
                data: { paymentStatus: 'failed' },
            });
            logger.warn(
                `Webhook [payment.failed]: RZ-Order ${paymentObj.order_id} -- ${paymentObj.error_description || paymentObj.error_code || 'no reason given'}${count ? '' : ' (order already settled)'}`,
            );
        }

        // --- Refund processed / failed ---
        // Each refund we make is its own row (food_order_refunds); the event
        // settles that row and the order's summary is recomputed from all of
        // them, so a partial or split refund never marks the whole order
        // refunded. A refund made from the Razorpay dashboard is recorded too.
        if (event === 'refund.processed' || event === 'refund.failed') {
            const refundObj = payload.refund.entity;
            const outcome = await applyGatewayRefundUpdate(refundObj);
            const line = `Webhook [${event}]: refund ${refundObj.id} for payment ${refundObj.payment_id}: ${outcome}`;
            if (event === 'refund.failed') logger.error(`${line} -- the amount is free to refund again from the admin panel`);
            else logger.info(line);
        }

        res.status(200).json({ status: 'ok' });
    } catch (err) {
        logger.error(`Razorpay Webhook Logic Error: ${err.message}`);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};
