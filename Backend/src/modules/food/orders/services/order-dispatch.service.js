import { prisma } from '../../../../config/prisma.js';
import { toOrder, orderInclude } from '../order.mapper.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { config } from '../../../../config/env.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { addOrderJob } from '../../../../queues/producers/order.producer.js';
import {
  buildDeliverySocketPayload,
  riderContact,
  buildOrderIdentityFilter,
  getBusyDeliveryPartnerIds,
  haversineKm,
  notifyOwnersActionableAlert,
  notifyOwnersSafely,
  TERMINAL_ORDER_STATUSES,
} from './order.helpers.js';
import { fetchDrivingRoute } from '../utils/googleMaps.js';
import { parseGeoPoint } from '../../shared/geo.utils.js';

/** Everything a dispatch broadcast needs about the order. */
const dispatchInclude = { ...orderInclude, restaurant: true, user: true };

/**
 * Resolve restaurant → customer road distance once per dispatch broadcast.
 * Falls back to pricing Haversine when Directions is unavailable.
 */
export async function enrichPayloadWithTripRoadDistance(order, payload) {
  const existingRoadKm = order?.tripDistanceKm ?? order?.pricing?.roadDistanceKm;
  if (Number.isFinite(Number(existingRoadKm))) {
    const km = Number(Number(existingRoadKm).toFixed(2));
    const minsRaw = order?.tripDurationMins ?? order?.pricing?.roadDurationMins;
    const tripDurationMins = Number.isFinite(Number(minsRaw))
      ? Math.ceil(Number(minsRaw))
      : payload.tripDurationMins;
    return { ...payload, tripDistanceKm: km, tripDurationMins: tripDurationMins ?? null, distanceKm: km };
  }

  const restaurantPoint = parseGeoPoint(order?.restaurantId);
  const customerPoint = parseGeoPoint(order?.deliveryAddress);
  if (!restaurantPoint || !customerPoint) return payload;

  try {
    const route = await fetchDrivingRoute(restaurantPoint, customerPoint);
    if (route.distanceKm != null) {
      const tripDurationMins =
        route.durationSeconds != null ? Math.ceil(route.durationSeconds / 60) : null;

      // Persist so subsequent offers / reconnects reuse the road distance.
      if (order?.id) {
        prisma.foodOrder
          .update({
            where: { id: order.id },
            data: {
              tripDistanceKm: route.distanceKm,
              tripDurationMins,
              roadDistanceKm: route.distanceKm,
              roadDurationMins: tripDurationMins,
            },
          })
          .catch(() => {});
      }

      return { ...payload, tripDistanceKm: route.distanceKm, tripDurationMins, distanceKm: route.distanceKm };
    }
  } catch (err) {
    logger.warn(`Trip road distance enrichment failed: ${err?.message || err}`);
  }

  return payload;
}

/**
 * Default rider accept window. The admin sets the real one
 * (FoodSettings.riderAcceptWindowSeconds); the client countdown, the offer
 * expiry and the timeout job all come from that one value.
 */
const DRIVER_ACCEPT_WINDOW_MS = 45000;

/**
 * Flat, string-only data map for the incoming-order push.
 *
 * FCM data values must be strings. Everything the full-screen alert needs is
 * included so the app can render it with no follow-up API call — important when
 * the device is locked or the app was killed.
 */
export function buildIncomingOrderPushData(order, payload, acceptanceDeadlineAt, windowMs = DRIVER_ACCEPT_WINDOW_MS) {
  const s = (v) => (v === undefined || v === null ? '' : String(v));

  const earning = s(payload?.riderEarning ?? 0);
  const distance = s(payload?.tripDistanceKm ?? '');
  const bodyLines = [
    payload?.restaurantName ? `Pickup: ${s(payload.restaurantName)}` : '',
    payload?.customerAddress ? `Drop: ${s(payload.customerAddress)}` : '',
    distance ? `${distance} km` : '',
    `Earning: Rs.${earning}`,
  ].filter(Boolean);

  return {
    type: 'new_order',
    // Carried INSIDE data on purpose: this push is data-only, so FCM omits the
    // notification block and an app reading message.notification.title renders a
    // blank notification. These give the rider app ready-made strings.
    title: 'New order available!',
    body: bodyLines.join('\n'),
    orderId: s(order?.id),
    orderMongoId: s(order?.id),
    orderDisplayId: s(order?.order_id || order?.id),
    restaurantName: s(payload?.restaurantName),
    restaurantAddress: s(payload?.restaurantAddress),
    customerAddress: s(payload?.customerAddress),
    tripDistanceKm: s(payload?.tripDistanceKm ?? ''),
    tripDurationMins: s(payload?.tripDurationMins ?? ''),
    riderEarning: s(payload?.riderEarning ?? 0),
    earnings: s(payload?.earnings ?? payload?.riderEarning ?? 0),
    paymentMethod: s(payload?.paymentMethod || order?.payment?.method),
    total: s(payload?.total ?? order?.pricing?.total ?? 0),
    acceptanceDeadlineAt: s(acceptanceDeadlineAt?.toISOString?.() || acceptanceDeadlineAt),
    // The offer window, so the client countdown is driven by the server rather
    // than a constant compiled into the app. The absolute deadline above is more
    // accurate, but a message delayed in Doze arrives already expired — sending
    // both lets the app prefer the deadline and fall back to this.
    acceptTimeoutSeconds: s(Math.round(windowMs / 1000)),
    pickupAddress: s(payload?.restaurantAddress),
    dropAddress: s(payload?.customerAddress),
    price: s(payload?.earnings ?? payload?.riderEarning ?? 0),
    distance: s(payload?.tripDistanceKm ?? ''),

    // Everything below exists so the alert can be drawn with ZERO network calls.
    // The background isolate rendering it often runs in Doze, where an HTTP
    // request is deferred or refused — and the rider has 45 seconds to decide.
    orderNumber: s(order?.order_id || ''),
    restaurantImage: s(payload?.restaurantCoverImage || ''),
    pickupLat: s(payload?.restaurantLocation?.latitude ?? ''),
    pickupLng: s(payload?.restaurantLocation?.longitude ?? ''),
    dropLat: s(payload?.customerLocation?.latitude ?? ''),
    dropLng: s(payload?.customerLocation?.longitude ?? ''),
    // The receiver on an order for someone else, never the account holder.
    customerName: s(payload?.customerName || riderContact(order).name || ''),
    customerPhone: s(payload?.customerPhone || riderContact(order).phone || ''),
    itemsCount: s(Array.isArray(order?.items) ? order.items.length : ''),
  };
}

/**
 * Riders already holding as much cash as they are allowed to.
 *
 * The limit existed as an admin setting and was shown to riders, but nothing
 * enforced it. Only applied to orders the rider physically collects money for —
 * a prepaid order adds nothing to their float. A limit of 0 means "no limit",
 * which is the default, so an unconfigured install excludes nobody.
 *
 * @returns {Promise<Set<string>>} partner ids to skip
 */
export async function getCashBlockedPartnerIds(partnerIds) {
  if (!partnerIds.length) return new Set();

  const settings = await prisma.foodDeliveryCashLimit.findFirst({
    where: { isActive: true },
    select: { deliveryCashLimit: true },
  });
  const limit = Number(settings?.deliveryCashLimit) || 0;
  if (limit <= 0) return new Set();

  // Wallets are one table now, keyed by (entityType, entityId).
  const wallets = await prisma.wallet.findMany({
    where: {
      entityType: 'deliveryBoy',
      entityId: { in: partnerIds.map(String) },
      cashInHand: { gte: limit },
    },
    select: { entityId: true },
  });

  return new Set(wallets.map((w) => w.entityId));
}

/** Cash the rider has to physically collect, so it counts against their float. */
export function orderCollectsCash(order) {
  const method = String(order?.payment?.method || order?.paymentMethod || '').toLowerCase();
  return method === 'cash' || method === 'razorpay_qr';
}

async function listNearbyOnlineDeliveryPartners(restaurant, { maxKm = 15, limit = 25 } = {}) {
  const rLat = Number(restaurant?.latitude);
  const rLng = Number(restaurant?.longitude);
  if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) {
    // Without restaurant coords we cannot safely match riders by zone/proximity.
    return { partners: [] };
  }

  const allOnline = await prisma.foodDeliveryPartner.findMany({
    where: { availabilityStatus: 'online' },
    select: { id: true, status: true, lastLat: true, lastLng: true, lastLocationAt: true, name: true },
  });

  const scored = [];
  const allowedStatuses =
    process.env.NODE_ENV === 'production' ? ['approved'] : ['approved', 'pending'];

  // A rider is only dropped for staleness after this long WITHOUT any GPS ping.
  //
  // This was 10 minutes, which silently starved the offer path: Doze suppresses
  // the background location upload, the GPS goes stale, the rider is excluded, so
  // no push is sent to wake the app, so the GPS stays stale. Coordinates half an
  // hour old and 3 km away still beat offering the order to nobody.
  const STALE_GPS_MS = Number(process.env.DISPATCH_STALE_GPS_MS) || 45 * 60 * 1000;

  let droppedStale = 0;
  for (const p of allOnline) {
    if (!allowedStatuses.includes(p.status)) continue;

    // No coordinates at all → genuinely unplaceable (never score as 999, which
    // used to bypass the maxKm gate entirely).
    if (p.lastLat == null || p.lastLng == null) {
      droppedStale += 1;
      continue;
    }
    if (!p.lastLocationAt || Date.now() - new Date(p.lastLocationAt).getTime() > STALE_GPS_MS) {
      droppedStale += 1;
      continue;
    }

    const d = haversineKm(rLat, rLng, p.lastLat, p.lastLng);
    if (Number.isFinite(d) && d <= maxKm) {
      scored.push({ partnerId: p.id, distanceKm: d, status: p.status });
    }
  }

  // Without this, a starved dispatch is indistinguishable from "no riders online".
  if (droppedStale > 0) {
    logger.warn(
      `[Dispatch] ${droppedStale}/${allOnline.length} online riders skipped for missing/stale GPS ` +
        `(restaurant ${restaurant.id}, maxKm ${maxKm}). ${scored.length} eligible.`,
    );
  }

  scored.sort((a, b) => a.distanceKm - b.distanceKm);
  const picked = scored.slice(0, Math.max(1, limit));

  // Do NOT fall back to any online partner worldwide (cross-zone bug). The caller
  // retries later when nearby GPS updates.
  if (picked.length === 0) return { partners: [] };

  const final = config.nodeEnv === 'production' ? picked.filter((p) => p.status === 'approved') : picked;
  return { partners: final };
}

/** The platform-wide dispatch settings row, with defaults. */
export async function getDispatchSettings() {
  const row = await prisma.foodSettings.findUnique({ where: { key: 'dispatch' } });
  return {
    dispatchMode: row?.dispatchMode === 'manual' ? 'manual' : 'auto',
    manualAcceptWindowSeconds: Number(row?.manualAcceptWindowSeconds) || 120,
    manualQueueAlertMinutes: Number(row?.manualQueueAlertMinutes) || 5,
    riderAcceptWindowSeconds: Math.min(300, Math.max(15,
      Number(row?.riderAcceptWindowSeconds) || DRIVER_ACCEPT_WINDOW_MS / 1000)),
  };
}

/**
 * Saves the global dispatch mode. This used to write 'auto' whatever was sent,
 * so the admin's choice never took effect.
 */
export async function updateDispatchSettings(dispatchMode, adminId, extra = {}) {
  const mode = dispatchMode === 'manual' ? 'manual' : 'auto';
  const data = {
    dispatchMode: mode,
    updatedByRole: 'ADMIN',
    updatedByAdminId: adminId ? String(adminId) : null,
    updatedAtBy: new Date(),
  };
  const window = Number(extra.manualAcceptWindowSeconds);
  if (Number.isFinite(window)) {
    if (window < 30 || window > 900) throw new ValidationError('Accept window must be 30 to 900 seconds');
    data.manualAcceptWindowSeconds = Math.round(window);
  }
  const alertMin = Number(extra.manualQueueAlertMinutes);
  if (Number.isFinite(alertMin)) {
    if (alertMin < 1 || alertMin > 120) throw new ValidationError('Alert time must be 1 to 120 minutes');
    data.manualQueueAlertMinutes = Math.round(alertMin);
  }
  const riderWindow = Number(extra.riderAcceptWindowSeconds);
  if (Number.isFinite(riderWindow)) {
    if (riderWindow < 15 || riderWindow > 300) throw new ValidationError('Rider accept time must be 15 to 300 seconds');
    data.riderAcceptWindowSeconds = Math.round(riderWindow);
  }
  const before = await getDispatchSettings();
  await prisma.foodSettings.upsert({
    where: { key: 'dispatch' },
    create: { key: 'dispatch', ...data },
    update: data,
  });
  const { clearDispatchModeCache, sweepWaitingOrdersToAuto } = await import('./manualDispatch.service.js');
  clearDispatchModeCache();
  // Manual -> auto: whatever was waiting for an admin goes out to riders now.
  if (before.dispatchMode === 'manual' && mode === 'auto') {
    void sweepWaitingOrdersToAuto().catch((err) => logger.warn(`Dispatch sweep failed: ${err?.message || err}`));
  }
  return getDispatchSettings();
}

/**
 * Riders holding a live offer on some other order. A rider gets one offer at
 * a time; an offer stuck past its window (a lost timeout job) stops counting.
 */
async function getRidersHoldingAnOffer(exceptOrderId, windowMs) {
  const rows = await prisma.foodOrder.findMany({
    where: {
      id: { not: exceptOrderId },
      dispatchStatus: 'assigned',
      dispatchAcceptedAt: null,
      dispatchDeliveryPartnerId: { not: null },
      dispatchAssignedAt: { gt: new Date(Date.now() - windowMs - 5000) },
      orderStatus: { notIn: TERMINAL_ORDER_STATUSES },
    },
    select: { dispatchDeliveryPartnerId: true },
    distinct: ['dispatchDeliveryPartnerId'],
  });
  return new Set(rows.map((r) => r.dispatchDeliveryPartnerId));
}

/**
 * Closes the popup on a rider's phone: their offer ran out or went elsewhere.
 * Socket for an open app, data-only push for one in the background -- the
 * offer arrived the same two ways. The worker has no socket, so from a
 * timeout job only the push goes.
 */
async function withdrawOfferFromRider(orderId, partnerId) {
  const io = getIO();
  if (io) {
    io.to(rooms.delivery(partnerId)).emit('order_claimed', { orderId, orderMongoId: orderId });
  }
  await notifyOwnersSafely([{ ownerType: 'DELIVERY_PARTNER', ownerId: partnerId }], {
    title: 'Order taken',
    body: 'This order was offered to another partner.',
    dataOnly: true,
    data: { type: 'order_taken', orderId, orderMongoId: orderId },
  });
}

/**
 * Ends a rider's offer that was not answered in time: the offer row becomes
 * 'timeout', the order is free again and the rider's popup is closed.
 * @returns {Promise<boolean>} false when the rider accepted in the meantime
 */
async function expireRiderOffer(row, partnerId, offerId = null) {
  const pid = String(partnerId);
  const { count } = await prisma.foodOrder.updateMany({
    where: { id: row.id, dispatchStatus: 'assigned', dispatchDeliveryPartnerId: pid, dispatchAcceptedAt: null },
    data: { dispatchStatus: 'unassigned', dispatchDeliveryPartnerId: null, dispatchAssignedAt: null },
  });
  if (count === 0) return false;

  await prisma.orderDispatchOffer.updateMany({
    where: { orderId: row.id, partnerId: pid, action: 'offered', ...(offerId ? { id: offerId } : {}) },
    data: { action: 'timeout' },
  });
  await withdrawOfferFromRider(row.id, pid).catch((err) =>
    logger.warn(`order_taken push after timeout failed for order ${row.id}: ${err?.message || err}`),
  );
  return true;
}

/**
 * Offers the order to ONE rider -- the nearest free one not yet asked in this
 * round -- and waits for their answer. Accept ends dispatch; reject or the
 * window running out (processDispatchTimeout) brings the next rider.
 *
 * A round ends when every free rider in range has been asked. After a pause
 * of one window the next round starts, and riders who said no may be asked
 * again (with a fresh offer). Riders an admin took the order off
 * ('deassigned') are never asked again.
 *
 * Options: attempt (the job counter; the radius widens with time),
 * newRound (start the next round), fromJob (called by the timeout job),
 * reason / partnerId (for the manual-dispatch queue).
 */
export async function tryAutoAssign(orderId, options = {}) {
  const id = String(orderId);

  // Manual dispatch: in a zone set to manual nothing is offered to riders; the
  // order waits for an admin to assign it. Every caller (restaurant confirm,
  // rider reject, timeouts, resend, emergency) comes through here.
  const { isManualForOrder, enterManualQueue } = await import('./manualDispatch.service.js');
  if (await isManualForOrder(id)) {
    return enterManualQueue(id, options);
  }

  const { riderAcceptWindowSeconds } = await getDispatchSettings();
  const windowMs = riderAcceptWindowSeconds * 1000;
  // Small buffer above the accept window so an in-flight offer isn't reclaimed early.
  const lockTimeout = windowMs + 5000;

  // Claim the dispatch lock atomically; only the winner proceeds. An order
  // still 'assigned' past its window is a lost timeout and may be taken over.
  const { count: claimed } = await prisma.foodOrder.updateMany({
    where: {
      id,
      dispatchingAt: null,
      OR: [
        { dispatchStatus: 'unassigned' },
        {
          dispatchStatus: 'assigned',
          dispatchAcceptedAt: null,
          dispatchAssignedAt: { lt: new Date(Date.now() - lockTimeout) },
        },
      ],
    },
    data: { dispatchingAt: new Date() },
  });

  if (claimed === 0) {
    logger.info(`tryAutoAssign: Skip for ${id} (already dispatching, offered, or accepted).`);
    return null;
  }

  let row = await prisma.foodOrder.findUnique({ where: { id }, include: dispatchInclude });
  const order = toOrder(row);

  try {
    // Ensure the restaurant accepted before dispatching to delivery partners.
    const DISPATCHABLE_STATUSES = [
      'confirmed', 'preparing', 'ready_for_pickup', 'ready', 'reached_pickup', 'picked_up', 'reached_drop',
    ];
    if (!DISPATCHABLE_STATUSES.includes(order.orderStatus)) {
      logger.info(`tryAutoAssign: Skip for ${id} (status ${order.orderStatus} not dispatchable yet).`);
      return order;
    }

    // A stale offer (its timeout job was lost): close it like a timeout first.
    if (row.dispatchStatus === 'assigned' && row.dispatchDeliveryPartnerId) {
      await expireRiderOffer(row, row.dispatchDeliveryPartnerId);
      row = await prisma.foodOrder.findUnique({ where: { id }, include: dispatchInclude });
    }

    const offers = row.dispatchOffers || [];
    const neverAgain = new Set(
      offers.filter((o) => o.action === 'deassigned').map((o) => String(o.partnerId)),
    );
    const lastRound = offers.reduce((max, o) => Math.max(max, Number(o.round) || 1), 0);
    const round = options.newRound && lastRound > 0 ? lastRound + 1 : Math.max(lastRound, 1);
    const askedThisRound = new Set(
      offers.filter((o) => (Number(o.round) || 1) === round).map((o) => String(o.partnerId)),
    );

    // The radius widens with the time spent looking, whoever calls: 15 km for
    // the first window, then 25, 40 and 60 km.
    const firstOfferAt = offers.length ? Math.min(...offers.map((o) => new Date(o.at).getTime())) : Date.now();
    const attempt = Math.max(
      Number(options.attempt) || 1,
      Math.floor((Date.now() - firstOfferAt) / windowMs) + 1,
    );
    let maxKm = 15;
    if (attempt === 2) maxKm = 25;
    if (attempt === 3) maxKm = 40;
    if (attempt >= 4) maxKm = 60;

    // Admin alert after ~6 windows with nobody on it. Only from the timeout
    // job, so a run of quick rejects does not repeat it.
    if (attempt >= 6 && options.fromJob) {
      logger.error(`[CRITICAL] Order ${id} unassigned after ${attempt} offer windows. Alerting admin.`);
      try {
        await notifyOwnersSafely([{ ownerType: 'ADMIN', ownerId: 'GLOBAL' }], {
          title: 'Unassigned Order Crisis!',
          body: `Order #${order.order_id || id} has not been picked up for 5+ minutes. Manual intervention required!`,
          data: { type: 'admin_alert_unassigned', orderId: id },
        });
      } catch (err) {
        logger.warn(`Admin notification failed: ${err.message}`);
      }
    }

    const { partners } = await listNearbyOnlineDeliveryPartners(row.restaurant, { maxKm, limit: 25 });
    const [busy, holdingOffer] = await Promise.all([
      getBusyDeliveryPartnerIds(),
      getRidersHoldingAnOffer(id, windowMs),
    ]);
    // Riders at their cash ceiling are skipped for cash-collect orders only.
    const cashBlocked = orderCollectsCash(order)
      ? await getCashBlockedPartnerIds(partners.map((p) => p.partnerId))
      : new Set();
    if (cashBlocked.size > 0) {
      logger.warn(
        `[Dispatch] ${cashBlocked.size} rider(s) skipped for order ${id}: cash-in-hand at or above the configured limit.`,
      );
    }

    // Nearest first (listNearbyOnlineDeliveryPartners sorts by distance).
    const free = partners.filter((p) => {
      const key = String(p.partnerId);
      return !neverAgain.has(key) && !busy.has(key) && !holdingOffer.has(key) && !cashBlocked.has(key);
    });
    const next = free.find((p) => !askedThisRound.has(String(p.partnerId)));

    if (!next) {
      // Nobody left to ask this round. Look again in one window; if free riders
      // are around and all said no, that look starts the next round.
      const roundOver = free.length > 0;
      logger.info(
        `tryAutoAssign: no rider to ask for ${id} in ${maxKm}km (round ${round}${roundOver ? ', everyone asked' : ''}).`,
      );
      await addOrderJob(
        { action: 'DISPATCH_TIMEOUT_CHECK', orderMongoId: id, orderId: id, attempt: attempt + 1, newRound: roundOver },
        { delay: windowMs },
      );
      return order;
    }

    const basePayload = buildDeliverySocketPayload(order, row.restaurant);
    const payload = await enrichPayloadWithTripRoadDistance(order, basePayload);

    // The order becomes this rider's offer, and only theirs: acceptOrderDelivery
    // lets the assigned rider claim it. Conditional, NOT a blind write -- a
    // rider may have accepted during the awaits above.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + windowMs);
    const offer = await prisma.$transaction(async (tx) => {
      const { count } = await tx.foodOrder.updateMany({
        where: { id, dispatchStatus: 'unassigned', dispatchAcceptedAt: null },
        data: {
          dispatchStatus: 'assigned',
          dispatchDeliveryPartnerId: String(next.partnerId),
          dispatchAssignedAt: now,
        },
      });
      if (count === 0) return null;
      return tx.orderDispatchOffer.create({
        data: { orderId: id, partnerId: String(next.partnerId), at: now, action: 'offered', expiresAt, round },
      });
    });
    if (!offer) {
      logger.info(`tryAutoAssign: order ${id} was taken during dispatch -- leaving it.`);
      return order;
    }

    logger.info(
      `Offering order ${id} to rider ${next.partnerId} (${next.distanceKm.toFixed(2)} km, round ${round}) for ${riderAcceptWindowSeconds}s.`,
    );

    const offerFields = { offerId: offer.id, offerExpiresAt: expiresAt, acceptanceDeadlineAt: expiresAt };
    const io = getIO();
    if (io) {
      io.to(rooms.delivery(next.partnerId)).emit('new_order', {
        ...payload,
        ...offerFields,
        pickupDistanceKm: next.distanceKm,
      });
    }

    try {
      await notifyOwnersActionableAlert([{ ownerType: 'DELIVERY_PARTNER', ownerId: next.partnerId }], {
        title: 'New order available!',
        body: `Order #${order.order_id || id} is available. You have ${riderAcceptWindowSeconds} seconds to accept!`,
        // Two messages — see notifyOwnersActionableAlert. This alert needs the
        // app's own full-screen UI (only a data-only message triggers it) AND
        // delivery on ROMs that refuse to start the app (only a notification
        // block achieves that). Blending them loses the first.
        //
        // The tag is the contract with the app (cancel(0, tag:) in
        // fcm_service.dart) — change one and you must change the other.
        androidTag: `order_${id}`,
        // The app's incoming channel is the _v3 id; the service default is the
        // stale v1 name, and Android silently downgrades an unknown channel to
        // low importance — no sound, no heads-up.
        androidChannelId: 'incoming_orders_channel_v3',
        data: {
          ...buildIncomingOrderPushData(order, payload, expiresAt, windowMs),
          offerId: offer.id,
          offerExpiresAt: expiresAt.toISOString(),
          pickupDistanceKm: String(Number(next.distanceKm.toFixed(2))),
        },
      });
    } catch (err) {
      logger.warn(`Offer push failed for order ${id}: ${err.message}`);
    }

    // When the window closes with no answer, the next rider is asked.
    await addOrderJob(
      {
        action: 'DISPATCH_TIMEOUT_CHECK',
        orderMongoId: id,
        orderId: id,
        partnerId: String(next.partnerId),
        offerId: offer.id,
        attempt: attempt + 1,
      },
      { delay: windowMs },
    );

    return order;
  } finally {
    await prisma.foodOrder.update({ where: { id }, data: { dispatchingAt: null } }).catch(() => {});
  }
}

/**
 * The DISPATCH_TIMEOUT_CHECK job. With a partnerId: that rider's offer window
 * closed -- if they still have not answered, the offer times out, their popup
 * is closed and the next rider is asked. Without one: a scheduled look for a
 * rider while nobody was available.
 */
export async function processDispatchTimeout(orderId, partnerId, options = {}) {
  const id = String(orderId);
  const row = await prisma.foodOrder.findUnique({ where: { id }, include: orderInclude });
  if (!row) return;
  if (row.dispatchStatus === 'accepted' || TERMINAL_ORDER_STATUSES.includes(row.orderStatus)) return;

  const attempt = Number(options.attempt) || (row.dispatchOffers?.length || 0) + 1;

  if (partnerId) {
    const stillTheirs =
      row.dispatchStatus === 'assigned' &&
      String(row.dispatchDeliveryPartnerId) === String(partnerId) &&
      !row.dispatchAcceptedAt;
    if (!stillTheirs) return; // answered already, or the order moved on

    // A job from an older offer to the same rider (asked again in a later round).
    if (options.offerId) {
      const offer = (row.dispatchOffers || []).find((o) => o.id === options.offerId);
      if (!offer || offer.action !== 'offered') return;
    }

    logger.info(`Offer to rider ${partnerId} on order ${id} timed out. Asking the next rider.`);
    const expired = await expireRiderOffer(row, partnerId, options.offerId || null);
    if (!expired) return; // accepted at the last moment

    // reason/partnerId only matter in a manual zone: they tell the admins who
    // let the order time out.
    await tryAutoAssign(id, { attempt, reason: 'timeout', partnerId, fromJob: true });
  } else if (row.dispatchStatus === 'unassigned') {
    await tryAutoAssign(id, { attempt, newRound: Boolean(options.newRound), fromJob: true });
  }
}

/** Shared by the restaurant and admin resend endpoints. */
async function resetDispatchAndRehunt(row, activeStatuses) {
  if (!activeStatuses.includes(row.orderStatus)) {
    throw new ValidationError(`Cannot resend notification for order in status: ${row.orderStatus}`);
  }
  if (row.dispatchStatus === 'accepted') {
    throw new ValidationError('A delivery partner has already accepted this order.');
  }

  await prisma.$transaction([
    prisma.orderDispatchOffer.deleteMany({ where: { orderId: row.id } }),
    prisma.foodOrder.update({
      where: { id: row.id },
      data: { dispatchStatus: 'unassigned', dispatchDeliveryPartnerId: null },
    }),
  ]);

  await tryAutoAssign(row.id);
  return { success: true };
}

export async function resendDeliveryNotificationRestaurant(orderId, restaurantId) {
  const identity = buildOrderIdentityFilter(orderId);
  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, restaurantId: String(restaurantId) },
    select: { id: true, orderStatus: true, dispatchStatus: true },
  });
  if (!row) throw new NotFoundError('Order not found');

  return resetDispatchAndRehunt(row, ['confirmed', 'preparing', 'ready_for_pickup', 'ready']);
}

export async function resendDeliveryNotificationAdmin(orderId) {
  const identity = buildOrderIdentityFilter(orderId);
  const row = await prisma.foodOrder.findFirst({
    where: identity,
    select: { id: true, orderStatus: true, dispatchStatus: true },
  });
  if (!row) throw new NotFoundError('Order not found');

  if (row.dispatchStatus === 'accepted') {
    throw new ValidationError(
      'A delivery partner has already accepted this order. Please use Deassign & Resend instead.',
    );
  }

  return resetDispatchAndRehunt(row, [
    'confirmed', 'preparing', 'ready_for_pickup', 'ready', 'reached_pickup',
  ]);
}
