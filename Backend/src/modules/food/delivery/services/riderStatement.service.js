import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { riderBalance } from './riderBalance.service.js';

/**
 * A rider's money in one place, in the shape a person reads it: what came in
 * (deliveries, cancellation pay, bonuses, admin credits), what was paid out
 * (withdrawals and admin payouts, with the date and reference), and what is
 * left — week by week, and as lists.
 *
 * The rider app showed only a balance: payouts, bonuses and past weeks were
 * nowhere, so a rider could not tell what they were paid or when. Every figure
 * here is read from the same records as riderBalance, so the closing balance
 * of the latest week is the wallet's balance.
 *
 * Dates: a delivery counts on its delivery day, cancellation pay on the day
 * the order was placed (as trip history does); a payout on the day it was paid.
 */
export async function getRiderStatement(riderId, query = {}) {
    const id = String(riderId || '');
    if (!id) throw new ValidationError('Delivery partner not found');
    const weeks = Math.min(Math.max(parseInt(query.weeks, 10) || 12, 1), 52);

    const [balance, delivered, cancelled, bonuses, adjustments, withdrawals, settlements] = await Promise.all([
        riderBalance(id),
        prisma.foodOrder.findMany({
            where: { dispatchDeliveryPartnerId: id, orderStatus: 'delivered' },
            select: { riderEarning: true, deliveredAt: true, createdAt: true },
        }),
        prisma.foodOrder.findMany({
            where: { dispatchDeliveryPartnerId: id, orderStatus: { not: 'delivered' }, riderCancelPay: { gt: 0 } },
            select: { riderCancelPay: true, createdAt: true },
        }),
        prisma.deliveryBonusTransaction.findMany({
            where: { deliveryPartnerId: id },
            orderBy: { createdAt: 'desc' },
            select: { id: true, amount: true, reference: true, createdAt: true },
        }),
        prisma.transaction.findMany({
            where: {
                entityType: 'deliveryBoy', entityId: id, category: 'adjustment',
                idempotencyKey: null, status: 'completed',
            },
            orderBy: { createdAt: 'desc' },
            select: { id: true, type: true, amount: true, description: true, createdAt: true },
        }),
        prisma.foodDeliveryWithdrawal.findMany({
            where: { deliveryPartnerId: id },
            orderBy: { createdAt: 'desc' },
        }),
        prisma.settlement.findMany({
            where: { entityType: 'deliveryBoy', entityId: id },
            orderBy: { createdAt: 'desc' },
        }),
    ]);

    // Every movement as { at, kind, amount }: credits positive, payouts negative.
    const moves = [
        ...delivered.map((o) => ({ at: o.deliveredAt || o.createdAt, kind: 'delivery', amount: num(o.riderEarning) })),
        ...cancelled.map((o) => ({ at: o.createdAt, kind: 'cancelPay', amount: num(o.riderCancelPay) })),
        ...bonuses.map((b) => ({ at: b.createdAt, kind: 'bonus', amount: num(b.amount) })),
        ...adjustments.map((t) => ({
            at: t.createdAt, kind: 'adjustment', amount: t.type === 'credit' ? num(t.amount) : -num(t.amount),
        })),
        ...withdrawals.filter((w) => w.status === 'approved')
            .map((w) => ({ at: w.processedAt || w.updatedAt, kind: 'paidOut', amount: -num(w.amount) })),
        ...settlements.filter((s) => s.status === 'processed')
            .map((s) => ({ at: s.processedAt || s.updatedAt, kind: 'paidOut', amount: -num(s.amount) })),
        // A request waiting for admin is held back from the balance the day it
        // was made, as the wallet does, so the latest week ends on the
        // wallet's balance rather than above it.
        ...withdrawals.filter((w) => w.status === 'pending')
            .map((w) => ({ at: w.createdAt, kind: 'pending', amount: -num(w.amount) })),
    ];

    const thisMonday = mondayOf(new Date());
    const weekRows = [];
    for (let i = weeks - 1; i >= 0; i -= 1) {
        const start = new Date(thisMonday);
        start.setDate(start.getDate() - 7 * i);
        const end = new Date(start);
        end.setDate(end.getDate() + 7);
        const sum = (kind) => money(moves
            .filter((m) => m.kind === kind && m.at >= start && m.at < end)
            .reduce((a, m) => a + m.amount, 0));
        const opening = money(moves.filter((m) => m.at < start).reduce((a, m) => a + m.amount, 0));
        const row = {
            start: start.toISOString(),
            end: new Date(end.getTime() - 1).toISOString(),
            deliveries: delivered.filter((o) => inRange(o.deliveredAt || o.createdAt, start, end)).length,
            deliveryPay: sum('delivery'),
            cancelPay: sum('cancelPay'),
            bonus: sum('bonus'),
            adjustments: sum('adjustment'),
            paidOut: money(-sum('paidOut')),
            pending: money(-sum('pending')),
            openingBalance: opening,
        };
        row.earned = money(row.deliveryPay + row.cancelPay + row.bonus + row.adjustments);
        row.closingBalance = money(opening + row.earned - row.paidOut - row.pending);
        weekRows.push(row);
    }
    weekRows.reverse(); // newest first

    const payouts = [
        ...withdrawals.map((w) => ({
            id: w.id,
            kind: 'withdrawal',
            amount: num(w.amount),
            status: w.status === 'approved' ? 'paid' : w.status === 'pending' ? 'pending' : 'rejected',
            requestedAt: w.createdAt,
            paidAt: w.status === 'approved' ? (w.processedAt || w.updatedAt) : null,
            method: w.paymentMethod === 'upi' ? 'UPI' : 'Bank transfer',
            reference: w.transactionId || '',
            note: w.status === 'rejected' ? (w.rejectionReason || w.adminNote || '') : (w.adminNote || ''),
        })),
        ...settlements.map((s) => ({
            id: s.id,
            kind: 'payout',
            amount: num(s.amount),
            status: s.status === 'processed' ? 'paid' : s.status === 'pending' ? 'pending' : 'failed',
            requestedAt: s.createdAt,
            paidAt: s.status === 'processed' ? (s.processedAt || s.updatedAt) : null,
            method: 'Weekly payout',
            reference: s.payoutRef || '',
            periodStart: s.periodStart,
            periodEnd: s.periodEnd,
            note: s.notes || '',
        })),
    ].sort((a, b) => new Date(b.paidAt || b.requestedAt) - new Date(a.paidAt || a.requestedAt));

    const credits = [
        ...bonuses.map((b) => ({
            id: b.id, kind: 'bonus', amount: num(b.amount), at: b.createdAt, label: b.reference || 'Bonus from MintoFood',
        })),
        ...adjustments.map((t) => ({
            id: t.id,
            kind: 'adjustment',
            amount: t.type === 'credit' ? num(t.amount) : -num(t.amount),
            at: t.createdAt,
            label: t.description || (t.type === 'credit' ? 'Added by MintoFood' : 'Deducted by MintoFood'),
        })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    return {
        summary: {
            deliveryPay: balance.deliveryEarned,
            cancelPay: balance.cancelPay,
            bonus: balance.bonus,
            adjustments: balance.adjustments,
            totalEarned: balance.totalEarned,
            paidOut: balance.paidOut,
            pending: balance.pending,
            available: balance.available,
        },
        weeks: weekRows,
        payouts,
        credits,
    };
}

function mondayOf(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
}

const inRange = (at, start, end) => at >= start && at < end;
const num = (v) => Number(v) || 0;
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
