-- Stop all ordering for a while (a city outage, a strike, bad weather), for
-- every zone or chosen ones, with a message customers see and an optional
-- time it lifts by itself.
ALTER TABLE "food_business_settings" ADD COLUMN "ordersPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "food_business_settings" ADD COLUMN "ordersPausedZoneIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "food_business_settings" ADD COLUMN "ordersPausedMessage" VARCHAR(300) NOT NULL DEFAULT '';
ALTER TABLE "food_business_settings" ADD COLUMN "ordersPausedUntil" TIMESTAMP(3);
