import test from 'node:test';
import assert from 'node:assert/strict';

import { checkDeliveryRadius } from './order-pricing.service.js';

/**
 * The delivery radius decides both what a customer can see and what they are
 * allowed to order, so the two call sites must agree exactly. Checked without a
 * database: the rule is a comparison, and a fixture Postgres would only hide it.
 */

test('a restaurant inside the platform radius is servable', () => {
    const { withinRadius, limitKm } = checkDeliveryRadius({
        distanceKm: 4.2,
        platformRadiusKm: 10,
    });
    assert.equal(withinRadius, true);
    assert.equal(limitKm, 10);
});

test('the boundary itself is inside', () => {
    // A 10 km radius has to serve the address measured at exactly 10 km, or
    // rounding to two decimals in the distance query decides the order.
    assert.equal(checkDeliveryRadius({ distanceKm: 10, platformRadiusKm: 10 }).withinRadius, true);
    assert.equal(checkDeliveryRadius({ distanceKm: 10.01, platformRadiusKm: 10 }).withinRadius, false);
});

test('past the platform radius is refused', () => {
    const { withinRadius, limitKm } = checkDeliveryRadius({
        distanceKm: 25,
        platformRadiusKm: 10,
    });
    assert.equal(withinRadius, false);
    assert.equal(limitKm, 10);
});

test("a restaurant's own radius replaces a wider platform default", () => {
    const tight = { distanceKm: 6, restaurantRadiusKm: 5, platformRadiusKm: 15 };
    assert.equal(checkDeliveryRadius(tight).withinRadius, false);
    assert.equal(checkDeliveryRadius(tight).limitKm, 5);

    assert.equal(checkDeliveryRadius({ ...tight, distanceKm: 5 }).withinRadius, true);
});

test("a restaurant's own radius wins even when it is wider than the platform's", () => {
    // The override is not a ceiling the platform imposes — a kitchen that runs
    // its own long-distance deliveries is exactly why the column exists.
    const wide = { distanceKm: 18, restaurantRadiusKm: 20, platformRadiusKm: 8 };
    assert.equal(checkDeliveryRadius(wide).withinRadius, true);
    assert.equal(checkDeliveryRadius(wide).limitKm, 20);

    assert.equal(checkDeliveryRadius({ ...wide, distanceKm: 21 }).withinRadius, false);
});

test('no radius configured anywhere means no limit', () => {
    const { withinRadius, limitKm } = checkDeliveryRadius({ distanceKm: 999 });
    assert.equal(withinRadius, true);
    assert.equal(limitKm, null);

    // Explicit nulls are what Prisma hands back for unset Decimal columns.
    assert.equal(
        checkDeliveryRadius({ distanceKm: 999, restaurantRadiusKm: null, platformRadiusKm: null })
            .withinRadius,
        true,
    );
});

test('a zero or unparseable radius is treated as unset, not as a closed restaurant', () => {
    assert.equal(checkDeliveryRadius({ distanceKm: 12, restaurantRadiusKm: 0, platformRadiusKm: 15 }).limitKm, 15);
    assert.equal(checkDeliveryRadius({ distanceKm: 12, platformRadiusKm: 0 }).withinRadius, true);
    assert.equal(checkDeliveryRadius({ distanceKm: 12, platformRadiusKm: 'soon' }).withinRadius, true);
});

test('an unknown distance is never refused', () => {
    // A cart with no address yet, or a restaurant with no coordinates: nothing
    // here says the trip is long, and refusing would break checkout.
    assert.equal(checkDeliveryRadius({ distanceKm: null, platformRadiusKm: 5 }).withinRadius, true);
    assert.equal(checkDeliveryRadius({ platformRadiusKm: 5 }).withinRadius, true);
    assert.equal(checkDeliveryRadius({ distanceKm: NaN, platformRadiusKm: 5 }).withinRadius, true);
});

test('radii arrive as Prisma Decimals, so strings must compare as numbers', () => {
    // Decimal(6,2) reaches JS as an object whose toString is "10.00"; a string
    // comparison would put 9 km outside a 10 km radius.
    assert.equal(checkDeliveryRadius({ distanceKm: 9, platformRadiusKm: '10.00' }).withinRadius, true);
    assert.equal(checkDeliveryRadius({ distanceKm: 9, restaurantRadiusKm: '8.50' }).withinRadius, false);
});
