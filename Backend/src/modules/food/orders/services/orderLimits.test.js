import test from 'node:test';
import assert from 'node:assert/strict';

import { codLimitError, quantityLimitError, codMaxOrderValueOf, maxItemQuantityOf } from './orderLimits.js';

test('quantity cap: 50 by default, the admin value when set', () => {
    assert.equal(maxItemQuantityOf(null), 50);
    assert.equal(maxItemQuantityOf({ maxItemQuantity: 10 }), 10);
    assert.equal(quantityLimitError([{ quantity: 50 }], null), null);
    assert.equal(quantityLimitError([{ quantity: 51 }], null), 'You can order at most 50 of one item');
    assert.equal(quantityLimitError([{ quantity: 11 }], { maxItemQuantity: 10 }), 'You can order at most 10 of one item');
});

test('COD limit: ₹2000 unset, admin value, 0 = no limit', () => {
    assert.equal(codMaxOrderValueOf({}), 2000);
    assert.equal(codMaxOrderValueOf({ codMaxOrderValue: '1500.00' }), 1500);
    assert.equal(codMaxOrderValueOf({ codMaxOrderValue: 0 }), null);
    assert.equal(codLimitError('cash', 1999, {}), null);
    assert.match(codLimitError('cash', 2000, {}), /below ₹2000/);
    assert.equal(codLimitError('razorpay', 5000, {}), null);
    assert.equal(codLimitError('cash', 99999, { codMaxOrderValue: 0 }), null);
});
