import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { logger } from '../../../../utils/logger.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { notifyAdminsSafely, sendNotificationToOwner } from '../../../../core/notifications/firebase.service.js';
import { normalizeMediaUrlForStorage } from '../../../../services/storage.service.js';

/**
 * Changing where a restaurant's payouts go.
 *
 * A restaurant's request is held here and applied only when an admin approves
 * it; until then payouts keep using the current account and the restaurant
 * stays live. The restaurant is told a change was requested, so if it was not
 * them -- a stolen phone, a shared login -- they hear about it before any
 * money moves.
 */

export const BANK_FIELDS = ['accountHolderName', 'accountNumber', 'ifscCode', 'accountType', 'upiId', 'upiQrImage'];

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** The bank part of a profile update, cleaned; null when it has none. */
export function extractBankChange(body = {}) {
    const out = {};
    if (body.accountHolderName !== undefined) out.accountHolderName = String(body.accountHolderName || '').trim();
    if (body.accountNumber !== undefined) out.accountNumber = String(body.accountNumber || '').replace(/\s|-/g, '').trim();
    if (body.ifscCode !== undefined) out.ifscCode = String(body.ifscCode || '').trim().toUpperCase();
    if (body.accountType !== undefined) out.accountType = String(body.accountType || '').trim();
    if (body.upiId !== undefined) out.upiId = String(body.upiId || '').trim();
    if (body.upiQrImage !== undefined || body.upiQrCode !== undefined) {
        const raw = body.upiQrImage !== undefined ? body.upiQrImage : body.upiQrCode;
        const url = typeof raw === 'object' && raw ? raw.url : raw;
        out.upiQrImage = normalizeMediaUrlForStorage(String(url || '').trim()) || '';
    }
    if (!Object.keys(out).length) return null;

    if (out.accountNumber && !/^\d{9,18}$/.test(out.accountNumber)) {
        throw new ValidationError('Account number must be 9 to 18 digits');
    }
    if (out.ifscCode && !IFSC.test(out.ifscCode)) {
        throw new ValidationError('IFSC looks wrong. It is 11 characters, like SBIN0001234.');
    }
    return out;
}

const mask = (acct) => (acct ? `XXXX${String(acct).slice(-4)}` : '');

const present = (row) =>
    row && {
        id: row.id,
        _id: row.id,
        restaurantId: row.restaurantId,
        restaurant: row.restaurant
            ? { id: row.restaurant.id, name: row.restaurant.restaurantName, ownerPhone: row.restaurant.ownerPhone }
            : undefined,
        status: row.status,
        requested: Object.fromEntries(BANK_FIELDS.filter((f) => row[f] !== null).map((f) => [f, row[f]])),
        current: row.restaurant
            ? Object.fromEntries(BANK_FIELDS.map((f) => [f, row.restaurant[f] ?? '']))
            : undefined,
        rejectionReason: row.rejectionReason || '',
        requestedAt: row.requestedAt,
        reviewedAt: row.reviewedAt,
    };

/**
 * Files a restaurant's bank change for review. A newer request replaces an
 * older pending one rather than stacking up, so the admin reviews one thing.
 */
export async function requestBankChange(restaurantId, change) {
    if (!isId(restaurantId) || !change) return null;
    const rid = String(restaurantId);

    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: rid },
        select: { restaurantName: true, accountNumber: true, ifscCode: true, accountHolderName: true, accountType: true, upiId: true, upiQrImage: true },
    });
    if (!restaurant) throw new NotFoundError('Restaurant not found');

    // Nothing actually different: do not bother the admin.
    const differs = Object.entries(change).some(([k, v]) => String(restaurant[k] ?? '') !== String(v ?? ''));
    if (!differs) return { status: 'unchanged' };

    const row = await prisma.$transaction(async (tx) => {
        await tx.foodRestaurantBankChange.updateMany({
            where: { restaurantId: rid, status: 'pending' },
            data: { status: 'superseded', reviewedAt: new Date() },
        });
        return tx.foodRestaurantBankChange.create({ data: { restaurantId: rid, ...change } });
    });

    void notifyAdminsSafely({
        title: 'Bank details change to review',
        body: `${restaurant.restaurantName} asked to change their payout account.`,
        data: { type: 'approval_request', subType: 'bank_change', id: row.id },
    }).catch((err) => logger.warn(`Bank change admin notice failed: ${err?.message || err}`));

    void sendNotificationToOwner({
        ownerType: 'RESTAURANT',
        ownerId: rid,
        payload: {
            title: 'Payout account change requested',
            body: 'A change to your payout bank account was requested and is waiting for approval. If this was not you, contact support right away.',
            data: { type: 'bank_change_requested', id: row.id },
        },
    }).catch((err) => logger.warn(`Bank change owner notice failed: ${err?.message || err}`));

    return { status: 'pending', id: row.id };
}

/** The restaurant's current pending request, for its own bank page. */
export async function getPendingBankChange(restaurantId) {
    if (!isId(restaurantId)) return null;
    const row = await prisma.foodRestaurantBankChange.findFirst({
        where: { restaurantId: String(restaurantId), status: { in: ['pending', 'rejected'] } },
        orderBy: { requestedAt: 'desc' },
    });
    if (!row) return null;
    const requested = Object.fromEntries(BANK_FIELDS.filter((f) => row[f] !== null).map((f) => [f, row[f]]));
    if (requested.accountNumber) requested.accountNumber = mask(requested.accountNumber);
    return { id: row.id, status: row.status, requested, rejectionReason: row.rejectionReason, requestedAt: row.requestedAt };
}

// ---- admin -----------------------------------------------------------------------

const WITH_RESTAURANT = {
    restaurant: {
        select: {
            id: true, restaurantName: true, ownerPhone: true,
            accountHolderName: true, accountNumber: true, ifscCode: true, accountType: true, upiId: true, upiQrImage: true,
        },
    },
};

export async function listBankChanges(query = {}) {
    const status = ['pending', 'approved', 'rejected', 'superseded'].includes(query.status) ? query.status : 'pending';
    const rows = await prisma.foodRestaurantBankChange.findMany({
        where: { status },
        orderBy: { requestedAt: 'desc' },
        take: 200,
        include: WITH_RESTAURANT,
    });
    return { requests: rows.map(present), status };
}

const loadPending = async (tx, id) => {
    if (!isId(id)) throw new NotFoundError('Request not found');
    const row = await tx.foodRestaurantBankChange.findUnique({ where: { id: String(id) } });
    if (!row) throw new NotFoundError('Request not found');
    if (row.status !== 'pending') throw new ValidationError(`This request is already ${row.status}`);
    return row;
};

export async function approveBankChange(id, adminId) {
    const row = await prisma.$transaction(async (tx) => {
        const req = await loadPending(tx, id);
        const data = Object.fromEntries(BANK_FIELDS.filter((f) => req[f] !== null).map((f) => [f, req[f]]));
        await tx.foodRestaurant.update({ where: { id: req.restaurantId }, data });
        // Guarded on status so two admins approving at once apply it once.
        const { count } = await tx.foodRestaurantBankChange.updateMany({
            where: { id: req.id, status: 'pending' },
            data: { status: 'approved', reviewedAt: new Date(), reviewedById: isId(adminId) ? String(adminId) : null },
        });
        if (!count) throw new ValidationError('This request was just reviewed by someone else');
        return tx.foodRestaurantBankChange.findUnique({ where: { id: req.id }, include: WITH_RESTAURANT });
    });

    void sendNotificationToOwner({
        ownerType: 'RESTAURANT',
        ownerId: row.restaurantId,
        payload: {
            title: 'Payout account updated',
            body: 'Your new payout bank details were approved. Future payouts go to the new account.',
            data: { type: 'bank_change_approved', id: row.id },
        },
    }).catch(() => {});
    return present(row);
}

export async function rejectBankChange(id, adminId, reason = '') {
    const text = String(reason || '').trim().slice(0, 500);
    if (!text) throw new ValidationError('Say why the change was rejected, so the restaurant can fix it');
    const row = await prisma.$transaction(async (tx) => {
        const req = await loadPending(tx, id);
        await tx.foodRestaurantBankChange.update({
            where: { id: req.id },
            data: { status: 'rejected', rejectionReason: text, reviewedAt: new Date(), reviewedById: isId(adminId) ? String(adminId) : null },
        });
        return tx.foodRestaurantBankChange.findUnique({ where: { id: req.id }, include: WITH_RESTAURANT });
    });

    void sendNotificationToOwner({
        ownerType: 'RESTAURANT',
        ownerId: row.restaurantId,
        payload: {
            title: 'Payout account change rejected',
            body: `Your payout account change was not approved: ${text}`,
            data: { type: 'bank_change_rejected', id: row.id },
        },
    }).catch(() => {});
    return present(row);
}
