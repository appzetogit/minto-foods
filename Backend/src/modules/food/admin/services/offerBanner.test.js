import test from 'node:test';
import assert from 'node:assert/strict';

import { isBannerLive } from './offerBanner.service.js';

/**
 * When an offer banner is showing.
 *
 * The dates are the whole point of this table, and an off-by-one here shows an
 * expired offer to customers or hides a campaign on the morning it launches.
 */

const NOW = new Date('2026-09-14T12:00:00.000Z');
const on = (extra = {}) => ({ isActive: true, startDate: null, endDate: null, ...extra });

test('switched on with no dates runs until someone switches it off', () => {
    assert.equal(isBannerLive(on(), NOW), true);
});

test('switched off never shows, whatever the dates say', () => {
    assert.equal(isBannerLive(on({ isActive: false }), NOW), false);
    assert.equal(
        isBannerLive({ isActive: false, startDate: '2026-09-01', endDate: '2026-12-01' }, NOW),
        false,
    );
});

test('a banner waiting to start is not shown', () => {
    assert.equal(isBannerLive(on({ startDate: '2026-09-20T00:00:00.000Z' }), NOW), false);
});

test('a banner past its end is not shown', () => {
    assert.equal(isBannerLive(on({ endDate: '2026-09-13T23:59:59.000Z' }), NOW), false);
});

test('the bounds include their own moment', () => {
    // A campaign starting at noon is live at noon, not a millisecond later.
    assert.equal(isBannerLive(on({ startDate: NOW.toISOString() }), NOW), true);
    assert.equal(isBannerLive(on({ endDate: NOW.toISOString() }), NOW), true);
});

test('one date set leaves the other end open', () => {
    assert.equal(isBannerLive(on({ startDate: '2026-09-01T00:00:00.000Z' }), NOW), true);
    assert.equal(isBannerLive(on({ endDate: '2026-12-01T00:00:00.000Z' }), NOW), true);
});

test('inside a window is live, either side of it is not', () => {
    const window = on({ startDate: '2026-09-10T00:00:00.000Z', endDate: '2026-09-20T00:00:00.000Z' });
    assert.equal(isBannerLive(window, NOW), true);
    assert.equal(isBannerLive(window, new Date('2026-09-09T23:59:59.000Z')), false);
    assert.equal(isBannerLive(window, new Date('2026-09-20T00:00:01.000Z')), false);
});

test('dates already parsed into Date objects behave the same as strings', () => {
    const asDates = on({ startDate: new Date('2026-09-10'), endDate: new Date('2026-09-20') });
    assert.equal(isBannerLive(asDates, NOW), true);
});
