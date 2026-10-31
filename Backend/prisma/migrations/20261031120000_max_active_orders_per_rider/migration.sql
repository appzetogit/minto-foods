-- Peak-time batching: how many open orders one rider may carry at once.
-- 1 keeps the old one-trip-at-a-time behaviour until an admin raises it.
ALTER TABLE "food_settings" ADD COLUMN "maxActiveOrdersPerRider" INTEGER NOT NULL DEFAULT 1;
