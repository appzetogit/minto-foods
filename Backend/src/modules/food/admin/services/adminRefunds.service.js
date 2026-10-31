import { prisma } from '../../../../config/prisma.js';

/**
 * Every refund movement, for the admin's refund tracking page.
 *
 * Reads food_order_refunds: one row per leg of money returned (wallet or back
 * to the card), which is what every refund path writes -- customer and
 * restaurant cancellations, expiry, and an admin's full or partial refund. The
 * older `refunds` table is no longer written, which is why the page that read
 * it was always empty.
 *
 * Scoped to the cities the admin is viewing through the order's zone.
 */

const num = (v) => Math.round((Number(v) || 0) * 100) / 100;
const STATUSES = ['pending', 'processed', 'failed'];

const parseDay = (value, endOfDay = false) => {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    // A bare date means that whole day in IST.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        const [y, m, day] = String(value).split('-').map(Number);
        const startUtc = Date.UTC(y, m - 1, day) - 330 * 60000;
        return new Date(endOfDay ? startUtc + 864e5 - 1 : startUtc);
    }
    return d;
};

export async function listOrderRefunds(query = {}, zoneIds = null) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
    const from = parseDay(query.from);
    const to = parseDay(query.to, true);
    const search = String(query.search || '').trim().slice(0, 60);

    const base = {
        ...(Array.isArray(zoneIds) ? { order: { zoneId: { in: zoneIds } } } : {}),
        ...(query.chargedTo && ['platform', 'restaurant'].includes(query.chargedTo) ? { chargedTo: query.chargedTo } : {}),
        ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
    if (search) {
        base.AND = [{
            order: {
                OR: [
                    { order_id: { contains: search, mode: 'insensitive' } },
                    { restaurant: { restaurantName: { contains: search, mode: 'insensitive' } } },
                    { user: { phone: { contains: search } } },
                    { user: { name: { contains: search, mode: 'insensitive' } } },
                ],
            },
        }];
    }
    const where = { ...base, ...(STATUSES.includes(query.status) ? { status: query.status } : {}) };

    const [rows, total, byStatus, byCharge] = await Promise.all([
        prisma.foodOrderRefund.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            include: {
                order: {
                    select: {
                        id: true, order_id: true, total: true, paymentMethod: true, orderStatus: true,
                        restaurant: { select: { id: true, restaurantName: true } },
                        user: { select: { id: true, name: true, phone: true } },
                    },
                },
            },
        }),
        prisma.foodOrderRefund.count({ where }),
        // Totals over the whole filter (not just this page), split by status.
        prisma.foodOrderRefund.groupBy({ by: ['status'], where: base, _sum: { amount: true }, _count: { _all: true } }),
        prisma.foodOrderRefund.groupBy({
            by: ['chargedTo'],
            where: { ...base, status: { in: ['pending', 'processed'] } },
            _sum: { amount: true },
        }),
    ]);

    const statusTotal = (s) => {
        const g = byStatus.find((x) => x.status === s);
        return { count: g?._count?._all || 0, amount: num(g?._sum?.amount) };
    };
    const chargeTotal = (c) => num(byCharge.find((x) => x.chargedTo === c)?._sum?.amount);

    return {
        refunds: rows.map((r) => ({
            id: r.id,
            orderId: r.orderId,
            orderDisplayId: r.order?.order_id || r.orderId,
            orderTotal: num(r.order?.total),
            orderStatus: r.order?.orderStatus || '',
            paymentMethod: r.order?.paymentMethod || '',
            restaurantName: r.order?.restaurant?.restaurantName || '',
            customerName: r.order?.user?.name || '',
            customerPhone: r.order?.user?.phone || '',
            amount: num(r.amount),
            source: r.source,
            refundTo: r.refundTo,
            status: r.status,
            chargedTo: r.chargedTo,
            reason: r.reason || '',
            failureReason: r.failureReason || '',
            initiatedBy: r.initiatedBy,
            gatewayRefundId: r.gatewayRefundId || '',
            createdAt: r.createdAt,
            processedAt: r.processedAt,
        })),
        summary: {
            processed: statusTotal('processed'),
            pending: statusTotal('pending'),
            failed: statusTotal('failed'),
            chargedToRestaurant: chargeTotal('restaurant'),
            chargedToPlatform: chargeTotal('platform'),
        },
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
}
