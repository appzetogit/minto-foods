import test from 'node:test';
import assert from 'node:assert/strict';

import { decideCod, codMessage } from './codAvailability.service.js';

/**
 * Who may pay cash on delivery.
 *
 * Three inputs and they are not interchangeable: the platform switch, the
 * zone's own setting, and how many orders the customer has actually taken
 * delivery of. Getting the precedence wrong either hands COD to the customers
 * a zone is trying to hold back, or refuses it to everyone at once.
 */

const ZONE_UNSET = { codEnabled: null, codMinDeliveredOrders: 0 };

test('the platform switch beats everything', () => {
    // The escape hatch. If it does not win, turning COD off during an incident
    // does not actually turn it off.
    const zoneSaysYes = { codEnabled: true, codMinDeliveredOrders: 0 };
    assert.equal(decideCod(zoneSaysYes, 99, false).allowed, false);
    assert.equal(decideCod(zoneSaysYes, 99, false).reason, 'platform-off');
});

test('a zone that has never been configured follows the platform', () => {
    // null is not false. Every zone predating this column has null, and they
    // must keep behaving exactly as they did.
    assert.equal(decideCod(ZONE_UNSET, 0, true).allowed, true);
    assert.equal(decideCod(null, 0, true).allowed, true);
    assert.equal(decideCod(undefined, 0, true).allowed, true);
});

test('a zone can switch COD off on its own', () => {
    const off = { codEnabled: false, codMinDeliveredOrders: 0 };
    assert.deepEqual(decideCod(off, 500, true), { allowed: false, reason: 'zone-off' });
});

test('a threshold of zero offers COD to everyone', () => {
    assert.equal(decideCod({ codEnabled: true, codMinDeliveredOrders: 0 }, 0, true).allowed, true);
});

test('a new customer is held back until they meet the threshold', () => {
    const zone = { codEnabled: true, codMinDeliveredOrders: 2 };
    assert.equal(decideCod(zone, 0, true).reason, 'new-customer');
    assert.equal(decideCod(zone, 1, true).reason, 'new-customer');
    assert.equal(decideCod(zone, 2, true).allowed, true);
    assert.equal(decideCod(zone, 3, true).allowed, true);
});

test('the threshold is met exactly at the boundary, not one past it', () => {
    // Off by one here means a customer is told "after your first order" twice.
    const zone = { codEnabled: true, codMinDeliveredOrders: 1 };
    assert.equal(decideCod(zone, 0, true).allowed, false);
    assert.equal(decideCod(zone, 1, true).allowed, true);
});

test('a zone that is off ignores the threshold entirely', () => {
    // Otherwise a well-established customer would be told they are too new,
    // which is both wrong and confusing.
    const zone = { codEnabled: false, codMinDeliveredOrders: 5 };
    assert.equal(decideCod(zone, 100, true).reason, 'zone-off');
});

test('a missing or nonsense threshold means no threshold', () => {
    for (const bad of [undefined, null, '', 'lots', NaN, -3]) {
        const zone = { codEnabled: true, codMinDeliveredOrders: bad };
        assert.equal(decideCod(zone, 0, true).allowed, true, String(bad));
    }
});

test('a new customer is told why, not just refused', () => {
    // An unexplained missing payment method reads as a bug and gets abandoned.
    const message = codMessage('new-customer');
    assert.match(message, /first delivered order/i);
    assert.notEqual(message, codMessage('zone-off'));
});

test('no message leaks the internal reason', () => {
    for (const reason of ['platform-off', 'zone-off', 'new-customer']) {
        assert.ok(!codMessage(reason).includes(reason));
    }
});
