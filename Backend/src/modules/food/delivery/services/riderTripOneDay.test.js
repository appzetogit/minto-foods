import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone } from '../../../../utils/testIds.js';
import { getDeliveryPartnerTripHistory, getDeliveryPartnerEarnings } from './delivery.service.js';

/**
 * A trip used to be listed on every day any of its stamps fell on, so an
 * order delivered on the 11th and touched again on the 12th appeared on both,
 * and trip history no longer added up to earnings or the wallet.
 */
const ids = { orders: [], rider: null, user: null, restaurant: null };

test.after(async () => {
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids.orders } } });
    if (ids.user) await prisma.foodUser.delete({ where: { id: ids.user } });
    if (ids.restaurant) await prisma.foodRestaurant.delete({ where: { id: ids.restaurant } });
    if (ids.rider) await prisma.foodDeliveryPartner.delete({ where: { id: ids.rider } });
    await prisma.$disconnect();
});

test('a trip is listed on one day only, and that day matches earnings', async () => {
    ids.rider = (await prisma.foodDeliveryPartner.create({ data: { name: 'One Day', phone: uniquePhone('8'), status: 'approved' } })).id;
    ids.restaurant = (await prisma.foodRestaurant.create({
        data: { restaurantName: 'OD Kitchen', ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    })).id;
    ids.user = (await prisma.foodUser.create({ data: { phone: uniquePhone('5') } })).id;
    const base = {
        userId: ids.user, restaurantId: ids.restaurant, dispatchDeliveryPartnerId: ids.rider, paymentMethod: 'cash',
        addrStreet: '1', addrCity: 'Indore', addrState: 'MP', subtotal: 100, total: 100, riderEarning: 35,
    };
    const day = (d, h) => new Date(2025, 2, d, h, 0, 0);
    const delivered = await prisma.foodOrder.create({
        data: { ...base, orderId: `OD-${uniquePhone('1')}`, orderStatus: 'delivered', createdAt: day(10, 23), deliveredAt: day(11, 0) },
    });
    const cancelled = await prisma.foodOrder.create({
        data: { ...base, orderId: `OD-${uniquePhone('2')}`, orderStatus: 'cancelled_by_admin', createdAt: day(11, 9) },
    });
    ids.orders.push(delivered.id, cancelled.id);
    // Touched the next day (a rating, a settlement…): updatedAt moves on.
    await prisma.foodOrder.update({ where: { id: delivered.id }, data: { updatedAt: day(12, 10) } });

    const on = async (d) => (await getDeliveryPartnerTripHistory(ids.rider, { period: 'daily', date: day(d, 12).toISOString() }))
        .trips.map((t) => t.orderId).sort();

    assert.deepEqual(await on(10), [], 'placed on the 10th, but delivered on the 11th');
    assert.deepEqual(await on(11), [delivered.orderId, cancelled.orderId].sort());
    assert.deepEqual(await on(12), [], 'updated on the 12th is not a trip on the 12th');

    const { summary } = await getDeliveryPartnerEarnings(ids.rider, { period: 'today', date: day(11, 12).toISOString() });
    assert.equal(summary.totalOrders, 1);
    assert.equal(summary.totalEarnings, 35);
});

test("the wallet tab's week counts cancellation pay, as the balance does", async () => {
    const { getDeliveryPocketDetails } = await import('./delivery.service.js');
    const base = {
        userId: ids.user, restaurantId: ids.restaurant, dispatchDeliveryPartnerId: ids.rider, paymentMethod: 'cash',
        addrStreet: '1', addrCity: 'Indore', addrState: 'MP', subtotal: 100, total: 100, riderEarning: 35,
    };
    const day = (d, h) => new Date(2025, 3, d, h);
    const made = await Promise.all([
        prisma.foodOrder.create({ data: { ...base, orderId: `PK-${uniquePhone('1')}`, orderStatus: 'delivered', createdAt: day(8, 9), deliveredAt: day(8, 10) } }),
        prisma.foodOrder.create({ data: { ...base, orderId: `PK-${uniquePhone('2')}`, orderStatus: 'cancelled_by_admin', riderCancelPay: 10, createdAt: day(9, 9) } }),
        prisma.foodOrder.create({ data: { ...base, orderId: `PK-${uniquePhone('3')}`, orderStatus: 'cancelled_by_admin', createdAt: day(9, 11) } }),
    ]);
    ids.orders.push(...made.map((o) => o.id));

    const pocket = await getDeliveryPocketDetails(ids.rider, { date: day(9, 12).toISOString() });
    assert.equal(pocket.summary.totalEarning, 45, '35 delivered + 10 cancellation pay');
    assert.equal(pocket.transactions.payment.length, 2, 'an unpaid cancellation is not a payment');
});
