import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { createOrder } from './order.service.js';
import { processDispatchTimeout, tryAutoAssign } from './order-dispatch.service.js';
import {
    acceptOrderDelivery,
    getCurrentTripDelivery,
    listOrdersAvailableDelivery,
    rejectOrderDelivery,
} from './order-delivery.service.js';
import { updateDeliveryAvailability } from '../../delivery/services/delivery.service.js';

/**
 * Automatic dispatch offers an order to ONE rider at a time, nearest first.
 * Accept ends it; reject or the window running out moves it to the next
 * rider. A rider is asked once per round; a later round may ask them again.
 */
const HERE = testPatch(16);
const created = { zones: [], restaurants: [], users: [], foods: [], partners: [] };
let tag;
let restaurantId;
let foodId;
let userId;

/** An online rider `km` (roughly) north of the restaurant. */
const rider = async (name, km) => {
    const r = await prisma.foodDeliveryPartner.create({
        data: {
            name: `${tag} ${name}`, phone: uniquePhone('8'), status: 'approved', availabilityStatus: 'online',
            lastLat: HERE.lat + km / 111, lastLng: HERE.lng, lastLocationAt: new Date(),
        },
    });
    created.partners.push(r.id);
    return r;
};

/** Takes a test's riders out of later tests. */
const offline = (...riders) =>
    prisma.foodDeliveryPartner.updateMany({ where: { id: { in: riders.map((r) => r.id) } }, data: { availabilityStatus: 'offline' } });

const confirmedOrder = async () => {
    const { order } = await createOrder(userId, {
        restaurantId,
        items: [{ itemId: foodId, quantity: 1 }],
        address: { label: 'Home', fullName: 'C', street: '1 St', city: 'Indore', state: 'MP', zipCode: '452001', phone: uniquePhone('5'), latitude: HERE.lat + 0.004, longitude: HERE.lng },
        paymentMethod: 'cash',
    });
    const id = order._id || order.id;
    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'confirmed' } });
    return id;
};

/** The reject hands the order on in the background; wait for it. */
const until = async (check, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
        const value = await check();
        if (value || Date.now() > end) return value;
        await new Promise((r) => setTimeout(r, 100));
    }
};

const orderRow = (id) =>
    prisma.foodOrder.findUnique({ where: { id }, include: { dispatchOffers: { orderBy: { at: 'asc' } } } });

const listIds = async (partnerId) => {
    const list = await listOrdersAvailableDelivery(partnerId, {});
    return (list.docs || list.data || list.items || []).map((o) => String(o._id || o.id));
};

test.before(async () => {
    tag = uniqueTag('Seq');
    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    created.zones.push(zone.id);
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved',
            zoneId: zone.id, latitude: HERE.lat, longitude: HERE.lng, isAcceptingOrders: true, outsideHoursOverride: true,
        },
    });
    created.restaurants.push(r.id);
    restaurantId = r.id;
    const f = await prisma.foodItem.create({ data: { restaurantId, name: `${tag} Dal`, price: 120, approvalStatus: 'approved', isAvailable: true } });
    created.foods.push(f.id);
    foodId = f.id;
    const u = await prisma.foodUser.create({ data: { name: `${tag} U`, phone: uniquePhone('5') } });
    created.users.push(u.id);
    userId = u.id;
});

test.after(async () => {
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.orderDispatchOffer.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodDeliveryPartnerSession.deleteMany({ where: { deliveryPartnerId: { in: created.partners } } });
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: created.partners } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('the order goes to the nearest rider only, and a reject moves it to the next', async () => {
    const near = await rider('Near', 0.3);
    const far = await rider('Far', 0.9);
    const id = await confirmedOrder();

    await tryAutoAssign(id);
    let row = await orderRow(id);
    assert.equal(row.dispatchOffers.length, 1, 'one rider at a time');
    const first = row.dispatchOffers[0];
    assert.equal(first.partnerId, near.id, 'the nearest first');
    assert.equal(first.action, 'offered');
    assert.equal(first.round, 1);
    const windowMs = new Date(first.expiresAt).getTime() - new Date(first.at).getTime();
    assert.ok(windowMs >= 15000 && windowMs <= 300000, `offer carries its expiry (${windowMs} ms)`);
    assert.equal(row.dispatchStatus, 'assigned');
    assert.equal(row.dispatchDeliveryPartnerId, near.id);

    // Only the rider it is offered to sees it, and only they can take it.
    assert.ok((await listIds(near.id)).includes(id));
    assert.ok(!(await listIds(far.id)).includes(id), 'not shown to the next rider yet');
    await assert.rejects(() => acceptOrderDelivery(id, far.id), /no longer available/);

    await rejectOrderDelivery(id, near.id);
    row = await until(async () => { const r = await orderRow(id); return r.dispatchDeliveryPartnerId ? r : null; });
    assert.equal(row.dispatchOffers.find((o) => o.id === first.id).action, 'rejected');
    assert.equal(row.dispatchDeliveryPartnerId, far.id, 'went to the next rider');
    assert.equal(row.dispatchOffers.filter((o) => o.action === 'offered').length, 1);
    assert.ok(!(await listIds(near.id)).includes(id), 'gone from the rider who declined');

    await acceptOrderDelivery(id, far.id);
    row = await orderRow(id);
    assert.equal(row.dispatchStatus, 'accepted');
    assert.equal(row.dispatchDeliveryPartnerId, far.id);
    await offline(near, far);
});

test('no answer in time: the offer times out and the next rider is asked', async () => {
    const a = await rider('A', 0.3);
    const b = await rider('B', 0.9);
    const id = await confirmedOrder();

    await tryAutoAssign(id);
    let row = await orderRow(id);
    const offerA = row.dispatchOffers[0];
    assert.equal(offerA.partnerId, a.id);

    await processDispatchTimeout(id, a.id, { offerId: offerA.id });
    row = await orderRow(id);
    assert.equal(row.dispatchOffers.find((o) => o.id === offerA.id).action, 'timeout');
    assert.equal(row.dispatchDeliveryPartnerId, b.id);
    const offerB = row.dispatchOffers.find((o) => o.partnerId === b.id);

    // The same job running twice changes nothing.
    await processDispatchTimeout(id, a.id, { offerId: offerA.id });
    row = await orderRow(id);
    assert.equal(row.dispatchDeliveryPartnerId, b.id);
    assert.equal(row.dispatchOffers.find((o) => o.id === offerB.id).action, 'offered');

    // A late reject from the rider who timed out is not an error.
    await rejectOrderDelivery(id, a.id);
    assert.equal((await orderRow(id)).dispatchDeliveryPartnerId, b.id);
    await offline(a, b);
});

test('a rider who declined is not asked again this round; a later round asks again, and accept works', async () => {
    const solo = await rider('Solo', 0.3);
    const id = await confirmedOrder();

    await tryAutoAssign(id);
    const firstOffer = (await orderRow(id)).dispatchOffers[0];
    await rejectOrderDelivery(id, solo.id);
    // Give the background re-dispatch its turn.
    await new Promise((r) => setTimeout(r, 1000));
    await until(async () => !(await prisma.foodOrder.findUnique({ where: { id } })).dispatchingAt);

    let row = await orderRow(id);
    assert.equal(row.dispatchStatus, 'unassigned', 'nobody else to ask this round');
    assert.equal(row.dispatchOffers.length, 1, 'not asked twice in one round');

    // The next round, after a pause (the queued look carries newRound).
    await processDispatchTimeout(id, null, { newRound: true });
    row = await orderRow(id);
    assert.equal(row.dispatchDeliveryPartnerId, solo.id);
    const again = row.dispatchOffers.find((o) => o.action === 'offered');
    assert.ok(again && again.id !== firstOffer.id, 'a fresh offer id');
    assert.equal(again.round, 2);
    assert.ok(new Date(again.expiresAt) > new Date(firstOffer.expiresAt), 'a fresh expiry');

    const order = await acceptOrderDelivery(id, solo.id);
    assert.ok(order);
    assert.equal((await orderRow(id)).dispatchStatus, 'accepted');
    await offline(solo);
});

test('a rider who was never offered the order cannot take it while it is unassigned', async () => {
    const id = await confirmedOrder();
    const outsider = await rider('Outsider', 30); // out of range: never asked
    await assert.rejects(() => acceptOrderDelivery(id, outsider.id), /no longer available/);
    await assert.rejects(() => rejectOrderDelivery(id, outsider.id), /Not your order/);
    await offline(outsider);
});

test('the ongoing trip stays at every open status, online or offline, and blocks going offline', async () => {
    const r = await rider('Trip', 0.3);
    const id = await confirmedOrder();
    await prisma.foodOrder.update({
        where: { id },
        data: { dispatchStatus: 'accepted', dispatchDeliveryPartnerId: r.id, dispatchAcceptedAt: new Date() },
    });

    for (const status of ['confirmed', 'ready_for_pickup', 'reached_pickup', 'picked_up', 'reached_drop']) {
        await prisma.foodOrder.update({ where: { id }, data: { orderStatus: status } });
        const trip = await getCurrentTripDelivery(r.id);
        assert.equal(String(trip?._id || trip?.id), id, `still shown at ${status}`);
    }

    await assert.rejects(
        () => updateDeliveryAvailability(r.id, { status: 'offline' }),
        /Finish your current delivery before going offline/,
    );
    // The heartbeat still goes through.
    assert.equal((await updateDeliveryAvailability(r.id, { status: 'online', lat: HERE.lat, lng: HERE.lng })).availabilityStatus, 'online');

    // Already offline (say, set by the server): the trip is still returned.
    await prisma.foodDeliveryPartner.update({ where: { id: r.id }, data: { availabilityStatus: 'offline' } });
    assert.equal(String((await getCurrentTripDelivery(r.id))?._id || ''), id);

    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'delivered' } });
    assert.equal(await getCurrentTripDelivery(r.id), null);
    await prisma.foodDeliveryPartner.update({ where: { id: r.id }, data: { availabilityStatus: 'online' } });
    assert.equal((await updateDeliveryAvailability(r.id, { status: 'offline' })).availabilityStatus, 'offline');
});
