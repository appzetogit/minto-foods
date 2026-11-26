import test from 'node:test';
import assert from 'node:assert/strict';

import { describeLiveStatus } from './liveStatus.helper.js';

// 10:00 in India, Thursday 26 Nov 2026.
const now = new Date('2026-11-26T04:30:00.000Z');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hours = (openingTime, closingTime, day = {}) => ({
    timings: DAYS.map((d) => ({ day: d, isOpen: true, openingTime, closingTime, ...(day[d] || {}) })),
});

test('open within its hours and switched on is online, till closing', () => {
    const s = describeLiveStatus({ outletTimings: hours('09:00', '23:00') }, now);
    assert.equal(s.code, 'online');
    assert.equal(s.online, true);
    assert.equal(s.closingTime, '23:00');
    assert.equal(s.nextOpeningAt, null);
});

test('before its slot it is outside hours and says when it opens', () => {
    const s = describeLiveStatus({ outletTimings: hours('18:00', '23:00') }, now);
    assert.equal(s.code, 'outside-hours');
    assert.match(s.nextOpeningAt, /^2026-11-26T18:00/);
});

test('a day marked closed opens on the next open day', () => {
    const s = describeLiveStatus({ outletTimings: hours('09:00', '23:00', { Thursday: { isOpen: false } }) }, now);
    assert.equal(s.code, 'closed-day');
    assert.match(s.nextOpeningAt, /^2026-11-27T09:00/);
});

test('switched off says by whom, even inside its hours', () => {
    const admin = describeLiveStatus({ isAcceptingOrders: false, offlineByAdmin: true, outletTimings: hours('09:00', '23:00') }, now);
    assert.equal(admin.code, 'offline-admin');
    assert.equal(admin.withinHours, true);
    const owner = describeLiveStatus({ isAcceptingOrders: false, outletTimings: hours('09:00', '23:00') }, now);
    assert.equal(owner.code, 'offline-restaurant');
});

test('an inactive zone hides it whatever the switch says', () => {
    const s = describeLiveStatus({ zone: { isActive: false }, outletTimings: hours('09:00', '23:00') }, now);
    assert.equal(s.code, 'zone-inactive');
});
