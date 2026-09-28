-- Which distance the delivery fee is charged on, per zone (null = inherit).
ALTER TABLE "food_fee_settings"
    ADD COLUMN "deliveryDistanceMode" VARCHAR(16),
    ADD COLUMN "roadDistanceCapFactor" DECIMAL(4,2);
