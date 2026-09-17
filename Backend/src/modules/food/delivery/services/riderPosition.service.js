import { prisma } from '../../../../config/prisma.js';

/**
 * Writes a rider's current position to the database.
 *
 * Positions were only ever saved through Redis and the tracking queue, so with
 * those switched off nothing was written: anything reading the database --
 * the order's route, admin views -- saw a stale or empty rider. The live map
 * was unaffected only because it reads Firebase. This saves directly, a few
 * times a minute, whenever the queue is not doing it.
 *
 * The order is only updated if this rider is the one assigned to it. The socket
 * accepts an order id from the rider's app, and nothing else stops one rider
 * from writing a position onto someone else's delivery.
 */
export async function saveRiderPosition({ orderId, riderId, lat, lng, at = new Date() }) {
    const id = String(orderId);
    const rider = String(riderId);
    await Promise.all([
        prisma.foodDeliveryPartner.updateMany({
            where: { id: rider },
            data: { lastLat: lat, lastLng: lng, lastLocationAt: at },
        }),
        // The app may send either the internal id or the display order id.
        prisma.foodOrder.updateMany({
            where: { dispatchDeliveryPartnerId: rider, OR: [{ id }, { orderId: id }] },
            data: { riderLat: lat, riderLng: lng },
        }),
    ]);
}
