-- A banner can be aimed at one zone. Null keeps it in every zone, which is
-- what every existing banner means.
ALTER TABLE "food_offer_banners" ADD COLUMN "zoneId" VARCHAR(24);

CREATE INDEX "food_offer_banners_zoneId_idx" ON "food_offer_banners"("zoneId");

ALTER TABLE "food_offer_banners"
    ADD CONSTRAINT "food_offer_banners_zoneId_fkey"
    FOREIGN KEY ("zoneId") REFERENCES "food_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
