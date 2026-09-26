import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getRestaurantAvailabilityStatus,
    getOutletScheduleStatus,
} from './restaurantAvailability.helper.js';

/**
 * Restaurants that close after midnight: open 1 Oct 4pm, close 2 Oct 2am.
 * Most restaurants on the platform keep hours like this, so a mistake here
 * shows real restaurants closed while they are cooking, or open when shut.
 *
 * 2026-10-01 is a Thursday. All times are India time.
 */
const at = (isoLocal) => new Date(`${isoLocal}+05:30`);
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const restaurant = (perDay) => ({
    isActive: true,
    isAcceptingOrders: true,
    outletTimings: {
        timings: DAYS.map((day) => ({ day, ...(perDay[day] ?? perDay.default) })),
    },
});
const lateNight = { isOpen: true, openingTime: '16:00', closingTime: '02:00' };
const closed = { isOpen: false, openingTime: '', closingTime: '' };
const open = (r, when) => getRestaurantAvailabilityStatus(r, at(when)).isOpen;

test('4pm to 2am: open in the evening and after midnight, shut in the morning', () => {
    const r = restaurant({ default: lateNight });
    assert.equal(open(r, '2026-10-01T15:59:00'), false, 'before opening');
    assert.equal(open(r, '2026-10-01T16:00:00'), true, 'at opening');
    assert.equal(open(r, '2026-10-01T23:30:00'), true, 'late evening');
    assert.equal(open(r, '2026-10-02T00:30:00'), true, 'after midnight');
    assert.equal(open(r, '2026-10-02T01:59:00'), true, 'just before closing');
    assert.equal(open(r, '2026-10-02T03:00:00'), false, 'after closing');
    assert.equal(open(r, '2026-10-02T11:00:00'), false, 'next morning');
});

test('after midnight the closing time shown is 2am', () => {
    const r = restaurant({ default: lateNight });
    const status = getRestaurantAvailabilityStatus(r, at('2026-10-02T01:00:00'));
    assert.equal(status.closingTime, '02:00');
});

test('a day off the night before is not open after midnight', () => {
    // Wednesday closed. Thursday's own 4pm-2am starts at 4pm Thursday; 1am
    // Thursday belongs to Wednesday night, and Wednesday was shut.
    const r = restaurant({ Wednesday: closed, default: lateNight });
    assert.equal(open(r, '2026-10-01T01:00:00'), false);
    assert.equal(open(r, '2026-10-01T17:00:00'), true);
});

test('the night before a day off still runs past midnight', () => {
    // Saturday 4pm-2am, Sunday closed: early Sunday is still Saturday night.
    const r = restaurant({ Sunday: closed, default: lateNight });
    const sat1am = '2026-10-04T01:00:00'; // Sunday 1am
    assert.equal(open(r, sat1am), true);
    const schedule = getOutletScheduleStatus(r, at(sat1am));
    assert.equal(schedule.isDayClosed, false, 'not reported as a day off while still open');
    assert.equal(open(r, '2026-10-04T03:00:00'), false);
    assert.equal(open(r, '2026-10-04T18:00:00'), false, 'Sunday evening is closed');
});

test('lunch plus a dinner that runs past midnight', () => {
    const split = {
        isOpen: true, openingTime: '11:00', closingTime: '15:00',
        slots: [{ open: '11:00', close: '15:00' }, { open: '19:00', close: '02:00' }],
    };
    const r = restaurant({ default: split });
    assert.equal(open(r, '2026-10-01T12:00:00'), true, 'lunch');
    assert.equal(open(r, '2026-10-01T17:00:00'), false, 'afternoon break');
    assert.equal(open(r, '2026-10-01T22:00:00'), true, 'dinner');
    assert.equal(open(r, '2026-10-02T01:00:00'), true, 'dinner after midnight');
    assert.equal(open(r, '2026-10-02T04:00:00'), false, 'night');
});

test('ordinary daytime hours are unchanged', () => {
    const r = restaurant({ default: { isOpen: true, openingTime: '09:00', closingTime: '22:00' } });
    assert.equal(open(r, '2026-10-01T08:59:00'), false);
    assert.equal(open(r, '2026-10-01T09:00:00'), true);
    assert.equal(open(r, '2026-10-01T22:00:00'), true);
    assert.equal(open(r, '2026-10-01T22:01:00'), false);
    assert.equal(open(r, '2026-10-02T01:00:00'), false, 'a daytime restaurant is not open after midnight');
});

test('closing at midnight', () => {
    const r = restaurant({ default: { isOpen: true, openingTime: '18:00', closingTime: '00:00' } });
    assert.equal(open(r, '2026-10-01T23:59:00'), true);
    assert.equal(open(r, '2026-10-02T00:30:00'), false);
});

test('hours on the restaurant itself, in am/pm, work the same', () => {
    const r = { isActive: true, isAcceptingOrders: true, openingTime: '4:00 pm', closingTime: '2:00 am' };
    assert.equal(open(r, '2026-10-01T20:00:00'), true);
    assert.equal(open(r, '2026-10-02T01:00:00'), true);
    assert.equal(open(r, '2026-10-02T10:00:00'), false);
});

test('no hours set is no restriction; a paused restaurant is shut whatever the time', () => {
    assert.equal(open({ isActive: true, isAcceptingOrders: true }, '2026-10-02T04:00:00'), true);
    const paused = { ...restaurant({ default: lateNight }), isAcceptingOrders: false };
    assert.equal(open(paused, '2026-10-01T20:00:00'), false);
});
