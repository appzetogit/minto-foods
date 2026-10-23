import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../utils/testIds.js';
import { notifyOwnersSafely, orderInboxRows } from './firebase.service.js';

/**
 * Customer order pushes are kept in the inbox the app's Notifications screen
 * reads. They used to be push-only, so the screen stayed empty.
 */
const push = (over = {}) => ({
    title: 'Order accepted',
    body: 'Order accepted by Test Kitchen, it is being prepared',
    data: { type: 'order_update', orderId: 'aaaaaaaaaaaaaaaaaaaaaaaa', orderMongoId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
    ...over,
});

test('a visible order push to a customer becomes one inbox row', () => {
    const rows = orderInboxRows(
        [{ ownerType: 'USER', ownerId: 'u1' }, { ownerType: 'RESTAURANT', ownerId: 'r1' }],
        push(),
    );
    assert.equal(rows.length, 1, 'customers only');
    assert.deepEqual(
        { ...rows[0], metadata: undefined },
        {
            ownerType: 'USER',
            ownerId: 'u1',
            title: 'Order accepted',
            message: 'Order accepted by Test Kitchen, it is being prepared',
            link: '/food/user/orders/aaaaaaaaaaaaaaaaaaaaaaaa',
            category: 'order',
            source: 'ORDER_EVENT',
            metadata: undefined,
        },
    );
});

test('silent pushes, broadcasts and pushes without an order are not kept', () => {
    const user = [{ ownerType: 'USER', ownerId: 'u1' }];
    assert.equal(orderInboxRows(user, push({ dataOnly: true })).length, 0);
    assert.equal(orderInboxRows(user, push({ data: { type: 'admin_broadcast', orderId: 'x' } })).length, 0);
    assert.equal(orderInboxRows(user, push({ data: { type: 'order_update' } })).length, 0);
    assert.equal(orderInboxRows(user, push({ saveToInbox: false })).length, 0);
    for (const type of ['order_status_update', 'order_cancelled']) {
        assert.equal(orderInboxRows(user, push({ data: { type, orderId: 'x' } })).length, 1, type);
    }
});

test('sending an order push saves the inbox row, with no device to push to', async () => {
    const user = await prisma.foodUser.create({ data: { name: uniqueTag('Inbox'), phone: uniquePhone('7') } });
    try {
        await notifyOwnersSafely([{ ownerType: 'USER', ownerId: user.id }], push());
        // Saved in the background so it never delays the push.
        let rows = [];
        for (let i = 0; i < 20 && !rows.length; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            rows = await prisma.foodNotification.findMany({ where: { ownerType: 'USER', ownerId: user.id } });
        }
        assert.equal(rows.length, 1);
        assert.equal(rows[0].source, 'ORDER_EVENT');
        assert.equal(rows[0].category, 'order');
        assert.equal(rows[0].link, '/food/user/orders/aaaaaaaaaaaaaaaaaaaaaaaa');
    } finally {
        await prisma.foodNotification.deleteMany({ where: { ownerType: 'USER', ownerId: user.id } });
        await prisma.foodUser.delete({ where: { id: user.id } });
        await prisma.$disconnect();
    }
});
