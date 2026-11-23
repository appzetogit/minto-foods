import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone } from '../../../../utils/testIds.js';
import { getDeliveryPartnerEarnings } from './delivery.service.js';

/**
 * The rider app's Yearly tab used to ask for 'all' (every year ever) because
 * the server had no year range; it now asks for the picked year.
 */
const created = [];

test.after(async () => {
    await prisma.foodDeliveryPartnerSession.deleteMany({ where: { deliveryPartnerId: { in: created } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
});

test('period=year counts only the picked year', async () => {
    const rider = await prisma.foodDeliveryPartner.create({
        data: { name: 'Year Rider', phone: uniquePhone('8'), status: 'approved' },
    });
    created.push(rider.id);
    // One hour on shift in mid-2025, two hours in mid-2024.
    await prisma.foodDeliveryPartnerSession.createMany({
        data: [
            { deliveryPartnerId: rider.id, wentOnlineAt: new Date(2025, 5, 10, 10), wentOfflineAt: new Date(2025, 5, 10, 11) },
            { deliveryPartnerId: rider.id, wentOnlineAt: new Date(2024, 5, 10, 10), wentOfflineAt: new Date(2024, 5, 10, 12) },
        ],
    });

    const y2025 = await getDeliveryPartnerEarnings(rider.id, { period: 'year', date: new Date(2025, 8, 1).toISOString() });
    assert.equal(y2025.summary.totalOnlineMinutes, 60);
    const y2024 = await getDeliveryPartnerEarnings(rider.id, { period: 'year', date: new Date(2024, 0, 15).toISOString() });
    assert.equal(y2024.summary.totalOnlineMinutes, 120);
    const all = await getDeliveryPartnerEarnings(rider.id, { period: 'all' });
    assert.equal(all.summary.totalOnlineMinutes, 180);
});

test('cancellation pay counts in earnings; a cancelled order without it does not', async () => {
    const rider = await prisma.foodDeliveryPartner.create({
        data: { name: 'Cancel Pay Rider', phone: uniquePhone('8'), status: 'approved' },
    });
    created.push(rider.id);
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: 'CP Kitchen', ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    const u = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    const base = {
        userId: u.id, restaurantId: r.id, dispatchDeliveryPartnerId: rider.id, paymentMethod: 'cash',
        addrStreet: '1', addrCity: 'Indore', addrState: 'MP', subtotal: 100, total: 100, riderEarning: 30,
    };
    const orders = await Promise.all([
        prisma.foodOrder.create({ data: { ...base, orderId: `CP-${uniquePhone('1')}`, orderStatus: 'delivered', deliveredAt: new Date() } }),
        prisma.foodOrder.create({ data: { ...base, orderId: `CP-${uniquePhone('2')}`, orderStatus: 'cancelled_by_admin', riderCancelPay: 10 } }),
        prisma.foodOrder.create({ data: { ...base, orderId: `CP-${uniquePhone('3')}`, orderStatus: 'cancelled_by_admin' } }),
    ]);
    try {
        const { summary } = await getDeliveryPartnerEarnings(rider.id, { period: 'today' });
        assert.equal(summary.totalEarnings, 40, '30 delivered + 10 cancellation pay');
        assert.equal(summary.orderEarning, 30);
        assert.equal(summary.cancelPay, 10);
        assert.equal(summary.totalOrders, 1, 'only deliveries are orders completed');
    } finally {
        await prisma.foodOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
        await prisma.foodUser.delete({ where: { id: u.id } });
        await prisma.foodRestaurant.delete({ where: { id: r.id } });
    }
});

test('credited incentives count in the period they were credited, and in the total', async () => {
    const rider = await prisma.foodDeliveryPartner.create({
        data: { name: 'Incentive Rider', phone: uniquePhone('8'), status: 'approved' },
    });
    created.push(rider.id);
    await prisma.deliveryBonusTransaction.create({
        data: { deliveryPartnerId: rider.id, transactionId: `inc-${uniquePhone('7')}`, amount: 300, reference: 'Earning Addon' },
    });
    await prisma.deliveryBonusTransaction.create({
        data: {
            deliveryPartnerId: rider.id, transactionId: `inc-${uniquePhone('7')}`, amount: 100,
            createdAt: new Date(2024, 0, 10),
        },
    });
    try {
        const today = (await getDeliveryPartnerEarnings(rider.id, { period: 'today' })).summary;
        assert.equal(today.incentive, 300);
        assert.equal(today.totalEarnings, 300);
        assert.equal(today.totalOrders, 0, 'an incentive is not an order');
        const all = (await getDeliveryPartnerEarnings(rider.id, { period: 'all' })).summary;
        assert.equal(all.incentive, 400);
    } finally {
        await prisma.deliveryBonusTransaction.deleteMany({ where: { deliveryPartnerId: rider.id } });
    }
});
