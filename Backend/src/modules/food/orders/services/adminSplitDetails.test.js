import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAdminSplitDetails, adminTransactionSplit } from './order.service.js';

/**
 * The admin order dialog splits the tip out of the rider's share and Quick Mode
 * out of the platform fee. Each pair must add back to the figure it came from.
 */
// 300 food + 20 packaging + 30 delivery + 1.5 delivery GST + (10 + 15 quick)
// platform + 15 tax - 0 discount = 391.5, plus a 20 checkout tip.
const pricing = {
  subtotal: 300, packagingFee: 20, deliveryFee: 30, deliveryFeeGst: 1.5,
  platformFee: 25, quickDeliveryFee: 15, tax: 15, discount: 0, tip: 20, total: 411.5,
};

test('checkout tip is split out of riderShare; the two add back up', () => {
  const s = buildAdminSplitDetails(pricing, { riderShare: 60 });
  assert.equal(s.tipOnOrder, 20);
  assert.equal(s.tipAfterDelivery, 0);
  assert.equal(s.riderTip, 20);
  assert.equal(s.riderEarningExTip, 40);
  assert.equal(s.riderTip + s.riderEarningExTip, 60);
});

test('quick mode is split out of the platform fee, not added on top', () => {
  const s = buildAdminSplitDetails(pricing);
  assert.equal(s.quickDeliveryFee, 15);
  assert.equal(s.platformFeeBase, 10);
  assert.equal(s.platformFeeBase + s.quickDeliveryFee, s.platformFeeTotal);
});

test('a tip left after delivery is not inside the total or riderShare', () => {
  // 20 at checkout, 30 more from the wallet later: tipAmount is 50, total unchanged.
  const s = buildAdminSplitDetails({ ...pricing, tip: 50 }, { riderShare: 60 });
  assert.equal(s.tipOnOrder, 20);
  assert.equal(s.tipAfterDelivery, 30);
  assert.equal(s.riderTip, 20);
  assert.equal(s.riderEarningExTip, 40);
});

test('no tip, no quick mode: nothing is split off', () => {
  const s = buildAdminSplitDetails(
    { ...pricing, platformFee: 10, quickDeliveryFee: 0, tip: 0, total: 381.5 },
    { riderShare: 40 },
  );
  assert.equal(s.riderTip, 0);
  assert.equal(s.riderEarningExTip, 40);
  assert.equal(s.quickDeliveryFee, 0);
  assert.equal(s.platformFeeBase, 10);
});

test('an unexplained gap in the total is never shown as a tip', () => {
  const s = buildAdminSplitDetails({ ...pricing, tip: 0, total: 500 }, { riderShare: 40 });
  assert.equal(s.tipOnOrder, 0);
  assert.equal(s.riderTip, 0);
});

test('transaction split uses the transaction platform fee', () => {
  const s = adminTransactionSplit(pricing, {
    amounts: { riderShare: 60 },
    pricing: { platformFee: 25 },
  });
  assert.equal(s.platformFeeBase + s.quickDeliveryFee, 25);
  assert.equal(s.riderTip, 20);
});
