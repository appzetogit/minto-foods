import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * The admin customer list, extracted from admin.service.js.
 *
 * Every row shows a lifetime order count and spend, which in Mongo meant a
 * $lookup pipeline when sorting by order count and a separate $group when not.
 * Postgres does both with one grouped query over food_orders, so the two paths
 * share it.
 */

const CUSTOMER_SELECT = {
    id: true, name: true, email: true, phone: true, countryCode: true,
    isVerified: true, isActive: true, profileImage: true,
    createdAt: true, updatedAt: true,
};

/**
 * Some profile image urls were stored wrapped in backticks by an old client.
 * Stripped on the way out rather than rewritten in place, because the raw value
 * is what that client still sends.
 */
const sanitizeUrl = (value) => String(value || '').trim().replace(/^`+|`+$/g, '').trim();

/** Delivered orders only: a cancelled order is not a customer's spend. */
const deliveredStatsFor = async (userIds) => {
    if (!userIds.length) return new Map();

    const rows = await prisma.foodOrder.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, orderStatus: 'delivered' },
        _count: { _all: true },
        _sum: { total: true },
    });

    return new Map(
        rows.map((row) => [
            row.userId,
            {
                totalOrder: row._count._all,
                // total is Decimal; the admin table sums and formats these.
                totalOrderAmount: Number(row._sum.total || 0),
            },
        ])
    );
};

const formatAddress = (a) => ({
    id: a.id,
    label: a.label,
    street: a.street,
    additionalDetails: a.additionalDetails || '',
    city: a.city,
    state: a.state,
    zipCode: a.zipCode || '',
    phone: a.phone || '',
    latitude: a.latitude,
    longitude: a.longitude,
    isDefault: a.isDefault,
    fullAddress: [a.additionalDetails, a.street, a.city, a.state, a.zipCode].filter(Boolean).join(', '),
});

/** Each customer's default address (or newest, if none is marked default). */
const defaultAddressesFor = async (userIds) => {
    if (!userIds.length) return new Map();
    const rows = await prisma.userAddress.findMany({
        where: { userId: { in: userIds } },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    const byUser = new Map();
    for (const row of rows) {
        if (!byUser.has(row.userId)) byUser.set(row.userId, formatAddress(row));
    }
    return byUser;
};

const serializeCustomer = (user, stats) => ({
    id: user.id,
    _id: user.id,
    name: user.name || 'Unnamed',
    email: user.email || '',
    phone: user.phone || '',
    profileImage: sanitizeUrl(user.profileImage),
    countryCode: user.countryCode || '+91',
    status: user.isActive !== false,
    isActive: user.isActive !== false,
    isVerified: user.isVerified === true,
    totalOrder: stats?.totalOrder || 0,
    totalOrderAmount: stats?.totalOrderAmount || 0,
    joiningDate: user.createdAt,
    createdAt: user.createdAt,
});

/**
 * The whole of one calendar day, as a Prisma range.
 *
 * The admin sends a plain `yyyy-mm-dd`, which on its own only matches the
 * instant of midnight -- so filtering on it directly returns nothing for every
 * customer who did not register at exactly 00:00:00.
 *
 * @returns {{gte: Date, lte: Date}|null} null when the input is absent or not a date
 */
export const dayWindow = (value) => {
    if (!value || !String(value).trim()) return null;
    const day = new Date(String(value));
    if (Number.isNaN(day.getTime())) return null;

    const start = new Date(day);
    start.setHours(0, 0, 0, 0);
    const end = new Date(day);
    end.setHours(23, 59, 59, 999);
    return { gte: start, lte: end };
};

export async function getCustomers(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = { role: 'USER' };

    if (String(query.status) === 'active') where.isActive = true;
    if (String(query.status) === 'inactive') where.isActive = false;

    const joinedOn = dayWindow(query.joiningDate);
    if (joinedOn) where.createdAt = joinedOn;

    // The admin panel has always shown an Order Date box; nothing here read it,
    // so picking a date changed nothing and the filter looked broken. It means
    // 'customers who placed an order that day' -- any order, not only the ones
    // that completed, since an admin looking up a date wants everyone who tried.
    const orderedOn = dayWindow(query.orderDate);
    if (orderedOn) where.orders = { some: { createdAt: orderedOn } };

    if (query.search && String(query.search).trim()) {
        const contains = { contains: String(query.search).trim().slice(0, 80), mode: 'insensitive' };
        where.OR = [{ name: contains }, { email: contains }, { phone: contains }];
    }

    const sortBy = String(query.sortBy || '').trim();
    const byOrderCount = sortBy === 'orders-asc' || sortBy === 'orders-desc';

    // Filter by how many delivered orders a customer has (e.g. 0 = never
    // ordered, 1, 2-5, 5+).
    const toCount = (value) => {
        if (value === undefined || value === null || String(value).trim() === '') return null;
        const n = parseInt(value, 10);
        return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const minOrders = toCount(query.minOrders);
    const maxOrders = toCount(query.maxOrders);
    const byOrderFilter = minOrders !== null || maxOrders !== null;

    let users;
    let total;

    if (byOrderCount || byOrderFilter) {
        // Ordering or filtering by a *filtered* relation count is beyond
        // Prisma's orderBy — its relation counts cannot be filtered to
        // delivered orders — so the page of ids is resolved in SQL. Was a
        // $lookup pipeline that loaded every matching order into the sort.
        const direction = sortBy === 'orders-asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
        const orderBySql = byOrderCount
            ? Prisma.sql`ORDER BY COUNT(o."id") ${direction}, u."createdAt" DESC`
            : Prisma.sql`ORDER BY u."createdAt" DESC`;
        const having = [
            ...(minOrders !== null ? [Prisma.sql`COUNT(o."id") >= ${minOrders}`] : []),
            ...(maxOrders !== null ? [Prisma.sql`COUNT(o."id") <= ${maxOrders}`] : []),
        ];
        const havingSql = having.length ? Prisma.sql`HAVING ${Prisma.join(having, ' AND ')}` : Prisma.empty;

        const scoped = await prisma.foodUser.findMany({ where, select: { id: true } });
        if (!scoped.length) return { customers: [], total: 0, page, limit };

        const grouped = Prisma.sql`
            SELECT u."id", u."createdAt", COUNT(o."id") AS cnt
            FROM "food_users" u
            LEFT JOIN "food_orders" o
              ON o."userId" = u."id" AND o."orderStatus" = 'delivered'
            WHERE u."id" = ANY(${scoped.map((u) => u.id)})
            GROUP BY u."id", u."createdAt"
            ${havingSql}
        `;

        total = byOrderFilter
            ? Number((await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM (${grouped}) g`)[0]?.n || 0)
            : scoped.length;
        if (!total) return { customers: [], total: 0, page, limit };

        const ordered = await prisma.$queryRaw`
            ${grouped}
            ${orderBySql}
            LIMIT ${limit} OFFSET ${skip}
        `;

        const pageIds = ordered.map((row) => row.id);
        const rows = await prisma.foodUser.findMany({
            where: { id: { in: pageIds } },
            select: CUSTOMER_SELECT,
        });
        // findMany does not preserve the id order, so the SQL ordering is
        // reapplied here rather than lost.
        const byId = new Map(rows.map((u) => [u.id, u]));
        users = pageIds.map((id) => byId.get(id)).filter(Boolean);
    } else {
        const orderBy =
            { 'name-asc': { name: 'asc' }, 'name-desc': { name: 'desc' } }[sortBy] ||
            { createdAt: 'desc' };

        [users, total] = await Promise.all([
            prisma.foodUser.findMany({ where, orderBy, skip, take: limit, select: CUSTOMER_SELECT }),
            prisma.foodUser.count({ where }),
        ]);
    }

    const [stats, addresses] = await Promise.all([
        deliveredStatsFor(users.map((u) => u.id)),
        defaultAddressesFor(users.map((u) => u.id)),
    ]);
    let customers = users.map((user) => ({
        ...serializeCustomer(user, stats.get(user.id)),
        address: addresses.get(user.id) || null,
    }));

    const chooseFirst = parseInt(query.chooseFirst, 10);
    if (Number.isFinite(chooseFirst) && chooseFirst > 0) {
        customers = customers.slice(0, chooseFirst);
    }

    return { customers, total, page, limit };
}

export async function getCustomerById(id) {
    if (!isId(id)) return null;

    const user = await prisma.foodUser.findUnique({
        where: { id: String(id) },
        select: CUSTOMER_SELECT,
    });
    if (!user) return null;

    // The detail screen has always had Addresses and Recent Orders sections;
    // the select never loaded either, so both stayed hidden.
    const [statsMap, addressRows, orderRows, placedCount] = await Promise.all([
        deliveredStatsFor([user.id]),
        prisma.userAddress.findMany({
            where: { userId: user.id },
            orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        }),
        prisma.foodOrder.findMany({
            where: { userId: user.id, orderStatus: { not: 'pending_payment' } },
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: {
                id: true, order_id: true, orderId: true, orderStatus: true, paymentMethod: true,
                paymentStatus: true, total: true, createdAt: true,
                restaurant: { select: { restaurantName: true } },
            },
        }),
        prisma.foodOrder.count({ where: { userId: user.id, orderStatus: { not: 'pending_payment' } } }),
    ]);
    const stats = statsMap.get(user.id);

    return {
        ...serializeCustomer(user, stats),
        // The detail screen reads totalOrders; the list reads totalOrder.
        totalOrders: stats?.totalOrder || 0,
        // Every order placed, delivered or not.
        totalOrdersPlaced: placedCount,
        updatedAt: user.updatedAt,
        addresses: addressRows.map(formatAddress),
        orders: orderRows.map((o) => ({
            id: o.id,
            orderId: o.order_id || o.orderId || o.id,
            restaurantName: o.restaurant?.restaurantName || '',
            total: Number(o.total) || 0,
            status: String(o.orderStatus || '').replace(/_/g, ' '),
            paymentMethod: o.paymentMethod,
            paymentStatus: o.paymentStatus,
            createdAt: o.createdAt,
        })),
    };
}

export async function updateCustomerStatus(id, isActive) {
    if (!isId(id)) return null;
    const active = Boolean(isActive);

    const updated = await prisma.$transaction(async (tx) => {
        const { count } = await tx.foodUser.updateMany({
            where: { id: String(id) },
            data: { isActive: active },
        });
        if (!count) return null;

        // Deactivating has to end the sessions too. Leaving the refresh tokens
        // alive let a blocked customer keep using the app until their token
        // expired — and the delete now shares the transaction, so a failure
        // cannot leave an account marked blocked but still signed in.
        if (!active) {
            await tx.foodRefreshToken.deleteMany({ where: { userId: String(id) } });
        }

        return tx.foodUser.findUnique({ where: { id: String(id) } });
    });

    return updated;
}
