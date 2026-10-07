import { prisma } from '../../../../config/prisma.js';
import { logger } from '../../../../utils/logger.js';
import { runUnscoped } from '../../../../core/roles/adminScope.context.js';
import { haversineKm } from './order.helpers.js';

/**
 * The customer's order notifications: exactly these, each sent once per order.
 *
 *   placed               "Your order with {restaurant} has been successfully placed"
 *   accepted             "Order accepted by {restaurant}, it is being prepared"
 *   rider_assigned       "Rider {name} is assigned for your order"
 *   rider_at_restaurant  "Rider has reached the restaurant, waiting for your order to be ready"
 *   ready                "Your order is marked ready by the restaurant"
 *   picked_up            "Your order is picked up and on the way"
 *   rider_at_location    "Rider has reached your location"
 *   delivered            "Yay! Your order has been delivered"
 *
 * Every path that reaches one of these moments calls notifyCustomer; the
 * food_order_notifications table (unique order + key) makes sure the push goes
 * out once however many paths fire. Cancellations and refunds are sent by
 * their own code and are not part of this list.
 */

export const CUSTOMER_EVENTS = {
  placed: {
    title: 'Order placed',
    body: (o) => `Your order with ${o.restaurantName || 'the restaurant'} has been successfully placed`,
  },
  accepted: {
    title: 'Order accepted',
    body: (o) => `Order accepted by ${o.restaurantName || 'the restaurant'}, it is being prepared`,
  },
  rider_assigned: {
    title: 'Rider assigned',
    body: (o) => `Rider ${o.riderName || 'a delivery partner'} is assigned for your order`,
  },
  rider_at_restaurant: {
    title: 'Rider at the restaurant',
    body: () => 'Rider has reached the restaurant, waiting for your order to be ready',
  },
  ready: {
    title: 'Order ready',
    body: () => 'Your order is marked ready by the restaurant',
  },
  picked_up: {
    title: 'On the way',
    body: () => 'Your order is picked up and on the way',
  },
  rider_at_location: {
    title: 'Rider has arrived',
    body: () => 'Rider has reached your location',
  },
  delivered: {
    title: 'Delivered',
    body: () => 'Yay! Your order has been delivered',
  },
};

/** The customer event an order status change stands for, if any. */
export const EVENT_FOR_STATUS = {
  confirmed: 'accepted',
  ready_for_pickup: 'ready',
  picked_up: 'picked_up',
  reached_drop: 'rider_at_location',
  delivered: 'delivered',
};

/** How far along an order is, to drop an event that arrives too late to matter. */
const PROGRESS = {
  created: 0, confirmed: 1, preparing: 1, ready_for_pickup: 4, reached_pickup: 4,
  picked_up: 5, reached_drop: 6, delivered: 7,
};
/** An event is skipped once the order has reached this point. */
const STALE_FROM = {
  placed: 5,
  accepted: 5,
  rider_at_restaurant: 5,
  ready: 5,
  rider_assigned: 7,
  picked_up: 7,
  rider_at_location: 7,
  delivered: 99,
};

/**
 * Sends one customer event for an order, unless it was already sent or the
 * order has moved past it. Never throws: a push must not break the action that
 * triggered it. Returns true when a push was sent.
 */
export async function notifyCustomer(orderId, event, { riderId = null } = {}) {
  const spec = CUSTOMER_EVENTS[event];
  if (!spec || !orderId) return false;
  try {
    const row = await runUnscoped(() =>
      prisma.foodOrder.findUnique({
        where: { id: String(orderId) },
        select: {
          id: true, userId: true, order_id: true, orderId: true, orderStatus: true,
          dispatchDeliveryPartnerId: true,
          restaurant: { select: { restaurantName: true } },
        },
      }),
    );
    if (!row?.userId) return false;
    const status = String(row.orderStatus || '');
    if (status.startsWith('cancelled') || status === 'pending_payment') return false;
    if ((PROGRESS[status] ?? 0) >= (STALE_FROM[event] ?? 99)) return false;

    let riderName = '';
    const rider = riderId || (event === 'rider_assigned' ? row.dispatchDeliveryPartnerId : null);
    if (event === 'rider_assigned') {
      if (!rider) return false;
      const p = await prisma.foodDeliveryPartner.findUnique({ where: { id: String(rider) }, select: { name: true } });
      riderName = p?.name || '';
    }

    // Claim the event first: only the path that inserts the row sends the push.
    // "Rider assigned" is keyed per rider, so a new rider after a cancellation
    // is announced again.
    const key = event === 'rider_assigned' ? `${event}:${rider}` : event;
    try {
      await prisma.foodOrderNotification.create({ data: { orderId: row.id, key, event } });
    } catch (err) {
      if (err?.code === 'P2002') return false;
      throw err;
    }

    const ctx = { restaurantName: row.restaurant?.restaurantName || '', riderName };
    const { notifyOwnersSafely } = await import('../../../../core/notifications/firebase.service.js');
    const { BRAND_IMAGE_URL } = await import('../../../../config/brand.js');
    await notifyOwnersSafely([{ ownerType: 'USER', ownerId: row.userId }], {
      title: spec.title,
      body: spec.body(ctx),
      image: BRAND_IMAGE_URL,
      data: {
        type: 'order_update',
        event,
        orderId: row.id,
        orderMongoId: row.id,
        orderDisplayId: row.order_id || row.orderId || row.id,
        orderStatus: status,
        link: `/food/user/orders/${row.id}`,
      },
    });
    return true;
  } catch (err) {
    logger.warn(`Customer notification ${event} failed for order ${orderId}: ${err?.message || err}`);
    return false;
  }
}

/** For a status change: send the customer event it maps to, if any. */
export function notifyCustomerForStatus(orderId, orderStatus) {
  const event = EVENT_FOR_STATUS[String(orderStatus || '')];
  if (!event) return Promise.resolve(false);
  return notifyCustomer(orderId, event);
}

/** "Rider has reached your location" also fires when the rider is this close. */
export const NEAR_DROP_METERS = 150;

/**
 * Called with each rider position update. Once the order is picked up and the
 * rider is within NEAR_DROP_METERS of the drop pin, tells the customer -- even
 * if the rider never taps "Reached". Once only, like every customer event.
 */
export async function checkRiderNearDrop({ orderId, riderId, lat, lng }) {
  try {
    if (!orderId || !riderId || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return false;
    const id = String(orderId);
    const row = await runUnscoped(() =>
      prisma.foodOrder.findFirst({
        where: {
          OR: [{ id }, { orderId: id }, { order_id: id }],
          dispatchDeliveryPartnerId: String(riderId),
          orderStatus: 'picked_up',
        },
        select: { id: true, addrLat: true, addrLng: true },
      }),
    );
    if (!row || row.addrLat == null || row.addrLng == null) return false;
    const meters = haversineKm(Number(lat), Number(lng), row.addrLat, row.addrLng) * 1000;
    if (!(meters <= NEAR_DROP_METERS)) return false;
    return notifyCustomer(row.id, 'rider_at_location');
  } catch (err) {
    logger.warn(`Near-drop check failed for order ${orderId}: ${err?.message || err}`);
    return false;
  }
}
