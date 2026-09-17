import test from 'node:test';
import assert from 'node:assert/strict';

import { withinDeliveryRadius } from './deliveryRadius.js';

/**
 * Whether a restaurant appears for a customer at a point. Indore coordinates;
 * 0.009 degrees of latitude is almost exactly one kilometre.
 */

const customer = { lat: 22.7196, lng: 75.8577 };
const at = (kmNorth, extra = {}) => ({
    latitude: customer.lat + kmNorth * 0.009,
    longitude: customer.lng,
    deliveryRadiusKm: null,
    ...extra,
});
const sees = (restaurant, platformRadiusKm) =>
    withinDeliveryRadius(restaurant, customer.lat, customer.lng, platformRadiusKm);

test('no radius anywhere: every restaurant is visible', () => {
    assert.equal(sees(at(40), null), true);
});

test('the platform radius hides restaurants beyond it', () => {
    assert.equal(sees(at(3), 5), true);
    assert.equal(sees(at(8), 5), false);
});

test("a restaurant's own radius replaces the platform's, wider or narrower", () => {
    assert.equal(sees(at(8, { deliveryRadiusKm: 10 }), 5), true, 'wider override reaches further');
    assert.equal(sees(at(3, { deliveryRadiusKm: 2 }), 5), false, 'narrower override hides it sooner');
    assert.equal(sees(at(8, { deliveryRadiusKm: 10 }), null), true, 'override alone, no platform radius');
});

test('an unset or zero override falls back to the platform radius', () => {
    assert.equal(sees(at(8, { deliveryRadiusKm: 0 }), 5), false);
    assert.equal(sees(at(8, { deliveryRadiusKm: '0.00' }), 5), false, 'Decimal columns arrive as strings');
});

test('a restaurant with no coordinates is not hidden', () => {
    assert.equal(sees({ latitude: null, longitude: null, deliveryRadiusKm: null }, 5), true);
});
