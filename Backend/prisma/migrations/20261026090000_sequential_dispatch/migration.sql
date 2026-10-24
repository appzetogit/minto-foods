-- One order goes to one rider at a time. Each offer carries when it runs out
-- and which dispatch round it belongs to: a rider who said no (or let it time
-- out) is not asked again in the same round.
ALTER TABLE "food_order_dispatch_offers" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "food_order_dispatch_offers" ADD COLUMN "round" INTEGER NOT NULL DEFAULT 1;

-- How long a rider has to accept an automatic offer, set by the admin.
ALTER TABLE "food_settings" ADD COLUMN "riderAcceptWindowSeconds" INTEGER NOT NULL DEFAULT 45;
