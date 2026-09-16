-- When a coupon works (days of the week and a daily window, India time) and
-- whether it is only for customers new to the restaurant. All default to the
-- old behaviour: every day, all day, everyone.
ALTER TABLE "food_offers" ADD COLUMN "activeDays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "food_offers" ADD COLUMN "activeFromTime" VARCHAR(5);
ALTER TABLE "food_offers" ADD COLUMN "activeToTime" VARCHAR(5);
ALTER TABLE "food_offers" ADD COLUMN "newToRestaurantOnly" BOOLEAN NOT NULL DEFAULT false;
