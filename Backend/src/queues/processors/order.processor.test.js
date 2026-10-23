import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { logger } from '../../utils/logger.js';
import { processOrderJob } from './order.processor.js';
import { prisma } from '../../config/prisma.js';

/**
 * The order jobs must reach the order service. Their imports once pointed
 * outside src/, every job failed with "Cannot find module", and dispatch
 * rounds and acceptance timeouts never ran on the queue.
 */
test.after(() => prisma.$disconnect());

test('both order jobs reach their handlers', async () => {
    const errors = mock.method(logger, 'error', () => {});
    try {
        // An id no order has: the handlers find nothing and do nothing.
        const orderMongoId = 'ffffffffffffffffffffffff';
        for (const action of ['DISPATCH_TIMEOUT_CHECK', 'ORDER_ACCEPTANCE_TIMEOUT_CHECK']) {
            const result = await processOrderJob({ id: `t-${action}`, data: { action, orderMongoId, orderId: orderMongoId } });
            assert.equal(result.processed, true);
        }
        const messages = errors.mock.calls.map((c) => String(c.arguments[0]));
        assert.deepEqual(messages.filter((m) => m.includes('[BullMQ:order]')), [], messages.join('\n'));
    } finally {
        errors.mock.restore();
    }
});
