import test from 'node:test';
import assert from 'node:assert/strict';

import {
    readSlots,
    isWithinAnySlot,
    normalizeDaySlots,
    parseTimeToMinutes,
    MAX_SLOTS_PER_DAY,
} from './daySlots.helper.js';

/**
 * More than one opening window in a day.
 *
 * The risk here is not the new behaviour, it is the old one. Every reader of
 * this JSON parses `openingTime`/`closingTime` — the open-now check, the
 * storefront, dispatch, and whatever app build a customer has installed. If the
 * shape changes underneath them a restaurant is silently shown as closed, which
 * loses real orders and gets reported as nothing at all.
 *
 * So the pair stays and mirrors the first window. These tests are mostly about
 * that promise holding.
 */

const at = (time) => parseTimeToMinutes(time);

test('a day stored before slots existed still reads as one window', () => {
    const legacy = { day: 'Monday', isOpen: true, openingTime: '09:00', closingTime: '22:00' };
    assert.deepEqual(readSlots(legacy), [{ open: '09:00', close: '22:00' }]);
});

test('writing slots keeps the legacy pair pointing at the first window', () => {
    // The whole compatibility promise in one assertion.
    const out = normalizeDaySlots(
        { isOpen: true, slots: [{ open: '11:00', close: '15:00' }, { open: '19:00', close: '23:00' }] },
        { day: 'Monday' },
    );
    assert.equal(out.openingTime, '11:00');
    assert.equal(out.closingTime, '15:00');
    assert.equal(out.slots.length, 2);
});

test('slots are ordered by opening time however they were entered', () => {
    const out = normalizeDaySlots(
        { isOpen: true, slots: [{ open: '19:00', close: '23:00' }, { open: '11:00', close: '15:00' }] },
        { day: 'Monday' },
    );
    assert.deepEqual(out.slots.map((s) => s.open), ['11:00', '19:00']);
    // And the mirrored pair follows the sort, not the input order.
    assert.equal(out.openingTime, '11:00');
});

test('the afternoon gap actually closes the restaurant', () => {
    // The reason for the whole change: a single window could only claim to be
    // open through an afternoon nobody was cooking in.
    const slots = [{ open: '11:00', close: '15:00' }, { open: '19:00', close: '23:00' }];
    assert.equal(isWithinAnySlot(slots, at('12:30')), true);
    assert.equal(isWithinAnySlot(slots, at('17:00')), false);
    assert.equal(isWithinAnySlot(slots, at('20:00')), true);
});

test('a window running past midnight stays open', () => {
    // 22:00–02:00 is a real kitchen. Read as a plain range it would be empty
    // and shut the restaurant at ten.
    const slots = [{ open: '22:00', close: '02:00' }];
    assert.equal(isWithinAnySlot(slots, at('23:30')), true);
    assert.equal(isWithinAnySlot(slots, at('01:00')), true);
    assert.equal(isWithinAnySlot(slots, at('12:00')), false);
});

test('a closed day has no windows and no times', () => {
    const out = normalizeDaySlots({ isOpen: false }, { day: 'Sunday' });
    assert.deepEqual(out, { day: 'Sunday', isOpen: false, openingTime: '', closingTime: '', slots: [] });
});

test('a day with nothing set falls back to the default window', () => {
    const out = normalizeDaySlots({}, { day: 'Monday' });
    assert.deepEqual(out.slots, [{ open: '09:00', close: '22:00' }]);
    assert.equal(out.openingTime, '09:00');
});

test('no windows at all means no restriction, not closed', () => {
    // Same meaning the absent pair has always had. Treating it as closed would
    // shut every restaurant that never set hours.
    assert.equal(isWithinAnySlot([], at('03:00')), true);
});

test('open equal to close is all day, as the single-pair reader always treated it', () => {
    assert.equal(isWithinAnySlot([{ open: '00:00', close: '00:00' }], at('13:00')), true);
});

test('slots are capped so a day cannot hold an unbounded list', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
        open: `0${i}:00`.slice(-5),
        close: `0${i}:30`.slice(-5),
    }));
    const out = normalizeDaySlots({ isOpen: true, slots: many }, { day: 'Monday' });
    assert.equal(out.slots.length, MAX_SLOTS_PER_DAY);
});

test('a malformed slot is dropped rather than parsed into nonsense', () => {
    const out = readSlots({ slots: [{ open: '25:00', close: '99:99' }, { open: '11:00', close: '15:00' }] });
    assert.deepEqual(out, [{ open: '11:00', close: '15:00' }]);
});

test('slots accept the legacy key names too', () => {
    // A client may send openingTime/closingTime inside a slot out of habit.
    const out = readSlots({ slots: [{ openingTime: '11:00', closingTime: '15:00' }] });
    assert.deepEqual(out, [{ open: '11:00', close: '15:00' }]);
});

test('times are padded to HH:mm so string comparison is safe', () => {
    const out = normalizeDaySlots({ isOpen: true, slots: [{ open: '9:05', close: '21:00' }] }, { day: 'Monday' });
    assert.equal(out.slots[0].open, '09:05');
});
