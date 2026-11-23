import { prisma } from '../../../../config/prisma.js';
import { logger } from '../../../../utils/logger.js';
import { notifyOwnersSafely } from '../../../../core/notifications/firebase.service.js';
import { handoverInfo, stuckInfo, formatDuration } from './handoverTiming.js';

const OPEN = ['created', 'confirmed', 'preparing', 'ready_for_pickup', 'picked_up'];
const STUCK_REPEAT_MS = 30 * 60 * 1000;

const select = {
  id: true, orderId: true, orderStatus: true, createdAt: true, estimatedDeliveryAt: true,
  restaurantId: true, dispatchDeliveryPartnerId: true, pickedUpAt: true, reachedPickupAt: true,
  handoverLateNotifiedAt: true, stuckNotifiedAt: true,
  statusHistory: { select: { to: true, at: true }, orderBy: { at: 'asc' } },
  restaurant: { select: { restaurantName: true } },
};

/**
 * Runs every minute. Two alerts nobody used to get:
 *  - handover late: ready a minute ago and not picked up — the rider is told
 *    once to pick it up now (the admin panel shows it red as well);
 *  - stuck: an order still open far past any delivery time (some sat for
 *    days unnoticed) — rider and restaurant are told, every 30 minutes,
 *    until it is delivered or cancelled.
 */
export async function sendOrderAlerts(now = new Date()) {
  const rows = await prisma.foodOrder.findMany({ where: { orderStatus: { in: OPEN } }, select, take: 500 });
  let handover = 0;
  let stuck = 0;
  for (const row of rows) {
    const code = row.orderId || row.id;
    const rider = row.dispatchDeliveryPartnerId;

    const h = handoverInfo(row, now);
    if (h?.late && !h.pickedUpAt && rider && !row.handoverLateNotifiedAt) {
      const { count } = await prisma.foodOrder.updateMany({
        where: { id: row.id, handoverLateNotifiedAt: null },
        data: { handoverLateNotifiedAt: now },
      });
      if (count) {
        handover += 1;
        await notifyOwnersSafely([{ ownerType: 'DELIVERY_PARTNER', ownerId: rider }], {
          title: `Pick up Order #${code} now`,
          body: `It has been ready at ${row.restaurant?.restaurantName || 'the restaurant'} for ${formatDuration((now - new Date(h.readyAt)) / 1000)}.`,
          data: { type: 'handover_late', orderMongoId: row.id, orderId: code },
        });
      }
    }

    const s = stuckInfo(row, now);
    if (s && (!row.stuckNotifiedAt || now - row.stuckNotifiedAt >= STUCK_REPEAT_MS)) {
      const { count } = await prisma.foodOrder.updateMany({
        where: { id: row.id, stuckNotifiedAt: row.stuckNotifiedAt },
        data: { stuckNotifiedAt: now },
      });
      if (!count) continue;
      stuck += 1;
      const open = formatDuration(s.openForMinutes * 60);
      const targets = [{ ownerType: 'RESTAURANT', ownerId: row.restaurantId }];
      if (rider) targets.push({ ownerType: 'DELIVERY_PARTNER', ownerId: rider });
      await notifyOwnersSafely(targets, {
        title: `Order #${code} is not delivered yet`,
        body: `Open for ${open}. If it was delivered, mark it delivered; otherwise contact MintoFood support.`,
        data: { type: 'order_stuck', orderMongoId: row.id, orderId: code },
      });
    }
  }
  if (handover || stuck) logger.info(`Order alerts: ${handover} handover late, ${stuck} stuck`);
  return { handover, stuck };
}
