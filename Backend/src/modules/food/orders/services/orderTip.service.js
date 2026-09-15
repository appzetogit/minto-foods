import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, ForbiddenError } from '../../../../core/auth/errors.js';
import { deductWalletBalance, refundWalletBalance } from '../../user/services/userWallet.service.js';
import { getTipSettings } from '../../admin/services/tip.service.js';

/**
 * Tipping a rider after the food has arrived.
 *
 * A tip at checkout rides on the order total and is paid with it. This one is
 * not: the order is already settled, and if it was cash the rider has gone. So
 * it is taken from the customer's wallet, which is already a payment method
 * here, rather than opening a second payment for a few rupees.
 *
 * Nothing is credited to a rider wallet, because rider pay is not held in one --
 * payouts are summed from the orders. Raising the order's riderEarning is what
 * actually owes them the money.
 */

/** How long after delivery a customer may still tip. */
export const TIP_WINDOW_DAYS = 7;

/**
 * May this order be tipped, and how much is left to give?
 *
 * Pure so the rules can be tested without a database, and so the app can be
 * told exactly why a tip was refused rather than "no".
 */
export const checkTipAfterDelivery = ({
    order,
    amount,
    settings = {},
    now = new Date(),
} = {}) => {
    if (!order) return { ok: false, reason: 'not-found', message: 'Order not found' };
    if (settings.tipsEnabled === false) {
        return { ok: false, reason: 'tips-off', message: 'Tipping is switched off' };
    }
    if (order.orderStatus !== 'delivered') {
        return { ok: false, reason: 'not-delivered', message: 'You can tip once the order has been delivered' };
    }

    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, reason: 'bad-amount', message: 'Enter a tip amount above 0' };
    }

    // Measured from delivery, not from when the order was placed: a long
    // scheduled order would otherwise be out of time before it even arrived.
    const deliveredAt = order.deliveredAt ? new Date(order.deliveredAt) : null;
    if (deliveredAt) {
        const days = (new Date(now).getTime() - deliveredAt.getTime()) / 86_400_000;
        if (days > TIP_WINDOW_DAYS) {
            return {
                ok: false,
                reason: 'too-late',
                message: `Orders can be tipped for ${TIP_WINDOW_DAYS} days after delivery`,
            };
        }
    }

    if (!order.dispatchDeliveryPartnerId) {
        return { ok: false, reason: 'no-rider', message: 'This order has no delivery partner to tip' };
    }

    // The ceiling is on the whole tip, so it cannot be stepped over in instalments.
    const ceiling = Number(settings.tipMaxAmount);
    if (Number.isFinite(ceiling) && ceiling > 0) {
        const already = Number(order.tipAmount) || 0;
        const remaining = Math.round((ceiling - already) * 100) / 100;
        if (remaining <= 0) {
            return { ok: false, reason: 'at-maximum', message: 'This order has already been tipped the maximum' };
        }
        if (value > remaining) {
            return {
                ok: false,
                reason: 'over-maximum',
                message: `The most you can add to this order is ₹${remaining}`,
                remaining,
            };
        }
    }

    return { ok: true, amount: Math.round(value * 100) / 100 };
};

/** Tip an order that has already been delivered, paying from the wallet. */
export const tipAfterDelivery = async ({ userId, orderId, amount }) => {
    if (!isId(orderId)) throw new ValidationError('Invalid order id');

    const order = await prisma.foodOrder.findUnique({
        where: { id: String(orderId) },
        select: {
            id: true,
            orderId: true,
            userId: true,
            orderStatus: true,
            deliveredAt: true,
            tipAmount: true,
            riderEarning: true,
            dispatchDeliveryPartnerId: true,
        },
    });

    if (!order) throw new ValidationError('Order not found');
    // Checked before anything else is said about the order: a stranger must not
    // learn its status from the error they get back.
    if (String(order.userId) !== String(userId)) {
        throw new ForbiddenError('This is not your order');
    }

    const settings = await getTipSettings();
    const verdict = checkTipAfterDelivery({ order, amount, settings });
    if (!verdict.ok) throw new ValidationError(verdict.message);

    const tip = verdict.amount;

    // Take the money first. Crediting the rider before the customer has paid
    // would owe a payout against a tip that might never be collected.
    await deductWalletBalance(userId, tip, 'Tip for delivery partner', { orderId: order.id });

    try {
        const updated = await prisma.foodOrder.update({
            where: { id: order.id },
            data: {
                tipAmount: { increment: tip },
                // Payouts are summed from the orders, so this is what actually
                // owes the rider their tip.
                riderEarning: { increment: tip },
            },
            select: { orderId: true, tipAmount: true, riderEarning: true },
        });

        return {
            orderId: updated.orderId,
            tipAdded: tip,
            tipAmount: Number(updated.tipAmount),
        };
    } catch (error) {
        // The customer has already been charged, so put it back rather than
        // leaving them paying for a tip no rider was credited with.
        await refundWalletBalance(userId, tip, 'Tip could not be applied', { orderId: order.id })
            .catch(() => {});
        throw error;
    }
};
