import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { createOrder } from './order.service.js';
import { tryAutoAssign } from './order-dispatch.service.js';
import { acceptOrderDelivery, rejectOrderDelivery } from './order-delivery.service.js';

/**
 * Automatic dispatch: an order is offered to several riders at once. A rider
 * declining it is recorded (it used to fail with "Not your order") and the
 * order stays with the others.
 */
const HERE = testPatch(16);
const created = { zones: [], restaurants: [], users: [], foods: [], partners: [] };
let tag;
let restaurantId;
let foodId;
let userId;
let amit;
let bala;

const rider = async (name) => {
    const r = await prisma.foodDeliveryPartner.create({
        data: {
            name: `${tag} ${name}`, phone: uniquePhone('8'), status: 'approved', availabilityStatus: 'online',
            lastLat: HERE.lat + 0.002, lastLng: HERE.lng, lastLocationAt: new Date(),
        },
    });
    created.partners.push(r.id);
    return r;
};

test.before(async () => {
    tag = uniqueTag('Dec');
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
    amit = await rider('Amit');
    bala = await rider('Bala');
});

test.after(async () => {
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

test('declining a broadcast offer is recorded and the order stays with the other riders', async () => {
    const { order } = await createOrder(userId, {
        restaurantId,
        items: [{ itemId: foodId, quantity: 1 }],
        address: { label: 'Home', fullName: 'C', street: '1 St', city: 'Indore', state: 'MP', zipCode: '452001', phone: uniquePhone('5'), latitude: HERE.lat + 0.004, longitude: HERE.lng },
        paymentMethod: 'cash',
    });
    const id = order._id || order.id;
    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'confirmed' } });
    await tryAutoAssign(id);

    let offers = await prisma.orderDispatchOffer.findMany({ where: { orderId: id } });
    assert.deepEqual(new Set(offers.map((o) => o.partnerId)), new Set([amit.id, bala.id]), 'offered to both at once');

    // Used to throw "Not your order".
    await rejectOrderDelivery(id, amit.id);
    offers = await prisma.orderDispatchOffer.findMany({ where: { orderId: id } });
    assert.equal(offers.find((o) => o.partnerId === amit.id).action, 'rejected');
    assert.equal(offers.find((o) => o.partnerId === bala.id).action, 'offered');

    const row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.dispatchStatus, 'unassigned', 'still open for the others');

    await acceptOrderDelivery(id, bala.id);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id } })).dispatchDeliveryPartnerId, bala.id);
});

test('a rider with no offer for the order still cannot reject it', async () => {
    const outsider = await rider('Outsider');
    const { order } = await createOrder(userId, {
        restaurantId,
        items: [{ itemId: foodId, quantity: 1 }],
        address: { label: 'Home', fullName: 'C', street: '1 St', city: 'Indore', state: 'MP', zipCode: '452001', phone: uniquePhone('5'), latitude: HERE.lat + 0.004, longitude: HERE.lng },
        paymentMethod: 'cash',
    });
    const id = order._id || order.id;
    await assert.rejects(() => rejectOrderDelivery(id, outsider.id), /Not your order/);
});
