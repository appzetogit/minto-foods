import test from 'node:test';
import assert from 'node:assert/strict';

import { checkTipAfterDelivery, TIP_WINDOW_DAYS } from './orderTip.service.js';

/**
 * Tipping after delivery.
 *
 * This takes money from a customer's wallet outside the order they already
 * paid for, so every refusal here is the difference between a fair charge and
 * an unexpected one.
 */

const NOW = new Date('2026-09-15T12:00:00.000Z');
const delivered = (extra = {}) => ({
    orderStatus: 'delivered',
    deliveredAt: '2026-09-15T10:00:00.000Z',
    tipAmount: 0,
    dispatchDeliveryPartnerId: 'rider-1',
    ...extra,
});
const on = { tipsEnabled: true, tipMaxAmount: null };

test('a delivered order can be tipped', () => {
    const v = checkTipAfterDelivery({ order: delivered(), amount: 20, settings: on, now: NOW });
    assert.equal(v.ok, true);
    assert.equal(v.amount, 20);
});

test('an order still on its way cannot be tipped', () => {
    const v = checkTipAfterDelivery({ order: delivered({ orderStatus: 'food_on_the_way' }), amount: 20, settings: on, now: NOW });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not-delivered');
});

test('tipping switched off refuses everything', () => {
    const v = checkTipAfterDelivery({ order: delivered(), amount: 20, settings: { tipsEnabled: false }, now: NOW });
    assert.equal(v.reason, 'tips-off');
});

test('an amount of zero or less is not a tip', () => {
    assert.equal(checkTipAfterDelivery({ order: delivered(), amount: 0, settings: on, now: NOW }).reason, 'bad-amount');
    assert.equal(checkTipAfterDelivery({ order: delivered(), amount: -50, settings: on, now: NOW }).reason, 'bad-amount');
    assert.equal(checkTipAfterDelivery({ order: delivered(), amount: 'lots', settings: on, now: NOW }).reason, 'bad-amount');
});

test('the window is measured from delivery, and closes after it', () => {
    const justInside = new Date(NOW.getTime() + (TIP_WINDOW_DAYS - 1) * 86400000);
    const wellPast = new Date(NOW.getTime() + (TIP_WINDOW_DAYS + 1) * 86400000);
    assert.equal(checkTipAfterDelivery({ order: delivered(), amount: 20, settings: on, now: justInside }).ok, true);
    assert.equal(checkTipAfterDelivery({ order: delivered(), amount: 20, settings: on, now: wellPast }).reason, 'too-late');
});

test('an order nobody delivered has nobody to tip', () => {
    const v = checkTipAfterDelivery({ order: delivered({ dispatchDeliveryPartnerId: null }), amount: 20, settings: on, now: NOW });
    assert.equal(v.reason, 'no-rider');
});

test('the maximum counts the tip already given, so it cannot be passed in instalments', () => {
    const settings = { tipsEnabled: true, tipMaxAmount: 100 };
    const order = delivered({ tipAmount: 80 });

    const over = checkTipAfterDelivery({ order, amount: 30, settings, now: NOW });
    assert.equal(over.reason, 'over-maximum');
    assert.equal(over.remaining, 20, 'says how much is actually left');

    assert.equal(checkTipAfterDelivery({ order, amount: 20, settings, now: NOW }).ok, true);
    assert.equal(
        checkTipAfterDelivery({ order: delivered({ tipAmount: 100 }), amount: 10, settings, now: NOW }).reason,
        'at-maximum',
    );
});

test('a missing order is refused rather than throwing', () => {
    assert.equal(checkTipAfterDelivery({ order: null, amount: 20, settings: on, now: NOW }).reason, 'not-found');
});

test('an order with no delivery timestamp is still tippable', () => {
    // Older orders predate the column; refusing them would punish the customer
    // for a gap in our own data.
    const v = checkTipAfterDelivery({ order: delivered({ deliveredAt: null }), amount: 20, settings: on, now: NOW });
    assert.equal(v.ok, true);
});
