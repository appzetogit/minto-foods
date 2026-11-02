-- Orders cancelled by an admin or by expiry never moved their transaction on,
-- so cancelled orders read as "pending" in the reports. Paid money is
-- 'refunded', anything else 'failed', as cancelling does now. Neither status
-- is paid out, so no payout changes.
UPDATE "food_transactions" t
SET "status" = CASE WHEN o."paymentStatus"::text IN ('paid', 'refunded') THEN 'refunded' ELSE 'failed' END::"FoodTxnStatus"
FROM "food_orders" o
WHERE o."id" = t."orderId"
  AND t."status" = 'pending'
  AND o."orderStatus"::text LIKE 'cancelled%';
