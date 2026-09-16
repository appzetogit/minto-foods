import test from 'node:test';
import assert from 'node:assert/strict';

import { validateCreateOfferDto } from './offer.validator.js';

/**
 * What a restaurant or admin may save as a coupon. Anything this lets through
 * reaches checkout as a real discount.
 */

const base = (extra = {}) => ({
    couponCode: 'lunch50',
    discountType: 'percentage',
    discountValue: 50,
    maxDiscount: 100,
    minOrderValue: 199,
    restaurantScope: 'selected',
    restaurantId: '1a2b3c4d5e6f7a8b9c0d1e2f',
    endDate: '2099-12-31',
    ...extra,
});

const rejects = (body, pattern) => assert.throws(() => validateCreateOfferDto(body), pattern);

test('a normal percentage coupon is accepted and the code upper-cased', () => {
    const v = validateCreateOfferDto(base());
    assert.equal(v.couponCode, 'LUNCH50');
    assert.equal(v.discountType, 'percentage');
    assert.equal(v.maxDiscount, 100);
});

test('the hyphenated spellings clients send reach Prisma in its own spelling', () => {
    // This was the bug: 'flat-price' went straight to Prisma, which rejects it,
    // so no flat or first-order coupon could ever be created.
    const flat = validateCreateOfferDto(base({ discountType: 'flat-price', discountValue: 75, minOrderValue: 299 }));
    assert.equal(flat.discountType, 'flat_price');
    const first = validateCreateOfferDto(base({ customerScope: 'first-time' }));
    assert.equal(first.customerScope, 'first_time');
});

test('a percentage above 100 is refused', () => {
    rejects(base({ discountValue: 150 }), /more than 100%/);
});

test('a percentage coupon must have a real cap', () => {
    rejects(base({ maxDiscount: undefined }), /maximum discount/);
    // Zero used to pass, and checkout reads a zero cap as no cap.
    rejects(base({ maxDiscount: 0 }), /maximum discount/);
});

test('a flat discount must be less than the minimum order', () => {
    rejects(base({ discountType: 'flat_price', discountValue: 100, minOrderValue: 0 }), /minimum order must be more/);
    rejects(base({ discountType: 'flat_price', discountValue: 100, minOrderValue: 100 }), /minimum order must be more/);
    const ok = validateCreateOfferDto(base({ discountType: 'flat_price', discountValue: 100, minOrderValue: 101 }));
    assert.equal(ok.maxDiscount, undefined, 'a cap means nothing on a flat discount');
});

test('codes are letters and digits a customer can type', () => {
    rejects(base({ couponCode: 'SAVE 20' }), /letters or numbers/);
    rejects(base({ couponCode: 'SAVE-20' }), /letters or numbers/);
    rejects(base({ couponCode: 'AB' }), /letters or numbers/);
    assert.equal(validateCreateOfferDto(base({ couponCode: '499' })).couponCode, '499');
});

test('a date-only end is the end of that day in India', () => {
    const v = validateCreateOfferDto(base({ startDate: '2099-01-01', endDate: '2099-01-31' }));
    assert.equal(v.endDate.toISOString(), '2099-01-31T18:29:59.999Z');
    assert.equal(v.startDate.toISOString(), '2098-12-31T18:30:00.000Z');
});

test('dates that make no sense are refused', () => {
    rejects(base({ endDate: '2020-01-01' }), /future date/);
    rejects(base({ startDate: '2099-02-01', endDate: '2099-01-01' }), /after startDate/);
    rejects(base({ endDate: 'soon' }), /Invalid endDate/);
});

test('redemption limits: zero is unlimited, and per customer cannot exceed total', () => {
    const v = validateCreateOfferDto(base({ usageLimit: 0, perUserLimit: 0 }));
    assert.equal(v.usageLimit, null);
    assert.equal(v.perUserLimit, null);
    const w = validateCreateOfferDto(base({ usageLimit: 500, perUserLimit: 2 }));
    assert.equal(w.usageLimit, 500);
    assert.equal(w.perUserLimit, 2);
    rejects(base({ usageLimit: 5, perUserLimit: 10 }), /cannot exceed total/);
    rejects(base({ perUserLimit: 1.5 }), /whole number/);
});

test('days and hours', () => {
    const v = validateCreateOfferDto(base({ activeDays: [5, 1, 3], activeFromTime: '12:00', activeToTime: '15:00' }));
    assert.deepEqual(v.activeDays, [1, 3, 5]);
    assert.equal(v.activeFromTime, '12:00');
    assert.deepEqual(validateCreateOfferDto(base({ activeDays: [0, 1, 2, 3, 4, 5, 6] })).activeDays, [], 'every day');
    assert.equal(validateCreateOfferDto(base({ activeFromTime: '22:00', activeToTime: '02:00' })).activeToTime, '02:00', 'overnight is fine');
    rejects(base({ activeDays: [7] }), /valid days/);
    rejects(base({ activeFromTime: '12:00' }), /both a start and an end/);
    rejects(base({ activeFromTime: '25:00', activeToTime: '26:00' }), /HH:mm/);
    rejects(base({ activeFromTime: '12:00', activeToTime: '12:00' }), /cannot be the same/);
});

test('no schedule means every day, all day', () => {
    const v = validateCreateOfferDto(base());
    assert.deepEqual(v.activeDays, []);
    assert.equal(v.activeFromTime, null);
    assert.equal(v.activeToTime, null);
    assert.equal(v.newToRestaurantOnly, false);
});
