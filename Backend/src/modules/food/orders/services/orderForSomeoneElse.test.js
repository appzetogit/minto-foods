import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { toOrder } from '../order.mapper.js';
import { validateCreateOrderDto } from '../validators/order.validator.js';
import { calculateOrder, createOrder, getOrderById } from './order.service.js';
import { buildDeliverySocketPayload, sanitizeOrderForDeliveryPartner } from './order.helpers.js';

/**
 * "Order for someone else": the account holder orders and pays; the food goes
 * to the receiver's address and the rider calls the receiver.
 */
const HERE = testPatch(13);
// About 2 km north of HERE: a second saved address with a different distance.
const FAR = { lat: HERE.lat + 0.018, lng: HERE.lng };

const created = { zones: [], restaurants: [], users: [], foods: [] };
let restaurantId;
let foodId;
let user;
let tag;

const receiverAddress = (over = {}) => ({
    label: 'Other',
    name: 'Ravi Sharma',
    phone: '9876543210',
    street: '12 Gift Lane',
    city: 'Indore',
    state: 'MP',
    zipCode: '452001',
    location: { type: 'Point', coordinates: [FAR.lng, FAR.lat] },
    ...over,
});

const giftDto = (over = {}) => ({
    restaurantId,
    items: [{ itemId: foodId, name: 'Thali', price: 200, quantity: 1 }],
    address: receiverAddress(),
    pricing: { subtotal: 200, total: 200 },
    paymentMethod: 'cash',
    orderForSomeoneElse: true,
    recipient: { name: '  Ravi Sharma ', phone: '9876543210' },
    // What the app also sends for older servers; must be ignored.
    customerName: 'Ravi Sharma',
    customerPhone: '9876543210',
    ...over,
});

test.before(async () => {
    tag = uniqueTag('Gift');
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
    user = await prisma.foodUser.create({ data: { name: `${tag} Owner`, phone: uniquePhone('7') } });
    created.users.push(user.id);
});

test.after(async () => {
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.userAddress.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

// ---- validation -------------------------------------------------------------

const httpBody = (over = {}) => ({ ...giftDto(), ...over });

test('the flag without a receiver, or with a bad one, is refused', () => {
    assert.throws(() => validateCreateOrderDto(httpBody({ recipient: undefined })), /receiver's name and phone/);
    assert.throws(() => validateCreateOrderDto(httpBody({ recipient: { name: '', phone: '9876543210' } })), /receiver's name/);
    assert.throws(() => validateCreateOrderDto(httpBody({ recipient: { name: 'R', phone: '5876543210' } })), /10-digit/);
    assert.throws(() => validateCreateOrderDto(httpBody({ recipient: { name: 'R', phone: '98765' } })), /10-digit/);
    assert.throws(() => validateCreateOrderDto(httpBody({ recipient: { name: 'x'.repeat(61), phone: '9876543210' } })), /60/);
    assert.throws(
        () => validateCreateOrderDto(httpBody({ address: receiverAddress({ location: undefined }) })),
        /location on the map/,
    );
});

test('the fields survive validation, trimmed', () => {
    const dto = validateCreateOrderDto(httpBody());
    assert.equal(dto.orderForSomeoneElse, true);
    assert.deepEqual(dto.recipient, { name: 'Ravi Sharma', phone: '9876543210' });
});

test('without the flag a stray recipient is dropped', () => {
    const dto = validateCreateOrderDto(httpBody({ orderForSomeoneElse: undefined }));
    assert.equal(dto.orderForSomeoneElse, false);
    assert.equal(dto.recipient, undefined);
});

// ---- the order ----------------------------------------------------------------

let giftOrderId;

test('the order keeps the account holder as customer and the receiver as recipient and contact', async () => {
    const { order } = await createOrder(user.id, giftDto());
    giftOrderId = order._id || order.id;

    const row = await prisma.foodOrder.findUnique({ where: { id: giftOrderId } });
    assert.equal(row.isForSomeoneElse, true);
    assert.equal(row.customerName, user.name, 'from the account, not the body');
    assert.equal(row.customerPhone, user.phone);
    assert.equal(row.recipientName, 'Ravi Sharma');
    assert.equal(row.recipientPhone, '9876543210');
    assert.equal(row.addrName, 'Ravi Sharma');
    assert.equal(row.addrPhone, '9876543210');
    assert.ok(Math.abs(Number(row.addrLat) - FAR.lat) < 1e-6, "delivered to the receiver's pin");
    // Priced on the receiver's distance (~2 km), not 0 from the restaurant.
    assert.ok(Number(row.distanceKm) > 1.5, `distance ${row.distanceKm}`);
});

test("the rider gets the receiver's name, phone and coordinates", async () => {
    const row = await prisma.foodOrder.findUnique({ where: { id: giftOrderId }, include: { items: true } });
    const rider = sanitizeOrderForDeliveryPartner(toOrder(row));
    assert.equal(rider.customerName, 'Ravi Sharma');
    assert.equal(rider.customerPhone, '9876543210');
    assert.equal(rider.customerCallUri, 'tel:9876543210');
    assert.deepEqual(rider.orderedBy, { name: user.name });
    assert.deepEqual(rider.deliveryAddress.location.coordinates.map(Number), [FAR.lng, FAR.lat]);
    assert.ok(!JSON.stringify(rider).includes(user.phone), "the account holder's number never reaches the rider");

    const socket = buildDeliverySocketPayload(toOrder(row), null);
    assert.equal(socket.customerName, 'Ravi Sharma');
    assert.equal(socket.customerPhone, '9876543210');
    assert.equal(socket.customerLocation.lat, FAR.lat);
    assert.deepEqual(socket.orderedBy, { name: user.name });
});

test('the user and admin see both people; the restaurant sees the receiver name only', async () => {
    const mine = await getOrderById(giftOrderId, { userId: user.id });
    assert.equal(mine.isForSomeoneElse, true);
    assert.deepEqual(mine.recipient, { name: 'Ravi Sharma', phone: '9876543210' });
    assert.equal(mine.customerName, user.name);

    const admin = await getOrderById(giftOrderId, { admin: true });
    assert.deepEqual(admin.recipient, { name: 'Ravi Sharma', phone: '9876543210' });
    assert.equal(admin.customerPhone, user.phone);

    const kitchen = await getOrderById(giftOrderId, { restaurantId });
    assert.equal(kitchen.isForSomeoneElse, true);
    assert.equal(kitchen.customerName, 'Ravi Sharma');
    assert.equal(kitchen.customerPhone, '');
    assert.ok(!JSON.stringify(kitchen).includes('9876543210'), 'no receiver phone');
    assert.ok(!JSON.stringify(kitchen).includes(user.phone), 'no account phone');
});

test('a bad receiver is refused by createOrder itself too', async () => {
    await assert.rejects(() => createOrder(user.id, giftDto({ recipient: { name: 'R', phone: '123' } })), /10-digit/);
});

test('an order without the flag behaves exactly as before', async () => {
    const { order } = await createOrder(user.id, {
        ...giftDto({ orderForSomeoneElse: undefined, recipient: undefined }),
        customerName: 'Self Name',
        customerPhone: '9123456780',
        address: receiverAddress({ name: 'Self Name', phone: '9123456780' }),
    });
    const row = await prisma.foodOrder.findUnique({ where: { id: order._id || order.id } });
    assert.equal(row.isForSomeoneElse, false);
    assert.equal(row.customerName, 'Self Name');
    assert.equal(row.customerPhone, '9123456780');
    assert.equal(row.recipientName, '');
    const rider = sanitizeOrderForDeliveryPartner(toOrder(row));
    assert.equal(rider.customerPhone, '9123456780');
});

// ---- /calculate ---------------------------------------------------------------

test('calculate prices the chosen (non-default) saved address, not the default', async () => {
    const home = await prisma.userAddress.create({
        data: { userId: user.id, label: 'Home', street: 'Home St', city: 'Indore', state: 'MP', latitude: HERE.lat, longitude: HERE.lng, isDefault: true },
    });
    const friend = await prisma.userAddress.create({
        data: { userId: user.id, label: 'Other', street: 'Friend St', city: 'Indore', state: 'MP', latitude: FAR.lat, longitude: FAR.lng, isDefault: false },
    });
    const items = [{ itemId: foodId, name: 'Thali', price: 200, quantity: 1 }];

    const atHome = await calculateOrder(user.id, { restaurantId, items, deliveryAddressId: home.id });
    const atFriend = await calculateOrder(user.id, { restaurantId, items, deliveryAddressId: friend.id });
    assert.ok(Number(atHome.pricing.distanceKm) < 0.5, `home ${atHome.pricing.distanceKm}`);
    assert.ok(Number(atFriend.pricing.distanceKm) > 1.5, `friend ${atFriend.pricing.distanceKm}`);

    await assert.rejects(
        () => calculateOrder(user.id, { restaurantId, items, deliveryAddressId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }),
        /not found/,
    );
});
