import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assertCodAllowedForTotal,
    assertItemQuantities,
    resolveOrderLimits,
} from './orderLimits.js';

test('limits in force: unset COD is ₹2000, 0 is no limit, quantity defaults to 50', () => {
    assert.deepEqual(resolveOrderLimits(null), { codMaxOrderValue: 2000, maxItemQuantity: 50 });
    assert.deepEqual(resolveOrderLimits({ codMaxOrderValue: '1500.00', maxItemQuantity: 10 }), {
        codMaxOrderValue: 1500,
        maxItemQuantity: 10,
    });
    assert.equal(resolveOrderLimits({ codMaxOrderValue: 0, maxItemQuantity: 50 }).codMaxOrderValue, 0);
});

test('COD is refused at or above the limit, never with no limit', () => {
    const limits = { codMaxOrderValue: 1500 };
    assert.doesNotThrow(() => assertCodAllowedForTotal(1499.99, limits));
    assert.throws(() => assertCodAllowedForTotal(1500, limits), /only for orders below ₹1500/);
    assert.throws(() => assertCodAllowedForTotal(1600, limits), /Cash on Delivery is available only for orders below ₹1500/);
    assert.doesNotThrow(() => assertCodAllowedForTotal(99999, { codMaxOrderValue: 0 }));
});

test('more of one dish than the limit is refused', () => {
    const limits = { maxItemQuantity: 10 };
    assert.doesNotThrow(() => assertItemQuantities([{ quantity: 10 }, { quantity: 3 }], limits));
    assert.throws(() => assertItemQuantities([{ quantity: 2 }, { quantity: 11 }], limits), /at most 10 of one item/);
});
