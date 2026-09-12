import test from 'node:test';
import assert from 'node:assert/strict';

import { decideCod, codMessage, effectiveCod, parseZoneCodSettings } from './codAvailability.service.js';

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

/**
 * What the admin screen is shown.
 *
 * It runs the same decision the order path runs, so these guard the one thing
 * that matters about it: the panel cannot promise something checkout refuses.
 */

test('the screen shows new and returning customers separately', () => {
    const zone = { codEnabled: true, codMinDeliveredOrders: 3 };
    const shown = effectiveCod(zone, true);
    assert.equal(shown.newCustomer.allowed, false);
    assert.equal(shown.newCustomer.reason, 'new-customer');
    assert.equal(shown.returningCustomer.allowed, true);
});

test('the screen agrees with the rule when the platform is off', () => {
    // An explicitly-on zone still reads as off, which is what the customer gets.
    const zone = { codEnabled: true, codMinDeliveredOrders: 0 };
    const shown = effectiveCod(zone, false);
    assert.equal(shown.newCustomer.reason, 'platform-off');
    assert.equal(shown.returningCustomer.reason, 'platform-off');
});

test('a zone with no threshold reads the same for both customers', () => {
    const shown = effectiveCod(ZONE_UNSET, true);
    assert.deepEqual(shown.newCustomer, shown.returningCustomer);
    assert.equal(shown.newCustomer.allowed, true);
});

/**
 * Reading the admin's edit.
 *
 * codEnabled is tri-state and null is a real instruction ("follow the
 * platform"), so an absent key and an explicit null must not collapse into one.
 */

test('an explicit null is stored, not treated as absent', () => {
    assert.deepEqual(parseZoneCodSettings({ codEnabled: null }).data, { codEnabled: null });
    assert.equal(parseZoneCodSettings({ codEnabled: null }).error, null);
});

test('an absent key leaves that setting alone', () => {
    const { data } = parseZoneCodSettings({ codMinDeliveredOrders: 2 });
    assert.deepEqual(data, { codMinDeliveredOrders: 2 });
    assert.ok(!('codEnabled' in data));
});

test('all three states of the zone switch survive the round trip', () => {
    for (const [sent, stored] of [[true, true], ['true', true], [false, false], ['false', false], [null, null], ['null', null]]) {
        assert.equal(parseZoneCodSettings({ codEnabled: sent }).data.codEnabled, stored, String(sent));
    }
});

test('a nonsense switch value is refused rather than guessed at', () => {
    // Guessing would silently turn COD on or off for a whole zone.
    for (const bad of [0, 1, 'yes', 'off', {}, []]) {
        assert.ok(parseZoneCodSettings({ codEnabled: bad }).error, JSON.stringify(bad));
    }
});

test('a threshold must be a whole number of zero or more', () => {
    assert.equal(parseZoneCodSettings({ codMinDeliveredOrders: 0 }).data.codMinDeliveredOrders, 0);
    assert.equal(parseZoneCodSettings({ codMinDeliveredOrders: '5' }).data.codMinDeliveredOrders, 5);
    for (const bad of [-1, 1.5, 'lots', null, '', NaN]) {
        assert.ok(parseZoneCodSettings({ codMinDeliveredOrders: bad }).error, String(bad));
    }
});

test('an empty patch is refused, so a bad post cannot look like a save', () => {
    assert.ok(parseZoneCodSettings({}).error);
    assert.ok(parseZoneCodSettings(null).error);
    assert.ok(parseZoneCodSettings({ somethingElse: true }).error);
});
