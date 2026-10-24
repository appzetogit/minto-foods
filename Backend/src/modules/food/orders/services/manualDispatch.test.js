import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { createOrder } from './order.service.js';
import { tryAutoAssign, processDispatchTimeout, getDispatchSettings, updateDispatchSettings } from './order-dispatch.service.js';
import {
    assignRiderManually,
    clearDispatchModeCache,
    listEligibleRiders,
    listManualQueue,
    setZoneDispatchMode,
    withdrawManualAssignment,
} from './manualDispatch.service.js';
import { acceptOrderDelivery, listOrdersAvailableDelivery, rejectOrderDelivery } from './order-delivery.service.js';

/**
 * Manual rider assignment: in a manual zone nothing is offered to riders, an
 * admin assigns a rider from the zone, and a decline or no answer sends the
 * order back to the admin's queue.
 */
const HERE = testPatch(14);
const ELSEWHERE = testPatch(15);
const created = { zones: [], restaurants: [], users: [], foods: [], partners: [] };
let tag;
let zoneId;
let restaurantId;
let foodId;
let userId;
const riders = {};

const address = () => ({
    label: 'Home', fullName: 'Test Customer', street: '1 Test Street', city: 'Indore', state: 'MP',
    zipCode: '452001', phone: uniquePhone('5'), latitude: HERE.lat + 0.005, longitude: HERE.lng,
});

const makeRider = async (key, { at = HERE, online = true } = {}) => {
    const r = await prisma.foodDeliveryPartner.create({
        data: {
            name: `${tag} ${key}`,
            phone: uniquePhone('8'),
            status: 'approved',
            availabilityStatus: online ? 'online' : 'offline',
            lastLat: at.lat + 0.002,
            lastLng: at.lng,
            lastLocationAt: new Date(),
        },
    });
    created.partners.push(r.id);
    riders[key] = r;
    return r;
};

/** A cash order the restaurant has confirmed, then handed to dispatch. */
const confirmedOrder = async () => {
    const { order } = await createOrder(userId, {
        restaurantId,
        items: [{ itemId: foodId, quantity: 1 }],
        address: address(),
        paymentMethod: 'cash',
    });
    const id = order._id || order.id;
    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'confirmed' } });
    await tryAutoAssign(id);
    return id;
};

const orderRow = (id) => prisma.foodOrder.findUnique({ where: { id }, include: { dispatchOffers: true } });

test.before(async () => {
    tag = uniqueTag('Dsp');
    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    created.zones.push(zone.id);
    zoneId = zone.id;
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved',
            zoneId, latitude: HERE.lat, longitude: HERE.lng, isAcceptingOrders: true, outsideHoursOverride: true,
        },
    });
    created.restaurants.push(restaurant.id);
    restaurantId = restaurant.id;
    const food = await prisma.foodItem.create({
        data: { restaurantId, name: `${tag} Rice`, price: 150, approvalStatus: 'approved', isAvailable: true },
    });
    created.foods.push(food.id);
    foodId = food.id;
    const user = await prisma.foodUser.create({ data: { name: `${tag} User`, phone: uniquePhone('5') } });
    created.users.push(user.id);
    userId = user.id;

    await makeRider('amit');
    await makeRider('bala');
    await makeRider('chetan', { at: ELSEWHERE });
    await makeRider('dev', { online: false });

    await setZoneDispatchMode(zoneId, 'manual');
});

test.after(async () => {
    await updateDispatchSettings('auto', null);
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.orderDispatchOffer.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

let orderA;

test('a manual zone offers nothing to riders; the order waits for an admin', async () => {
    orderA = await confirmedOrder();
    const row = await orderRow(orderA);
    assert.equal(row.dispatchStatus, 'unassigned');
    assert.equal(row.dispatchOffers.length, 0, 'no rider was offered it');
    assert.ok(row.awaitingManualAt, 'it is in the admin queue');

    const queue = await listManualQueue();
    assert.ok(queue.orders.some((o) => o.id === orderA));
});

test('riders can neither see nor grab an unassigned manual order', async () => {
    const list = await listOrdersAvailableDelivery(riders.amit.id, {});
    const ids = (list.docs || list.orders || list.items || list.data || list).map?.((o) => o._id || o.id) || [];
    assert.ok(!ids.includes(orderA), 'not in the available list');
    await assert.rejects(() => acceptOrderDelivery(orderA, riders.amit.id), /assigned by the dispatcher/);
});

test('the picker lists online riders in the zone first and flags the rest', async () => {
    const { riders: list } = await listEligibleRiders(orderA);
    const names = list.map((r) => r.name);
    assert.ok(names.includes(riders.amit.name) && names.includes(riders.bala.name));
    assert.ok(!names.includes(riders.dev.name), 'offline hidden by default');
    const amit = list.find((r) => r.id === riders.amit.id);
    assert.equal(amit.insideZone, true);
    assert.equal(amit.assignable, true);

    const all = await listEligibleRiders(orderA, { includeOffline: true });
    const dev = all.riders.find((r) => r.id === riders.dev.id);
    assert.equal(dev.assignable, false);
    assert.match(dev.notAssignableReason, /Offline/);
});

test('an offline or out-of-zone rider is refused without an override', async () => {
    await assert.rejects(() => assignRiderManually(orderA, riders.dev.id, null), /Offline/);
    await assert.rejects(() => assignRiderManually(orderA, riders.chetan.id, null), /zone/);
});

test('assign -> rider declines -> back in the queue, marked as declined by them', async () => {
    const res = await assignRiderManually(orderA, riders.amit.id, null);
    assert.equal(res.assignedTo.id, riders.amit.id);
    let row = await orderRow(orderA);
    assert.equal(row.dispatchStatus, 'assigned');
    assert.equal(row.dispatchDeliveryPartnerId, riders.amit.id);

    // Only the assigned rider can take it.
    await assert.rejects(() => acceptOrderDelivery(orderA, riders.bala.id), /not assigned to you/);

    await rejectOrderDelivery(orderA, riders.amit.id);
    await new Promise((r) => setTimeout(r, 300));
    row = await orderRow(orderA);
    assert.equal(row.dispatchStatus, 'unassigned');
    assert.equal(row.dispatchOffers.length, 1, 'still no automatic offers');
    assert.equal(row.dispatchOffers[0].action, 'rejected');

    const queued = (await listManualQueue()).orders.find((o) => o.id === orderA);
    assert.deepEqual(queued.declinedBy.map((d) => d.id), [riders.amit.id]);
});

test('two admins assigning at once: only one wins', async () => {
    const results = await Promise.allSettled([
        assignRiderManually(orderA, riders.bala.id, null),
        assignRiderManually(orderA, riders.amit.id, null),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('the assigned rider accepts; the order leaves the queue', async () => {
    const row = await orderRow(orderA);
    const assignee = row.dispatchDeliveryPartnerId;
    await acceptOrderDelivery(orderA, assignee);
    const after = await orderRow(orderA);
    assert.equal(after.dispatchStatus, 'accepted');
    assert.equal(after.awaitingManualAt, null);
    assert.ok(!(await listManualQueue()).orders.some((o) => o.id === orderA));

    // That rider is now busy and can't be given another order.
    const another = await confirmedOrder();
    await assert.rejects(() => assignRiderManually(another, assignee, null), /another delivery/);
});

test('no answer in time sends the order back to the queue', async () => {
    const id = await confirmedOrder();
    const { riders: list } = await listEligibleRiders(id);
    const pick = list.find((r) => r.assignable);
    await assignRiderManually(id, pick.id, null);
    await processDispatchTimeout(id, pick.id);
    const row = await orderRow(id);
    assert.equal(row.dispatchStatus, 'unassigned');
    assert.ok(row.dispatchOffers.some((o) => o.partnerId === pick.id && o.action === 'timeout'));
});

test('an admin can take an assignment back', async () => {
    const id = await confirmedOrder();
    const { riders: list } = await listEligibleRiders(id);
    const pick = list.find((r) => r.assignable);
    await assignRiderManually(id, pick.id, null);
    await withdrawManualAssignment(id, null);
    const row = await orderRow(id);
    assert.equal(row.dispatchStatus, 'unassigned');
    assert.ok(row.dispatchOffers.some((o) => o.partnerId === pick.id && o.action === 'withdrawn'));
});

test('switching the zone back to automatic offers the waiting orders to riders', async () => {
    const id = await confirmedOrder();
    // A rider is offered one order at a time, so earlier waiting orders would
    // take the riders first. Close them; this one is the order under test.
    await prisma.foodOrder.updateMany({
        where: { restaurantId, id: { not: id }, orderStatus: { notIn: ['delivered', 'cancelled_by_admin'] } },
        data: { orderStatus: 'cancelled_by_admin', awaitingManualAt: null },
    });
    await setZoneDispatchMode(zoneId, 'auto');
    await new Promise((r) => setTimeout(r, 1500));
    const row = await orderRow(id);
    assert.equal(row.awaitingManualAt, null);
    assert.ok(row.dispatchOffers.some((o) => o.action === 'offered'), 'offered to nearby riders');
    await setZoneDispatchMode(zoneId, 'manual');
});

test('the global setting is saved (it used to always save auto)', async () => {
    await updateDispatchSettings('manual', null, { manualAcceptWindowSeconds: 90 });
    clearDispatchModeCache();
    const s = await getDispatchSettings();
    assert.equal(s.dispatchMode, 'manual');
    assert.equal(s.manualAcceptWindowSeconds, 90);
    await updateDispatchSettings('auto', null, { manualAcceptWindowSeconds: 120 });
    assert.equal((await getDispatchSettings()).dispatchMode, 'auto');
});
