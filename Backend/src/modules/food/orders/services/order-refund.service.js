import { prisma } from '../../../../config/prisma.js';
import { logger } from '../../../../utils/logger.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { recordTransaction } from '../../../../core/payments/transaction.service.js';
import { getRazorpayInstance, isRazorpayConfigured } from '../helpers/razorpay.helper.js';

/**
 * Refunds for orders, one row per movement of money (food_order_refunds).
 *
 * An order can be paid from the wallet, online, or both. Every refund is split
 * into legs by the part of the payment it comes out of — online first, then
 * the wallet — and each leg goes back to where that money came from unless the
 * caller asks for the wallet. What is left to refund is always worked out from
 * the legs (a failed leg does not count), so partial refunds, retries and a
 * cancellation after a partial refund all add up.
 *
 * Money moves outside the database transaction (Razorpay is an HTTP call), so
 * the order row is locked only while the legs are planned and inserted as
 * `pending`. A second refund arriving at the same moment waits for that lock
 * and then sees the first one's legs as already spoken for.
 *
 * All arithmetic is in whole paise.
 */

const toPaise = (value) => Math.round(Number(value || 0) * 100);
const toRupees = (paise) => Math.round(paise) / 100;

/** A leg that is done or on its way; failed legs give their amount back. */
const COMMITTED = ['pending', 'processed'];

/**
 * How much of an order was paid from the wallet and how much online, in paise.
 * Orders from before split payments were backfilled by the migration; the
 * fallbacks cover a row written by old code between migration and restart.
 */
export function paidParts(order) {
    const method = String(order?.paymentMethod || '').toLowerCase();
    const total = toPaise(order?.total);
    let wallet = toPaise(order?.walletAmount);
    let online = toPaise(order?.onlineAmount);
    if (wallet === 0 && online === 0) {
        if (method === 'wallet') wallet = total;
        else if (method === 'razorpay') online = total;
    }
    return { wallet, online };
}

/** What Razorpay should have charged for this order, in paise. */
export function onlineAmountDuePaise(order) {
    const online = toPaise(order?.onlineAmount);
    return online > 0 ? online : toPaise(order?.total);
}

function remainingFrom(order, legs) {
    const paid = paidParts(order);
    const used = { wallet: 0, online: 0 };
    for (const leg of legs) {
        if (COMMITTED.includes(leg.status)) used[leg.source] += toPaise(leg.amount);
    }
    return {
        paid,
        wallet: Math.max(0, paid.wallet - used.wallet),
        online: Math.max(0, paid.online - used.online),
    };
}

/**
 * Split a refund into legs. Online money first: the customer gets real money
 * back before store credit.
 *
 * @param {{wallet:number, online:number}} remaining paise left per part
 * @param {number} requestedPaise
 * @param {'original'|'wallet'} destination
 * @param {boolean} canUseGateway there is a captured Razorpay payment to refund
 */
export function planRefundLegs(remaining, requestedPaise, destination, canUseGateway) {
    const legs = [];
    const fromOnline = Math.min(requestedPaise, remaining.online);
    const fromWallet = Math.min(requestedPaise - fromOnline, remaining.wallet);
    if (fromOnline > 0) {
        legs.push({
            source: 'online',
            refundTo: destination === 'wallet' || !canUseGateway ? 'wallet' : 'gateway',
            paise: fromOnline,
        });
    }
    if (fromWallet > 0) legs.push({ source: 'wallet', refundTo: 'wallet', paise: fromWallet });
    return legs;
}

async function lockOrder(tx, orderId) {
    await tx.$queryRaw`SELECT "id" FROM "food_orders" WHERE "id" = ${orderId} FOR UPDATE`;
    return tx.foodOrder.findUnique({
        where: { id: orderId },
        select: {
            id: true, order_id: true, userId: true, total: true,
            paymentMethod: true, paymentStatus: true,
            walletAmount: true, onlineAmount: true, razorpayPaymentId: true,
            refundLegs: true,
        },
    });
}

/**
 * Bring the order's refund summary (refundStatus, refundAmount, paymentStatus)
 * in line with its legs. Every path that changes a leg ends here, so the
 * summary can never disagree with the money.
 */
export async function syncOrderRefundSummary(orderId) {
    return prisma.$transaction(async (tx) => {
        const order = await lockOrder(tx, String(orderId));
        if (!order) return null;
        const legs = order.refundLegs;
        if (!legs.length) return order;

        const sum = (status) =>
            legs.filter((l) => l.status === status).reduce((acc, l) => acc + toPaise(l.amount), 0);
        const processed = sum('processed');
        const pending = sum('pending');
        const remaining = remainingFrom(order, legs);
        const left = remaining.wallet + remaining.online;
        const paidTotal = remaining.paid.wallet + remaining.paid.online;
        const anyFailed = legs.some((l) => l.status === 'failed');

        let refundStatus = 'none';
        if (pending > 0) refundStatus = 'pending';
        else if (anyFailed && left > 0) refundStatus = 'failed';
        else if (processed > 0) refundStatus = 'processed';

        const data = {
            refundStatus,
            refundAmount: toRupees(processed + pending),
        };
        const lastGateway = legs
            .filter((l) => l.gatewayRefundId && l.status !== 'failed')
            .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (lastGateway) data.refundId = lastGateway.gatewayRefundId;
        const lastDone = legs
            .filter((l) => l.processedAt)
            .sort((a, b) => b.processedAt - a.processedAt)[0];
        if (lastDone) data.refundProcessedAt = lastDone.processedAt;

        // Only paid money can become refunded, and a refund that later fails
        // hands the order back to paid.
        if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded') {
            data.paymentStatus = paidTotal > 0 && processed + pending >= paidTotal ? 'refunded' : 'paid';
        }

        return tx.foodOrder.update({ where: { id: order.id }, data });
    });
}

const walletRefundKey = (legId) => `order_refund_leg:${legId}`;

async function markLeg(legId, fromStatuses, data) {
    const { count } = await prisma.foodOrderRefund.updateMany({
        where: { id: legId, status: { in: fromStatuses } },
        data,
    });
    return count > 0;
}

/**
 * Pay a wallet leg. The leg id is the ledger idempotency key, so running this
 * twice (a retry, the sweep) credits once.
 */
async function executeWalletLeg(leg, order) {
    try {
        await recordTransaction({
            entityType: 'user',
            entityId: String(leg.userId),
            type: 'credit',
            amount: Number(leg.amount),
            description:
                leg.source === 'online'
                    ? `Refund for order #${order.order_id || order.id} (online payment, to wallet)`
                    : `Refund for order #${order.order_id || order.id}`,
            category: 'order_refund',
            orderId: String(order.id),
            idempotencyKey: walletRefundKey(leg.id),
            metadata: { source: 'order_refund', refundLegId: leg.id, from: leg.source },
        });
        await markLeg(leg.id, ['pending', 'failed'], { status: 'processed', processedAt: new Date(), failureReason: '' });
    } catch (err) {
        // If the credit did land and only what followed failed, it must not be
        // marked failed -- that would let the amount be refunded again.
        const landed = await prisma.transaction
            .findUnique({ where: { idempotencyKey: walletRefundKey(leg.id) } })
            .catch(() => null);
        if (landed) {
            await markLeg(leg.id, ['pending', 'failed'], { status: 'processed', processedAt: new Date() });
            return;
        }
        logger.error(`Wallet refund leg ${leg.id} failed: ${err?.message || err}`);
        await markLeg(leg.id, ['pending'], { status: 'failed', failureReason: String(err?.message || err).slice(0, 500) });
    }
}

/**
 * Razorpay's answer to a refund call, sorted into what we can act on.
 * A 4xx is a definite no; anything else (timeout, 5xx, no response) means we
 * do not know whether the refund was created, so the leg stays pending and the
 * sweep asks Razorpay later rather than risk refunding twice.
 */
function classifyGatewayError(err) {
    const status = Number(err?.statusCode);
    const description = err?.error?.description || err?.message || 'Razorpay refund failed';
    if (status >= 400 && status < 500) return { definite: true, description };
    return { definite: false, description };
}

async function executeGatewayLeg(leg, order) {
    if (!isRazorpayConfigured()) {
        await markLeg(leg.id, ['pending'], { status: 'failed', failureReason: 'Online payments are not configured on this server' });
        return;
    }
    try {
        const rzRefund = await getRazorpayInstance().payments.refund(leg.gatewayPaymentId, {
            amount: toPaise(leg.amount),
            speed: 'normal',
            notes: { orderId: String(order.id), refundLegId: leg.id, reason: String(leg.reason || '').slice(0, 200) },
        });
        const done = String(rzRefund?.status || '').toLowerCase() === 'processed';
        await prisma.foodOrderRefund.updateMany({
            where: { id: leg.id, status: 'pending' },
            data: {
                gatewayRefundId: rzRefund.id,
                ...(done ? { status: 'processed', processedAt: new Date() } : {}),
            },
        });
    } catch (err) {
        const { definite, description } = classifyGatewayError(err);
        logger.error(`Gateway refund leg ${leg.id} ${definite ? 'refused' : 'outcome unknown'}: ${description}`);
        if (definite) {
            await markLeg(leg.id, ['pending'], { status: 'failed', failureReason: String(description).slice(0, 500) });
        } else {
            await prisma.foodOrderRefund.updateMany({
                where: { id: leg.id, status: 'pending' },
                data: { failureReason: `Awaiting confirmation from Razorpay: ${String(description).slice(0, 400)}` },
            });
        }
    }
}

/**
 * Refund an order. With no amount, refunds whatever is left.
 *
 * @param {object} args
 * @param {string} args.orderId
 * @param {number} [args.amount] rupees; omit for everything left
 * @param {'original'|'wallet'} [args.destination] 'original' sends online
 *        money back through Razorpay; 'wallet' sends all of it to the wallet
 * @param {string} [args.initiatedBy] user | restaurant | admin | system
 * @param {string} [args.initiatedById]
 * @param {string} [args.reason]
 * @param {boolean} [args.strict] throw when the amount is more than is left
 *        (admin); otherwise refund what is left
 * @returns {Promise<{legs: object[], order: object|null, refundedPaise: number, reason?: string}>}
 */
export async function refundOrder({
    orderId,
    amount = null,
    destination = 'original',
    initiatedBy = 'system',
    initiatedById = null,
    reason = '',
    strict = false,
}) {
    const id = String(orderId);
    if (!['original', 'wallet'].includes(destination)) {
        throw new ValidationError('Refund destination must be original or wallet');
    }

    const planned = await prisma.$transaction(async (tx) => {
        const order = await lockOrder(tx, id);
        if (!order) throw new ValidationError('Order not found');
        if (!['paid', 'refunded'].includes(order.paymentStatus)) {
            return { order, legs: [], reason: order.paymentMethod === 'cash' ? 'cash_payment' : `payment_${order.paymentStatus}` };
        }

        const remaining = remainingFrom(order, order.refundLegs);
        const left = remaining.wallet + remaining.online;
        if (left <= 0) return { order, legs: [], reason: 'nothing_left_to_refund' };

        let requested = left;
        if (amount != null && amount !== '') {
            requested = toPaise(amount);
            if (!(requested > 0)) throw new ValidationError('Refund amount must be greater than zero');
            if (requested > left) {
                if (strict) throw new ValidationError(`Only ₹${toRupees(left)} is left to refund on this order`);
                requested = left;
            }
        }

        const canUseGateway = Boolean(order.razorpayPaymentId);
        const plan = planRefundLegs(remaining, requested, destination, canUseGateway);
        const legs = [];
        for (const step of plan) {
            legs.push(
                await tx.foodOrderRefund.create({
                    data: {
                        orderId: order.id,
                        userId: order.userId,
                        source: step.source,
                        refundTo: step.refundTo,
                        amount: toRupees(step.paise),
                        status: 'pending',
                        gatewayPaymentId: step.refundTo === 'gateway' ? order.razorpayPaymentId : null,
                        reason: String(reason || '').slice(0, 500),
                        initiatedBy: String(initiatedBy || 'system').slice(0, 16),
                        initiatedById: initiatedById ? String(initiatedById) : null,
                    },
                }),
            );
        }
        return { order, legs };
    });

    for (const leg of planned.legs) {
        if (leg.refundTo === 'wallet') await executeWalletLeg(leg, planned.order);
        else await executeGatewayLeg(leg, planned.order);
    }

    const order = planned.legs.length ? await syncOrderRefundSummary(id) : planned.order;
    const legs = planned.legs.length
        ? await prisma.foodOrderRefund.findMany({ where: { id: { in: planned.legs.map((l) => l.id) } } })
        : [];
    const refundedPaise = legs
        .filter((l) => COMMITTED.includes(l.status))
        .reduce((acc, l) => acc + toPaise(l.amount), 0);
    return { legs, order, refundedPaise, reason: planned.reason };
}

/** How much is left to refund on an order, in rupees, per part. */
export async function getRefundableAmounts(orderId) {
    const order = await prisma.foodOrder.findUnique({
        where: { id: String(orderId) },
        select: {
            total: true, paymentMethod: true, paymentStatus: true,
            walletAmount: true, onlineAmount: true, refundLegs: true,
        },
    });
    if (!order) return null;
    const refundable = ['paid', 'refunded'].includes(order.paymentStatus);
    const remaining = remainingFrom(order, order.refundLegs);
    return {
        paidWallet: toRupees(remaining.paid.wallet),
        paidOnline: toRupees(remaining.paid.online),
        leftWallet: refundable ? toRupees(remaining.wallet) : 0,
        leftOnline: refundable ? toRupees(remaining.online) : 0,
        leftTotal: refundable ? toRupees(remaining.wallet + remaining.online) : 0,
    };
}

/**
 * The customer-facing sentence for a set of legs, e.g.
 * "₹120 has been added back to your Minto wallet. ₹330 will be refunded to
 * your original payment method within 5-7 working days."
 */
export function describeRefundLegs(legs) {
    let toWallet = 0;
    let toGateway = 0;
    for (const leg of legs || []) {
        if (!COMMITTED.includes(leg.status)) continue;
        if (leg.refundTo === 'wallet') toWallet += toPaise(leg.amount);
        else toGateway += toPaise(leg.amount);
    }
    const parts = [];
    if (toWallet > 0) parts.push(`₹${toRupees(toWallet)} has been added back to your Minto wallet.`);
    if (toGateway > 0) {
        parts.push(`₹${toRupees(toGateway)} will be refunded to your original payment method within 5-7 working days.`);
    }
    return parts.join(' ');
}

// ----- Razorpay webhook and sweep -----

/**
 * Find the leg a Razorpay refund belongs to: by its refund id, or -- when our
 * call timed out before the id was saved -- by the leg id we put in its notes.
 */
async function findLegForGatewayRefund(refundEntity) {
    const byId = await prisma.foodOrderRefund.findUnique({ where: { gatewayRefundId: String(refundEntity.id) } });
    if (byId) return byId;
    const legId = refundEntity?.notes?.refundLegId;
    if (!legId) return null;
    const byNote = await prisma.foodOrderRefund.findUnique({ where: { id: String(legId) } });
    if (byNote && !byNote.gatewayRefundId) {
        await prisma.foodOrderRefund.update({ where: { id: byNote.id }, data: { gatewayRefundId: String(refundEntity.id) } });
    }
    return byNote;
}

/**
 * Apply a Razorpay refund entity (from a webhook or a fetch) to our records.
 * A refund made from the Razorpay dashboard has no leg; it is recorded as one
 * so what is left to refund stays right.
 *
 * @returns {Promise<string>} what happened, for the log
 */
export async function applyGatewayRefundUpdate(refundEntity) {
    const status = String(refundEntity?.status || '').toLowerCase();
    let leg = await findLegForGatewayRefund(refundEntity);

    if (!leg) {
        const order = await prisma.foodOrder.findFirst({
            where: { razorpayPaymentId: String(refundEntity.payment_id) },
            select: { id: true, userId: true },
        });
        if (!order) return 'no matching order';
        if (status === 'failed') return 'unknown refund failed; nothing recorded';
        try {
            leg = await prisma.foodOrderRefund.create({
                data: {
                    orderId: order.id,
                    userId: order.userId,
                    source: 'online',
                    refundTo: 'gateway',
                    amount: toRupees(Number(refundEntity.amount)),
                    status: status === 'processed' ? 'processed' : 'pending',
                    processedAt: status === 'processed' ? new Date() : null,
                    gatewayPaymentId: String(refundEntity.payment_id),
                    gatewayRefundId: String(refundEntity.id),
                    reason: 'Refunded from the Razorpay dashboard',
                    initiatedBy: 'admin',
                },
            });
        } catch (err) {
            // Two deliveries of the same event: the unique refund id stops the second.
            if (err?.code !== 'P2002') throw err;
            leg = await prisma.foodOrderRefund.findUnique({ where: { gatewayRefundId: String(refundEntity.id) } });
        }
        await syncOrderRefundSummary(order.id);
        return 'recorded a dashboard refund';
    }

    if (status === 'processed') {
        await markLeg(leg.id, ['pending'], { status: 'processed', processedAt: new Date(), failureReason: '' });
    } else if (status === 'failed') {
        await markLeg(leg.id, ['pending', 'processed'], {
            status: 'failed',
            failureReason: 'Razorpay reported the refund failed',
        });
    } else {
        return `refund is ${status || 'unknown'}; nothing to change`;
    }
    await syncOrderRefundSummary(leg.orderId);
    return `leg ${leg.id} is ${status}`;
}

const SWEEP_UNKNOWN_AFTER_MS = 5 * 60 * 1000;
const SWEEP_GIVE_UP_AFTER_MS = 30 * 60 * 1000;

/**
 * Finish refunds that were left pending: a wallet leg interrupted mid-way, a
 * gateway refund whose webhook never came, or a Razorpay call that timed out
 * so we never learned whether it went through. Safe to run at any time.
 */
export async function reconcilePendingRefunds() {
    const cutoff = new Date(Date.now() - SWEEP_UNKNOWN_AFTER_MS);
    const legs = await prisma.foodOrderRefund.findMany({
        where: { status: 'pending', createdAt: { lte: cutoff } },
        orderBy: { createdAt: 'asc' },
        take: 100,
    });
    const razorpay = getRazorpayInstance();
    const touched = new Set();

    for (const leg of legs) {
        try {
            if (leg.refundTo === 'wallet') {
                const order = await prisma.foodOrder.findUnique({ where: { id: leg.orderId }, select: { id: true, order_id: true } });
                await executeWalletLeg(leg, order || { id: leg.orderId });
                touched.add(leg.orderId);
                continue;
            }
            if (!razorpay || !leg.gatewayPaymentId) continue;

            if (leg.gatewayRefundId) {
                const rz = await razorpay.payments.fetchRefund(leg.gatewayPaymentId, leg.gatewayRefundId);
                await applyGatewayRefundUpdate(rz);
                continue;
            }

            // Our call's outcome was never known. Look for a refund carrying this leg's id.
            const list = await razorpay.payments.fetchMultipleRefund(leg.gatewayPaymentId, { count: 100 });
            const match = (list?.items || []).find((r) => r?.notes?.refundLegId === leg.id);
            if (match) {
                await applyGatewayRefundUpdate(match);
            } else if (Date.now() - new Date(leg.createdAt).getTime() > SWEEP_GIVE_UP_AFTER_MS) {
                // Razorpay has no refund for it, so none was made: free the amount to be retried.
                await markLeg(leg.id, ['pending'], { status: 'failed', failureReason: 'Razorpay has no record of this refund' });
                touched.add(leg.orderId);
            }
        } catch (err) {
            logger.warn(`Refund sweep: leg ${leg.id} not resolved: ${err?.error?.description || err?.message || err}`);
        }
    }

    for (const orderId of touched) await syncOrderRefundSummary(orderId).catch(() => {});
    return { checked: legs.length };
}
