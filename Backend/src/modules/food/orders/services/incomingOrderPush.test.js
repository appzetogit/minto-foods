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

test('the offer push says when the customer paid for quick delivery', () => {
    const quick = { id: 'o3', items: [], pricing: { deliveryMode: 'quick' } };
    assert.equal(buildIncomingOrderPushData(quick, {}, new Date()).deliveryMode, 'quick');
    assert.equal(buildIncomingOrderPushData({ id: 'o4', items: [] }, {}, new Date()).deliveryMode, 'basic');
});

test('the offer push carries the customer\'s tip', () => {
    assert.equal(buildIncomingOrderPushData({ id: 'o5', items: [], pricing: { tip: 20 } }, {}, new Date()).tipAmount, '20');
    assert.equal(buildIncomingOrderPushData({ id: 'o6', items: [] }, {}, new Date()).tipAmount, '0');
});
