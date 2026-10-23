import test from 'node:test';
import assert from 'node:assert/strict';

import { getNextOpeningAt, withOpenStatus } from './restaurantAvailability.helper.js';
import { toRestaurantIsoString } from '../../../../utils/timezone.js';

/**
 * When a closed restaurant opens next, which the apps show as "Opens at 6 PM".
 *
 * 2026-10-01 is a Thursday. All times are India time.
 */
const at = (isoLocal) => new Date(`${isoLocal}+05:30`);
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const restaurant = (perDay, extra = {}) => ({
    isActive: true,
    isAcceptingOrders: true,
    outletTimings: {
        timings: DAYS.map((day) => ({ day, ...(perDay[day] ?? perDay.default) })),
    },
    ...extra,
});
const evening = { isOpen: true, openingTime: '18:00', closingTime: '23:00' };
const closedDay = { isOpen: false, openingTime: '', closingTime: '' };

test('before today\'s window it is today\'s opening time', () => {
    const r = restaurant({ default: evening });
    assert.equal(toRestaurantIsoString(getNextOpeningAt(r, at('2026-10-01T11:00:00'))), '2026-10-01T18:00:00+05:30');
});

test('after today\'s window it is tomorrow\'s', () => {
    const r = restaurant({ default: evening });
    assert.equal(toRestaurantIsoString(getNextOpeningAt(r, at('2026-10-01T23:30:00'))), '2026-10-02T18:00:00+05:30');
});

test('closed days are skipped', () => {
    // Shut Friday and Saturday: Thursday night's next opening is Sunday.
    const r = restaurant({ default: evening, Friday: closedDay, Saturday: closedDay });
    assert.equal(toRestaurantIsoString(getNextOpeningAt(r, at('2026-10-01T23:30:00'))), '2026-10-04T18:00:00+05:30');
});

test('between lunch and dinner it is the dinner slot', () => {
    const r = restaurant({
        default: { isOpen: true, slots: [{ open: '11:00', close: '15:00' }, { open: '19:00', close: '23:00' }] },
    });
    assert.equal(toRestaurantIsoString(getNextOpeningAt(r, at('2026-10-01T16:00:00'))), '2026-10-01T19:00:00+05:30');
});

test('withOpenStatus: nextOpeningAt only when closed by its hours', () => {
    const r = restaurant({ default: evening });

    const closedNow = withOpenStatus(r, at('2026-10-01T11:00:00'));
    assert.equal(closedNow.isOpenNow, false);
    assert.equal(closedNow.openStatusReason, 'outside-hours');
    assert.equal(closedNow.nextOpeningAt, '2026-10-01T18:00:00+05:30');

    const openNow = withOpenStatus(r, at('2026-10-01T19:00:00'));
    assert.equal(openNow.isOpenNow, true);
    assert.equal(openNow.nextOpeningAt, null);

    // Switched off by hand: the hours cannot say when it comes back.
    const off = withOpenStatus({ ...r, isAcceptingOrders: false }, at('2026-10-01T19:00:00'));
    assert.equal(off.openStatusReason, 'not-accepting-orders');
    assert.equal(off.nextOpeningAt, null);
});
