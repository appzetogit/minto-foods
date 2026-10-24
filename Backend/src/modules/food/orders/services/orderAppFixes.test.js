import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import {
    cancelOrder,
    createOrder,
    getOrderById,
    listOrdersRestaurant,
    restaurantStatusRefusal,
    updateOrderStatusRestaurant,
} from './order.service.js';
import { toRestaurantContact } from './order.helpers.js';

/**
 * What the customer, restaurant and rider apps now rely on: the one-minute
 * cancel window, "Mark ready" from accepted or preparing, and no customer
 * phone in anything the restaurant receives.
 */
const HERE = testPatch(18);
const created = { zones: [], restaurants: [], users: [], foods: [], partners: [] };
let restaurantId;
let foodId;
let user;
let rider;

const address = () => ({
    label: 'Home',
    name: 'Asha',
    phone: '9811122233',
    street: '1 Test Road',
    city: 'Indore',
    state: 'MP',
    zipCode: '452001',
    location: { type: 'Point', coordinates: [HERE.lng + 0.005, HERE.lat] },
});

const placeOrder = async () => {
    const { order } = await createOrder(user.id, {
        restaurantId,
        items: [{ itemId: foodId, name: 'Thali', price: 200, quantity: 1 }],
        address: address(),
        pricing: { subtotal: 200, total: 200 },
        paymentMethod: 'cash',
    });
    return order._id || order.id;
};

test.before(async () => {
    const tag = uniqueTag('Fix');
    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    created.zones.push(zone.id);
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            zoneId: zone.id,
            latitude: HERE.lat,
            longitude: HERE.lng,
            isAcceptingOrders: true,
            outsideHoursOverride: true,
        },
    });
    created.restaurants.push(restaurant.id);
    restaurantId = restaurant.id;
    const food = await prisma.foodItem.create({
        data: { restaurantId, name: `${tag} Thali`, price: 200, approvalStatus: 'approved', isAvailable: true },
    });
    created.foods.push(food.id);
    foodId = food.id;
    user = await prisma.foodUser.create({ data: { name: `${tag} Customer`, phone: uniquePhone('7') } });
    created.users.push(user.id);
    rider = await prisma.foodDeliveryPartner.create({ data: { name: `${tag} Rider`, phone: uniquePhone('6'), status: 'approved' } });
    created.partners.push(rider.id);
});

test.after(async () => {
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: [...created.users, ...created.partners] } } });
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrderNotification.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

const placedAgo = (id, seconds) =>
    prisma.foodOrder.update({ where: { id }, data: { createdAt: new Date(Date.now() - seconds * 1000) } });

// ---- the customer's cancel window ----------------------------------------------

test('a cancel after 65 seconds is refused', async () => {
    const id = await placeOrder();
    await placedAgo(id, 65);
    await assert.rejects(() => cancelOrder(id, user.id, 'changed my mind'), /within 1 minute of placing them/);
    const row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.orderStatus, 'created', 'still on');
});

test('a cancel at 30 seconds works, with a rider already on it', async () => {
    const id = await placeOrder();
    await placedAgo(id, 30);
    await prisma.foodOrder.update({ where: { id }, data: { dispatchDeliveryPartnerId: rider.id } });

    const order = await cancelOrder(id, user.id, 'ordered twice');
    assert.equal(order.orderStatus, 'cancelled_by_user');
});

test('an accepted order cannot be cancelled by the customer, even in the first minute', async () => {
    const id = await placeOrder();
    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'confirmed' } });
    await assert.rejects(() => cancelOrder(id, user.id, ''), /within 1 minute/);
});

// ---- Mark ready for pickup -------------------------------------------------------

test('ready for pickup works from accepted and from preparing', async () => {
    for (const from of ['confirmed', 'preparing']) {
        const id = await placeOrder();
        await prisma.foodOrder.update({ where: { id }, data: { orderStatus: from, acceptanceDeadlineAt: null } });
        const order = await updateOrderStatusRestaurant(id, restaurantId, 'ready_for_pickup');
        assert.equal(order.orderStatus, 'ready_for_pickup', `from ${from}`);
    }
});

test('marking ready twice is not an error, and a picked-up order says why it cannot', async () => {
    const id = await placeOrder();
    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'ready_for_pickup', acceptanceDeadlineAt: null } });
    const again = await updateOrderStatusRestaurant(id, restaurantId, 'ready_for_pickup');
    assert.equal(again.orderStatus, 'ready_for_pickup');

    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'picked_up' } });
    await assert.rejects(
        () => updateOrderStatusRestaurant(id, restaurantId, 'ready_for_pickup'),
        /already picked up by the rider, so it can't be marked ready for pickup/,
    );
    assert.equal(
        restaurantStatusRefusal('cancelled_by_user', 'ready_for_pickup'),
        "This order was cancelled by the customer, so it can't be marked ready for pickup.",
    );
});

// ---- no customer phone for the restaurant ------------------------------------------

test('restaurant order payloads carry no customer phone', async () => {
    const id = await placeOrder();
    const phones = [user.phone, '9811122233'];
    const noPhone = (payload, where) => {
        const body = JSON.stringify(payload);
        for (const phone of phones) assert.ok(!body.includes(phone), `${where} leaks ${phone}`);
    };

    const detail = await getOrderById(id, { restaurantId });
    noPhone(detail, 'detail');
    assert.equal(detail.customerPhone, '');
    assert.ok(detail.customerName, 'the name stays');

    const list = await listOrdersRestaurant(restaurantId, { limit: 50 });
    noPhone(list, 'list');

    await prisma.foodOrder.update({ where: { id }, data: { acceptanceDeadlineAt: null } });
    noPhone(await updateOrderStatusRestaurant(id, restaurantId, 'confirmed'), 'status update');

    // The rider still gets the number: the customer view is unchanged.
    const mine = await getOrderById(id, { userId: user.id });
    assert.ok(JSON.stringify(mine).includes('9811122233'));
});

test('toRestaurantContact strips every phone, not only on gift orders', () => {
    const out = toRestaurantContact({
        customerName: 'Asha',
        customerPhone: '9811122233',
        addrPhone: '9811122233',
        deliveryAddress: { street: 'x', phone: '9811122233' },
        userId: { name: 'Asha', phone: '9811122233', email: 'a@b.c' },
        recipient: { name: '', phone: '' },
    });
    assert.equal(out.customerName, 'Asha');
    assert.ok(!JSON.stringify(out).includes('9811122233'));
    assert.ok(!JSON.stringify(out).includes('a@b.c'));
    assert.deepEqual(out.recipient, { name: '', phone: '' });
});

// ---- two phones answering the same new order ---------------------------------------

test('two phones accept together: one wins, the other gets 409', async () => {
    const id = await placeOrder();
    await prisma.foodOrder.update({ where: { id }, data: { acceptanceDeadlineAt: null } });

    const [a, b] = await Promise.allSettled([
        updateOrderStatusRestaurant(id, restaurantId, 'confirmed'),
        updateOrderStatusRestaurant(id, restaurantId, 'confirmed'),
    ]);
    const won = [a, b].filter((r) => r.status === 'fulfilled');
    const lost = [a, b].filter((r) => r.status === 'rejected');
    assert.equal(won.length, 1, 'exactly one phone accepts');
    assert.equal(lost.length, 1);
    assert.equal(lost[0].reason.statusCode, 409);
    assert.equal(lost[0].reason.message, 'This order was already accepted on another device');

    // A third phone, later, gets the same answer.
    await assert.rejects(
        () => updateOrderStatusRestaurant(id, restaurantId, 'confirmed'),
        (err) => err.statusCode === 409 && /already accepted on another device/.test(err.message),
    );
});

test('a reject after another phone rejected gets 409, and an accept after it too', async () => {
    const id = await placeOrder();
    await prisma.foodOrder.update({ where: { id }, data: { acceptanceDeadlineAt: null } });

    await updateOrderStatusRestaurant(id, restaurantId, 'cancelled_by_restaurant', 'Out of stock');
    await assert.rejects(
        () => updateOrderStatusRestaurant(id, restaurantId, 'cancelled_by_restaurant'),
        (err) => err.statusCode === 409 && err.message === 'This order was already rejected on another device',
    );
    await assert.rejects(
        () => updateOrderStatusRestaurant(id, restaurantId, 'confirmed'),
        (err) => err.statusCode === 409 && /already rejected on another device/.test(err.message),
    );
});

// ---- admin cancels: the restaurant's alert carries the reason ------------------------

test('admin cancel needs a reason, and the restaurant alert carries it as strings', async () => {
    const { adminCancelFields } = await import('./order.service.js');
    const { rejectOrderAdminController } = await import('../controllers/order.controller.js');

    assert.deepEqual(adminCancelFields({ id: 'abc', order_id: 'MFB24102610001' }, ' Restaurant closed early '), {
        orderStatus: 'cancelled_by_admin',
        orderId: 'abc',
        orderDisplayId: 'MFB24102610001',
        cancellationReason: 'Restaurant closed early',
    });

    const call = (orderId, body) => new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(payload) { resolve({ status: this.statusCode, payload }); return this; },
        };
        rejectOrderAdminController({ params: { orderId }, body, user: { userId: null } }, res, reject);
    });

    const id = await placeOrder();
    const blank = await call(id, { reason: '   ' });
    assert.equal(blank.status, 400);
    assert.match(blank.payload.message, /Enter a reason/);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id } })).orderStatus, 'created', 'nothing cancelled');

    const done = await call(id, { reason: 'Customer called support to cancel' });
    assert.equal(done.status, 200);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id } })).orderStatus, 'cancelled_by_admin');
    const history = await prisma.orderStatusHistory.findFirst({ where: { orderId: id, to: 'cancelled_by_admin' } });
    assert.equal(history.note, 'Customer called support to cancel');
});
