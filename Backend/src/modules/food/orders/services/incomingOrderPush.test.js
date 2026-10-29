import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIncomingOrderPushData } from './order-dispatch.service.js';

test('the offer push carries the customer\'s note for the rider, never the kitchen note', () => {
    const order = { id: 'o1', order_id: 'MFB1', items: [], note: 'Less spicy', deliveryInstructions: 'Ring the bell' };
    const data = buildIncomingOrderPushData(order, {}, new Date(), 45000);
    assert.equal(data.deliveryInstructions, 'Ring the bell');
    assert.ok(!Object.values(data).includes('Less spicy'));
    // FCM data values must all be strings.
    assert.ok(Object.values(data).every((v) => typeof v === 'string'));
    assert.equal(buildIncomingOrderPushData({ id: 'o2', items: [] }, {}, new Date()).deliveryInstructions, '');
});
