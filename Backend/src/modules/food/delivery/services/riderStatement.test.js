import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone } from '../../../../utils/testIds.js';
import { getRiderStatement } from './riderStatement.service.js';
import { riderBalance } from './riderBalance.service.js';

const ids = { rider: null, user: null, restaurant: null, orders: [], settlements: [] };

test.after(async () => {
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids.orders } } });
    await prisma.settlement.deleteMany({ where: { id: { in: ids.settlements } } });
    if (ids.rider) {
        await prisma.foodDeliveryWithdrawal.deleteMany({ where: { deliveryPartnerId: ids.rider } });
        await prisma.deliveryBonusTransaction.deleteMany({ where: { deliveryPartnerId: ids.rider } });
        await prisma.foodDeliveryPartner.delete({ where: { id: ids.rider } });
    }
    if (ids.user) await prisma.foodUser.delete({ where: { id: ids.user } });
    if (ids.restaurant) await prisma.foodRestaurant.delete({ where: { id: ids.restaurant } });
    await prisma.$disconnect();
});

test('the statement lists payouts and bonuses and ends on the wallet balance', async () => {
    ids.rider = (await prisma.foodDeliveryPartner.create({ data: { name: 'Statement', phone: uniquePhone('8'), status: 'approved' } })).id;
    ids.restaurant = (await prisma.foodRestaurant.create({
        data: { restaurantName: 'ST Kitchen', ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    })).id;
    ids.user = (await prisma.foodUser.create({ data: { phone: uniquePhone('5') } })).id;
    const base = {
        userId: ids.user, restaurantId: ids.restaurant, dispatchDeliveryPartnerId: ids.rider, paymentMethod: 'cash',
        addrStreet: '1', addrCity: 'Indore', addrState: 'MP', subtotal: 100, total: 100, riderEarning: 35,
    };
    const now = new Date();
    const lastWeek = new Date(now.getTime() - 7 * 864e5);
    const orders = await Promise.all([
        prisma.foodOrder.create({ data: { ...base, orderId: `ST-${uniquePhone('1')}`, orderStatus: 'delivered', deliveredAt: lastWeek, createdAt: lastWeek } }),
        prisma.foodOrder.create({ data: { ...base, orderId: `ST-${uniquePhone('2')}`, orderStatus: 'delivered', deliveredAt: now } }),
        prisma.foodOrder.create({ data: { ...base, orderId: `ST-${uniquePhone('3')}`, orderStatus: 'cancelled_by_admin', riderCancelPay: 10 } }),
    ]);
    ids.orders.push(...orders.map((o) => o.id));
    await prisma.deliveryBonusTransaction.create({
        data: { deliveryPartnerId: ids.rider, transactionId: `st-${uniquePhone('7')}`, amount: 300, reference: 'Earning Addon: 2 orders' },
    });
    const paid = await prisma.settlement.create({
        data: { entityType: 'deliveryBoy', entityId: ids.rider, amount: 35, status: 'processed', payoutRef: 'UTR123', processedAt: now },
    });
    ids.settlements.push(paid.id);
    await prisma.foodDeliveryWithdrawal.create({ data: { deliveryPartnerId: ids.rider, amount: 50, status: 'pending' } });
    await prisma.foodDeliveryWithdrawal.create({ data: { deliveryPartnerId: ids.rider, amount: 999, status: 'rejected', rejectionReason: 'Bank details wrong' } });

    const st = await getRiderStatement(ids.rider, { weeks: 4 });
    const bal = await riderBalance(ids.rider);

    // 35 + 35 + 10 + 300 = 380 earned; 35 paid; 50 waiting.
    assert.equal(st.summary.totalEarned, 380);
    assert.equal(st.summary.paidOut, 35);
    assert.equal(st.summary.pending, 50);
    assert.equal(st.summary.available, bal.available);
    assert.equal(st.summary.available, 295);

    const [thisWeek, prevWeek] = st.weeks;
    assert.equal(prevWeek.deliveryPay, 35);
    assert.equal(prevWeek.closingBalance, 35);
    assert.equal(thisWeek.openingBalance, 35);
    assert.equal(thisWeek.earned, 345, '35 delivery + 10 cancellation + 300 bonus');
    assert.equal(thisWeek.paidOut, 35);
    assert.equal(thisWeek.pending, 50);
    assert.equal(thisWeek.closingBalance, st.summary.available, 'ends on the wallet balance');

    assert.deepEqual(st.payouts.map((p) => p.status).sort(), ['paid', 'pending', 'rejected']);
    const p = st.payouts.find((x) => x.status === 'paid');
    assert.equal(p.reference, 'UTR123');
    assert.ok(p.paidAt);
    assert.equal(st.payouts.find((x) => x.status === 'rejected').note, 'Bank details wrong');
    assert.equal(st.credits[0].label, 'Earning Addon: 2 orders');
});
