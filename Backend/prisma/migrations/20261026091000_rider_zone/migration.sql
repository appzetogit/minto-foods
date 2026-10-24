-- The zone an admin puts a rider in (Add delivery partner). Shown and
-- filtered on in the admin list; dispatch still goes by distance.
ALTER TABLE "food_delivery_partners" ADD COLUMN "zoneId" VARCHAR(24);
ALTER TABLE "food_delivery_partners"
  ADD CONSTRAINT "food_delivery_partners_zoneId_fkey"
  FOREIGN KEY ("zoneId") REFERENCES "food_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "food_delivery_partners_zoneId_idx" ON "food_delivery_partners"("zoneId");
