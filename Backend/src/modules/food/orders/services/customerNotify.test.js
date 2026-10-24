import test from 'node:test';
import { tryAutoAssign } from './order-dispatch.service.js';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { createOrder, updateOrderStatusRestaurant, markOrderDeliveredAdmin } from './order.service.js';
import { acceptOrderDelivery } from './order-delivery.service.js';
import { checkRiderNearDrop, notifyCustomer, CUSTOMER_EVENTS } from './customerNotify.service.js';

/**
 * Customer order notifications: exactly eight, each once per order, sent from
 * whichever path reaches the moment. Sent pushes are read back from
 * food_order_notifications (the once-only log).
 */
const HERE = testPatch(17);
const created = { zones: [], restaurants: [], users: [], foods: [], partners: [] };
let tag;
let restaurantId;
let foodId;
let userId;
let rider;

const sent = async (orderId) =>
    (await prisma.foodOrderNotification.findMany({ where: { orderId }, orderBy: { sentAt: 'asc' } })).map((n) => n.event);

const newOrder = async () => {
    const { order } = await createOrder(userId, {
        restaurantId,
        items: [{ itemId: foodId, quantity: 1 }],
        address: {
            label: 'Home', fullName: 'C', street: '1 St', city: 'Indore', state: 'MP', zipCode: '452001',
            phone: uniquePhone('5'), latitude: HERE.lat + 0.01, longitude: HERE.lng,
        },
        paymentMethod: 'cash',
    });
    return order._id || order.id;
};

test.before(async () => {
    tag = uniqueTag('Ntf');
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
    const f = await prisma.foodItem.create({ data: { restaurantId, name: `${tag} Roti`, price: 90, approvalStatus: 'approved', isAvailable: true } });
    created.foods.push(f.id);
    foodId = f.id;
    const u = await prisma.foodUser.create({ data: { name: `${tag} U`, phone: uniquePhone('5') } });
    created.users.push(u.id);
    userId = u.id;
    rider = await prisma.foodDeliveryPartner.create({
        data: {
            name: `${tag} Ravi`, phone: uniquePhone('8'), status: 'approved', availabilityStatus: 'online',
            lastLat: HERE.lat, lastLng: HERE.lng, lastLocationAt: new Date(),
        },
    });
    created.partners.push(rider.id);
});

test.after(async () => {
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.foodOrderNotification.deleteMany({ where: { orderId: { in: ids } } });
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

const settle = () => new Promise((r) => setTimeout(r, 400));

test('the wording is exactly as specified', () => {
    const ctx = { restaurantName: 'Md.ALi', riderName: 'Ravi' };
    assert.equal(CUSTOMER_EVENTS.placed.body(ctx), 'Your order with Md.ALi has been successfully placed');
    assert.equal(CUSTOMER_EVENTS.accepted.body(ctx), 'Order accepted by Md.ALi, it is being prepared');
    assert.equal(CUSTOMER_EVENTS.rider_assigned.body(ctx), 'Rider Ravi is assigned for your order');
    assert.equal(CUSTOMER_EVENTS.rider_at_restaurant.body(ctx), 'Rider has reached the restaurant, waiting for your order to be ready');
    assert.equal(CUSTOMER_EVENTS.ready.body(ctx), 'Your order is marked ready by the restaurant');
    assert.equal(CUSTOMER_EVENTS.picked_up.body(ctx), 'Your order is picked up and on the way');
    assert.equal(CUSTOMER_EVENTS.rider_at_location.body(ctx), 'Rider has reached your location');
    assert.equal(CUSTOMER_EVENTS.delivered.body(ctx), 'Yay! Your order has been delivered');
});

test('placed -> accepted -> rider assigned -> ready, from the real paths, once each', async () => {
    const id = await newOrder();
    await settle();
    assert.deepEqual(await sent(id), ['placed']);

    await updateOrderStatusRestaurant(id, restaurantId, 'confirmed');
    await settle();
    // A second confirm (double tap) sends nothing new.
    await notifyCustomer(id, 'accepted');
    assert.deepEqual(await sent(id), ['placed', 'accepted']);

    // Dispatch offers the order to one rider at a time (on the server it starts
    // from the socket-enabled accept path; there is no socket here).
    await tryAutoAssign(id);
    await acceptOrderDelivery(id, rider.id);
    await settle();
    assert.deepEqual(await sent(id), ['placed', 'accepted', 'rider_assigned']);

    await updateOrderStatusRestaurant(id, restaurantId, 'preparing');
    await updateOrderStatusRestaurant(id, restaurantId, 'ready_for_pickup');
    await settle();
    assert.deepEqual(await sent(id), ['placed', 'accepted', 'rider_assigned', 'ready'], '"preparing" sends nothing');
});

test('near the drop pin after pickup: "rider has reached your location", once', async () => {
    const id = await newOrder();
    await prisma.foodOrder.update({
        where: { id },
        data: { orderStatus: 'picked_up', dispatchStatus: 'accepted', dispatchDeliveryPartnerId: rider.id },
    });
    const row = await prisma.foodOrder.findUnique({ where: { id }, select: { addrLat: true, addrLng: true } });

    // 1 km away: nothing.
    assert.equal(await checkRiderNearDrop({ orderId: id, riderId: rider.id, lat: row.addrLat + 0.009, lng: row.addrLng }), false);
    // ~50 m away: sent, then never again.
    assert.equal(await checkRiderNearDrop({ orderId: id, riderId: rider.id, lat: row.addrLat + 0.0004, lng: row.addrLng }), true);
    assert.equal(await checkRiderNearDrop({ orderId: id, riderId: rider.id, lat: row.addrLat, lng: row.addrLng }), false);
    assert.equal((await sent(id)).filter((e) => e === 'rider_at_location').length, 1);
});

test('a late event is skipped, and "delivered" is sent once however it is marked', async () => {
    const id = await newOrder();
    await prisma.foodOrder.update({
        where: { id },
        data: { orderStatus: 'picked_up', dispatchStatus: 'accepted', dispatchDeliveryPartnerId: rider.id },
    });
    assert.equal(await notifyCustomer(id, 'rider_at_restaurant'), false, 'after pickup it no longer matters');

    await markOrderDeliveredAdmin(id, null);
    await settle();
    await notifyCustomer(id, 'delivered');
    assert.equal((await sent(id)).filter((e) => e === 'delivered').length, 1);
});

test('a new rider after a cancellation is announced again, with the new name', async () => {
    const id = await newOrder();
    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'confirmed' } });
    const other = await prisma.foodDeliveryPartner.create({
        data: { name: `${tag} Amit`, phone: uniquePhone('8'), status: 'approved', availabilityStatus: 'online' },
    });
    created.partners.push(other.id);
    assert.equal(await notifyCustomer(id, 'rider_assigned', { riderId: rider.id }), true);
    assert.equal(await notifyCustomer(id, 'rider_assigned', { riderId: rider.id }), false);
    assert.equal(await notifyCustomer(id, 'rider_assigned', { riderId: other.id }), true);
});

test('a cancelled order gets none of these', async () => {
    const id = await newOrder();
    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'cancelled_by_restaurant' } });
    assert.equal(await notifyCustomer(id, 'accepted'), false);
});
