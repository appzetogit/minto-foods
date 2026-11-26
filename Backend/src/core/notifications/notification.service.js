import { prisma } from '../../config/prisma.js';
import { isId } from '../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../auth/errors.js';

const normalizePagination = ({ page = 1, limit = 20 } = {}) => {
    const nextPage = Math.max(1, Number(page) || 1);
    const nextLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return { page: nextPage, limit: nextLimit, skip: (nextPage - 1) * nextLimit };
};

const normalizeOwnerType = (role) => {
    const normalized = String(role || '').trim().toUpperCase();
    if (normalized === 'USER') return 'USER';
    if (normalized === 'RESTAURANT') return 'RESTAURANT';
    if (normalized === 'DELIVERY_PARTNER') return 'DELIVERY_PARTNER';
    return null;
};

const requireId = (value, fieldName) => {
    if (!isId(value)) throw new ValidationError(`${fieldName} is invalid`);
    return String(value);
};

export const resolveNotificationOwnerFromRequest = (user = {}) => {
    const ownerType = normalizeOwnerType(user?.role);
    const ownerId = user?.userId || user?._id || user?.id || null;

    if (!ownerType || !ownerId) {
        throw new ValidationError('Authenticated notification owner not found');
    }

    return { ownerType, ownerId: requireId(ownerId, 'ownerId') };
};

/**
 * Fan a broadcast out into per-recipient inbox rows.
 *
 * Two shapes of "already sent", which is why this is not one upsert:
 *
 *  - With a broadcastId, (broadcastId, ownerType, ownerId) is unique, so the
 *    fan-out is genuinely idempotent — re-running a broadcast cannot double-post.
 *  - Without one, there is no constraint to upsert on, so a matching row is
 *    refreshed and only a miss inserts. That mirrors the old bulkWrite filter,
 *    and it is inherently racy; a broadcastId is the reliable path.
 */
export const createInboxNotifications = async ({ notifications = [] } = {}) => {
    const rows = Array.isArray(notifications)
        ? notifications.filter((item) => item?.ownerType && item?.ownerId && item?.title && item?.message)
        : [];

    if (!rows.length) return [];

    const broadcastIds = new Set();

    for (const item of rows) {
        const data = {
            ownerType: item.ownerType,
            ownerId: requireId(item.ownerId, 'ownerId'),
            title: String(item.title).trim(),
            message: String(item.message).trim(),
            link: String(item.link || '').trim(),
            category: String(item.category || 'broadcast').trim(),
            source: 'ADMIN_BROADCAST',
            metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
            // Re-sending resurfaces a notification the recipient had dismissed.
            dismissedAt: null,
        };

        const broadcastId = isId(item.broadcastId) ? String(item.broadcastId) : null;

        if (broadcastId) {
            broadcastIds.add(broadcastId);
            await prisma.foodNotification.upsert({
                where: {
                    broadcastId_ownerType_ownerId: {
                        broadcastId,
                        ownerType: data.ownerType,
                        ownerId: data.ownerId,
                    },
                },
                create: { ...data, broadcastId, isRead: false, readAt: null },
                update: data,
            });
            continue;
        }

        const { count } = await prisma.foodNotification.updateMany({
            where: {
                ownerType: data.ownerType,
                ownerId: data.ownerId,
                title: data.title,
                message: data.message,
                source: data.source,
            },
            data,
        });
        if (count === 0) {
            await prisma.foodNotification.create({ data: { ...data, isRead: false, readAt: null } });
        }
    }

    if (broadcastIds.size === 0) return [];

    return prisma.foodNotification.findMany({
        where: { broadcastId: { in: [...broadcastIds] } },
        orderBy: { createdAt: 'desc' },
    });
};

/**
 * Links of this owner's restaurant notifications ("/restaurant-detail/<id>")
 * whose restaurant's zone does not cover the point: an Indore restaurant's
 * offer means nothing to a customer ordering in Bhiwandi. A restaurant with no
 * zone, or a zone with no drawn boundary, limits nothing.
 */
export const outOfZoneLinks = async ({ ownerType, ownerId, lat, lng }) => {
    const la = Number(lat);
    const ln = Number(lng);
    if (lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(ln)) return [];
    const rows = await prisma.$queryRaw`
        SELECT DISTINCT n."link"
        FROM "food_notifications" n
        JOIN "food_restaurants" r ON r."id" = substring(n."link" from '^/restaurant-detail/([0-9a-f]{24})')
        JOIN "food_zones" z ON z."id" = r."zoneId" AND z."isActive" = true AND z."boundary" IS NOT NULL
        WHERE n."ownerType"::text = ${ownerType} AND n."ownerId" = ${ownerId}
          AND n."dismissedAt" IS NULL
          AND n."link" LIKE '/restaurant-detail/%'
          AND NOT ST_Contains(z."boundary"::geometry, ST_SetSRID(ST_MakePoint(${ln}, ${la}), 4326))
    `;
    return rows.map((r) => r.link);
};

export const getInboxNotifications = async ({ ownerType, ownerId, page = 1, limit = 20, lat, lng } = {}) => {
    const where = {
        ownerType: normalizeOwnerType(ownerType),
        ownerId: requireId(ownerId, 'ownerId'),
        dismissedAt: null,
    };
    const hidden = await outOfZoneLinks({ ...where, lat, lng });
    if (hidden.length) where.link = { notIn: hidden };
    const { skip, ...meta } = normalizePagination({ page, limit });

    const [items, total, unreadCount] = await Promise.all([
        prisma.foodNotification.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: meta.limit,
        }),
        prisma.foodNotification.count({ where }),
        prisma.foodNotification.count({ where: { ...where, isRead: false } }),
    ]);

    return {
        // A broadcast's picture, at the top level as well as in metadata.
        items: items.map((item) => ({ ...item, imageUrl: String(item?.metadata?.imageUrl || '') })),
        pagination: {
            page: meta.page,
            limit: meta.limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / meta.limit)),
        },
        unreadCount,
    };
};

/**
 * Ownership is part of the WHERE clause, so another owner's notification reads
 * as "not found" rather than confirming it exists.
 */
const updateOwnedNotification = async ({ notificationId, ownerType, ownerId }, data) => {
    const { count } = await prisma.foodNotification.updateMany({
        where: {
            id: requireId(notificationId, 'notificationId'),
            ownerType: normalizeOwnerType(ownerType),
            ownerId: requireId(ownerId, 'ownerId'),
            dismissedAt: null,
        },
        data,
    });

    if (count === 0) throw new NotFoundError('Notification not found');

    return prisma.foodNotification.findUnique({ where: { id: String(notificationId) } });
};

export const markNotificationAsRead = async (args = {}) =>
    updateOwnedNotification(args, { isRead: true, readAt: new Date() });

export const dismissNotification = async (args = {}) =>
    updateOwnedNotification(args, { dismissedAt: new Date(), isRead: true, readAt: new Date() });

export const dismissAllNotifications = async ({ ownerType, ownerId } = {}) => {
    const result = await prisma.foodNotification.updateMany({
        where: {
            ownerType: normalizeOwnerType(ownerType),
            ownerId: requireId(ownerId, 'ownerId'),
            dismissedAt: null,
        },
        data: { dismissedAt: new Date(), isRead: true, readAt: new Date() },
    });

    return { modifiedCount: Number(result?.count || 0) };
};
