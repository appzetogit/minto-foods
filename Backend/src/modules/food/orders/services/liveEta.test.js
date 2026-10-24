import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLiveEta } from './order.helpers.js';

/**
 * The time to the customer's door must exist before any rider is assigned:
 * the app said "Calculating..." until then. Kitchen time plus the ride.
 */
const shop = { latitude: 22.72, longitude: 75.88 };
const door = { latitude: 22.75, longitude: 75.90 };

test('no rider yet: kitchen time plus the ride, to the door', () => {
    const eta = buildLiveEta({
        orderStatus: 'confirmed',
        createdAt: new Date(),
        restaurantId: shop,
        deliveryAddress: door,
        pricing: { roadDurationMins: 12 },
    });
    assert.equal(eta.source, 'estimate');
    assert.equal(eta.target, 'customer');
    assert.equal(eta.minutesToDoor, 15 + 12);
    assert.equal(eta.minutes, eta.minutesToDoor);
});

test('food ready: only the ride remains', () => {
    const eta = buildLiveEta({
        orderStatus: 'ready_for_pickup',
        createdAt: new Date(Date.now() - 60 * 60000),
        restaurantId: shop,
        deliveryAddress: door,
        pricing: { roadDurationMins: 12 },
    });
    assert.equal(eta.minutesToDoor, 1 + 12);
});

test('no trip estimate: the straight line between shop and door is used', () => {
    const eta = buildLiveEta({ orderStatus: 'preparing', createdAt: new Date(), restaurantId: shop, deliveryAddress: door });
    assert.ok(eta.minutesToDoor > 15, `got ${eta.minutesToDoor}`);
});

test('delivered: nothing to show', () => {
    assert.equal(buildLiveEta({ orderStatus: 'delivered' }).minutesToDoor, null);
});
