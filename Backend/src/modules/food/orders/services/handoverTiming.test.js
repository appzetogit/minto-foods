import test from 'node:test';
import assert from 'node:assert/strict';
import { handoverInfo, stuckInfo, orderTimeline, HANDOVER_SECONDS } from './handoverTiming.js';

const t = (min, sec = 0) => new Date(Date.UTC(2026, 10, 17, 1, min, sec));
const order = (over = {}) => ({
  orderStatus: 'ready_for_pickup',
  createdAt: t(14),
  packingMinutes: 20,
  statusHistory: [
    { to: 'confirmed', at: t(14), byRole: 'RESTAURANT' },
    { to: 'preparing', at: t(14), byRole: 'RESTAURANT' },
    { to: 'ready_for_pickup', at: t(40), byRole: 'RESTAURANT' },
  ],
  ...over,
});

test('handover counts a minute from ready', () => {
  const h = handoverInfo(order(), t(40, 30));
  assert.equal(HANDOVER_SECONDS, 60);
  assert.equal(h.dueAt, t(41).toISOString());
  assert.equal(h.late, false);
  assert.equal(handoverInfo(order(), t(43)).lateBySeconds, 120, 'still waiting, 2 min late');
  const picked = handoverInfo(order({ orderStatus: 'delivered', pickedUpAt: t(42, 6) }), t(59));
  assert.equal(picked.lateBySeconds, 66, 'stops at pickup: 1 min 6 secs');
  assert.equal(handoverInfo(order({ statusHistory: [] })), null, 'no clock before ready');
});

test('an order open far past any delivery time is stuck; a delivered one never', () => {
  assert.equal(stuckInfo(order(), t(14 + 60)), null);
  assert.ok(stuckInfo(order(), new Date(t(14).getTime() + 3 * 864e5)).openForMinutes > 4000);
  assert.equal(stuckInfo(order({ orderStatus: 'delivered' }), new Date(t(14).getTime() + 3 * 864e5)), null);
});

test('timeline reads like the reference: names, handover delay, delivered in N mins', () => {
  const o = order({
    orderStatus: 'delivered', reachedPickupAt: t(42), pickedUpAt: t(42, 6),
    statusHistory: [...order().statusHistory,
      { to: 'picked_up', at: t(42, 6), byRole: 'DELIVERY_PARTNER' },
      { to: 'delivered', at: t(60), byRole: 'DELIVERY_PARTNER' }],
  });
  const steps = orderTimeline(o, { restaurant: 'Smashed Burger', rider: 'Abdullah' }, t(61));
  const labels = steps.map((s) => s.label);
  assert.deepEqual(labels, [
    'Order placed', 'Accepted by restaurant', 'Preparation started',
    'Food order ready (FOR) marked', 'Delivery partner Abdullah arrived',
    'Picked up by Abdullah', 'Delivered in 46 mins',
  ]);
  const ready = steps.find((s) => s.key === 'ready_for_pickup');
  assert.equal(ready.actor, 'Smashed Burger');
  assert.equal(ready.delay.label, 'Food handover delayed by');
  assert.equal(ready.delay.value, '1 min 6 secs');
});
