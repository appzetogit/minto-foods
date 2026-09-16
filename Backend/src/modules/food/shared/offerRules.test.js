// The server runs in UTC; pin it so the end-of-day rule behaves the same on a
// developer machine set to India time.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    checkOfferEligibility,
    checkSchedule,
    computeOfferDiscount,
    describeConditions,
    describeDays,
    describeDiscount,
    istClock,
    normalizeActiveDays,
    normalizeCustomerScope,
    normalizeDiscountType,
    offerLifecycle,
} from './offerRules.js';

/**
 * Coupon rules. A wrong answer here either charges a customer more than the
 * code they were promised, or gives a restaurant's food away.
 */

// 2026-09-16 is a Wednesday. 06:30 UTC is noon in India.
const WED_NOON_IST = new Date('2026-09-16T06:30:00Z');
const at = (isoIst) => new Date(new Date(`${isoIst}+05:30`).getTime());

const offer = (extra = {}) => ({
    id: 'o1',
    couponCode: 'LUNCH50',
    status: 'active',
    showInCart: true,
    discountType: 'percentage',
    discountValue: 50,
    maxDiscount: 100,
    minOrderValue: 199,
    usageLimit: null,
    usedCount: 0,
    perUserLimit: null,
    customerScope: 'all',
    customerIds: [],
    restaurantScope: 'selected',
    restaurantId: 'r1',
    restaurantIds: ['r1'],
    startDate: null,
    endDate: null,
    isFirstOrderOnly: false,
    activeDays: [],
    activeFromTime: null,
    activeToTime: null,
    newToRestaurantOnly: false,
    ...extra,
});

const check = (o, extra = {}) => checkOfferEligibility({
    offer: o, subtotal: 400, restaurantId: 'r1', userId: 'u1', now: WED_NOON_IST, ...extra,
});

// ---------------------------------------------------------------------------

test('both enum spellings are accepted and only Prisma names come out', () => {
    assert.equal(normalizeDiscountType('flat-price'), 'flat_price');
    assert.equal(normalizeDiscountType('flat_price'), 'flat_price');
    assert.equal(normalizeDiscountType('PERCENTAGE'), 'percentage');
    assert.equal(normalizeDiscountType('bogus'), null);
    assert.equal(normalizeCustomerScope('first-time'), 'first_time');
    assert.equal(normalizeCustomerScope('specific'), 'specific');
});

test('the clock is India time regardless of the server clock', () => {
    assert.deepEqual(istClock(WED_NOON_IST), { day: 3, minutes: 12 * 60 });
    // 19:00 UTC Wednesday is 00:30 Thursday in India.
    assert.deepEqual(istClock(new Date('2026-09-16T19:00:00Z')), { day: 4, minutes: 30 });
});

test('a qualifying cart gets the offer', () => {
    assert.deepEqual(check(offer()), { ok: true });
});

test('the discount matches the formula checkout has always used', () => {
    // The pre-refactor calculation, verbatim, as the reference.
    const legacy = (o, subtotal) => {
        if (o.discountType === 'percentage') {
            const raw = subtotal * (Number(o.discountValue) / 100);
            const capped = Number(o.maxDiscount) ? Math.min(raw, Number(o.maxDiscount)) : raw;
            return Math.max(0, Math.min(subtotal, Math.floor(capped)));
        }
        return Math.max(0, Math.min(subtotal, Math.floor(Number(o.discountValue) || 0)));
    };
    const cases = [];
    for (const subtotal of [0, 1, 99.5, 199, 250, 333.33, 1000, 5000]) {
        for (const o of [
            offer(), offer({ maxDiscount: null }), offer({ discountValue: 12.5, maxDiscount: 40 }),
            offer({ discountValue: 100, maxDiscount: 10000 }),
            offer({ discountType: 'flat_price', discountValue: 75 }),
            offer({ discountType: 'flat_price', discountValue: 99.99 }),
        ]) cases.push([o, subtotal]);
    }
    for (const [o, subtotal] of cases) {
        assert.equal(computeOfferDiscount(o, subtotal), legacy(o, subtotal), `${o.discountType} ${o.discountValue} on ${subtotal}`);
    }
});

test('a percentage discount stops at its cap, and flat never exceeds the cart', () => {
    assert.equal(computeOfferDiscount(offer(), 1000), 100);
    assert.equal(computeOfferDiscount(offer(), 150), 75);
    assert.equal(computeOfferDiscount(offer({ discountType: 'flat_price', discountValue: 500 }), 300), 300);
});

// ---- refusals, and the reason each gives -----------------------------------

test('an unknown code', () => {
    const v = check(null);
    assert.equal(v.code, 'not-found');
    assert.equal(v.message, 'Invalid coupon code');
});

test('paused and hidden offers are refused', () => {
    assert.equal(check(offer({ status: 'paused' })).code, 'inactive');
    assert.equal(check(offer({ showInCart: false })).code, 'inactive');
});

test('before its start and after its end', () => {
    assert.equal(check(offer({ startDate: '2026-09-20T00:00:00Z' })).code, 'not-started');
    assert.equal(check(offer({ endDate: '2026-09-15T10:00:00Z' })).code, 'expired');
});

test('an end stamped at midnight covers that whole day, as checkout always read it', () => {
    assert.equal(check(offer({ endDate: '2026-09-16T00:00:00Z' })).ok, true);
});

test('another restaurant\'s code does not work here', () => {
    assert.equal(check(offer(), { restaurantId: 'r2' }).code, 'wrong-restaurant');
    // Platform-wide codes work anywhere.
    assert.equal(check(offer({ restaurantScope: 'all' }), { restaurantId: 'r2' }).ok, true);
});

test('a customer-specific code', () => {
    const o = offer({ customerScope: 'specific', customerIds: ['u1'] });
    assert.equal(check(o).ok, true);
    assert.equal(check(o, { userId: 'u2' }).code, 'not-for-you');
    assert.equal(check(o, { userId: null }).code, 'not-for-you');
});

test('first order anywhere', () => {
    const o = offer({ customerScope: 'first_time' });
    assert.equal(check(o, { priorOrders: 0 }).ok, true);
    assert.equal(check(o, { priorOrders: 3 }).code, 'first-order');
    assert.equal(check(offer({ isFirstOrderOnly: true }), { priorOrders: 1 }).code, 'first-order');
    // An anonymous cart preview is not refused on history it cannot know.
    assert.equal(check(o, { userId: null, priorOrders: 3 }).ok, true);
});

test('new to this restaurant is judged on this restaurant only', () => {
    const o = offer({ newToRestaurantOnly: true });
    assert.equal(check(o, { priorOrders: 12, priorOrdersHere: 0 }).ok, true, 'orders elsewhere do not count');
    const v = check(o, { priorOrdersHere: 1 });
    assert.equal(v.code, 'new-to-restaurant');
    assert.match(v.message, /first order from this restaurant/);
});

test('total redemptions', () => {
    const v = check(offer({ usageLimit: 100, usedCount: 100 }));
    assert.equal(v.code, 'fully-redeemed');
    assert.equal(check(offer({ usageLimit: 100, usedCount: 99 })).ok, true);
    assert.equal(check(offer({ usageLimit: 0, usedCount: 5000 })).ok, true, 'zero means unlimited');
});

test('max redemptions per customer, with wording for once and for many', () => {
    const once = offer({ perUserLimit: 1 });
    assert.equal(check(once, { usageCount: 0 }).ok, true);
    assert.equal(check(once, { usageCount: 1 }).message, 'You have already used this coupon');
    assert.equal(check(offer({ perUserLimit: 3 }), { usageCount: 3 }).message, 'You have used this coupon the maximum 3 times');
    assert.equal(check(offer({ perUserLimit: 3 }), { usageCount: 2 }).ok, true);
});

test('below the minimum order says exactly how much more to add', () => {
    const v = check(offer(), { subtotal: 150 });
    assert.equal(v.code, 'min-order');
    assert.equal(v.message, 'Add ₹49 more to use this coupon');
});

test('a reason the customer cannot fix outranks one they can', () => {
    // Expired and under the minimum: telling them to add ₹49 would be a lie.
    const v = check(offer({ endDate: '2026-09-01T10:00:00Z' }), { subtotal: 150 });
    assert.equal(v.code, 'expired');
    const w = check(offer({ perUserLimit: 1 }), { subtotal: 150, usageCount: 1 });
    assert.equal(w.code, 'used-up');
});

// ---- days and hours ---------------------------------------------------------

test('a weekday lunch offer', () => {
    const lunch = offer({ activeDays: [1, 2, 3, 4, 5], activeFromTime: '12:00', activeToTime: '15:00' });
    assert.equal(checkSchedule(lunch, at('2026-09-16T12:00:00')).ok, true, 'opens on the minute');
    assert.equal(checkSchedule(lunch, at('2026-09-16T14:59:00')).ok, true);
    assert.equal(checkSchedule(lunch, at('2026-09-16T15:00:00')).code, 'wrong-time', 'closes on the minute');
    assert.equal(checkSchedule(lunch, at('2026-09-16T11:59:00')).code, 'wrong-time');
    assert.equal(checkSchedule(lunch, at('2026-09-19T13:00:00')).code, 'wrong-day', 'Saturday');
});

test('the day is India\'s, not UTC\'s', () => {
    // 00:30 Thursday in India is still Wednesday in UTC.
    const wednesdays = offer({ activeDays: [3] });
    assert.equal(checkSchedule(wednesdays, new Date('2026-09-16T19:00:00Z')).code, 'wrong-day');
    assert.equal(checkSchedule(wednesdays, new Date('2026-09-16T18:00:00Z')).ok, true, '23:30 Wednesday');
});

test('an overnight window belongs to the day it opened', () => {
    const fridayNight = offer({ activeDays: [5], activeFromTime: '22:00', activeToTime: '02:00' });
    assert.equal(checkSchedule(fridayNight, at('2026-09-18T23:00:00')).ok, true, 'Friday 11pm');
    assert.equal(checkSchedule(fridayNight, at('2026-09-19T01:30:00')).ok, true, 'Saturday 1:30am is still Friday night');
    // Closed on the minute. Once the window has ended it is simply Saturday,
    // and the next time the code works is next Friday, so "Fri only" is the
    // truthful reason rather than the hours.
    assert.equal(checkSchedule(fridayNight, at('2026-09-19T02:00:00')).ok, false);
    assert.equal(checkSchedule(fridayNight, at('2026-09-19T02:00:00')).code, 'wrong-day');
    // Friday evening before it opens is the right day, wrong hour.
    assert.equal(checkSchedule(fridayNight, at('2026-09-18T20:00:00')).code, 'wrong-time');
    assert.equal(checkSchedule(fridayNight, at('2026-09-19T23:00:00')).code, 'wrong-day', 'Saturday night');
    assert.equal(checkSchedule(fridayNight, at('2026-09-18T01:00:00')).code, 'wrong-day', 'Friday 1am is Thursday night');
});

test('refusals name the days and hours', () => {
    const lunch = offer({ activeDays: [1, 2, 3, 4, 5], activeFromTime: '12:00', activeToTime: '15:00' });
    assert.equal(check(lunch, { now: at('2026-09-19T13:00:00') }).message, 'This coupon works on Mon-Fri only');
    assert.equal(check(lunch, { now: at('2026-09-16T18:00:00') }).message, 'This coupon works between 12:00 and 15:00');
});

test('every day has one representation', () => {
    assert.deepEqual(normalizeActiveDays([0, 1, 2, 3, 4, 5, 6]), []);
    assert.deepEqual(normalizeActiveDays([5, 1, 1, 9, -1, 'x']), [1, 5]);
    assert.deepEqual(normalizeActiveDays(undefined), []);
});

// ---- wording ----------------------------------------------------------------

test('the offer is described the way a customer reads it', () => {
    assert.equal(describeDiscount(offer()), '50% OFF up to ₹100');
    assert.equal(describeDiscount(offer({ discountType: 'flat_price', discountValue: 75 })), '₹75 OFF');
    assert.equal(describeDays([6, 0]), 'Sun, Sat');
    assert.equal(describeDays([1, 2, 3, 4, 5]), 'Mon-Fri');
    assert.deepEqual(
        describeConditions(offer({ activeDays: [1, 2, 3, 4, 5], activeFromTime: '12:00', activeToTime: '15:00', perUserLimit: 1, newToRestaurantOnly: true })),
        ['on orders above ₹199', 'Mon-Fri', '12:00-15:00', 'new customers only', 'once per customer'],
    );
});

test('where an offer is in its life', () => {
    assert.equal(offerLifecycle(offer(), WED_NOON_IST), 'live');
    assert.equal(offerLifecycle(offer({ status: 'paused' }), WED_NOON_IST), 'paused');
    assert.equal(offerLifecycle(offer({ status: 'inactive' }), WED_NOON_IST), 'ended');
    assert.equal(offerLifecycle(offer({ startDate: '2026-10-01T00:00:00Z' }), WED_NOON_IST), 'scheduled');
    assert.equal(offerLifecycle(offer({ endDate: '2026-09-10T10:00:00Z' }), WED_NOON_IST), 'expired');
    assert.equal(offerLifecycle(offer({ usageLimit: 5, usedCount: 5 }), WED_NOON_IST), 'exhausted');
    // Outside today's lunch window it is still live -- just not usable this minute.
    assert.equal(offerLifecycle(offer({ activeFromTime: '12:00', activeToTime: '13:00' }), at('2026-09-16T20:00:00')), 'live');
});
