import test from 'node:test';
import assert from 'node:assert/strict';

import { validateCalculateOrderDto, validateCreateOrderDto } from '../validators/order.validator.js';

/**
 * The tip at checkout.
 *
 * The pricing function handled a tip correctly all along; what failed was that
 * no tip ever reached it. Both order schemas left tipAmount out, and Zod removes
 * keys a schema does not name -- so these tests go through the validators, the
 * layer an HTTP request actually passes, rather than calling pricing directly.
 */

const { checkCheckoutTip } = await import('./order-pricing.service.js').catch(() => ({}));

const cart = {
    restaurantId: '1a2b3c4d5e6f7a8b9c0d1e2f',
    items: [{ itemId: 'a1b2c3d4e5f6a7b8c9d0e1f2', name: 'Paneer Tikka', price: 200, quantity: 2 }],
};

test('the preview keeps the tip it was sent', () => {
    assert.equal(validateCalculateOrderDto({ ...cart, tipAmount: 20 }).tipAmount, 20);
});

test('placing the order keeps the tip it was sent', () => {
    const dto = validateCreateOrderDto({
        ...cart,
        address: { street: '12 MG Road', city: 'Indore', state: 'MP', zipCode: '452001' },
        pricing: { subtotal: 400, total: 443, couponCode: null },
        paymentMethod: 'razorpay',
        tipAmount: 20,
    });
    assert.equal(dto.tipAmount, 20);
});

test('a negative tip is refused at the door', () => {
    assert.throws(() => validateCalculateOrderDto({ ...cart, tipAmount: -5 }), /negative/);
});

test('no tip stays no tip', () => {
    assert.equal(validateCalculateOrderDto(cart).tipAmount, undefined);
});

test('the admin switch and ceiling apply at checkout', { skip: !checkCheckoutTip && 'pricing module needs a database to import' }, () => {
    assert.deepEqual(checkCheckoutTip(0, { tipsEnabled: false }), { ok: true }, 'no tip is always fine');
    assert.equal(checkCheckoutTip(20, { tipsEnabled: false }).message, 'Tipping is switched off');
    assert.equal(checkCheckoutTip(150, { tipsEnabled: true, tipMaxAmount: 100 }).message, 'The most you can tip is ₹100');
    assert.equal(checkCheckoutTip(100, { tipsEnabled: true, tipMaxAmount: 100 }).ok, true, 'exactly the ceiling is allowed');
    assert.equal(checkCheckoutTip(500, { tipsEnabled: true, tipMaxAmount: null }).ok, true, 'no ceiling');
});
