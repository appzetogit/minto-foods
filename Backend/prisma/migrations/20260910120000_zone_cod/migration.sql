-- Cash on delivery, per zone.
--
-- COD was one environment variable for the whole platform: on everywhere or off
-- everywhere. A zone with a recovery problem could not be switched off without
-- taking COD away from every other zone too.
--
-- Nullable rather than defaulted, so a zone says one of three things: yes, no,
-- or nothing -- and "nothing" follows the platform default, which is how every
-- existing zone keeps behaving exactly as it did.
ALTER TABLE "food_zones"
  ADD COLUMN "codEnabled" BOOLEAN,
  ADD COLUMN "codMinDeliveredOrders" INTEGER NOT NULL DEFAULT 0;
