/**
 * Pure timing maths for the pickup handover and the admin order timeline,
 * shared by the order mapper (every app) and the overdue check.
 *
 * Handover: once the restaurant marks an order ready, the rider has
 * HANDOVER_SECONDS to take it. The restaurant, the rider and the admin panel
 * all count down to the same `dueAt`, and anything after it is a handover
 * delay the team can chase.
 */
export const HANDOVER_SECONDS = 60;

/** Undelivered this long after it was placed and the order counts as stuck. */
export const STUCK_AFTER_MINUTES = 90;

const OPEN = ['created', 'confirmed', 'preparing', 'ready_for_pickup', 'picked_up'];

const at = (v) => {
  const d = v ? new Date(v) : null;
  return d && Number.isFinite(d.getTime()) ? d : null;
};

const firstTo = (history, ...statuses) =>
  at((history || []).find((h) => statuses.includes(h?.to))?.at);

/** The handover block, or null before the order is ready. */
export function handoverInfo(order, now = new Date()) {
  const history = order?.statusHistory || [];
  const readyAt = firstTo(history, 'ready_for_pickup');
  if (!readyAt) return null;
  const dueAt = new Date(readyAt.getTime() + HANDOVER_SECONDS * 1000);
  const pickedUpAt = at(order?.pickedUpAt ?? order?.deliveryState?.pickedUpAt)
    || firstTo(history, 'picked_up');
  const end = pickedUpAt || (OPEN.includes(String(order?.orderStatus)) ? now : null);
  const lateBySeconds = end ? Math.max(0, Math.round((end - dueAt) / 1000)) : 0;
  return {
    seconds: HANDOVER_SECONDS,
    readyAt: readyAt.toISOString(),
    dueAt: dueAt.toISOString(),
    riderArrivedAt: at(order?.reachedPickupAt ?? order?.deliveryState?.reachedPickupAt)?.toISOString() || null,
    pickedUpAt: pickedUpAt ? pickedUpAt.toISOString() : null,
    // Still waiting and past due, or picked up after due.
    late: lateBySeconds > 0,
    lateBySeconds,
  };
}

/** Whether an undelivered order has been open far longer than any delivery takes. */
export function stuckInfo(order, now = new Date()) {
  if (!OPEN.includes(String(order?.orderStatus))) return null;
  const placed = at(order?.createdAt);
  if (!placed) return null;
  const expected = at(order?.estimatedDeliveryAt);
  const limit = new Date(Math.max(
    placed.getTime() + STUCK_AFTER_MINUTES * 60000,
    expected ? expected.getTime() + 30 * 60000 : 0,
  ));
  if (now <= limit) return null;
  return { since: limit.toISOString(), openForMinutes: Math.round((now - placed) / 60000) };
}

export const formatDuration = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} sec${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} secs` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hr${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(h / 24)} days ${h % 24} hr`;
};

const ACTOR = { USER: 'Customer', RESTAURANT: 'Restaurant', DELIVERY_PARTNER: 'Delivery partner', ADMIN: 'Admin', SYSTEM: 'System' };

/**
 * The admin "Order timeline": every step in order, who did it, and the delays
 * that matter (late kitchen, slow handover, total delivery time).
 * `names` = { restaurant, rider } for the actor lines.
 */
export function orderTimeline(order, names = {}, now = new Date()) {
  const history = [...(order?.statusHistory || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
  const steps = [];
  const placed = at(order?.createdAt);
  const rider = names.rider || '';
  const restaurant = names.restaurant || '';
  if (placed) steps.push({ key: 'placed', label: 'Order placed', at: placed.toISOString(), actor: 'Customer' });

  const handover = handoverInfo(order, now);
  const seen = new Set();
  for (const h of history) {
    const to = String(h?.to || '');
    if (!to || seen.has(to)) continue;
    seen.add(to);
    const by = ACTOR[h.byRole] || '';
    const base = { at: at(h.at)?.toISOString() || null, actor: by === 'Restaurant' ? restaurant || by : by === 'Delivery partner' ? rider || by : by, note: h.note || '' };
    if (to === 'confirmed') steps.push({ key: to, label: 'Accepted by restaurant', ...base });
    else if (to === 'preparing') steps.push({ key: to, label: 'Preparation started', ...base });
    else if (to === 'ready_for_pickup') {
      const step = { key: to, label: 'Food order ready (FOR) marked', ...base };
      const prepMin = Number(order?.packingMinutes);
      const accepted = firstTo(history, 'confirmed', 'preparing');
      if (prepMin > 0 && accepted && step.at) {
        const late = (new Date(step.at) - accepted) / 1000 - prepMin * 60;
        if (late > 0) step.delay = { label: 'Food ready later than promised by', value: formatDuration(late) };
      }
      if (handover?.late) {
        step.warning = true;
        step.delay = {
          label: handover.pickedUpAt ? 'Food handover delayed by' : 'Food handover running late by',
          value: formatDuration(handover.lateBySeconds),
          note: handover.pickedUpAt ? 'Food handover took more time than expected' : 'Not picked up yet — call the rider',
        };
      }
      steps.push(step);
    } else if (to === 'picked_up') steps.push({ key: to, label: `Picked up${rider ? ` by ${rider}` : ''}`, ...base, actor: '' });
    else if (to === 'delivered') {
      const mins = placed && base.at ? Math.round((new Date(base.at) - placed) / 60000) : null;
      steps.push({ key: to, label: mins != null ? `Delivered in ${mins} mins` : 'Delivered', ...base, actor: '' });
    } else if (to.startsWith('cancelled')) {
      steps.push({ key: to, label: `Cancelled by ${ACTOR[h.byRole]?.toLowerCase() || to.replace('cancelled_by_', '')}`, ...base, warning: true });
    }
  }

  const assigned = at(order?.dispatchAcceptedAt);
  if (assigned) steps.push({ key: 'rider_assigned', label: `Delivery partner ${rider || ''} assigned`.replace('  ', ' '), at: assigned.toISOString(), actor: '' });
  const arrived = at(order?.reachedPickupAt);
  if (arrived) steps.push({ key: 'rider_arrived', label: `Delivery partner ${rider || ''} arrived`.replace('  ', ' '), at: arrived.toISOString(), actor: '' });
  const atDrop = at(order?.reachedDropAt);
  if (atDrop) steps.push({ key: 'reached_drop', label: 'Reached the customer', at: atDrop.toISOString(), actor: '' });

  const stuck = stuckInfo(order, now);
  if (stuck) steps.push({ key: 'stuck', label: `Not delivered — open for ${formatDuration(stuck.openForMinutes * 60)}`, at: now.toISOString(), warning: true, actor: '' });

  return steps.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
}
