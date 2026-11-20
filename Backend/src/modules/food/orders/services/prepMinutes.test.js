import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { setPrepMinutesRestaurant } from './order.service.js';

/** The restaurant's - / + on an accepted order moves its prep time. */
const created = { orders: [], users: [], restaurants: [] };
let restaurant;
let other;
let user;

test.before(async () => {
    restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${uniqueTag('Prep')} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    other = await prisma.foodRestaurant.create({
        data: { restaurantName: `${uniqueTag('Other')} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.restaurants.push(restaurant.id, other.id);
    created.users.push(user.id);
});

test.after(async () => {
    await prisma.foodOrderStatusHistory?.deleteMany?.({ where: { orderId: { in: created.orders } } }).catch(() => {});
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

const order = async (orderStatus) => {
    const o = await prisma.foodOrder.create({
        data: {
            userId: user.id, restaurantId: restaurant.id, orderId: uniqueTag('P'), orderStatus,
            paymentMethod: 'cash', addrStreet: '1 St', addrCity: 'Indore', addrState: 'MP',
            subtotal: 100, total: 100, packingMinutes: 20,
        },
    });
    created.orders.push(o.id);
    return o;
};

test('+5 on an accepted order moves its prep time', async () => {
    const o = await order('confirmed');
    const view = await setPrepMinutesRestaurant(o.id, restaurant.id, 25);
    assert.equal(view.pricing.packingMinutes, 25);
    const row = await prisma.foodOrder.findUnique({ where: { id: o.id } });
    assert.equal(row.packingMinutes, 25);
});

test('refused once the food is ready, out of range, or for another restaurant', async () => {
    const ready = await order('ready_for_pickup');
    await assert.rejects(setPrepMinutesRestaurant(ready.id, restaurant.id, 30), /before the food is ready/);
    const o = await order('preparing');
    await assert.rejects(setPrepMinutesRestaurant(o.id, restaurant.id, 0), /between 1 and 240/);
    await assert.rejects(setPrepMinutesRestaurant(o.id, other.id, 30), /not found/i);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id: o.id } })).packingMinutes, 20);
});
