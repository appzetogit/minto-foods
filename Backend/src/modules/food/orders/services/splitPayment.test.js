import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { prisma } from '../../../../config/prisma.js';
import { config } from '../../../../config/env.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { recordTransaction, getBalance } from '../../../../core/payments/transaction.service.js';
import { __setRazorpayForTests } from '../helpers/razorpay.helper.js';
import { handleRazorpayWebhook } from '../../../../core/payments/controllers/razorpayWebhook.controller.js';
import {
    calculateOrder,
    createOrder,
    verifyPayment,
    cancelOrder,
    abandonOnlinePaymentOrder,
    processRefundAdmin,
    expireStalePendingPaymentOrders,
} from './order.service.js';
import {
    planRefundLegs,
    reconcilePendingRefunds,
    applyGatewayRefundUpdate,
} from './order-refund.service.js';

/**
 * Paying part from the wallet and part online, and refunding each part back
 * to where it came from.
 *
 * Every test goes through the real entry points (createOrder, verifyPayment,
 * cancelOrder, the webhook handler) against real Postgres. Razorpay is a fake
 * that behaves like the real API for the calls the code makes, and can be told
 * to refuse a refund or to time out after making one.
 *
 * The one rule every test checks in the end: the customer is never charged
 * for something they did not get, and never refunded twice.
 */
const HERE = testPatch(8);
const SECRET = 'split_test_secret';
const WEBHOOK_SECRET = 'split_webhook_secret';

const created = { zones: [], restaurants: [], users: [], foods: [], categories: [] };
let restaurantId = null;
let foodId = null;
let tag = null;

// ----- Fake Razorpay -----

const rz = {
    seq: 0,
    orders: new Map(),
    payments: new Map(),
    refunds: [],
    /** 'ok' | 'reject' | 'timeout' (the refund is made, but the reply is lost) */
    refundMode: 'ok',
    refundStatus: 'processed',
};
const nextId = (prefix) => `${prefix}_${tag}${++rz.seq}`;

const fakeRazorpay = {
    orders: {
        create: async ({ amount, currency, receipt, notes }) => {
            const order = { id: nextId('order'), amount, currency, receipt, notes: notes || {}, status: 'created' };
            rz.orders.set(order.id, order);
            return order;
        },
        fetch: async (id) => rz.orders.get(id),
        fetchPayments: async (id) => ({ items: [...rz.payments.values()].filter((p) => p.order_id === id) }),
    },
    payments: {
        fetch: async (id) => rz.payments.get(id),
        capture: async (id) => {
            const p = rz.payments.get(id);
            p.status = 'captured';
            return p;
        },
        refund: async (paymentId, { amount, notes }) => {
            if (rz.refundMode === 'reject') {
                throw { statusCode: 400, error: { description: 'The payment has been fully refunded already' } };
            }
            const payment = rz.payments.get(paymentId);
            assert.ok(payment, `refund for a payment Razorpay has: ${paymentId}`);
            // Razorpay's own rule: never more than was captured.
            assert.ok(payment.amount_refunded + amount <= payment.amount, 'Razorpay would refuse an over-refund');
            payment.amount_refunded += amount;
            const refund = { id: nextId('rfnd'), payment_id: paymentId, amount, notes: notes || {}, status: rz.refundStatus };
            rz.refunds.push(refund);
            if (rz.refundMode === 'timeout') throw new Error('ETIMEDOUT');
            return refund;
        },
        fetchRefund: async (paymentId, refundId) => rz.refunds.find((r) => r.id === refundId),
        fetchMultipleRefund: async (paymentId) => ({ items: rz.refunds.filter((r) => r.payment_id === paymentId) }),
    },
};

/** The customer completes the Razorpay sheet for `paise`. */
function customerPays(rzOrderId, paise) {
    const payment = { id: nextId('pay'), order_id: rzOrderId, amount: paise, amount_refunded: 0, status: 'captured', currency: 'INR' };
    rz.payments.set(payment.id, payment);
    const signature = crypto.createHmac('sha256', SECRET).update(`${rzOrderId}|${payment.id}`).digest('hex');
    return { payment, signature };
}

const refundsFor = (paymentId) => rz.refunds.filter((r) => r.payment_id === paymentId);

// ----- Fixtures -----

const address = () => ({
    label: 'Home', fullName: 'Test Customer', street: '1 Test Street', city: 'Indore',
    state: 'MP', zipCode: '452001', phone: uniquePhone('5'), latitude: HERE.lat, longitude: HERE.lng,
});

const cart = (extra = {}) => ({
    restaurantId,
    items: [{ itemId: foodId, quantity: 2 }],
    address: address(),
    paymentMethod: 'razorpay',
    ...extra,
});

async function customerWithWallet(rupees) {
    const user = await prisma.foodUser.create({ data: { name: `${tag} Customer`, phone: uniquePhone('5') } });
    created.users.push(user.id);
    if (rupees > 0) {
        await recordTransaction({
            entityType: 'user', entityId: user.id, type: 'credit', amount: rupees,
            description: 'Test top-up', category: 'wallet_topup',
        });
    }
    return user.id;
}

const walletOf = async (userId) => (await getBalance('user', userId)).balance;
const orderRow = (id) => prisma.foodOrder.findUnique({ where: { id }, include: { refundLegs: true } });
const paise = (n) => Math.round(Number(n) * 100);

/** Place a split order and pay its online part the way the app does. */
async function placeAndPay(userId) {
    const placed = await createOrder(userId, cart({ useWallet: true }));
    const order = placed.order;
    const { payment, signature } = customerPays(placed.razorpay.orderId, placed.razorpay.amount);
    await verifyPayment(userId, {
        orderId: order.id,
        razorpayOrderId: placed.razorpay.orderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: signature,
    });
    return { order, payment, placed };
}

test.before(async () => {
    tag = uniqueTag('Split');
    __setRazorpayForTests(fakeRazorpay, { keySecret: SECRET });
    config.razorpayWebhookSecret = WEBHOOK_SECRET;

    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    created.zones.push(zone.id);
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'),
            status: 'approved', zoneId: zone.id, latitude: HERE.lat, longitude: HERE.lng,
            isAcceptingOrders: true, outsideHoursOverride: true,
        },
    });
    created.restaurants.push(restaurant.id);
    restaurantId = restaurant.id;
    const category = await prisma.foodCategory.create({
        data: { name: `${tag} Mains`, restaurantId, approvalStatus: 'approved' },
    });
    created.categories.push(category.id);
    const food = await prisma.foodItem.create({
        data: {
            restaurantId, categoryId: category.id, categoryName: category.name,
            name: `${tag} Biryani`, price: 250, approvalStatus: 'approved', isAvailable: true,
        },
    });
    created.foods.push(food.id);
    foodId = food.id;
});

test.after(async () => {
    __setRazorpayForTests(null);
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.foodOrderRefund.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.transaction.deleteMany({ where: { entityId: { in: created.users } } });
    await prisma.transaction.updateMany({ where: { orderId: { in: ids } }, data: { orderId: null } });
    await prisma.wallet.deleteMany({ where: { entityId: { in: created.users } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test.beforeEach(() => {
    rz.refundMode = 'ok';
    rz.refundStatus = 'processed';
});

// ----- The split itself -----

test('refunds take the online part first, then the wallet', () => {
    const left = { wallet: 10000, online: 33000 };
    assert.deepEqual(planRefundLegs(left, 43000, 'original', true), [
        { source: 'online', refundTo: 'gateway', paise: 33000 },
        { source: 'wallet', refundTo: 'wallet', paise: 10000 },
    ]);
    assert.deepEqual(planRefundLegs(left, 5000, 'original', true), [
        { source: 'online', refundTo: 'gateway', paise: 5000 },
    ]);
    // "All to wallet" still counts the money against the part it came from.
    assert.deepEqual(planRefundLegs(left, 40000, 'wallet', true), [
        { source: 'online', refundTo: 'wallet', paise: 33000 },
        { source: 'wallet', refundTo: 'wallet', paise: 7000 },
    ]);
    // No captured payment to refund through: it has to go to the wallet.
    assert.equal(planRefundLegs(left, 1000, 'original', false)[0].refundTo, 'wallet');
});

test('the cart preview shows what the wallet would cover', async () => {
    const userId = await customerWithWallet(100);
    const quote = await calculateOrder(userId, cart());
    const total = Number(quote.pricing.total);

    assert.equal(quote.wallet.balance, 100);
    assert.equal(quote.wallet.walletAmount, 100);
    assert.equal(paise(quote.wallet.onlineAmount), paise(total) - 10000);
    assert.equal(quote.wallet.coversAll, false);
});

test('a split order takes the wallet part and charges Razorpay only the rest', async () => {
    const userId = await customerWithWallet(100);
    const placed = await createOrder(userId, cart({ useWallet: true }));
    const row = await orderRow(placed.order.id);

    assert.equal(row.paymentMethod, 'razorpay');
    assert.equal(row.orderStatus, 'pending_payment');
    assert.equal(Number(row.walletAmount), 100);
    assert.equal(paise(row.walletAmount) + paise(row.onlineAmount), paise(row.total), 'the parts add up to the total');
    assert.equal(placed.razorpay.amount, paise(row.onlineAmount), 'Razorpay is asked for the online part only');
    assert.equal(rz.orders.get(placed.razorpay.orderId).notes.purpose, 'food_order');
    assert.equal(await walletOf(userId), 0, 'the wallet part is taken up front');
});

test('paying the online part confirms the order without touching the wallet again', async () => {
    const userId = await customerWithWallet(100);
    const { order } = await placeAndPay(userId);
    const row = await orderRow(order.id);

    assert.equal(row.paymentStatus, 'paid');
    assert.equal(row.orderStatus, 'created');
    assert.equal(await walletOf(userId), 0);
});

test('a Razorpay payment for the whole total is refused on a split order', async () => {
    const userId = await customerWithWallet(100);
    const placed = await createOrder(userId, cart({ useWallet: true }));
    const row = await orderRow(placed.order.id);
    const { payment, signature } = customerPays(placed.razorpay.orderId, paise(row.total));

    await assert.rejects(
        () => verifyPayment(userId, {
            orderId: row.id, razorpayOrderId: placed.razorpay.orderId,
            razorpayPaymentId: payment.id, razorpaySignature: signature,
        }),
        /verification failed/i,
    );
    assert.notEqual((await orderRow(row.id)).paymentStatus, 'paid');
});

test('an empty wallet makes it a plain online order', async () => {
    const userId = await customerWithWallet(0);
    const placed = await createOrder(userId, cart({ useWallet: true }));
    const row = await orderRow(placed.order.id);

    assert.equal(Number(row.walletAmount), 0);
    assert.equal(paise(row.onlineAmount), paise(row.total));
    assert.equal(placed.razorpay.amount, paise(row.total));
});

test('a wallet that covers everything makes it a wallet order', async () => {
    const userId = await customerWithWallet(5000);
    const placed = await createOrder(userId, cart({ useWallet: true }));
    const row = await orderRow(placed.order.id);

    assert.equal(row.paymentMethod, 'wallet');
    assert.equal(row.paymentStatus, 'paid');
    assert.equal(placed.razorpay, null, 'no Razorpay sheet');
    assert.equal(paise(row.walletAmount), paise(row.total));
    assert.equal(paise(await walletOf(userId)), 500000 - paise(row.total));
});

test('the online part is never below ₹1', async () => {
    const probe = await customerWithWallet(0);
    const total = Number((await calculateOrder(probe, cart())).pricing.total);
    const userId = await customerWithWallet(total - 0.5);

    const placed = await createOrder(userId, cart({ useWallet: true }));
    const row = await orderRow(placed.order.id);
    assert.equal(paise(row.onlineAmount), 100);
    assert.equal(paise(row.walletAmount), paise(total) - 100);
    assert.equal(await walletOf(userId), 0.5, 'the unused 50 paise stay in the wallet');
});

// ----- Giving up an unpaid order -----

test('closing the payment sheet hands the wallet part back and removes the order', async () => {
    const userId = await customerWithWallet(100);
    const placed = await createOrder(userId, cart({ useWallet: true }));

    const result = await abandonOnlinePaymentOrder(userId, placed.order.id);
    assert.equal(result.deleted, true);
    assert.equal(await orderRow(placed.order.id), null);
    assert.equal(await walletOf(userId), 100, 'the wallet is whole again');
});

test('closing the sheet after actually paying keeps the order', async () => {
    const userId = await customerWithWallet(100);
    const placed = await createOrder(userId, cart({ useWallet: true }));
    // Paid, but the success callback never reached the app.
    customerPays(placed.razorpay.orderId, placed.razorpay.amount);

    const result = await abandonOnlinePaymentOrder(userId, placed.order.id);
    assert.equal(result.deleted, false);
    assert.equal(result.paid, true);
    const row = await orderRow(placed.order.id);
    assert.equal(row.paymentStatus, 'paid');
    assert.equal(row.orderStatus, 'created');
    assert.equal(await walletOf(userId), 0, 'the wallet part stays paid');
});

test('the 30-minute cleanup returns the wallet part exactly once', async () => {
    const userId = await customerWithWallet(100);
    const placed = await createOrder(userId, cart({ useWallet: true }));
    await prisma.foodOrder.update({
        where: { id: placed.order.id },
        data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    await expireStalePendingPaymentOrders({ force: true });
    await expireStalePendingPaymentOrders({ force: true });

    assert.equal(await orderRow(placed.order.id), null);
    assert.equal(await walletOf(userId), 100);
});

test('a payment that arrives after the order was given up is refunded in full', async () => {
    const userId = await customerWithWallet(100);
    const placed = await createOrder(userId, cart({ useWallet: true }));
    await abandonOnlinePaymentOrder(userId, placed.order.id);
    assert.equal(await walletOf(userId), 100);

    const { payment } = customerPays(placed.razorpay.orderId, placed.razorpay.amount);
    const body = { event: 'payment.captured', payload: { payment: { entity: payment } } };
    const res = await sendWebhook(body);
    assert.equal(res.statusCode, 200);

    const refunds = refundsFor(payment.id);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amount, placed.razorpay.amount, 'all of it goes back');

    // Razorpay retries the webhook: still one refund.
    await sendWebhook(body);
    assert.equal(refundsFor(payment.id).length, 1);
});

// ----- Cancelling and refunding -----

test('cancelling a split order sends each part back where it came from', async () => {
    const userId = await customerWithWallet(100);
    const { order, payment } = await placeAndPay(userId);
    const before = await orderRow(order.id);

    const cancelled = await cancelOrder(order.id, userId, 'changed my mind');
    const row = await orderRow(order.id);

    assert.equal(row.orderStatus, 'cancelled_by_user');
    assert.equal(row.paymentStatus, 'refunded');
    assert.equal(row.refundStatus, 'processed');
    assert.equal(paise(row.refundAmount), paise(before.total));
    assert.equal(await walletOf(userId), 100, 'the wallet part is back');
    const gateway = refundsFor(payment.id);
    assert.equal(gateway.length, 1);
    assert.equal(gateway[0].amount, paise(before.onlineAmount), 'the online part goes back to the card or UPI');
    assert.equal(row.refundLegs.length, 2);
    assert.ok(cancelled, 'the customer gets the order back');

    await assert.rejects(() => cancelOrder(order.id, userId, 'again'), /within 1 minute of placing them/);
    assert.equal(refundsFor(payment.id).length, 1, 'no second refund');
    assert.equal(await walletOf(userId), 100);
});

test('a partial refund, then a cancellation, refunds exactly the total', async () => {
    const userId = await customerWithWallet(100);
    const { order, payment } = await placeAndPay(userId);
    const total = paise((await orderRow(order.id)).total);

    await processRefundAdmin(order.id, 50, null);
    let row = await orderRow(order.id);
    assert.equal(row.paymentStatus, 'paid', 'a partial refund does not mark the order refunded');
    assert.equal(paise(row.refundAmount), 5000);
    assert.equal(refundsFor(payment.id)[0].amount, 5000, 'taken from the online part');

    await cancelOrder(order.id, userId, 'late');
    row = await orderRow(order.id);
    assert.equal(row.paymentStatus, 'refunded');
    assert.equal(paise(row.refundAmount), total);
    const toCard = refundsFor(payment.id).reduce((s, r) => s + r.amount, 0);
    const toWallet = paise(await walletOf(userId));
    assert.equal(toCard + toWallet, total, 'card + wallet refunds add up to what was paid');
    assert.equal(toWallet, 10000);
});

test('an admin can send it all to the wallet, and cannot refund more than is left', async () => {
    const userId = await customerWithWallet(100);
    const { order, payment } = await placeAndPay(userId);
    const total = paise((await orderRow(order.id)).total);

    await assert.rejects(() => processRefundAdmin(order.id, total / 100 + 1, null), /left to refund/);
    await processRefundAdmin(order.id, null, null, 'wallet');

    assert.equal(refundsFor(payment.id).length, 0, 'nothing through Razorpay');
    assert.equal(paise(await walletOf(userId)), total);
    assert.equal((await orderRow(order.id)).paymentStatus, 'refunded');
    await assert.rejects(() => processRefundAdmin(order.id, null, null), /Nothing is left/);
});

test('a refund Razorpay refuses can be retried to the wallet', async () => {
    const userId = await customerWithWallet(100);
    const { order, payment } = await placeAndPay(userId);
    const before = await orderRow(order.id);

    rz.refundMode = 'reject';
    await cancelOrder(order.id, userId, 'refused');
    let row = await orderRow(order.id);
    assert.equal(row.refundStatus, 'failed', 'the admin can see it failed');
    assert.equal(await walletOf(userId), 100, 'the wallet part still went back');
    assert.equal(paise(row.refundAmount), 10000);

    rz.refundMode = 'ok';
    await processRefundAdmin(order.id, null, null, 'wallet');
    row = await orderRow(order.id);
    assert.equal(row.paymentStatus, 'refunded');
    assert.equal(row.refundStatus, 'processed');
    assert.equal(paise(await walletOf(userId)), paise(before.total));
    assert.equal(refundsFor(payment.id).length, 0);
});

test('a refund whose reply was lost is found later, not made twice', async () => {
    const userId = await customerWithWallet(100);
    const { order, payment } = await placeAndPay(userId);

    rz.refundMode = 'timeout';
    await cancelOrder(order.id, userId, 'timeout');
    let row = await orderRow(order.id);
    assert.equal(row.refundStatus, 'pending', 'we do not know yet, so we do not say failed');
    assert.equal(refundsFor(payment.id).length, 1, 'Razorpay did make it');

    // The sweep only looks at legs a few minutes old.
    await prisma.foodOrderRefund.updateMany({
        where: { orderId: order.id }, data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
    });
    rz.refundMode = 'ok';
    await reconcilePendingRefunds();

    row = await orderRow(order.id);
    assert.equal(row.refundStatus, 'processed');
    assert.equal(row.paymentStatus, 'refunded');
    assert.equal(refundsFor(payment.id).length, 1, 'still exactly one refund');
    const onlineLeg = row.refundLegs.find((l) => l.source === 'online');
    assert.equal(onlineLeg.gatewayRefundId, refundsFor(payment.id)[0].id);
});

test('a refund Razorpay later reports failed frees the amount to refund again', async () => {
    const userId = await customerWithWallet(100);
    const { order, payment } = await placeAndPay(userId);

    rz.refundStatus = 'pending';
    await cancelOrder(order.id, userId, 'slow bank');
    const refund = refundsFor(payment.id)[0];

    await applyGatewayRefundUpdate({ ...refund, status: 'failed' });
    let row = await orderRow(order.id);
    assert.equal(row.refundStatus, 'failed');
    assert.equal(row.paymentStatus, 'paid', 'not refunded any more');

    // A duplicate "failed" changes nothing; a retry refunds only the online part.
    await applyGatewayRefundUpdate({ ...refund, status: 'failed' });
    rz.refundStatus = 'processed';
    await processRefundAdmin(order.id, null, null);
    row = await orderRow(order.id);
    assert.equal(row.paymentStatus, 'refunded');
    assert.equal(paise(row.refundAmount), paise(row.total));
    assert.equal(await walletOf(userId), 100, 'the wallet part was not paid twice');
});

test('the refund webhook settles a pending refund', async () => {
    const userId = await customerWithWallet(100);
    const { order, payment } = await placeAndPay(userId);

    rz.refundStatus = 'pending';
    await cancelOrder(order.id, userId, 'webhook');
    assert.equal((await orderRow(order.id)).refundStatus, 'pending');

    const refund = { ...refundsFor(payment.id)[0], status: 'processed' };
    const res = await sendWebhook({ event: 'refund.processed', payload: { refund: { entity: refund } } });
    assert.equal(res.statusCode, 200);
    const row = await orderRow(order.id);
    assert.equal(row.refundStatus, 'processed');
    assert.equal(row.paymentStatus, 'refunded');
});

test('two refunds at once never pay out more than was paid', async () => {
    const userId = await customerWithWallet(100);
    const { order, payment } = await placeAndPay(userId);
    const total = paise((await orderRow(order.id)).total);

    const results = await Promise.allSettled([
        processRefundAdmin(order.id, null, null),
        processRefundAdmin(order.id, null, null),
        cancelOrder(order.id, userId, 'at the same time'),
    ]);
    assert.ok(results.some((r) => r.status === 'fulfilled'), 'one of them refunds');

    const toCard = refundsFor(payment.id).reduce((s, r) => s + r.amount, 0);
    const toWallet = paise(await walletOf(userId));
    assert.equal(toCard + toWallet, total, 'exactly what was paid, once');
});

test('an old-style online order still refunds in full to the card', async () => {
    const userId = await customerWithWallet(0);
    const placed = await createOrder(userId, cart());
    const { payment, signature } = customerPays(placed.razorpay.orderId, placed.razorpay.amount);
    await verifyPayment(userId, {
        orderId: placed.order.id, razorpayOrderId: placed.razorpay.orderId,
        razorpayPaymentId: payment.id, razorpaySignature: signature,
    });

    await cancelOrder(placed.order.id, userId, 'plain');
    const row = await orderRow(placed.order.id);
    assert.equal(row.paymentStatus, 'refunded');
    assert.equal(refundsFor(payment.id)[0].amount, placed.razorpay.amount);
    assert.equal(await walletOf(userId), 0);
});

// ----- helpers -----

async function sendWebhook(body) {
    const raw = Buffer.from(JSON.stringify(body));
    const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json() { return this; },
        send() { return this; },
    };
    await handleRazorpayWebhook({ headers: { 'x-razorpay-signature': signature }, rawBody: raw, body }, res);
    return res;
}
