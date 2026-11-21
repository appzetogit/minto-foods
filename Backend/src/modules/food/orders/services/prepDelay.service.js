import { prisma } from '../../../../config/prisma.js';
import { logger } from '../../../../utils/logger.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { notifyOwnersSafely } from '../../../../core/notifications/firebase.service.js';

/**
 * The kitchen's promise on an order: accepted at X with a prep time of N
 * minutes, so the food is due at X + N. Past that and still not marked ready,
 * the order is delayed -- the rider waiting at the counter is told (to push
 * the restaurant), the customer is told the restaurant is running late, and
 * the restaurant is reminded. Once per order.
 */
import { prepDueAt, KITCHEN } from './prepTiming.js';

export { prepDueAt, prepInfo } from './prepTiming.js';

/** Finds orders whose prep time just ran out and tells everyone once. */
export async function notifyPrepDelays(now = new Date()) {
  const rows = await prisma.foodOrder.findMany({
    where: { orderStatus: { in: KITCHEN }, packingMinutes: { not: null }, prepDelayNotifiedAt: null },
    select: {
      id: true, orderId: true, userId: true, restaurantId: true, dispatchDeliveryPartnerId: true,
      orderStatus: true, packingMinutes: true,
      statusHistory: { select: { to: true, at: true }, orderBy: { at: 'asc' } },
      restaurant: { select: { restaurantName: true } },
    },
    take: 200,
  });
  let count = 0;
  for (const row of rows) {
    const due = prepDueAt(row);
    if (!due || now <= due) continue;
    // Claim it: two scheduler ticks must not both notify.
    const { count: claimed } = await prisma.foodOrder.updateMany({
      where: { id: row.id, prepDelayNotifiedAt: null },
      data: { prepDelayNotifiedAt: now },
    });
    if (!claimed) continue;
    count += 1;
    const code = row.orderId || row.id;
    const name = row.restaurant?.restaurantName || 'The restaurant';
    const data = { type: 'order_prep_delayed', orderId: row.id, orderMongoId: row.id, orderStatus: row.orderStatus };
    const sends = [
      notifyOwnersSafely([{ ownerType: 'RESTAURANT', ownerId: row.restaurantId }], {
        title: `Order #${code} is delayed`,
        body: `The ${row.packingMinutes} min preparation time is over. Please mark it ready as soon as possible.`,
        data,
      }),
      notifyOwnersSafely([{ ownerType: 'USER', ownerId: row.userId }], {
        title: 'Your food is taking a little longer',
        body: `${name} is running a bit late with your order. We have asked them to hurry.`,
        data,
      }),
    ];
    if (row.dispatchDeliveryPartnerId) {
      sends.push(notifyOwnersSafely([{ ownerType: 'DELIVERY_PARTNER', ownerId: row.dispatchDeliveryPartnerId }], {
        title: `Order #${code} delayed by restaurant`,
        body: `${name} has passed its preparation time. Please ask them to hand over the order quickly.`,
        data,
      }));
    }
    await Promise.allSettled(sends);
    try {
      const io = getIO();
      const payload = { ...data, prepDelayed: true };
      io?.to(rooms.user(row.userId)).emit('order_status_update', payload);
      io?.to(rooms.restaurant(row.restaurantId)).emit('order_status_update', payload);
      if (row.dispatchDeliveryPartnerId) io?.to(rooms.delivery(row.dispatchDeliveryPartnerId)).emit('order_status_update', payload);
    } catch (_) {}
  }
  if (count) logger.info(`Prep delay: notified ${count} order(s)`);
  return count;
}
