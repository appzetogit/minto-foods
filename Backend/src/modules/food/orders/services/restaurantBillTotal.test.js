import test from 'node:test';
import assert from 'node:assert/strict';

import { restaurantBillTotal, toRestaurantView } from './order.helpers.js';

test("the restaurant's order value is its food bill, not the customer's total", () => {
    // MFB03112610149: Rs 100 of food (105 with the 5 markup), GST 5.25,
    // delivery 38, platform 10 -> customer pays 158.25.
    const order = {
        priceMarkupAmount: 5,
        pricing: { subtotal: 105, packagingFee: 0, tax: 5.25, deliveryFee: 38, platformFee: 10, total: 158.25 },
        items: [],
    };
    assert.equal(restaurantBillTotal(toRestaurantView(order).pricing), 105.25);
    assert.equal(restaurantBillTotal({ subtotal: 200, packagingFee: 10, tax: 10.5 }), 220.5);
    assert.equal(restaurantBillTotal(undefined), 0);
});
