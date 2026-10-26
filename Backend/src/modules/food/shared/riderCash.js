import { prisma } from '../../../config/prisma.js';

/**
 * The cash a rider is holding for us, and whether it has hit the admin's limit.
 *
 * One definition: cash collected on delivered COD orders, minus every completed
 * deposit (online through Razorpay, or paid at the office and recorded by an
 * admin). It used to be worked out four different ways, and the one dispatch
 * read -- wallet.cashInHand -- never went up when a rider collected cash, so
 * the limit never stopped anyone.
 *
 * At or over the limit a rider gets no orders at all and cannot go online
 * until they deposit enough to drop below it.
 */

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

/** The admin's limit in rupees; 0 means no limit. */
export async function loadRiderCashLimit() {
    const doc = await prisma.foodDeliveryCashLimit.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
        select: { deliveryCashLimit: true },
    });
    return Math.max(0, num(doc?.deliveryCashLimit));
}

/** Cash in hand per rider id, for many riders in two queries. */
export async function cashInHandByPartner(partnerIds) {
    const ids = [...new Set((partnerIds || []).map(String))];
    if (!ids.length) return new Map();
    const [collected, deposited] = await Promise.all([
        prisma.foodOrder.groupBy({
            by: ['dispatchDeliveryPartnerId'],
            where: {
                dispatchDeliveryPartnerId: { in: ids },
                orderStatus: 'delivered',
                paymentMethod: 'cash',
            },
            _sum: { total: true },
        }),
        prisma.foodDeliveryCashDeposit.groupBy({
            by: ['deliveryPartnerId'],
            where: { deliveryPartnerId: { in: ids }, status: 'Completed' },
            _sum: { amount: true },
        }),
    ]);
    const paid = new Map(deposited.map((d) => [String(d.deliveryPartnerId), num(d._sum?.amount)]));
    const out = new Map(ids.map((id) => [id, 0]));
    for (const c of collected) {
        const id = String(c.dispatchDeliveryPartnerId);
        out.set(id, roundRupees(Math.max(0, num(c._sum?.total) - (paid.get(id) || 0))));
    }
    return out;
}

const roundRupees = (v) => Math.round(v * 100) / 100;

/** Pure: the rider's position against the limit. */
export function cashStatus(cashInHand, limit) {
    const blocked = limit > 0 && cashInHand >= limit;
    return {
        cashInHand,
        limit,
        blocked,
        // What brings them back under the limit; depositing all of it is fine too.
        minimumDeposit: blocked ? roundRupees(cashInHand - limit + 1) : 0,
        remaining: limit > 0 ? roundRupees(Math.max(0, limit - cashInHand)) : null,
    };
}

/** One rider's cash status. */
export async function riderCashStatus(partnerId) {
    const [limit, byId] = await Promise.all([loadRiderCashLimit(), cashInHandByPartner([partnerId])]);
    return cashStatus(byId.get(String(partnerId)) || 0, limit);
}

/** Riders among [partnerIds] who are at or over the limit. */
export async function cashBlockedPartnerIds(partnerIds) {
    const limit = await loadRiderCashLimit();
    if (limit <= 0) return new Set();
    const byId = await cashInHandByPartner(partnerIds);
    return new Set([...byId].filter(([, cash]) => cash >= limit).map(([id]) => id));
}

/** The error a blocked rider gets when trying to go online or take an order. */
export function cashLimitMessage(status) {
    return `You are holding ₹${status.cashInHand} in cash, over your ₹${status.limit} limit. ` +
        `Deposit at least ₹${status.minimumDeposit} online, or pay at the office, to start getting orders again.`;
}
