import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveUserDeliveryFee,
    calculateRiderEarning,
    serviceableRadiusKm,
    resolveDeliveryFeeGstRate,
    computeDeliveryFeeGst,
} from './order-pricing.service.js';

/**
 * Distance-band pricing, checked without a database. These branches decide what a
 * customer is charged and what a rider is paid, and both have already produced
 * live incidents — a flat fee overriding the bands, and a rider paid nothing for a
 * delivery past the last band.
 */

const settings = {
    deliveryFee: 99, // deliberately higher than every band
    deliveryFeeRanges: [
        { min: 0, max: 3, fee: 20, deliveryBoyBasePay: 15 },
        { min: 3, max: 7, fee: 40, deliveryBoyPerKm: 8 },
        { min: 7, max: 12, fee: 70, deliveryBoyPerKm: 10 },
    ],
    gstRate: 5,
    deliveryFeeGstRate: 18,
};

test('bands beat the flat fee when the distance is known', () => {
    assert.equal(resolveUserDeliveryFee(settings, { distanceKm: 2 }).deliveryFee, 20);
    assert.equal(resolveUserDeliveryFee(settings, { distanceKm: 5 }).deliveryFee, 40);
    assert.equal(resolveUserDeliveryFee(settings, { distanceKm: 9 }).deliveryFee, 70);
});

test('band boundaries are half-open, except the last which includes its max', () => {
    // 3 km belongs to the 3–7 band, not 0–3.
    assert.equal(resolveUserDeliveryFee(settings, { distanceKm: 3 }).deliveryFee, 40);
    assert.equal(resolveUserDeliveryFee(settings, { distanceKm: 7 }).deliveryFee, 70);
    assert.equal(resolveUserDeliveryFee(settings, { distanceKm: 12 }).deliveryFee, 70);
});

test('an unknown distance quotes the cheapest band, never the flat fee', () => {
    // The flat 99 used to win here, so carts without an address yet showed a fee
    // no band would ever have produced.
    const quote = resolveUserDeliveryFee(settings, { distanceKm: null });
    assert.equal(quote.deliveryFee, 20);
    assert.equal(quote.source, 'default');
});

test("a restaurant's free-delivery threshold overrides every band", () => {
    // The card promises "Free delivery above ₹149", so a ₹149 subtotal must not
    // be charged the 9 km band's ₹70.
    const free = resolveUserDeliveryFee(settings, { distanceKm: 9, subtotal: 149, freeDeliveryAbove: 149 });
    assert.equal(free.deliveryFee, 0);
    assert.equal(free.source, 'free_delivery_threshold');

    // A rupee short still pays.
    const paid = resolveUserDeliveryFee(settings, { distanceKm: 9, subtotal: 148, freeDeliveryAbove: 149 });
    assert.equal(paid.deliveryFee, 70);

    // No threshold configured leaves pricing exactly as it was.
    assert.equal(resolveUserDeliveryFee(settings, { distanceKm: 9, subtotal: 9999 }).deliveryFee, 70);
});

test('the flat fee is used only when no bands exist at all', () => {
    const quote = resolveUserDeliveryFee({ deliveryFee: 99, deliveryFeeRanges: [] }, { distanceKm: 5 });
    assert.equal(quote.deliveryFee, 99);
});

test('a trip past the last band is charged as the widest band', () => {
    const quote = resolveUserDeliveryFee(settings, { distanceKm: 20 });
    assert.equal(quote.deliveryFee, 70);
    assert.equal(quote.source, 'distance_over_range');
});

test('rider pay: flat base pay wins over per-km inside a band', () => {
    assert.equal(calculateRiderEarning(settings, 2), 15);
});

test('rider pay: per-km bands multiply by the real distance', () => {
    assert.equal(calculateRiderEarning(settings, 5), 40); // 5 × 8
    assert.equal(calculateRiderEarning(settings, 9), 90); // 9 × 10
});

test('rider pay past the last band falls back rather than paying zero', () => {
    // The customer is still charged, so a 0 here would mean unpaid work on a real
    // delivery whenever the bands do not span the dispatch radius.
    assert.equal(calculateRiderEarning(settings, 20), 200); // 20 × 10, widest band
});

test('rider pay is zero only when nothing is configured', () => {
    assert.equal(calculateRiderEarning({ deliveryFeeRanges: [] }, 5), 0);
    assert.equal(calculateRiderEarning(settings, -1), 0);
});

test('the serviceable radius is the widest band max', () => {
    assert.equal(serviceableRadiusKm(settings), 12);
    // No bands means no limit can be derived, so none is enforced.
    assert.equal(serviceableRadiusKm({ deliveryFeeRanges: [] }), null);
});

test('delivery-fee GST is charged only at a configured rate', () => {
    assert.equal(resolveDeliveryFeeGstRate(settings), 18);
    assert.equal(computeDeliveryFeeGst(40, 18), 7.2);

    // Unset means not charged — it used to be a hidden hardcoded 18%.
    assert.equal(resolveDeliveryFeeGstRate({}), 0);
    assert.equal(computeDeliveryFeeGst(40, 0), 0);
});

/**
 * A band can carry a per-km rate as well as a flat fee, so a tariff like
 * "Rs 20 up to 2 km, then Rs 5 per km" is two bands and stays exact for
 * fractional distances instead of rounding up to the next whole-km band.
 */
const perKmSettings = {
    deliveryFeeRanges: [
        { min: 0, max: 2, fee: 20, feePerKm: 0 },
        { min: 2, max: 20, fee: 20, feePerKm: 5 },
    ],
};

test('a per-km band charges the flat fee until its own start', () => {
    assert.equal(resolveUserDeliveryFee(perKmSettings, { distanceKm: 0.4 }).deliveryFee, 20);
    assert.equal(resolveUserDeliveryFee(perKmSettings, { distanceKm: 1.9 }).deliveryFee, 20);
    assert.equal(resolveUserDeliveryFee(perKmSettings, { distanceKm: 2 }).deliveryFee, 20);
});

test('past the free distance it is base + rate * the kilometres beyond', () => {
    assert.equal(resolveUserDeliveryFee(perKmSettings, { distanceKm: 3 }).deliveryFee, 25);
    assert.equal(resolveUserDeliveryFee(perKmSettings, { distanceKm: 7 }).deliveryFee, 45);
    assert.equal(resolveUserDeliveryFee(perKmSettings, { distanceKm: 20 }).deliveryFee, 110);
});

test('fractional distances are charged exactly, not rounded to a whole km', () => {
    assert.equal(resolveUserDeliveryFee(perKmSettings, { distanceKm: 7.5 }).deliveryFee, 47.5);
    assert.equal(resolveUserDeliveryFee(perKmSettings, { distanceKm: 2.1 }).deliveryFee, 20.5);
    // 20 + 5 * (7.3 - 2) is 46.50000000000001 in binary floating point.
    assert.equal(resolveUserDeliveryFee(perKmSettings, { distanceKm: 7.3 }).deliveryFee, 46.5);
});

test('a trip past the last band keeps accruing the rate, not the start price', () => {
    const quote = resolveUserDeliveryFee(perKmSettings, { distanceKm: 25 });
    assert.equal(quote.source, 'distance_over_range');
    assert.equal(quote.deliveryFee, 135);
});

test('bands with no rate price exactly as before', () => {
    assert.equal(resolveUserDeliveryFee(settings, { distanceKm: 9 }).deliveryFee, 70);
});
