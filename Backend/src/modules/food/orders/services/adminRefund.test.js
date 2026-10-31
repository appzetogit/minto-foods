import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { getBalance } from '../../../../core/payments/transaction.service.js';
import { processRefundAdmin } from './order.service.js';
import { listOrderRefunds } from '../../admin/services/adminRefunds.service.js';

/**
 * An admin refunds an order from the Orders page: any paid order, in full or
 * part, to the wallet, borne by the restaurant (off its payout) or the company.
 * The sheet's case: a customer got one item short on a delivered order.
 */
const created = { orders: [], users: [], restaurants: [] };
let restaurantId;
let user;
const tag = uniqueTag('ARF');

test.before(async () => {
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    restaurantId = r.id;
    created.restaurants.push(r.id);
    user = await prisma.foodUser.create({ data: { phone: uniquePhone('5'), name: `${tag} Customer` } });
    created.users.push(user.id);
});

test.after(async () => {
    const ids = created.orders;
    await prisma.foodOrderRefund.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodTransactionHistory.deleteMany({ where: { transaction: { orderId: { in: ids } } } });
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.transaction.deleteMany({ where: { entityType: 'user', entityId: { in: created.users } } });
    await prisma.wallet.deleteMany({ where: { entityType: 'user', entityId: { in: created.users } } }).catch(() => {});
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

let seq = 0;
/** A delivered order with its money record, as checkout and delivery leave it. */
const deliveredOrder = async ({ method = 'cash', status = 'delivered', settled = false } = {}) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId: user.id,
            restaurantId,
            order_id: `${tag}${++seq}`,
            orderStatus: status,
            paymentMethod: method,
            paymentStatus: 'paid',
            ...(method === 'wallet' ? { walletAmount: 500 } : {}),
            addrStreet: '1 St', addrCity: 'Indore', addrState: 'MP',
            subtotal: 450, packagingFee: 0, restaurantCommission: 45, total: 500,
        },
    });
    created.orders.push(order.id);
    await prisma.foodTransaction.create({
        data: {
            orderId: order.id, userId: user.id, restaurantId, paymentMethod: method, status: 'captured',
            subtotal: 450, total: 500, totalCustomerPaid: 500,
            restaurantShare: 405, commissionAmount: 45, riderShare: 40, platformNetProfit: 15,
            isRestaurantSettled: settled,
        },
    });
    return order;
};

const txnOf = (orderId) => prisma.foodTransaction.findUnique({ where: { orderId } });

test('a missing item on a delivered COD order: wallet credit, taken off the restaurant payout', async () => {
    const order = await deliveredOrder();
    const before = (await getBalance('user', user.id)).balance;

    const res = await processRefundAdmin(order.id, 120, 'admin-test', 'original', { chargedTo: 'restaurant', reason: '1 roti missing' });
    assert.equal(res.refundAmount, 120);

    assert.equal((await getBalance('user', user.id)).balance, before + 120, 'cash comes back as wallet credit');
    const txn = await txnOf(order.id);
    assert.equal(txn.status, 'captured', 'still paid out; only the refund comes off');
    assert.equal(Number(txn.restaurantShare), 285);
    assert.equal(Number(txn.restaurantRefundDeduction), 120);
    assert.equal(Number(txn.platformNetProfit), 15);

    // A second partial refund, borne by the company this time.
    await processRefundAdmin(order.id, 80, 'admin-test', 'original', { chargedTo: 'platform' });
    const after = await txnOf(order.id);
    assert.equal(Number(after.restaurantShare), 285, 'the restaurant is not charged for the company one');
    assert.equal(Number(after.platformNetProfit), -65);

    await assert.rejects(() => processRefundAdmin(order.id, 400, 'admin-test'), /Only ₹300 is left/);
});

test('a refund cannot come off a payout that was already paid', async () => {
    const order = await deliveredOrder({ settled: true });
    await assert.rejects(
        () => processRefundAdmin(order.id, 50, 'admin-test', 'original', { chargedTo: 'restaurant' }),
        /already been paid/,
    );
    const res = await processRefundAdmin(order.id, 50, 'admin-test', 'original', { chargedTo: 'platform' });
    assert.equal(res.refundAmount, 50);
});

test('an unpaid cash order has nothing to refund', async () => {
    const order = await deliveredOrder();
    await prisma.foodOrder.update({ where: { id: order.id }, data: { paymentStatus: 'cod_pending', orderStatus: 'preparing' } });
    await assert.rejects(() => processRefundAdmin(order.id, 10, 'admin-test'), /not been paid yet/);
});

test('a cancelled order refunded in full leaves the payouts', async () => {
    const order = await deliveredOrder({ method: 'wallet', status: 'cancelled_by_admin' });
    await processRefundAdmin(order.id, null, 'admin-test');
    assert.equal((await txnOf(order.id)).status, 'refunded');
});

test('refund tracking lists every movement with totals', async () => {
    const page = await listOrderRefunds({ search: tag, limit: 50 });
    assert.ok(page.refunds.length >= 4);
    assert.ok(page.refunds.every((r) => r.restaurantName === `${tag} Kitchen`));
    assert.ok(page.summary.chargedToRestaurant >= 120);
    const restaurantOnly = await listOrderRefunds({ search: tag, chargedTo: 'restaurant' });
    assert.ok(restaurantOnly.refunds.every((r) => r.chargedTo === 'restaurant'));
    assert.equal((await listOrderRefunds({ search: tag }, [])).refunds.length, 0, 'scoped to the viewed zones');
});
