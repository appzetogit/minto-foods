import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { getBalance } from '../../../../core/payments/transaction.service.js';
import { updateOrderStatusAdmin } from './order.service.js';

/**
 * An admin cancelling an order: the status change is claimed before money
 * moves, and an order still waiting for payment cannot be cancelled into a
 * state that strands its wallet part.
 */
const created = { orders: [], users: [], restaurants: [] };
const tag = uniqueTag('ACR');
let restaurantId;
let user;

test.before(async () => {
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    restaurantId = r.id;
    created.restaurants.push(r.id);
    user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);
});

test.after(async () => {
    const ids = created.orders;
    await prisma.foodOrderRefund.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.transaction.deleteMany({ where: { entityType: 'user', entityId: { in: created.users } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

let seq = 0;
const makeOrder = async (over = {}) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId: user.id,
            restaurantId,
            order_id: `${tag}${++seq}`,
            orderStatus: 'confirmed',
            paymentMethod: 'wallet',
            paymentStatus: 'paid',
            walletAmount: 300,
            addrStreet: '1 St', addrCity: 'Indore', addrState: 'MP',
            subtotal: 300, packagingFee: 0, restaurantCommission: 30, total: 300,
            ...over,
        },
    });
    created.orders.push(order.id);
    return order;
};

test('cancelling refunds a paid order once, after claiming the status', async () => {
    const order = await makeOrder();
    const before = (await getBalance('user', user.id)).balance;
    await updateOrderStatusAdmin(order.id, 'cancelled_by_admin', 'test', 'a'.repeat(24));
    const row = await prisma.foodOrder.findUnique({ where: { id: order.id } });
    assert.equal(row.orderStatus, 'cancelled_by_admin');
    assert.equal((await getBalance('user', user.id)).balance, before + 300);
});

test('an order still waiting for payment is refused, wallet part untouched', async () => {
    const order = await makeOrder({ orderStatus: 'pending_payment', paymentStatus: 'created', paymentMethod: 'razorpay', walletAmount: 100, onlineAmount: 200 });
    await assert.rejects(() => updateOrderStatusAdmin(order.id, 'cancelled_by_admin', 'test', 'a'.repeat(24)), /waiting for payment/);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id: order.id } })).orderStatus, 'pending_payment');
});
