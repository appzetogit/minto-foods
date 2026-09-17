import test from 'node:test';
import assert from 'node:assert/strict';

import {
    checkRiderFix,
    createRiderFixTracker,
    distanceMeters,
    MAX_SPEED_KMH,
    SAVE_EVERY_MS,
} from './riderFix.js';

/**
 * Which rider positions reach the customer's map. Indore; 0.00009 degrees of
 * latitude is about 10 metres.
 */

const START = { lat: 22.7196, lng: 75.8577 };
const north = (metres) => ({ lat: START.lat + metres * 0.000009, lng: START.lng });
const T0 = 1_800_000_000_000;

test('distance is right to within a metre over a city block', () => {
    assert.ok(Math.abs(distanceMeters(START, north(100)) - 100) < 1);
});

test('a normal ride is accepted fix after fix', () => {
    const tracker = createRiderFixTracker();
    // ~30 km/h: 42 m every 5 seconds, good accuracy.
    for (let i = 0; i < 20; i++) {
        const v = tracker.accept('o1', { ...north(i * 42), accuracy: 8, at: T0 + i * 5000 });
        assert.equal(v.ok, true, `fix ${i}`);
    }
});

test('a wildly inaccurate fix mid-ride is dropped', () => {
    const tracker = createRiderFixTracker();
    tracker.accept('o1', { ...north(0), accuracy: 6, at: T0 });
    const bad = tracker.accept('o1', { ...north(40), accuracy: 150, at: T0 + 5000 });
    assert.deepEqual(bad, { ok: false, reason: 'inaccurate' });
    // And the next good fix is judged against the last GOOD one.
    assert.equal(tracker.accept('o1', { ...north(80), accuracy: 7, at: T0 + 10000 }).ok, true);
});

test('a GPS jump across town is dropped', () => {
    const tracker = createRiderFixTracker();
    tracker.accept('o1', { ...north(0), accuracy: 5, at: T0 });
    // 800 m in 5 s is 576 km/h.
    const jump = tracker.accept('o1', { ...north(800), accuracy: 12, at: T0 + 5000 });
    assert.deepEqual(jump, { ok: false, reason: 'implausible-jump' });
});

test('fast but real riding is not mistaken for a jump', () => {
    // Just under the limit: 160 m in 5 s is 115 km/h.
    const v = checkRiderFix({ ...START, at: T0 }, { ...north(160), accuracy: 10, at: T0 + 5000 });
    assert.equal(v.ok, true);
    assert.ok(MAX_SPEED_KMH >= 115);
});

test('two fixes milliseconds apart cannot fake an impossible speed', () => {
    // 4 m of jitter 20 ms later would be 720 km/h if divided by 0.02 s.
    const v = checkRiderFix({ ...START, at: T0 }, { ...north(4), accuracy: 5, at: T0 + 20 });
    assert.equal(v.ok, true);
});

test('the map never freezes: after a long silence, whatever comes is taken', () => {
    const tracker = createRiderFixTracker();
    tracker.accept('o1', { ...north(0), accuracy: 5, at: T0 });
    // Rider went through a long underpass, app asleep: 2 km later, 90 s on,
    // with poor accuracy. Still better than a bike frozen 2 km back.
    const v = tracker.accept('o1', { ...north(2000), accuracy: 80, at: T0 + 90_000 });
    assert.equal(v.ok, true);
});

test('pure noise is refused even after a silence', () => {
    const v = checkRiderFix(null, { ...START, accuracy: 900, at: T0 });
    assert.deepEqual(v, { ok: false, reason: 'inaccurate' });
});

test('the first fix of a trip is taken when reasonable', () => {
    assert.equal(checkRiderFix(null, { ...START, accuracy: 40, at: T0 }).ok, true);
    assert.equal(checkRiderFix(null, { ...START, accuracy: null, at: T0 }).ok, true, 'accuracy not sent');
});

test('0,0 -- a phone with no position yet -- is never shown', () => {
    assert.deepEqual(checkRiderFix(null, { lat: 0, lng: 0, accuracy: 5, at: T0 }), { ok: false, reason: 'no-position' });
});

test('orders are tracked independently', () => {
    const tracker = createRiderFixTracker();
    tracker.accept('o1', { ...north(0), accuracy: 5, at: T0 });
    // A different order far away is its own first fix, not a jump.
    assert.equal(tracker.accept('o2', { ...north(5000), accuracy: 5, at: T0 + 1000 }).ok, true);
});

test('the database is written at most once per interval per order', () => {
    const tracker = createRiderFixTracker();
    assert.equal(tracker.shouldSave('o1', T0), true);
    assert.equal(tracker.shouldSave('o1', T0 + 5000), false);
    assert.equal(tracker.shouldSave('o1', T0 + SAVE_EVERY_MS - 1), false);
    assert.equal(tracker.shouldSave('o1', T0 + SAVE_EVERY_MS), true);
    assert.equal(tracker.shouldSave('o2', T0 + 1000), true, 'other orders are not held back');
});
