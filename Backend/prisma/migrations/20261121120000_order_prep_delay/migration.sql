ALTER TABLE "food_orders" ADD COLUMN "prepDelayNotifiedAt" TIMESTAMP(3);
-- Orders already in the kitchen at deploy are not announced as late in bulk.
UPDATE "food_orders" SET "prepDelayNotifiedAt" = now() WHERE "orderStatus" IN ('confirmed', 'preparing');
