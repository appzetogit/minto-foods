import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { logger } from '../../../../utils/logger.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { notifyAdminsSafely, sendNotificationToOwner } from '../../../../core/notifications/firebase.service.js';
import { invalidateCache } from '../../../../middleware/cache.js';

/**
 * Edits to a live restaurant that an admin checks before customers see them.
 *
 * They used to be written straight away and send the restaurant back to
 * `pending`, which hid it from the customer app until an admin re-approved it.
 * Now the restaurant keeps trading with its current details and the edit waits
 * in FoodRestaurantProfileChange until approved.
 *
 * Only for restaurants already approved: one still being onboarded is not
 * visible to anyone, so it keeps the old apply-and-review behaviour.
 */

/** Columns whose change needs a look first. Bank details have their own flow. */
export const HELD_FIELDS = new Set([
    'restaurantName', 'restaurantNameNormalized',
    'ownerName', 'ownerEmail', 'ownerPhone', 'ownerPhoneDigits', 'ownerPhoneLast10',
    'primaryContactNumber',
    'panNumber', 'nameOnPan', 'panImage',
    'aadhaarNumber', 'aadhaarImage',
    'gstRegistered', 'gstNumber', 'gstLegalName', 'gstAddress', 'gstImage',
    'fssaiNumber', 'fssaiExpiry', 'fssaiImage',
    'profileImage', 'coverImages', 'menuImages',
]);

/** Fields a reviewer reads; derived ones (normalised name, phone digits) ride along silently. */
const LABELS = {
    restaurantName: 'Restaurant name',
    ownerName: 'Owner name',
    ownerEmail: 'Owner email',
    ownerPhone: 'Owner phone',
    primaryContactNumber: 'Contact number',
    panNumber: 'PAN number',
    nameOnPan: 'Name on PAN',
    panImage: 'PAN card',
    aadhaarNumber: 'Aadhaar number',
    aadhaarImage: 'Aadhaar card',
    gstRegistered: 'GST registered',
    gstNumber: 'GSTIN',
    gstLegalName: 'GST legal name',
    gstAddress: 'GST address',
    gstImage: 'GST certificate',
    fssaiNumber: 'FSSAI number',
    fssaiExpiry: 'FSSAI expiry',
    fssaiImage: 'FSSAI certificate',
    profileImage: 'Logo',
    coverImages: 'Cover photos',
    menuImages: 'Menu photos',
};

/** Splits an update into what applies now and what is held. */
export function splitHeld(update = {}) {
    const now = {};
    const held = {};
    for (const [key, value] of Object.entries(update)) {
        (HELD_FIELDS.has(key) ? held : now)[key] = value;
    }
    return { now, held };
}

/**
 * Files held edits for review. A pending request for the same restaurant is
 * merged into rather than stacked, so the reviewer sees one combined change.
 */
export async function requestProfileChange(restaurantId, held, restaurantName = '') {
    if (!isId(restaurantId) || !held || !Object.keys(held).length) return null;
    const rid = String(restaurantId);

    const row = await prisma.$transaction(async (tx) => {
        const open = await tx.foodRestaurantProfileChange.findFirst({
            where: { restaurantId: rid, status: 'pending' },
            orderBy: { requestedAt: 'desc' },
        });
        if (open) {
            return tx.foodRestaurantProfileChange.update({
                where: { id: open.id },
                data: { changes: { ...(open.changes || {}), ...held }, requestedAt: new Date() },
            });
        }
        return tx.foodRestaurantProfileChange.create({ data: { restaurantId: rid, changes: held } });
    });

    void notifyAdminsSafely({
        title: 'Restaurant changes to review',
        body: `${restaurantName || 'A restaurant'} updated ${describe(held)}.`,
        data: { type: 'approval_request', subType: 'profile_change', id: row.id },
    }).catch((err) => logger.warn(`Profile change admin notice failed: ${err?.message || err}`));

    return { status: 'pending', id: row.id, fields: labelsOf(held) };
}

const labelsOf = (changes) => Object.keys(changes || {}).filter((k) => LABELS[k]).map((k) => LABELS[k]);
const describe = (changes) => {
    const l = labelsOf(changes);
    return l.length > 3 ? `${l.slice(0, 3).join(', ')} and ${l.length - 3} more` : l.join(', ') || 'their details';
};

/** What the restaurant sees on its own profile while a change waits. */
export async function getOpenProfileChange(restaurantId) {
    if (!isId(restaurantId)) return null;
    const row = await prisma.foodRestaurantProfileChange.findFirst({
        where: { restaurantId: String(restaurantId), status: { in: ['pending', 'rejected'] } },
        orderBy: { requestedAt: 'desc' },
    });
    if (!row) return null;
    return {
        id: row.id,
        status: row.status,
        fields: labelsOf(row.changes),
        rejectionReason: row.rejectionReason,
        requestedAt: row.requestedAt,
    };
}

// ---- admin -----------------------------------------------------------------------

const present = (row) => {
    const changes = row.changes || {};
    const shown = Object.keys(changes).filter((k) => LABELS[k]);
    return {
        id: row.id,
        _id: row.id,
        restaurantId: row.restaurantId,
        restaurant: row.restaurant ? { id: row.restaurant.id, name: row.restaurant.restaurantName, ownerPhone: row.restaurant.ownerPhone } : undefined,
        status: row.status,
        items: shown.map((k) => ({
            field: k,
            label: LABELS[k],
            current: row.restaurant ? row.restaurant[k] ?? null : null,
            requested: changes[k],
        })),
        rejectionReason: row.rejectionReason || '',
        requestedAt: row.requestedAt,
        reviewedAt: row.reviewedAt,
    };
};

const RESTAURANT_SELECT = Object.fromEntries(
    ['id', 'restaurantName', ...Object.keys(LABELS)].map((k) => [k, true]),
);

export async function listProfileChanges(query = {}) {
    const status = ['pending', 'approved', 'rejected', 'superseded'].includes(query.status) ? query.status : 'pending';
    const rows = await prisma.foodRestaurantProfileChange.findMany({
        where: { status },
        orderBy: { requestedAt: 'desc' },
        take: 200,
        include: { restaurant: { select: RESTAURANT_SELECT } },
    });
    return { requests: rows.map(present), status };
}

/** Json turns dates into strings; the one date column is turned back. */
const toColumns = (changes = {}) => {
    const data = { ...changes };
    if (data.fssaiExpiry) data.fssaiExpiry = new Date(data.fssaiExpiry);
    return data;
};

const dropRestaurantCaches = async () => {
    for (const pattern of ['restaurants:*', 'restaurant_detail:*']) await invalidateCache(pattern).catch(() => {});
};

export async function approveProfileChange(id, adminId) {
    if (!isId(id)) throw new NotFoundError('Request not found');
    let row;
    try {
        row = await prisma.$transaction(async (tx) => {
            const req = await tx.foodRestaurantProfileChange.findUnique({ where: { id: String(id) } });
            if (!req) throw new NotFoundError('Request not found');
            if (req.status !== 'pending') throw new ValidationError(`This request is already ${req.status}`);
            await tx.foodRestaurant.update({ where: { id: req.restaurantId }, data: toColumns(req.changes) });
            const { count } = await tx.foodRestaurantProfileChange.updateMany({
                where: { id: req.id, status: 'pending' },
                data: { status: 'approved', reviewedAt: new Date(), reviewedById: isId(adminId) ? String(adminId) : null },
            });
            if (!count) throw new ValidationError('This request was just reviewed by someone else');
            return tx.foodRestaurantProfileChange.findUnique({
                where: { id: req.id },
                include: { restaurant: { select: RESTAURANT_SELECT } },
            });
        });
    } catch (err) {
        if (err?.code === 'P2002') {
            throw new ValidationError('Another restaurant already uses this name with this phone number');
        }
        throw err;
    }
    await dropRestaurantCaches();

    void sendNotificationToOwner({
        ownerType: 'RESTAURANT',
        ownerId: row.restaurantId,
        payload: {
            title: 'Your changes are live',
            body: `Approved: ${describe(row.changes)}.`,
            data: { type: 'profile_change_approved', id: row.id },
        },
    }).catch(() => {});
    return present(row);
}

export async function rejectProfileChange(id, adminId, reason = '') {
    const text = String(reason || '').trim().slice(0, 500);
    if (!text) throw new ValidationError('Say why, so the restaurant can fix it');
    if (!isId(id)) throw new NotFoundError('Request not found');
    const { count } = await prisma.foodRestaurantProfileChange.updateMany({
        where: { id: String(id), status: 'pending' },
        data: { status: 'rejected', rejectionReason: text, reviewedAt: new Date(), reviewedById: isId(adminId) ? String(adminId) : null },
    });
    if (!count) throw new ValidationError('This request is no longer waiting for review');
    const row = await prisma.foodRestaurantProfileChange.findUnique({
        where: { id: String(id) },
        include: { restaurant: { select: RESTAURANT_SELECT } },
    });

    void sendNotificationToOwner({
        ownerType: 'RESTAURANT',
        ownerId: row.restaurantId,
        payload: {
            title: 'Changes not approved',
            body: `Your changes were not approved: ${text}`,
            data: { type: 'profile_change_rejected', id: row.id },
        },
    }).catch(() => {});
    return present(row);
}

/** The edits already waiting for a restaurant, so a new photo adds to them. */
export async function pendingChangesOf(restaurantId) {
    if (!isId(restaurantId)) return {};
    const row = await prisma.foodRestaurantProfileChange.findFirst({
        where: { restaurantId: String(restaurantId), status: 'pending' },
        orderBy: { requestedAt: 'desc' },
        select: { changes: true },
    });
    return row?.changes || {};
}
