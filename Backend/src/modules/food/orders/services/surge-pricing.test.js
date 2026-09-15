import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSurgeFee, resolveUserDeliveryFee } from './order-pricing.service.js';

/**
 * Surge: a flat amount added to a charged delivery fee.
 *
 * The rules decide what a customer pays, so the edges matter — a rule that
 * outstays its window keeps charging for rain that stopped days ago.
 */

const NOW = new Date('2026-09-15T12:00:00.000Z');
const rule = (extra = {}) => ({ surgeFee: 15, isActive: true, startAt: null, endAt: null, ...extra });

test('no rules means no surge', () => {
    assert.equal(resolveSurgeFee([], NOW), 0);
    assert.equal(resolveSurgeFee(undefined, NOW), 0);
});

test('a rule with no window is on until it is switched off', () => {
    assert.equal(resolveSurgeFee([rule()], NOW), 15);
    assert.equal(resolveSurgeFee([rule({ isActive: false })], NOW), 0);
});

test('a scheduled rule applies only inside its window', () => {
    const scheduled = rule({ startAt: '2026-09-15T18:00:00.000Z', endAt: '2026-09-15T22:00:00.000Z' });
    assert.equal(resolveSurgeFee([scheduled], NOW), 0, 'before the window');
    assert.equal(resolveSurgeFee([scheduled], new Date('2026-09-15T19:00:00.000Z')), 15, 'inside');
    assert.equal(resolveSurgeFee([scheduled], new Date('2026-09-16T01:00:00.000Z')), 0, 'after');
});

test('the window includes its own edges', () => {
    const scheduled = rule({ startAt: NOW.toISOString(), endAt: '2026-09-15T22:00:00.000Z' });
    assert.equal(resolveSurgeFee([scheduled], NOW), 15);
    assert.equal(resolveSurgeFee([rule({ endAt: NOW.toISOString() })], NOW), 15);
});

test('overlapping rules charge the largest, never the sum', () => {
    // Two rules at once is an admin mistake; charging Rs 40 for it would be a
    // far bigger surprise to the customer than charging Rs 25.
    assert.equal(resolveSurgeFee([rule({ surgeFee: 15 }), rule({ surgeFee: 25 })], NOW), 25);
});

test('a rule with no amount is ignored', () => {
    assert.equal(resolveSurgeFee([rule({ surgeFee: 0 })], NOW), 0);
    assert.equal(resolveSurgeFee([rule({ surgeFee: null })], NOW), 0);
});

const settings = {
    deliveryFeeRanges: [
        { min: 0, max: 2, fee: 20, feePerKm: 0 },
        { min: 2, max: 20, fee: 20, feePerKm: 5 },
    ],
};

test('surge is added to the fee the bands worked out', () => {
    assert.equal(resolveUserDeliveryFee(settings, { distanceKm: 7 }).deliveryFee, 45);
    assert.equal(
        resolveUserDeliveryFee({ ...settings, surgeFee: 15 }, { distanceKm: 7 }).deliveryFee,
        60,
    );
});

test('surge rides on a fractional fee without floating-point dust', () => {
    assert.equal(
        resolveUserDeliveryFee({ ...settings, surgeFee: 15 }, { distanceKm: 7.5 }).deliveryFee,
        62.5,
    );
});

test('a trip past the last band surges too', () => {
    const quote = resolveUserDeliveryFee({ ...settings, surgeFee: 10 }, { distanceKm: 25 });
    assert.equal(quote.source, 'distance_over_range');
    assert.equal(quote.deliveryFee, 145);
});

test('free delivery stays free, surge or not', () => {
    // The restaurant promised free delivery on the card; charging surge on top
    // would make that promise a lie at the moment of payment.
    const quote = resolveUserDeliveryFee(
        { ...settings, surgeFee: 15 },
        { distanceKm: 7, subtotal: 500, freeDeliveryAbove: 199 },
    );
    assert.equal(quote.deliveryFee, 0);
    assert.equal(quote.source, 'free_delivery_threshold');
});
