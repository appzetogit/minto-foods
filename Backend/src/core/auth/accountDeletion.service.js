import crypto from 'node:crypto';
import { prisma } from '../../config/prisma.js';
import { isId } from '../../utils/helpers.js';
import { ValidationError, NotFoundError } from './errors.js';

/**
 * Deleting your own account, for customers, restaurants and riders.
 *
 * A soft delete: the row stays, because orders, payouts, invoices and ratings
 * point at it and the business has to keep those. What changes is that the
 * account can never sign in again, every device is signed out at once, it is
 * hidden from customers, and its phone number is released so the same person
 * can start over with a fresh account.
 */

/** Orders that are still being made or delivered. */
const IN_PROGRESS = ['created', 'confirmed', 'preparing', 'ready_for_pickup', 'reached_pickup', 'picked_up', 'reached_drop'];

/** A placeholder for the unique, required phone column: "del_" + time + random, 16 chars. */
const tombstonePhone = () => `del_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

const ROLES = {
    USER: {
        orderField: 'userId',
        busy: 'You have an order on its way. You can delete your account once it is delivered.',
        async remove(tx, id, now) {
            const user = await tx.foodUser.findUnique({ where: { id }, select: { phone: true, deletedAt: true } });
            if (!user || user.deletedAt) return false;
            await tx.foodUser.update({
                where: { id },
                data: {
                    deletedAt: now,
                    deletedPhone: user.phone,
                    phone: tombstonePhone(),
                    isActive: false,
                    fcmTokens: [],
                    fcmTokenMobile: [],
                    tokenVersion: { increment: 1 },
                },
            });
            return true;
        },
    },
    RESTAURANT: {
        orderField: 'restaurantId',
        busy: 'You have orders in progress. Finish or cancel them before deleting the restaurant account.',
        async remove(tx, id, now) {
            const r = await tx.foodRestaurant.findUnique({ where: { id }, select: { ownerPhone: true, deletedAt: true } });
            if (!r || r.deletedAt) return false;
            await tx.foodRestaurant.update({
                where: { id },
                data: {
                    deletedAt: now,
                    deletedPhone: r.ownerPhone,
                    ownerPhone: null,
                    ownerPhoneDigits: null,
                    ownerPhoneLast10: null,
                    primaryContactNumber: null,
                    // Every customer-facing list already shows approved
                    // restaurants only, so this is what takes it off the app.
                    status: 'rejected',
                    rejectionReason: 'Account deleted by the owner',
                    isAcceptingOrders: false,
                    fcmTokens: [],
                    fcmTokenMobile: [],
                    tokenVersion: { increment: 1 },
                },
            });
            return true;
        },
    },
    DELIVERY_PARTNER: {
        orderField: 'dispatchDeliveryPartnerId',
        busy: 'You have a delivery in progress. Complete it before deleting your account.',
        async remove(tx, id, now) {
            const p = await tx.foodDeliveryPartner.findUnique({ where: { id }, select: { phone: true, deletedAt: true } });
            if (!p || p.deletedAt) return false;
            await tx.foodDeliveryPartner.update({
                where: { id },
                data: {
                    deletedAt: now,
                    deletedPhone: p.phone,
                    phone: tombstonePhone(),
                    // Unique too: the same bike can be registered again.
                    vehicleNumber: null,
                    status: 'deactivated',
                    rejectionReason: 'Account deleted by the rider',
                    availabilityStatus: 'offline',
                    fcmTokens: [],
                    fcmTokenMobile: [],
                    tokenVersion: { increment: 1 },
                },
            });
            return true;
        },
    },
};

/**
 * Deletes the signed-in account. Refused while an order is in progress, since
 * that order still needs the customer, the kitchen or the rider.
 */
export async function deleteOwnAccount(role, accountId) {
    const spec = ROLES[role];
    if (!spec || !isId(accountId)) throw new ValidationError('This account cannot be deleted here');
    const id = String(accountId);

    const busy = await prisma.foodOrder.findFirst({
        where: { [spec.orderField]: id, orderStatus: { in: IN_PROGRESS } },
        select: { id: true },
    });
    if (busy) throw new ValidationError(spec.busy);

    const removed = await prisma.$transaction(async (tx) => {
        const ok = await spec.remove(tx, id, new Date());
        if (ok) await tx.foodRefreshToken.deleteMany({ where: { userId: id } });
        return ok;
    });
    if (!removed) throw new NotFoundError('Account not found');
    return { deleted: true };
}
