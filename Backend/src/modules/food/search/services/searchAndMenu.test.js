import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { searchUnified } from './search.service.js';
import {
    getPublicApprovedRestaurantMenu,
    getRestaurantMenu,
} from '../../restaurant/services/restaurantMenu.service.js';

/**
 * Customers never see an out-of-stock dish (owners still do), and search
 * results carry the same open-now fields as the restaurant list.
 */
const HERE = testPatch(19);
const created = { restaurants: [], foods: [] };
let restaurant;
let tag;
let available;
let soldOut;
let backNow;

test.before(async () => {
    tag = uniqueTag('Srch');
    restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            latitude: HERE.lat,
            longitude: HERE.lng,
        },
    });
    created.restaurants.push(restaurant.id);
    const food = (name, extra = {}) => prisma.foodItem.create({
        data: { restaurantId: restaurant.id, name: `${tag} ${name}`, price: 100, approvalStatus: 'approved', ...extra },
    });
    available = await food('Paneer', { isAvailable: true });
    soldOut = await food('Biryani', { isAvailable: false });
    // Taken off for an hour that is already over: it must come back by itself.
    backNow = await food('Dosa', { isAvailable: false, stockResumeAt: new Date(Date.now() - 60_000), stockOffMode: 'specific_time' });
    created.foods.push(available.id, soldOut.id, backNow.id);
});

test.after(async () => {
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('the public menu leaves out of stock dishes out; the owner still sees them', async () => {
    const dishIds = (menu) => new Set(menu.sections.flatMap((s) => s.items.map((i) => i.id)));

    const publicIds = dishIds(await getPublicApprovedRestaurantMenu(restaurant.id));
    assert.ok(publicIds.has(available.id));
    assert.ok(!publicIds.has(soldOut.id), 'out of stock is not sent to customers');
    assert.ok(publicIds.has(backNow.id), 'a timed out-of-stock that has ended is back');

    const ownerIds = dishIds(await getRestaurantMenu(restaurant.id));
    assert.ok(ownerIds.has(soldOut.id), "the owner's menu keeps it");
});

test('search does not match an out of stock dish', async () => {
    const soldOutSearch = await searchUnified({ q: `${tag} Biryani`, lat: HERE.lat, lng: HERE.lng });
    assert.ok(!soldOutSearch.data.restaurants.some((r) => r.matchedDishId === soldOut.id));

    const inStock = await searchUnified({ q: `${tag} Paneer`, lat: HERE.lat, lng: HERE.lng });
    const hit = inStock.data.restaurants.find((r) => r.id === restaurant.id);
    assert.ok(hit, 'an in-stock dish finds its restaurant');
    assert.equal(hit.matchedDishId, available.id);
});

test('search results carry isOpenNow, openStatusReason and nextOpeningAt, and no zone flag', async () => {
    const result = await searchUnified({ q: tag, lat: HERE.lat, lng: HERE.lng });
    const hit = result.data.restaurants.find((r) => r.id === restaurant.id);
    assert.ok(hit);
    for (const key of ['isOpenNow', 'isOpen', 'openStatusReason', 'nextOpeningAt', 'openingTime', 'closingTime', 'openDays', 'outletTimings']) {
        assert.ok(key in hit, `${key} is returned`);
    }
    assert.equal(typeof hit.isOpenNow, 'boolean');
    assert.ok(!('zoneFiltered' in result.data));
});

test('search needs a location, and ignores the zone the app sends', async () => {
    const unlocated = await searchUnified({ q: tag });
    assert.equal(unlocated.data.requiresLocation, true);
    assert.equal(unlocated.data.restaurants.length, 0);

    const withZone = await searchUnified({ q: tag, lat: HERE.lat, lng: HERE.lng, zoneId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.ok(withZone.data.restaurants.some((r) => r.id === restaurant.id));
});
