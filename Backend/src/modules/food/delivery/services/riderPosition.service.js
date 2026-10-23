import { prisma } from '../../../../config/prisma.js';
import { checkRiderNearDrop } from '../../orders/services/customerNotify.service.js';
import { refreshOrderEta } from '../../orders/services/eta.service.js';

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
    // "Rider has reached your location" when they get close, tap or no tap.
    void checkRiderNearDrop({ orderId: id, riderId: rider, lat, lng });
    await Promise.all([
        prisma.foodDeliveryPartner.updateMany({
            where: { id: rider },
            data: { lastLat: lat, lastLng: lng, lastLocationAt: at },
        }),
        saveOrderRiderPosition({ orderId: id, riderId: rider, lat, lng, at }),
    ]);
}

/**
 * The rider's position on the order they are carrying, and a fresh ETA.
 *
 * The app may send the internal id or the order number, and the order number
 * lives in two columns (orderId and order_id). Matching only one of them is
 * why riderLat/riderLng stayed empty on every live order: the queued write
 * looked in orderId while the app sent the internal id.
 */
export async function saveOrderRiderPosition({ orderId, riderId, lat, lng, at = new Date() }) {
    const id = String(orderId || '');
    if (!id || !riderId) return;
    const matched = await prisma.foodOrder.findMany({
        where: {
            dispatchDeliveryPartnerId: String(riderId),
            OR: [{ id }, { orderId: id }, { order_id: id }],
        },
        select: { id: true },
    });
    if (!matched.length) return;
    await prisma.foodOrder.updateMany({
        where: { id: { in: matched.map((o) => o.id) } },
        data: { riderLat: lat, riderLng: lng, riderLocationAt: at },
    });
    // Rate-limited inside: at most once a minute per order.
    for (const order of matched) void refreshOrderEta(order.id);
}

/** Orders a rider is on the way with, from accepting to handing over. */
const RIDER_ACTIVE_STATUSES = ['confirmed', 'preparing', 'ready_for_pickup', 'reached_pickup', 'picked_up', 'reached_drop'];

/**
 * The availability heartbeat carries a position too: put it on every order the
 * rider is carrying, so the customer's map and ETA move even when the app's
 * order-scoped location socket is not running.
 */
export async function saveRiderActiveOrdersPosition({ riderId, lat, lng, at = new Date() }) {
    if (!riderId) return;
    const active = await prisma.foodOrder.findMany({
        where: {
            dispatchDeliveryPartnerId: String(riderId),
            dispatchAcceptedAt: { not: null },
            orderStatus: { in: RIDER_ACTIVE_STATUSES },
        },
        select: { id: true },
    });
    if (!active.length) return;
    await prisma.foodOrder.updateMany({
        where: { id: { in: active.map((o) => o.id) } },
        data: { riderLat: lat, riderLng: lng, riderLocationAt: at },
    });
    for (const order of active) void refreshOrderEta(order.id);
}
