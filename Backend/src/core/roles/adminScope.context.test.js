import test from 'node:test';
import assert from 'node:assert/strict';

import { applyAdminScope, createAllowed, currentAdminScope, runWithAdminScope } from './adminScope.context.js';

/** A sub-admin for Indore, which has two zones. */
const INDORE = { adminId: 'a1', cityIds: ['c-indore'], cityNames: ['Indore'], zoneIds: ['z1', 'z2'] };
const NOTHING = { adminId: 'a2', cityIds: [], cityNames: [], zoneIds: [] };

test('orders are limited to the zones of the assigned cities', () => {
    const args = applyAdminScope('FoodOrder', 'findMany', { where: { orderStatus: 'delivered' }, take: 5 }, INDORE);
    assert.deepEqual(args, {
        take: 5,
        where: { AND: [{ orderStatus: 'delivered' }, { zoneId: { in: ['z1', 'z2'] } }] },
    });
});

test('a query with no where of its own still gets the limit', () => {
    assert.deepEqual(applyAdminScope('FoodOrder', 'count', {}, INDORE).where, { zoneId: { in: ['z1', 'z2'] } });
});

test('an order in another city reads as not found', () => {
    const args = applyAdminScope('FoodOrder', 'findUnique', { where: { id: 'o9' } }, INDORE);
    assert.deepEqual(args.where, { id: 'o9', AND: [{ zoneId: { in: ['z1', 'z2'] } }] });
});

test('updates and deletes carry the limit too', () => {
    for (const op of ['update', 'delete', 'updateMany', 'deleteMany']) {
        const where = applyAdminScope('FoodRestaurant', op, { where: { id: 'r1' }, data: {} }, INDORE).where;
        assert.ok(JSON.stringify(where).includes('pendingZoneId'), op);
    }
});

test('a restaurant awaiting approval in the city is visible through its pending zone', () => {
    const { where } = applyAdminScope('FoodRestaurant', 'findMany', {}, INDORE);
    assert.deepEqual(where, { OR: [{ zoneId: { in: ['z1', 'z2'] } }, { pendingZoneId: { in: ['z1', 'z2'] } }] });
});

test('riders are matched on their city name', () => {
    const { where } = applyAdminScope('FoodDeliveryPartner', 'findMany', {}, INDORE);
    assert.deepEqual(where, { city: { in: ['Indore'], mode: 'insensitive' } });
});

test('platform-wide banners are visible but only the city\'s own can be changed', () => {
    const read = applyAdminScope('FoodOfferBanner', 'findMany', {}, INDORE).where;
    assert.deepEqual(read, { OR: [{ zoneId: { in: ['z1', 'z2'] } }, { zoneId: null }] });
    const write = applyAdminScope('FoodOfferBanner', 'updateMany', { where: {}, data: {} }, INDORE).where;
    assert.deepEqual(write, { AND: [{}, { zoneId: { in: ['z1', 'z2'] } }] });
});

test('a sub-admin with no cities sees nothing', () => {
    assert.deepEqual(applyAdminScope('FoodOrder', 'findMany', {}, NOTHING).where, { zoneId: { in: [] } });
});

test('models with no city are left alone', () => {
    const args = { where: { id: 'u1' } };
    assert.equal(applyAdminScope('FoodUser', 'findUnique', args, INDORE), args);
    assert.equal(applyAdminScope('FoodOrder', 'findMany', args, undefined), args, 'no scope, no change');
});

test('creating outside the cities is refused', () => {
    assert.equal(createAllowed('FoodZone', { cityId: 'c-indore' }, INDORE), true);
    assert.equal(createAllowed('FoodZone', { cityId: 'c-vapi' }, INDORE), false);
    assert.equal(createAllowed('FoodRestaurant', { pendingZoneId: 'z2' }, INDORE), true);
    assert.equal(createAllowed('FoodRestaurant', { zone: { connect: { id: 'z9' } } }, INDORE), false);
    assert.equal(createAllowed('FoodDeliveryPartner', { city: ' indore' }, INDORE), true);
    assert.throws(() => applyAdminScope('FoodSurgeRule', 'create', { data: { zoneId: null } }, INDORE), /outside the cities/);
    assert.doesNotThrow(() => applyAdminScope('FoodSurgeRule', 'create', { data: { zoneId: 'z1' } }, INDORE));
});

test('the scope follows the request through awaits', async () => {
    const seen = await runWithAdminScope(INDORE, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentAdminScope();
    });
    assert.equal(seen, INDORE);
    assert.equal(currentAdminScope(), undefined);
});
