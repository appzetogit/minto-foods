-- The least a rider earns for one delivery, per zone. Null means no floor.
ALTER TABLE "food_fee_settings" ADD COLUMN "riderMinPayPerTrip" DECIMAL(14,2);
