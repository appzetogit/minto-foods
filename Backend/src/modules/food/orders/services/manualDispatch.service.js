import { prisma } from '../../../../config/prisma.js';
import { toOrder, orderInclude } from '../order.mapper.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { addOrderJob } from '../../../../queues/producers/order.producer.js';
import { runUnscoped } from '../../../../core/roles/adminScope.context.js';
import {
  buildDeliverySocketPayload,
  getBusyDeliveryPartnerIds,
  haversineKm,
  notifyOwnersActionableAlert,
  pushStatusHistory,
} from './order.helpers.js';
import {
  buildIncomingOrderPushData,
  enrichPayloadWithTripRoadDistance,
  getCashBlockedPartnerIds,
  getDispatchSettings,
  orderCollectsCash,
  tryAutoAssign,
} from './order-dispatch.service.js';

/**
 * Manual rider assignment.
 *
 * A zone (or the whole platform) can be set to 'manual': orders there are never
 * offered to riders automatically. They wait in the admin panel's Assign rider
 * queue; an admin picks a rider from that zone, the rider gets the usual
 * accept popup, and if they decline or don't answer the order comes back to
 * the queue. Mode = the zone's own setting, else the global one, else 'auto'.
 */

/** Statuses an order can be given a rider in -- the same as automatic dispatch. */
const DISPATCHABLE = ['confirmed', 'preparing', 'ready_for_pickup', 'ready', 'reached_pickup', 'picked_up', 'reached_drop'];
/** What an admin may assign a rider to: before pickup. */
const ASSIGNABLE = ['confirmed', 'preparing', 'ready_for_pickup'];

// ---- which mode applies ------------------------------------------------------

const CACHE_MS = 30_000;
let modeCache = { at: 0, value: null };

export function clearDispatchModeCache() {
  modeCache = { at: 0, value: null };
}

async function loadModes() {
  if (modeCache.value && Date.now() - modeCache.at < CACHE_MS) return modeCache.value;
  const [settings, zones] = await Promise.all([
    getDispatchSettings(),
    runUnscoped(() =>
      prisma.foodZone.findMany({ where: { dispatchMode: { not: null } }, select: { id: true, dispatchMode: true } }),
    ),
  ]);
  const zoneModes = new Map(zones.map((z) => [z.id, z.dispatchMode === 'manual' ? 'manual' : 'auto']));
  modeCache = { at: Date.now(), value: { global: settings.dispatchMode, settings, zoneModes } };
  return modeCache.value;
}

export async function getDispatchModeForZone(zoneId) {
  const { global, zoneModes } = await loadModes();
  return (zoneId && zoneModes.get(String(zoneId))) || global || 'auto';
}

export async function isManualForOrder(orderId) {
  const row = await runUnscoped(() =>
    prisma.foodOrder.findUnique({ where: { id: String(orderId) }, select: { zoneId: true } }),
  );
  if (!row) return false;
  return (await getDispatchModeForZone(row.zoneId)) === 'manual';
}

/**
 * Which orders are in manual mode, as a Prisma filter.
 * `{ kind: 'none' }` -- no order is manual; `{ kind: 'all' }` -- every order;
 * `{ kind: 'some', where }` -- only those matching `where`.
 */
export async function manualOrderFilter() {
  const { global, zoneModes } = await loadModes();
  if (global === 'manual') {
    const autoZones = [...zoneModes].filter(([, m]) => m === 'auto').map(([id]) => id);
    if (!autoZones.length) return { kind: 'all' };
    return { kind: 'some', where: { OR: [{ zoneId: null }, { zoneId: { notIn: autoZones } }] } };
  }
  const manualZones = [...zoneModes].filter(([, m]) => m === 'manual').map(([id]) => id);
  if (!manualZones.length) return { kind: 'none' };
  return { kind: 'some', where: { zoneId: { in: manualZones } } };
}

// ---- telling admins ------------------------------------------------------------

/** Super admins, plus sub-admins who look after the zone's city. */
async function zoneAdminTargets(zoneId) {
  return runUnscoped(async () => {
    const zone = zoneId
      ? await prisma.foodZone.findUnique({ where: { id: String(zoneId) }, select: { cityId: true } })
      : null;
    const admins = await prisma.foodAdmin.findMany({
      where: {
        isActive: true,
        isDeleted: false,
        OR: [
          { adminType: 'super_admin' },
          ...(zone?.cityId ? [{ cities: { some: { cityId: zone.cityId } } }] : []),
        ],
      },
      select: { id: true },
    });
    return admins.map((a) => ({ ownerType: 'ADMIN', ownerId: a.id }));
  });
}

function emitToAdmins(event, zoneId, payload) {
  try {
    const io = getIO();
    if (!io) return;
    let target = io.to(rooms.adminOrdersAll());
    if (zoneId) target = target.to(rooms.adminOrdersZone(zoneId));
    target.emit(event, payload);
  } catch (err) {
    logger.warn(`Admin dispatch emit failed: ${err?.message || err}`);
  }
}

async function alertAdmins(row, { title, body, reason }) {
  const payload = {
    orderId: row.id,
    orderMongoId: row.id,
    displayOrderId: row.order_id || row.orderId || '',
    zoneId: row.zoneId || null,
    restaurantName: row.restaurant?.restaurantName || '',
    reason: reason || 'new',
    message: body,
    waitingSince: row.awaitingManualAt || new Date(),
  };
  emitToAdmins('order_needs_assignment', row.zoneId, payload);
  try {
    const { sendNotificationToOwners } = await import('../../../../core/notifications/firebase.service.js');
    const targets = await zoneAdminTargets(row.zoneId);
    if (targets.length) {
      await sendNotificationToOwners(targets, {
        title,
        body,
        data: { type: 'order_needs_assignment', orderId: row.id, link: '/admin/food/dispatch/assign' },
      });
    }
  } catch (err) {
    logger.warn(`Manual dispatch admin push failed for ${row.id}: ${err?.message || err}`);
  }
}

// ---- the queue ---------------------------------------------------------------

/**
 * Called by tryAutoAssign for a manual-mode order: put it in (or keep it in)
 * the admin queue instead of offering it to riders. Admins are alerted when it
 * first arrives and whenever a rider declines or lets it time out -- not on
 * every background re-check.
 */
export async function enterManualQueue(orderId, options = {}) {
  const id = String(orderId);
  const row = await runUnscoped(() =>
    prisma.foodOrder.findUnique({
      where: { id },
      select: {
        id: true, order_id: true, orderId: true, zoneId: true, orderStatus: true,
        dispatchStatus: true, awaitingManualAt: true,
        restaurant: { select: { restaurantName: true } },
      },
    }),
  );
  if (!row || row.dispatchStatus === 'accepted' || !DISPATCHABLE.includes(row.orderStatus)) return null;

  const firstTime = !row.awaitingManualAt;
  if (firstTime) {
    await prisma.foodOrder.updateMany({ where: { id, awaitingManualAt: null }, data: { awaitingManualAt: new Date() } });
    row.awaitingManualAt = new Date();
  }

  const display = row.order_id || row.orderId || id;
  if (options.reason === 'declined' || options.reason === 'timeout') {
    const rider = options.partnerId
      ? await prisma.foodDeliveryPartner.findUnique({ where: { id: String(options.partnerId) }, select: { name: true } })
      : null;
    const who = rider?.name || 'The rider';
    const what = options.reason === 'declined' ? 'declined' : "didn't respond to";
    await alertAdmins(row, {
      title: 'Order needs a rider',
      body: `${who} ${what} order #${display}. Please assign another rider.`,
      reason: options.reason,
    });
  } else if (firstTime) {
    await alertAdmins(row, {
      title: 'Order needs a rider',
      body: `Order #${display} from ${row.restaurant?.restaurantName || 'a restaurant'} is waiting for a rider to be assigned.`,
      reason: 'new',
    });
  }
  return row;
}

/** Orders waiting for an admin to assign (or for an assigned rider to accept). */
export async function listManualQueue() {
  const filter = await manualOrderFilter();
  if (filter.kind === 'none') return { orders: [] };

  const settings = await getDispatchSettings();
  const rows = await prisma.foodOrder.findMany({
    where: {
      orderStatus: { in: ASSIGNABLE },
      dispatchAcceptedAt: null,
      dispatchStatus: { in: ['unassigned', 'assigned'] },
      ...(filter.kind === 'some' ? filter.where : {}),
    },
    select: {
      id: true, order_id: true, orderId: true, orderStatus: true, dispatchStatus: true,
      dispatchDeliveryPartnerId: true, dispatchAssignedAt: true, awaitingManualAt: true, createdAt: true,
      paymentMethod: true, total: true, zoneId: true, addrStreet: true, addrCity: true,
      isForSomeoneElse: true,
      restaurant: { select: { restaurantName: true, area: true } },
      zone: { select: { name: true } },
      items: { select: { name: true, quantity: true } },
      dispatchOffers: {
        where: { action: { in: ['rejected', 'timeout', 'offered'] } },
        select: { partnerId: true, action: true, at: true, partner: { select: { name: true } } },
        orderBy: { at: 'desc' },
      },
    },
    orderBy: [{ awaitingManualAt: 'asc' }, { createdAt: 'asc' }],
    take: 300,
  });

  const now = Date.now();
  return {
    alertMinutes: settings.manualQueueAlertMinutes,
    acceptWindowSeconds: settings.manualAcceptWindowSeconds,
    orders: rows.map((r) => {
      const assigned = r.dispatchStatus === 'assigned' && r.dispatchDeliveryPartnerId
        ? r.dispatchOffers.find((o) => o.partnerId === r.dispatchDeliveryPartnerId && o.action === 'offered')
        : null;
      const since = r.awaitingManualAt || r.createdAt;
      return {
        id: r.id,
        displayId: r.order_id || r.orderId || r.id,
        orderStatus: r.orderStatus,
        restaurantName: r.restaurant?.restaurantName || '',
        restaurantArea: r.restaurant?.area || '',
        zoneId: r.zoneId,
        zoneName: r.zone?.name || '',
        dropArea: [r.addrStreet, r.addrCity].filter(Boolean).join(', '),
        paymentMethod: r.paymentMethod,
        total: Number(r.total) || 0,
        isForSomeoneElse: r.isForSomeoneElse,
        items: r.items.map((i) => `${i.quantity} x ${i.name}`),
        waitingSince: since,
        waitingMinutes: Math.floor((now - new Date(since).getTime()) / 60000),
        assignedTo: assigned
          ? {
              id: r.dispatchDeliveryPartnerId,
              name: assigned.partner?.name || '',
              assignedAt: r.dispatchAssignedAt,
              deadlineAt: new Date(new Date(r.dispatchAssignedAt).getTime() + settings.manualAcceptWindowSeconds * 1000),
            }
          : null,
        declinedBy: r.dispatchOffers
          .filter((o) => o.action === 'rejected' || o.action === 'timeout')
          .map((o) => ({ id: o.partnerId, name: o.partner?.name || '', action: o.action, at: o.at })),
      };
    }),
  };
}

// ---- choosing a rider ----------------------------------------------------------

async function loadOrderForAssign(orderId) {
  const row = await prisma.foodOrder.findUnique({
    where: { id: String(orderId) },
    include: { ...orderInclude, restaurant: true, zone: { select: { id: true, name: true, cityId: true, cityRef: { select: { name: true } } } } },
  });
  if (!row) throw new NotFoundError('Order not found');
  return row;
}

/** Riders whose last location is inside the zone's boundary. */
async function riderIdsInsideZone(zoneId) {
  if (!zoneId) return new Set();
  const rows = await prisma.$queryRaw`
    SELECT p."id"
    FROM "food_delivery_partners" p
    JOIN "food_zones" z ON z."id" = ${String(zoneId)}
    WHERE p."status" = 'approved'
      AND p."lastLat" IS NOT NULL AND p."lastLng" IS NOT NULL
      AND z."boundary" IS NOT NULL
      AND ST_Contains(z."boundary"::geometry, ST_SetSRID(ST_MakePoint(p."lastLng", p."lastLat"), 4326))
  `;
  return new Set(rows.map((r) => r.id));
}

const startOfTodayIst = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + 330 * 60000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 330 * 60000);
};

/**
 * Riders an admin can pick for an order: approved riders inside the order's
 * zone right now, then riders from the zone's city who are elsewhere. Each
 * says whether they can be assigned and why not.
 */
export async function listEligibleRiders(orderId, { includeOffline = false } = {}) {
  const row = await loadOrderForAssign(orderId);
  const order = toOrder(row);
  const zoneId = row.zoneId;
  const cityName = row.zone?.cityRef?.name || row.zone?.name || '';

  const [inside, cityRiders] = await Promise.all([
    riderIdsInsideZone(zoneId),
    cityName
      ? prisma.foodDeliveryPartner.findMany({
          where: { status: 'approved', city: { equals: cityName, mode: 'insensitive' } },
          select: { id: true },
        })
      : [],
  ]);
  const ids = [...new Set([...inside, ...cityRiders.map((r) => r.id)])];
  if (!ids.length) return { order: { id: row.id, zoneName: row.zone?.name || '' }, riders: [] };

  const [partners, busy, cashBlocked, wallets, todayCounts] = await Promise.all([
    prisma.foodDeliveryPartner.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, phone: true, city: true, availabilityStatus: true, lastLat: true, lastLng: true, lastLocationAt: true, rating: true, vehicleType: true },
    }),
    getBusyDeliveryPartnerIds(),
    orderCollectsCash(order) ? getCashBlockedPartnerIds(ids) : new Set(),
    prisma.wallet.findMany({ where: { entityType: 'deliveryBoy', entityId: { in: ids } }, select: { entityId: true, cashInHand: true } }),
    prisma.foodOrder.groupBy({
      by: ['dispatchDeliveryPartnerId'],
      where: { dispatchDeliveryPartnerId: { in: ids }, orderStatus: 'delivered', deliveredAt: { gte: startOfTodayIst() } },
      _count: { _all: true },
    }),
  ]);
  const cash = new Map(wallets.map((w) => [w.entityId, Number(w.cashInHand) || 0]));
  const today = new Map(todayCounts.map((c) => [c.dispatchDeliveryPartnerId, c._count._all]));
  const declined = new Set(
    (row.dispatchOffers || []).filter((o) => ['rejected', 'timeout'].includes(o.action)).map((o) => o.partnerId),
  );
  const rLat = Number(row.restaurant?.latitude);
  const rLng = Number(row.restaurant?.longitude);

  const riders = partners.map((p) => {
    const online = p.availabilityStatus === 'online';
    const isInside = inside.has(p.id);
    const reasons = [];
    if (!online) reasons.push('Offline');
    if (busy.has(p.id)) reasons.push('On another delivery');
    if (cashBlocked.has(p.id)) reasons.push('Cash limit reached');
    const distanceKm =
      Number.isFinite(rLat) && p.lastLat != null ? Math.round(haversineKm(rLat, rLng, p.lastLat, p.lastLng) * 10) / 10 : null;
    return {
      id: p.id,
      name: p.name,
      phone: p.phone,
      city: p.city,
      vehicleType: p.vehicleType,
      rating: Number(p.rating) || 0,
      online,
      insideZone: isInside,
      busy: busy.has(p.id),
      cashInHand: cash.get(p.id) || 0,
      cashBlocked: cashBlocked.has(p.id),
      deliveredToday: today.get(p.id) || 0,
      distanceKm,
      lastLocationAt: p.lastLocationAt,
      declinedThisOrder: declined.has(p.id),
      currentlyAssigned: row.dispatchDeliveryPartnerId === p.id && row.dispatchStatus === 'assigned',
      assignable: reasons.length === 0,
      // Outside the zone is allowed only with an override and a reason.
      needsOverride: reasons.length === 0 && !isInside,
      notAssignableReason: reasons.join(', '),
    };
  });

  const rank = (r) => (r.assignable ? 0 : 2) + (r.insideZone ? 0 : 1);
  riders.sort(
    (a, b) => rank(a) - rank(b) || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || a.name.localeCompare(b.name),
  );
  return {
    order: { id: row.id, displayId: row.order_id || row.id, zoneId, zoneName: row.zone?.name || '', restaurantName: row.restaurant?.restaurantName || '' },
    riders: includeOffline ? riders : riders.filter((r) => r.online),
  };
}

// ---- assigning -------------------------------------------------------------------

async function notifyRiderOfAssignment(row, partnerId, windowMs) {
  const order = toOrder(row);
  const basePayload = buildDeliverySocketPayload(order, row.restaurant);
  const payload = await enrichPayloadWithTripRoadDistance(order, basePayload);
  const acceptanceDeadlineAt = new Date(Date.now() + windowMs);
  try {
    getIO()?.to(rooms.delivery(partnerId)).emit('new_order', {
      ...payload,
      acceptanceDeadlineAt,
      acceptTimeoutSeconds: Math.round(windowMs / 1000),
      assignedByAdmin: true,
    });
  } catch (err) {
    logger.warn(`Assign socket failed: ${err?.message || err}`);
  }
  try {
    await notifyOwnersActionableAlert([{ ownerType: 'DELIVERY_PARTNER', ownerId: partnerId }], {
      title: 'New order assigned to you',
      body: `Order #${row.order_id || row.id} has been assigned to you. Tap to accept.`,
      androidTag: `order_${row.id}`,
      androidChannelId: 'incoming_orders_channel_v3',
      data: buildIncomingOrderPushData(order, payload, acceptanceDeadlineAt, windowMs),
    });
  } catch (err) {
    logger.warn(`Assign push failed for ${row.id}: ${err?.message || err}`);
  }
}

/**
 * Tell a rider their pending assignment was taken back. 'order_deassigned' is
 * the event the shipped rider app already listens for: it closes the accept
 * popup for that order, so no app update is needed.
 */
function tellRiderWithdrawn(partnerId, row) {
  try {
    getIO()?.to(rooms.delivery(partnerId)).emit('order_deassigned', {
      orderId: row.id,
      orderMongoId: row.id,
      message: `Order #${row.order_id || row.id} is no longer assigned to you.`,
    });
  } catch {
    /* best effort */
  }
}

/**
 * An admin gives an order to a rider. The rider gets the same accept popup as
 * an automatic offer, with the manual accept window; declining or not
 * answering brings the order back to the queue.
 */
export async function assignRiderManually(orderId, partnerId, adminId, { force = false, reason = '' } = {}) {
  const row = await loadOrderForAssign(orderId);
  if (!ASSIGNABLE.includes(row.orderStatus)) {
    throw new ValidationError(`An order that is ${row.orderStatus.replace(/_/g, ' ')} can't be assigned a rider`);
  }
  if (row.dispatchStatus === 'accepted' || row.dispatchAcceptedAt) {
    throw new ValidationError('A rider has already accepted this order');
  }

  const { riders } = await listEligibleRiders(row.id, { includeOffline: true });
  const pick = riders.find((r) => r.id === String(partnerId));
  if (!pick) {
    if (!force) throw new ValidationError("This rider isn't in the order's zone or city");
  } else if (!pick.assignable) {
    throw new ValidationError(`Can't assign ${pick.name}: ${pick.notAssignableReason}`);
  }
  if ((!pick || pick.needsOverride) && !force) {
    throw new ValidationError(`${pick?.name || 'This rider'} is outside the zone right now. Assign anyway with a reason.`);
  }
  if (force && !String(reason || '').trim()) {
    throw new ValidationError('Give a reason for assigning a rider from outside the zone');
  }
  const partner = pick
    ? { id: pick.id, name: pick.name }
    : await prisma.foodDeliveryPartner.findFirst({
        where: { id: String(partnerId), status: 'approved', availabilityStatus: 'online' },
        select: { id: true, name: true },
      });
  if (!partner) throw new ValidationError('That rider is not available');

  const settings = await getDispatchSettings();
  const windowMs = settings.manualAcceptWindowSeconds * 1000;
  const previous = row.dispatchStatus === 'assigned' ? row.dispatchDeliveryPartnerId : null;
  if (previous === partner.id) throw new ValidationError(`${partner.name} is already assigned this order`);

  // Only from the state we just read: two admins assigning at once can't both win.
  const { count } = await prisma.foodOrder.updateMany({
    where: {
      id: row.id,
      dispatchAcceptedAt: null,
      dispatchStatus: row.dispatchStatus,
      dispatchDeliveryPartnerId: row.dispatchDeliveryPartnerId,
    },
    data: {
      dispatchStatus: 'assigned',
      dispatchDeliveryPartnerId: partner.id,
      dispatchAssignedAt: new Date(),
      awaitingManualAt: row.awaitingManualAt || new Date(),
    },
  });
  if (!count) throw new ValidationError('This order was just assigned or accepted. Refresh and try again.');

  if (previous) {
    await prisma.orderDispatchOffer.updateMany({
      where: { orderId: row.id, partnerId: previous, action: 'offered' },
      data: { action: 'withdrawn' },
    });
    tellRiderWithdrawn(previous, row);
  }
  await prisma.orderDispatchOffer.create({ data: { orderId: row.id, partnerId: partner.id, action: 'offered' } });
  await pushStatusHistory(row.id, {
    byRole: 'ADMIN',
    byId: adminId,
    from: row.orderStatus,
    to: row.orderStatus,
    note: `Rider ${partner.name} assigned by admin${force ? ` (outside zone: ${String(reason).trim()})` : ''}`,
  });

  const fresh = await loadOrderForAssign(row.id);
  await notifyRiderOfAssignment(fresh, partner.id, windowMs);
  await addOrderJob(
    { action: 'DISPATCH_TIMEOUT_CHECK', orderMongoId: row.id, orderId: row.id, partnerId: partner.id, manual: true },
    { delay: windowMs },
  );
  emitToAdmins('order_assignment_update', row.zoneId, { orderId: row.id, assignedTo: partner });

  return {
    orderId: row.id,
    assignedTo: partner,
    deadlineAt: new Date(Date.now() + windowMs),
  };
}

/** Take back an assignment the rider hasn't accepted; the order stays queued. */
export async function withdrawManualAssignment(orderId, adminId) {
  const row = await loadOrderForAssign(orderId);
  if (row.dispatchStatus !== 'assigned' || !row.dispatchDeliveryPartnerId || row.dispatchAcceptedAt) {
    throw new ValidationError('No pending assignment to cancel');
  }
  const partnerId = row.dispatchDeliveryPartnerId;
  const { count } = await prisma.foodOrder.updateMany({
    where: { id: row.id, dispatchStatus: 'assigned', dispatchDeliveryPartnerId: partnerId, dispatchAcceptedAt: null },
    data: { dispatchStatus: 'unassigned', dispatchDeliveryPartnerId: null, dispatchAssignedAt: null },
  });
  if (!count) throw new ValidationError('The rider has just accepted or the order changed. Refresh.');
  await prisma.orderDispatchOffer.updateMany({
    where: { orderId: row.id, partnerId, action: 'offered' },
    data: { action: 'withdrawn' },
  });
  tellRiderWithdrawn(partnerId, row);
  await pushStatusHistory(row.id, {
    byRole: 'ADMIN',
    byId: adminId,
    from: row.orderStatus,
    to: row.orderStatus,
    note: 'Rider assignment cancelled by admin',
  });
  emitToAdmins('order_assignment_update', row.zoneId, { orderId: row.id, assignedTo: null });
  return { orderId: row.id, withdrawn: true };
}

// ---- zone switches, sweeps and reminders -------------------------------------------

/** A zone's own mode: 'auto', 'manual', or null to follow the global default. */
export async function setZoneDispatchMode(zoneId, mode) {
  const value = mode === 'manual' || mode === 'auto' ? mode : null;
  const before = await getDispatchModeForZone(zoneId);
  const { count } = await prisma.foodZone.updateMany({ where: { id: String(zoneId) }, data: { dispatchMode: value } });
  if (!count) throw new NotFoundError('Zone not found');
  clearDispatchModeCache();
  const after = await getDispatchModeForZone(zoneId);
  if (before === 'manual' && after === 'auto') {
    void sweepWaitingOrdersToAuto(zoneId).catch((err) => logger.warn(`Zone dispatch sweep failed: ${err?.message || err}`));
  }
  return { zoneId: String(zoneId), dispatchMode: value, effectiveMode: after };
}

export async function listZoneDispatchModes() {
  const [{ global, settings }, zones] = await Promise.all([
    loadModes(),
    prisma.foodZone.findMany({
      where: { isActive: true },
      select: { id: true, name: true, dispatchMode: true, cityRef: { select: { name: true } } },
      orderBy: { name: 'asc' },
    }),
  ]);
  return {
    ...settings,
    dispatchMode: global,
    zones: zones.map((z) => ({
      id: z.id,
      name: z.name,
      city: z.cityRef?.name || '',
      dispatchMode: z.dispatchMode || null,
      effectiveMode: z.dispatchMode || global,
    })),
  };
}

/** A zone went back to automatic: offer its waiting orders to riders now. */
export async function sweepWaitingOrdersToAuto(zoneId = null) {
  const rows = await runUnscoped(() =>
    prisma.foodOrder.findMany({
      where: {
        awaitingManualAt: { not: null },
        dispatchAcceptedAt: null,
        dispatchStatus: 'unassigned',
        orderStatus: { in: ASSIGNABLE },
        ...(zoneId ? { zoneId: String(zoneId) } : {}),
      },
      select: { id: true, zoneId: true },
    }),
  );
  let swept = 0;
  for (const r of rows) {
    if ((await getDispatchModeForZone(r.zoneId)) !== 'auto') continue;
    await prisma.foodOrder.update({ where: { id: r.id }, data: { awaitingManualAt: null } });
    await tryAutoAssign(r.id).catch((err) => logger.warn(`Sweep auto-assign failed for ${r.id}: ${err?.message || err}`));
    swept += 1;
  }
  return { swept };
}

/** Every few minutes: remind admins of orders that have waited too long. */
export async function remindStaleManualQueue() {
  const settings = await getDispatchSettings();
  const cutoff = new Date(Date.now() - settings.manualQueueAlertMinutes * 60000);
  const rows = await runUnscoped(() =>
    prisma.foodOrder.findMany({
      where: {
        awaitingManualAt: { lt: cutoff },
        dispatchAcceptedAt: null,
        dispatchStatus: 'unassigned',
        orderStatus: { in: ASSIGNABLE },
      },
      select: {
        id: true, order_id: true, orderId: true, zoneId: true, awaitingManualAt: true,
        restaurant: { select: { restaurantName: true } },
      },
      take: 100,
    }),
  );
  for (const r of rows) {
    if ((await getDispatchModeForZone(r.zoneId)) !== 'manual') continue;
    const mins = Math.floor((Date.now() - new Date(r.awaitingManualAt).getTime()) / 60000);
    await alertAdmins(r, {
      title: 'Order still needs a rider',
      body: `Order #${r.order_id || r.orderId || r.id} has waited ${mins} min for a rider. Please assign one.`,
      reason: 'reminder',
    });
  }
  return { reminded: rows.length };
}

