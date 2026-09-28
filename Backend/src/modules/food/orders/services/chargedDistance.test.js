import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseChargedDistanceKm } from './order-pricing.service.js';

/**
 * Which distance a delivery is charged on. The case that started it: a
 * Bhiwandi customer 0.48 km from Md.ALi was charged for Google's 2.06 km route.
 */

test('by default the road distance is capped at 1.5x the straight line', () => {
    assert.equal(chooseChargedDistanceKm({ roadKm: 2.06, straightKm: 0.48 }), 0.72);
});

test('a real, modest detour is charged in full', () => {
    // 1.2 km by road for a 1 km trip is under the cap.
    assert.equal(chooseChargedDistanceKm({ roadKm: 1.2, straightKm: 1 }), 1.2);
});

test('straight-line and plain road modes', () => {
    assert.equal(chooseChargedDistanceKm({ roadKm: 2.06, straightKm: 0.48, mode: 'straight' }), 0.48);
    assert.equal(chooseChargedDistanceKm({ roadKm: 2.06, straightKm: 0.48, mode: 'road' }), 2.06);
});

test('the cap can be changed; nonsense caps fall back to 1.5', () => {
    assert.equal(chooseChargedDistanceKm({ roadKm: 2.06, straightKm: 0.48, capFactor: 2 }), 0.96);
    assert.equal(chooseChargedDistanceKm({ roadKm: 2.06, straightKm: 0.48, capFactor: 0.2 }), 0.72);
    assert.equal(chooseChargedDistanceKm({ roadKm: 2.06, straightKm: 0.48, capFactor: '1.25' }), 0.6);
});

test('whichever distance is known is used when the other is missing', () => {
    assert.equal(chooseChargedDistanceKm({ roadKm: null, straightKm: 0.48 }), 0.48);
    assert.equal(chooseChargedDistanceKm({ roadKm: 2.06, straightKm: null }), 2.06);
    assert.equal(chooseChargedDistanceKm({ roadKm: null, straightKm: null }), null);
});

test('an unknown mode behaves like the default', () => {
    assert.equal(chooseChargedDistanceKm({ roadKm: 2.06, straightKm: 0.48, mode: 'teleport' }), 0.72);
});
