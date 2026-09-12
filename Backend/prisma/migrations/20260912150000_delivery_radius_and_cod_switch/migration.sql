-- Platform COD switch, moved out of the environment so it can be changed
-- without a deploy. Defaults to on, which is how COD_ENABLED shipped.
ALTER TABLE "food_business_settings" ADD COLUMN "codEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Delivery radius: a platform default and a per-restaurant override.
-- Both null, so nothing is limited until someone sets a value.
ALTER TABLE "food_business_settings" ADD COLUMN "discoveryRadiusKm" DECIMAL(6,2);
ALTER TABLE "food_restaurants" ADD COLUMN "deliveryRadiusKm" DECIMAL(6,2);
