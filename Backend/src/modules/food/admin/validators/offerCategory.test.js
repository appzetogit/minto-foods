import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOfferCategory, validateCreateOfferDto } from './offer.validator.js';

test('a coupon category is one of the five, or none', () => {
    assert.equal(normalizeOfferCategory('bank'), 'bank');
    assert.equal(normalizeOfferCategory(' Free_Delivery '), 'free_delivery');
    assert.equal(normalizeOfferCategory(''), null);
    assert.equal(normalizeOfferCategory(null), null);
    assert.throws(() => normalizeOfferCategory('cashback'), /Category must be one of/);
});

test('a new coupon carries its category', () => {
    const dto = validateCreateOfferDto({
        couponCode: 'BANK10',
        discountType: 'percentage',
        discountValue: 10,
        maxDiscount: 100,
        category: 'bank',
    });
    assert.equal(dto.category, 'bank');
    assert.equal(validateCreateOfferDto({ couponCode: 'NOCAT1', discountType: 'percentage', discountValue: 10, maxDiscount: 50 }).category, null);
});
