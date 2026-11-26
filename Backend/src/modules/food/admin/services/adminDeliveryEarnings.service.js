import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * What every rider earned, order by order.
 *
 * `riderEarning` is what the split actually credited. Orders written before it
 * was recorded fall back to the delivery fee, which is what the rider would
 * have been paid. (A `deliveryPartnerSettlement` fallback sat between the two
 * in the Mongo version; no such field exists on any schema, so it is gone.)
 */

const num = (value) => Number(value) || 0;
const round2 = (value) => Math.round(num(value) * 100) / 100;

/**
 * Bonuses credited to riders -- earning add-ons and admin bonuses alike, since
 * both write a DeliveryBonusTransaction when the money moves -- and one row
 * per rider: delivery pay, cancellation pay, bonuses, total. Dated by when they
 * were credited, as the rider app and the balance sheet date them.
 *
 * A pending earning add-on (target met, not yet credited by an admin) is not
 * money yet and is not counted.
 */
async function getBonusesAndRiderSummary(query, orderWhere, createdAt) {
    const bonusWhere = {};
    if (createdAt) bonusWhere.createdAt = createdAt;
    if (isId(query.deliveryPartnerId)) bonusWhere.deliveryPartnerId = String(query.deliveryPartnerId);
    const search = String(query.search || '').trim();
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        bonusWhere.OR = [
            { reference: contains },
            { transactionId: contains },
            { deliveryPartner: { OR: [{ name: contains }, { phone: contains }] } },
        ];
    }

    const [bonusRows, delivered, cancelled] = await Promise.all([
        prisma.deliveryBonusTransaction.findMany({
            where: bonusWhere,
            orderBy: { createdAt: 'desc' },
            take: 500,
            select: {
                id: true, transactionId: true, amount: true, reference: true, createdAt: true,
                deliveryPartner: { select: { id: true, name: true, phone: true } },
            },
        }),
        prisma.foodOrder.groupBy({
            by: ['dispatchDeliveryPartnerId'],
            where: { ...orderWhere, orderStatus: 'delivered' },
            _sum: { riderEarning: true, deliveryFee: true },
            _count: { _all: true },
        }),
        prisma.foodOrder.groupBy({
            by: ['dispatchDeliveryPartnerId'],
            where: { ...orderWhere, riderCancelPay: { gt: 0 } },
            _sum: { riderCancelPay: true },
        }),
    ]);

    // Same per-order fallback as the list, per rider: an order with no
    // recorded earning counts at its delivery fee.
    const fallbackRows = delivered.length
        ? await prisma.foodOrder.groupBy({
            by: ['dispatchDeliveryPartnerId'],
            where: { ...orderWhere, orderStatus: 'delivered', riderEarning: { lte: 0 } },
            _sum: { deliveryFee: true },
        })
        : [];
    const recordedRows = delivered.length
        ? await prisma.foodOrder.groupBy({
            by: ['dispatchDeliveryPartnerId'],
            where: { ...orderWhere, orderStatus: 'delivered', riderEarning: { gt: 0 } },
            _sum: { riderEarning: true },
        })
        : [];

    const bonusTotal = round2(bonusRows.reduce((sum, b) => sum + num(b.amount), 0));
    const bonuses = bonusRows.map((b) => {
        const isAddon = String(b.transactionId).startsWith('ADDON-')
            || String(b.reference).startsWith('Earning Addon');
        return {
            id: b.id,
            transactionId: b.transactionId,
            deliveryPartnerId: b.deliveryPartner?.id || null,
            deliveryPartnerName: b.deliveryPartner?.name || 'N/A',
            deliveryPartnerPhone: b.deliveryPartner?.phone || '',
            type: isAddon ? 'earning_addon' : 'admin_bonus',
            title: String(b.reference || '').replace(/^Earning Addon:\s*/, '') || (isAddon ? 'Earning Addon' : 'Bonus'),
            amount: round2(b.amount),
            creditedAt: b.createdAt,
        };
    });

    const riders = new Map();
    const at = (id) => {
        if (!riders.has(id)) {
            riders.set(id, { deliveryPartnerId: id, deliveries: 0, deliveryEarnings: 0, cancelPay: 0, bonuses: 0, bonusCount: 0 });
        }
        return riders.get(id);
    };
    for (const g of delivered) if (g.dispatchDeliveryPartnerId) at(g.dispatchDeliveryPartnerId).deliveries = g._count._all;
    for (const g of recordedRows) if (g.dispatchDeliveryPartnerId) at(g.dispatchDeliveryPartnerId).deliveryEarnings += num(g._sum.riderEarning);
    for (const g of fallbackRows) if (g.dispatchDeliveryPartnerId) at(g.dispatchDeliveryPartnerId).deliveryEarnings += num(g._sum.deliveryFee);
    for (const g of cancelled) if (g.dispatchDeliveryPartnerId) at(g.dispatchDeliveryPartnerId).cancelPay += num(g._sum.riderCancelPay);
    for (const b of bonuses) {
        if (!b.deliveryPartnerId) continue;
        const r = at(b.deliveryPartnerId);
        r.bonuses += b.amount;
        r.bonusCount += 1;
    }

    const ids = [...riders.keys()];
    const names = ids.length
        ? await prisma.foodDeliveryPartner.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } })
        : [];
    const nameById = new Map(names.map((p) => [p.id, p]));

    const riderSummary = [...riders.values()]
        .map((r) => {
            const deliveryEarnings = round2(r.deliveryEarnings);
            const cancelPay = round2(r.cancelPay);
            const bonusAmount = round2(r.bonuses);
            return {
                ...r,
                deliveryPartnerName: nameById.get(r.deliveryPartnerId)?.name || 'N/A',
                deliveryPartnerPhone: nameById.get(r.deliveryPartnerId)?.phone || '',
                deliveryEarnings,
                cancelPay,
                bonuses: bonusAmount,
                totalEarnings: round2(deliveryEarnings + cancelPay + bonusAmount),
            };
        })
        .sort((a, b) => b.totalEarnings - a.totalEarnings);

    return { bonusTotal, bonuses, riderSummary };
}

/** An explicit date range, or one of the period shortcuts. */
function buildDateRange(query = {}) {
    const range = {};

    if (query.fromDate) {
        const from = new Date(query.fromDate);
        if (!Number.isNaN(from.getTime())) {
            from.setHours(0, 0, 0, 0);
            range.gte = from;
        }
    }
    if (query.toDate) {
        const to = new Date(query.toDate);
        if (!Number.isNaN(to.getTime())) {
            to.setHours(23, 59, 59, 999);
            range.lte = to;
        }
    }
    if (range.gte || range.lte) return range;

    const now = new Date();
    const period = String(query.period || 'all').trim().toLowerCase();

    if (period === 'today') {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        const end = new Date(now);
        end.setHours(23, 59, 59, 999);
        return { gte: start, lte: end };
    }
    if (period === 'week') {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday, as payouts
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        end.setHours(23, 59, 59, 999);
        return { gte: start, lte: end };
    }
    if (period === 'month') {
        return {
            gte: new Date(now.getFullYear(), now.getMonth(), 1),
            lte: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
        };
    }

    return null;
}

export async function getDeliveryEarnings(query = {}) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.max(1, Math.min(1000, parseInt(query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    // Only dispatched orders have a rider to pay, and only the ones that paid:
    // delivered, or cancelled with cancellation pay. Every cancelled order the
    // rider had been on used to be listed too, reading as an earning at ₹0.
    const where = {
        dispatchDeliveryPartnerId: { not: null },
        AND: [{ OR: [{ orderStatus: 'delivered' }, { riderCancelPay: { gt: 0 } }] }],
    };

    const createdAt = buildDateRange(query);
    if (createdAt) where.createdAt = createdAt;

    if (isId(query.deliveryPartnerId)) {
        where.dispatchDeliveryPartnerId = String(query.deliveryPartnerId);
    }

    const search = String(query.search || '').trim();
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        // Reached through the relations rather than pre-resolving id lists.
        where.OR = [
            { orderId: contains },
            { deliveryPartner: { OR: [{ name: contains }, { phone: contains }, { email: contains }] } },
            { restaurant: { restaurantName: contains } },
        ];
    }

    const [orders, total, totals, partners] = await Promise.all([
        prisma.foodOrder.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            select: {
                id: true, orderId: true, orderStatus: true, createdAt: true,
                riderEarning: true, deliveryFee: true, total: true,
                riderCancelPay: true, riderCancelPayReason: true,
                deliveryPartner: { select: { id: true, name: true, phone: true } },
                restaurant: { select: { restaurantName: true } },
            },
        }),
        prisma.foodOrder.count({ where }),
        // Split in two so the per-order fallback is applied exactly: summing
        // both columns over all rows would double-count an order that has a
        // recorded earning, and applying the fallback to the totals would be
        // wrong for any page mixing the two.
        // Only what was earned: delivered orders, and the cancellation pay of
        // cancelled ones. Every order the rider was on used to count, a
        // cancelled one at its full trip pay.
        Promise.all([
            prisma.foodOrder.aggregate({
                where: { ...where, orderStatus: 'delivered', riderEarning: { gt: 0 } },
                _sum: { riderEarning: true },
            }),
            prisma.foodOrder.aggregate({
                where: { ...where, orderStatus: 'delivered', riderEarning: { lte: 0 } },
                _sum: { deliveryFee: true },
            }),
            prisma.foodOrder.aggregate({
                where: { ...where, riderCancelPay: { gt: 0 } },
                _sum: { riderCancelPay: true },
            }),
        ]),
        // GROUP BY in the database: Prisma's distinct loads every order.
        prisma.foodOrder.groupBy({ by: ['dispatchDeliveryPartnerId'], where }),
    ]);

    const earnings = orders.map((order) => ({
        transactionId: order.id,
        orderId: order.orderId || 'N/A',
        deliveryPartnerId: order.deliveryPartner?.id || null,
        deliveryPartnerName: order.deliveryPartner?.name || 'N/A',
        deliveryPartnerPhone: order.deliveryPartner?.phone || 'N/A',
        restaurantName: order.restaurant?.restaurantName || 'N/A',
        amount: order.orderStatus === 'delivered'
            ? num(order.riderEarning) || num(order.deliveryFee)
            : String(order.orderStatus).startsWith('cancelled')
                ? num(order.riderCancelPay)
                : 0,
        // Not delivered yet: what it will pay, shown apart from the earned amount.
        expectedAmount: num(order.riderEarning) || num(order.deliveryFee),
        cancelPayReason: order.riderCancelPayReason || null,
        orderTotal: num(order.total),
        deliveryFee: num(order.deliveryFee),
        orderStatus: order.orderStatus || 'N/A',
        createdAt: order.createdAt,
    }));

    const deliveryTotal = round2(num(totals[0]._sum.riderEarning) + num(totals[1]._sum.deliveryFee));
    const cancelPayTotal = round2(num(totals[2]._sum.riderCancelPay));
    const extras = await getBonusesAndRiderSummary(query, where, createdAt);

    return {
        earnings,
        summary: {
            totalDeliveryPartners: partners.filter((p) => p.dispatchDeliveryPartnerId).length,
            // Delivery pay (tips included) and cancellation pay, as before.
            deliveryEarnings: deliveryTotal,
            cancelPay: cancelPayTotal,
            // Earning add-ons and admin bonuses credited in the period. They
            // were missing here, so a rider with three credited bonuses
            // showed none of them on this page.
            totalBonuses: extras.bonusTotal,
            totalEarnings: round2(deliveryTotal + cancelPayTotal + extras.bonusTotal),
            totalOrders: total,
        },
        bonuses: extras.bonuses,
        riderSummary: extras.riderSummary,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit) || 1,
        },
    };
}
