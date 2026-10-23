import test from 'node:test';
import assert from 'node:assert/strict';

import { etaMinutesFor, parsePrepMinutes } from './eta.service.js';

test('prep time is read from what restaurants type', () => {
    assert.equal(parsePrepMinutes('15-20 min'), 20);
    assert.equal(parsePrepMinutes('25'), 25);
    assert.equal(parsePrepMinutes('1 hr'), 60);
    assert.equal(parsePrepMinutes(''), null);
    assert.equal(parsePrepMinutes('quick'), null);
});

const placedAt = new Date('2026-10-24T12:00:00+05:30');
const at = (minutesLater) => new Date(placedAt.getTime() + minutesLater * 60000);

test('before pickup: the kitchen and the rider overlap, then the drive to the customer', () => {
    // 20 min to cook, rider 5 min away, 12 min drive: 20 + 12.
    assert.equal(etaMinutesFor({
        status: 'preparing', prepMinutes: 20, placedAt, now: placedAt,
        riderToRestaurant: 5, restaurantToCustomer: 12,
    }), 32);
    // Rider 30 min away: the rider is the slower part.
    assert.equal(etaMinutesFor({
        status: 'confirmed', prepMinutes: 20, placedAt, now: placedAt,
        riderToRestaurant: 30, restaurantToCustomer: 12,
    }), 42);
    // 15 minutes in, 5 minutes of cooking left.
    assert.equal(etaMinutesFor({
        status: 'preparing', prepMinutes: 20, placedAt, now: at(15),
        riderToRestaurant: null, restaurantToCustomer: 12,
    }), 17);
    // Food ready: only the rider and the drive remain.
    assert.equal(etaMinutesFor({
        status: 'ready_for_pickup', prepMinutes: 20, placedAt, now: placedAt,
        riderToRestaurant: 4, restaurantToCustomer: 12,
    }), 16);
});

test('after pickup it is the rider\'s drive to the customer', () => {
    assert.equal(etaMinutesFor({
        status: 'picked_up', prepMinutes: 20, placedAt, now: at(30),
        riderToCustomer: 7, restaurantToCustomer: 12,
    }), 7);
});

test('no drive time, no ETA', () => {
    assert.equal(etaMinutesFor({ status: 'preparing', prepMinutes: 20, placedAt, now: placedAt }), null);
});
