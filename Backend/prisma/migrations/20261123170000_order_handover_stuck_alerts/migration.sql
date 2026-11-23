ALTER TABLE "food_orders" ADD COLUMN IF NOT EXISTS "handoverLateNotifiedAt" TIMESTAMP(3);
ALTER TABLE "food_orders" ADD COLUMN IF NOT EXISTS "stuckNotifiedAt" TIMESTAMP(3);
