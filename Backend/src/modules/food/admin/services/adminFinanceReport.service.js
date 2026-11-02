import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * The two money reports the admin panel exports: every transaction, and a
 * per-restaurant roll-up.
 *
 * Both are scoped to orders that represent real money — a customer who
 * abandoned checkout must not appear in either.
 */

/**
 * Orders that count. The Mongo filter also listed the payment statuses
 * 'captured' and 'settled', which belong to the transaction's own lifecycle
 * and were never order statuses, so they matched nothing.
 */
const REAL_ORDER_SQL = {
    OR: [
        { paymentMethod: { in: ['cash', 'wallet'] } },
        { paymentStatus: { in: ['paid', 'authorized', 'refunded'] } },
    ],
};

const num = (value) => Number(value) || 0;
const formatCurrency = (value) => `₹${num(value).toFixed(2)}`;

/** A zone named by id, or by either of its two name columns. */
async function resolveZoneId(zoneRaw) {
    const value = String(zoneRaw || '').trim();
    if (!value) return undefined;
    if (isId(value)) return value;

    const zone = await prisma.foodZone.findFirst({
        where: { OR: [{ name: value }, { zoneName: value }] },
        select: { id: true },
    });
    return zone?.id ?? null; // null = named a zone that does not exist
}

/** A date filter from the query, ignoring anything that is not a date. */
const validDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
};

const CANCELLED_STATUSES = ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'];

/** What a row reads as in the report, in words rather than ledger states. */
const transactionStatusLabel = (tx) => {
    const paid = num(tx.totalCustomerPaid);
    const refunded = num(tx.order?.refundAmount);
    if (refunded > 0) return paid > 0 && refunded < paid ? 'Partly refunded' : 'Refunded';
    if (tx.status === 'refunded') return 'Refunded';
    if (CANCELLED_STATUSES.includes(tx.order?.orderStatus)) return 'Cancelled';
    if (tx.status === 'captured' || tx.order?.orderStatus === 'delivered') return 'Completed';
    return 'In progress';
};

export async function getTransactionReport(query = {}) {
    const { fromDate, toDate, zone, restaurant, search } = query;
    const where = {};

    // Either end alone is a filter too; a custom range with one date was ignored.
    const from = validDate(fromDate);
    const to = validDate(toDate);
    if (from || to) {
        where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    }

    if (search && String(search).trim()) {
        // The readable id lives on the order, not the transaction. The Mongo
        // version also looked for `orderReadableId` on the transaction, which
        // is not a field there, so that half of the search never matched.
        const term = String(search).trim();
        where.order = {
            OR: [
                { orderId: { contains: term, mode: 'insensitive' } },
                { order_id: { contains: term, mode: 'insensitive' } },
            ],
        };
    }

    if (zone || restaurant) {
        const restaurantWhere = {};
        let impossible = false;

        if (zone) {
            const zoneId = await resolveZoneId(zone);
            if (zoneId === null) impossible = true;
            else if (zoneId) restaurantWhere.zoneId = zoneId;
        }

        if (!impossible && restaurant && restaurant !== 'All restaurants') {
            const value = String(restaurant).trim();
            if (value) {
                const match = isId(value)
                    ? await prisma.foodRestaurant.findUnique({ where: { id: value }, select: { id: true } })
                    : await prisma.foodRestaurant.findFirst({
                        where: { restaurantName: value },
                        select: { id: true },
                    });
                if (match) restaurantWhere.id = match.id;
                else impossible = true;
            }
        }

        // A filter that names something that does not exist returns nothing,
        // rather than quietly returning everything.
        if (impossible) where.restaurantId = { in: [] };
        else if (Object.keys(restaurantWhere).length) {
            // The order's own zone as well: a restaurant with no zone set still
            // has orders in one.
            const { zoneId, ...rest } = restaurantWhere;
            if (Object.keys(rest).length) where.restaurant = rest;
            if (zoneId) {
                where.AND = [{ OR: [{ restaurant: { zoneId } }, { order: { zoneId } }] }];
            }
        }
    }

    // A page, not the table. This used to fetch and return every transaction
    // ever recorded — the response grew without bound and the summing below ran
    // over all of it in Node.
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500);

    // Which rows count as money in, and which as money back out. Expressed once
    // so the summary and any later filter cannot drift apart.
    const COMPLETED = {
        OR: [
            // 'settled' was in this list too, but it is not a FoodTxnStatus —
            // settleRestaurant() writes 'captured' and records the settlement
            // as a history entry, so the extra value matched nothing in Mongo
            // and throws outright here.
            { status: 'captured' },
            { order: { orderStatus: 'delivered' } },
        ],
    };
    // Money actually sent back. This used to count every admin-cancelled order
    // at full value, cash orders nobody had paid for included.
    const REFUNDED = {
        OR: [
            { status: 'refunded' },
            { order: { refundAmount: { gt: 0 } } },
        ],
    };
    const NOT_REFUNDED = { NOT: REFUNDED };
    const CANCELLED = { AND: [{ order: { orderStatus: { in: CANCELLED_STATUSES } } }, NOT_REFUNDED] };
    const VIEWS = {
        // Exactly what the Completed and earning cards add up, so tapping one lists
        // what it counts. A delivered order partly refunded is in both lists.
        completed: COMPLETED,
        refunded: REFUNDED,
        cancelled: CANCELLED,
        in_progress: {
            AND: [{ NOT: COMPLETED }, NOT_REFUNDED, { order: { orderStatus: { notIn: CANCELLED_STATUSES } } }],
        },
    };
    // The list narrows to the status picked; the cards above it keep the totals
    // for the other filters, so the numbers do not vanish on tapping one.
    const view = VIEWS[String(query.view || '').trim()] || null;
    const rowsWhere = view ? { AND: [where, view] } : where;

    const [transactionRows, total, completed, refunded, legacyRefunded] = await Promise.all([
        prisma.foodTransaction.findMany({
            where: rowsWhere,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            include: {
                order: { select: { orderId: true, order_id: true, orderStatus: true, refundAmount: true } },
                restaurant: { select: { restaurantName: true } },
            },
        }),
        prisma.foodTransaction.count({ where: rowsWhere }),
        // Summed by the database over the whole filter, not over the page.
        prisma.foodTransaction.aggregate({
            where: { AND: [where, COMPLETED] },
            _sum: {
                totalCustomerPaid: true, platformNetProfit: true,
                restaurantShare: true, riderShare: true,
            },
            _count: { _all: true },
        }),
        // What was refunded, per order, partial refunds at their real amount.
        prisma.foodOrder.aggregate({
            where: { refundAmount: { gt: 0 }, foodTransaction: { is: where } },
            _sum: { refundAmount: true },
            _count: { _all: true },
        }),
        // Refunded before refund amounts were recorded on the order.
        prisma.foodTransaction.aggregate({
            where: { AND: [where, { status: 'refunded' }, { NOT: { order: { refundAmount: { gt: 0 } } } }] },
            _sum: { totalCustomerPaid: true },
            _count: { _all: true },
        }),
    ]);

    // The user is not a relation on the transaction, so the names come from one
    // extra query rather than one per row.
    const users = transactionRows.length
        ? await prisma.foodUser.findMany({
            where: { id: { in: [...new Set(transactionRows.map((tx) => tx.userId))] } },
            select: { id: true, name: true },
        })
        : [];
    const nameByUserId = new Map(users.map((u) => [u.id, u.name]));

    const transactions = transactionRows.map((tx) => {
        const subtotal = num(tx.subtotal);
        const packagingFee = num(tx.packagingFee);
        const deliveryFee = num(tx.deliveryFee);
        const tax = num(tx.tax);
        const discount = num(tx.discount);
        const total = num(tx.total);

        // The column is non-nullable and defaults to 0, so an order written
        // before the fee was recorded is indistinguishable from a genuinely
        // free one. Both are handled by the pricing equation:
        //   total = subtotal + packaging + delivery + platformFee + tax − discount
        // which returns 0 when the fee really was zero, and the missing amount
        // when the totals do not add up without one.
        const platformFee = num(tx.platformFee)
            || Math.max(0, total - subtotal - packagingFee - deliveryFee - tax + discount);

        return {
            id: tx.id,
            orderId: tx.order?.orderId || tx.order?.order_id || 'N/A',
            orderStatus: tx.order?.orderStatus || '',
            statusLabel: transactionStatusLabel(tx),
            refundAmount: num(tx.order?.refundAmount),
            adminEarning: num(tx.platformNetProfit),
            restaurantEarning: num(tx.restaurantShare),
            deliverymanEarning: num(tx.riderShare),
            restaurant: tx.restaurant?.restaurantName || 'N/A',
            customerName: nameByUserId.get(tx.userId) || 'Guest',
            totalItemAmount: subtotal,
            itemDiscount: discount,
            couponDiscount: discount,
            adminDiscountShare: num(tx.adminDiscountShare),
            restaurantDiscountShare: num(tx.restaurantDiscountShare),
            referralDiscount: 0, // Placeholder
            discountedAmount: Math.max(0, subtotal - discount),
            vatTax: num(tx.taxAmount) || tax,
            deliveryCharge: deliveryFee,
            platformFee,
            orderAmount: num(tx.totalCustomerPaid) || total,
            status: tx.status,
        };
    });

    const summary = {
        completedTransaction: num(completed._sum.totalCustomerPaid),
        refundedTransaction: num(refunded._sum.refundAmount) + num(legacyRefunded._sum.totalCustomerPaid),
        completedCount: completed._count._all,
        refundedCount: refunded._count._all + legacyRefunded._count._all,
        adminEarning: num(completed._sum.platformNetProfit),
        restaurantEarning: num(completed._sum.restaurantShare),
        deliverymanEarning: num(completed._sum.riderShare),
    };

    return {
        transactions,
        summary,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    };
}

/** The labelled ranges the report's dropdown offers. */
const parseTimeRange = (timeLabel) => {
    const value = String(timeLabel || '').trim().toLowerCase();
    if (!value || value === 'all time') return null;

    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    if (value === 'today') {
        start.setHours(0, 0, 0, 0);
    } else if (value === 'this week') {
        // Weeks start on Monday here, unlike the dashboard's Sunday.
        const day = start.getDay();
        start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
        start.setHours(0, 0, 0, 0);
    } else if (value === 'this month') {
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
    } else if (value === 'this year') {
        start.setMonth(0, 1);
        start.setHours(0, 0, 0, 0);
    } else {
        return null;
    }

    return { gte: start, lte: end };
};

export async function getRestaurantReport(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 1000, 1), 5000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const empty = { restaurants: [], total: 0, page, limit };
    const where = {};

    const allFilter = String(query.all || '').trim().toLowerCase();
    if (allFilter === 'active') where.status = 'approved';
    else if (allFilter === 'inactive') where.status = { not: 'approved' };

    if (String(query.zone || '').trim()) {
        const zoneId = await resolveZoneId(query.zone);
        if (zoneId === null) return empty;
        where.zoneId = zoneId;
    }

    if (String(query.type || '').trim().toLowerCase() === 'commission') {
        const rows = await prisma.foodRestaurantCommission.findMany({
            where: { status: true },
            select: { restaurantId: true },
        });
        if (!rows.length) return empty;
        where.id = { in: rows.map((row) => row.restaurantId).filter(Boolean) };
    }

    const search = String(query.search || '').trim();
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        where.OR = [
            { restaurantName: contains },
            { ownerName: contains },
            { ownerPhone: contains },
            { city: contains },
            { area: contains },
        ];
    }

    const [restaurants, total] = await Promise.all([
        prisma.foodRestaurant.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            select: {
                id: true, restaurantName: true, profileImage: true,
                rating: true, totalRatings: true, status: true,
                zone: { select: { name: true, zoneName: true } },
            },
        }),
        prisma.foodRestaurant.count({ where }),
    ]);

    if (!restaurants.length) return { ...empty, total };

    const restaurantIds = restaurants.map((r) => r.id);

    // An explicit date range wins over the labelled dropdown.
    const createdAt = (() => {
        if (query.fromDate || query.toDate) {
            const range = {};
            if (query.fromDate) range.gte = new Date(query.fromDate);
            if (query.toDate) range.lte = new Date(query.toDate);
            return Object.keys(range).length ? range : null;
        }
        return parseTimeRange(query.time);
    })();

    const orderWhere = { restaurantId: { in: restaurantIds }, ...REAL_ORDER_SQL };
    if (createdAt) orderWhere.createdAt = createdAt;

    const [foodCounts, orderTotals] = await Promise.all([
        prisma.foodItem.groupBy({
            by: ['restaurantId'],
            where: { restaurantId: { in: restaurantIds }, approvalStatus: 'approved' },
            _count: { _all: true },
        }),
        prisma.foodOrder.groupBy({
            by: ['restaurantId'],
            where: orderWhere,
            _count: { _all: true },
            _sum: { total: true, discount: true, tax: true, platformProfit: true, platformFee: true },
        }),
    ]);

    const foodByRestaurant = new Map(foodCounts.map((row) => [row.restaurantId, row._count._all]));
    const ordersByRestaurant = new Map(orderTotals.map((row) => [row.restaurantId, {
        totalOrder: row._count._all,
        totalOrderAmount: num(row._sum.total),
        totalDiscountGiven: num(row._sum.discount),
        totalVATTAX: num(row._sum.tax),
        // The recorded profit where there is one; the flat fee is the fallback
        // for orders written before the split was stored.
        totalAdminCommission: num(row._sum.platformProfit) > 0
            ? num(row._sum.platformProfit)
            : num(row._sum.platformFee),
    }]));

    return {
        restaurants: restaurants.map((restaurant, index) => {
            const counts = ordersByRestaurant.get(restaurant.id) || {
                totalOrder: 0, totalOrderAmount: 0, totalDiscountGiven: 0,
                totalVATTAX: 0, totalAdminCommission: 0,
            };

            return {
                _id: restaurant.id,
                sl: skip + index + 1,
                icon: restaurant.profileImage || '',
                restaurantName: restaurant.restaurantName || '',
                totalFood: foodByRestaurant.get(restaurant.id) || 0,
                totalOrder: counts.totalOrder,
                totalOrderAmount: formatCurrency(counts.totalOrderAmount),
                totalDiscountGiven: formatCurrency(counts.totalDiscountGiven),
                totalAdminCommission: formatCurrency(counts.totalAdminCommission),
                totalVATTAX: formatCurrency(counts.totalVATTAX),
                averageRatings: num(restaurant.rating),
                reviews: num(restaurant.totalRatings),
                status: restaurant.status || 'pending',
                zoneName: restaurant.zone?.name || restaurant.zone?.zoneName || '',
            };
        }),
        total,
        page,
        limit,
    };
}
