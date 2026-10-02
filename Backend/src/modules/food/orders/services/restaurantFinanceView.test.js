import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRestaurantFinanceViewSync } from './order.service.js';

/**
 * What the restaurant app shows as "your earning" for an order: item total,
 * minus commission, equals payout. Never the customer's delivery fee or tax.
 */
const order = { subtotal: 500, packagingFee: 20, discount: 0, tax: 25, total: 565 };

test('the commission shown is the one deducted, not the checkout snapshot', () => {
  // The mapped transaction: flat restaurantCommission is the pricing snapshot
  // (0 here), the real deduction is commissionAmount / amounts.restaurantCommission.
  const tx = {
    restaurantCommission: 0,
    commissionAmount: 78,
    restaurantShare: 442,
    amounts: { restaurantCommission: 78, restaurantShare: 442, taxAmount: 25, totalCustomerPaid: 565 },
    settlement: { isRestaurantSettled: true, restaurantSettledAt: '2026-10-01T00:00:00.000Z' },
  };
  const f = buildRestaurantFinanceViewSync(order, tx);
  assert.equal(f.commission, 78);
  assert.equal(f.netPayout, 442);
  assert.equal(f.isSettled, true);
});

test('the list page shape ({ amounts, settlement } only) reads the same values', () => {
  const f = buildRestaurantFinanceViewSync(order, {
    amounts: { restaurantCommission: 78, restaurantShare: 442 },
    settlement: { isRestaurantSettled: false },
  });
  assert.equal(f.commission, 78);
  assert.equal(f.netPayout, 442);
  assert.equal(f.isSettled, false);
});

test('before the transaction exists the payout is items + packaging - commission', () => {
  const f = buildRestaurantFinanceViewSync({ ...order, restaurantCommission: 50 }, null);
  assert.equal(f.commission, 50);
  assert.equal(f.netPayout, 470);
});
