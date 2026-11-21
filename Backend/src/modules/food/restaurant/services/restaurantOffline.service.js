import { prisma } from '../../../../config/prisma.js';

/**
 * Starts and ends restaurants' timed offline breaks. Run every minute by the
 * scheduler. Only the on/off switch moves, so every list, search and order
 * check that already reads isAcceptingOrders follows without changes.
 *
 * An admin's offline (offlineByAdmin) is never ended here.
 */
export async function applyRestaurantOfflineSchedule(now = new Date()) {
    // A scheduled break begins.
    const started = await prisma.foodRestaurant.updateMany({
        where: { offlineFrom: { not: null, lte: now } },
        data: { isAcceptingOrders: false, offlineFrom: null },
    });
    // A break, or "offline for 2 hours", is over.
    const ended = await prisma.foodRestaurant.updateMany({
        where: { offlineFrom: null, offlineUntil: { not: null, lte: now }, offlineByAdmin: false },
        data: { isAcceptingOrders: true, offlineUntil: null, offlineReason: '' },
    });
    return { started: started.count, ended: ended.count };
}
