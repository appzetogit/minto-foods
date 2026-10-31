-- A COD order paid on delivery can be refunded (to the wallet) by an admin,
-- e.g. an item was missing.
ALTER TYPE "RefundSource" ADD VALUE IF NOT EXISTS 'cash';

-- Who bears a refund: the restaurant (taken off its payout) or the platform.
ALTER TABLE "food_order_refunds" ADD COLUMN "chargedTo" VARCHAR(16) NOT NULL DEFAULT 'platform';

-- What was taken off the restaurant's payout for refunds it bears. Already
-- subtracted from restaurantShare; kept so the payout can show it.
ALTER TABLE "food_transactions" ADD COLUMN "restaurantRefundDeduction" DECIMAL(14,2) NOT NULL DEFAULT 0;
