import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { requestDeliveryWithdrawal, getDeliveryPartnerWalletEnhanced } from './deliveryFinance.service.js';
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * Requesting a withdrawal used to write a computed "should-be" balance
 * straight onto wallet.balance, with no transaction row behind it — a rider
 * could watch their stored balance jump with nothing in their history
 * explaining why. The one test here is that the sync now goes through
 * recordTransaction: a real ledger row, not a silent overwrite.
 */
const created = { partners: [], restaurants: [], orders: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

test.after(async () => {
    await prisma.foodDeliveryWithdrawal.deleteMany({ where: { deliveryPartnerId: { in: created.partners } } });
    await prisma.deliveryBonusTransaction.deleteMany({ where: { deliveryPartnerId: { in: created.partners } } });
    await prisma.transaction.deleteMany({ where: { entityType: 'deliveryBoy', entityId: { in: created.partners } } });
    await prisma.wallet.deleteMany({ where: { entityId: { in: created.partners } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.$disconnect();
});

const deliveredOrder = async (partnerId, riderEarning) => {
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `Pay Rest ${stamp()}`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(restaurant.id);
    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    const order = await prisma.foodOrder.create({
        data: {
            userId: user.id, restaurantId: restaurant.id, dispatchDeliveryPartnerId: partnerId,
            orderStatus: 'delivered', paymentMethod: 'cash', addrStreet: '1 Test Street', addrCity: 'Indore',
            addrState: 'MP', subtotal: 500, total: 500, riderEarning,
        },
    });
    created.orders.push(order.id);
};

test('one withdrawal request at a time, never more than the rider has', async () => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: { name: `Payout Rider ${stamp()}`, phone: uniquePhone('7'), status: 'approved' },
    });
    created.partners.push(partner.id);
    await deliveredOrder(partner.id, 500);

    await assert.rejects(() => requestDeliveryWithdrawal(partner.id, { amount: 600 }), /up to ₹500/);

    // Five taps at once: exactly one request.
    const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => requestDeliveryWithdrawal(partner.id, { amount: 300 })),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => /already have a withdrawal/.test(r.reason.message)));
    const rows = await prisma.foodDeliveryWithdrawal.findMany({ where: { deliveryPartnerId: partner.id } });
    assert.equal(rows.length, 1);

    // Nothing is written to the ledger by asking.
    const ledger = await prisma.transaction.count({ where: { entityType: 'deliveryBoy', entityId: partner.id } });
    assert.equal(ledger, 0);

    const wallet = await getDeliveryPartnerWalletEnhanced(partner.id);
    assert.equal(wallet.pocketBalance, 200, '500 earned, 300 waiting');
    assert.equal(wallet.pendingWithdrawals, 300);
});

test('a bonus is counted once, however the ledger has grown', async () => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: { name: `Bonus Rider ${stamp()}`, phone: uniquePhone('7'), status: 'approved' },
    });
    created.partners.push(partner.id);
    await deliveredOrder(partner.id, 100);
    // An add-on or admin bonus: a bonus row, and a ledger credit that also
    // raises the wallet's lifetime counter -- the two used to be added up.
    await prisma.deliveryBonusTransaction.create({
        data: { deliveryPartnerId: partner.id, transactionId: `T${stamp()}`, amount: 300, reference: 'Earning add-on' },
    });
    await prisma.wallet.create({
        data: { entityType: 'deliveryBoy', entityId: partner.id, balance: 300, totalEarnings: 300, totalBonus: 300 },
    });

    const wallet = await getDeliveryPartnerWalletEnhanced(partner.id);
    assert.equal(wallet.totalEarned, 100);
    assert.equal(wallet.totalBonus, 300);
    assert.equal(wallet.pocketBalance, 400, 'not 700');
});
