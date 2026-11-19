import test from 'node:test';
import assert from 'node:assert/strict';

import { rankRidersForBatching } from './order-dispatch.service.js';

// Nearest first, as listNearbyOnlineDeliveryPartners returns them.
const partners = [{ partnerId: 'far-detour' }, { partnerId: 'idle' }, { partnerId: 'same-route' }, { partnerId: 'same-rest' }];
const order = { restaurantId: 'R1', dropLat: 22.7196, dropLng: 75.8577 };
const active = new Map([
  ['far-detour', [{ restaurantId: 'R9', orderStatus: 'picked_up', addrLat: 22.80, addrLng: 75.95 }]],
  ['same-route', [{ restaurantId: 'R2', orderStatus: 'picked_up', addrLat: 22.7250, addrLng: 75.8600 }]],
  ['same-rest', [{ restaurantId: 'R1', orderStatus: 'preparing', addrLat: 22.60, addrLng: 75.70 }]],
]);

test('batching: same restaurant, then same way, then idle, then detours', () => {
  const ranked = rankRidersForBatching(partners, active, order);
  assert.deepEqual(ranked.map((r) => r.partner.partnerId), ['same-rest', 'same-route', 'idle', 'far-detour']);
  assert.deepEqual(ranked.map((r) => r.reason), ['same_restaurant', 'same_route', '', '']);
});

test('batching: a same-restaurant order already picked up is not a shared pickup', () => {
  const picked = new Map([['same-rest', [{ restaurantId: 'R1', orderStatus: 'picked_up', addrLat: 22.60, addrLng: 75.70 }]]]);
  const ranked = rankRidersForBatching([{ partnerId: 'same-rest' }, { partnerId: 'idle' }], picked, order);
  assert.deepEqual(ranked.map((r) => r.partner.partnerId), ['idle', 'same-rest']);
});

test('batching: with nobody on a trip the order is unchanged (nearest first)', () => {
  const ranked = rankRidersForBatching(partners, new Map(), order);
  assert.deepEqual(ranked.map((r) => r.partner.partnerId), partners.map((p) => p.partnerId));
});
