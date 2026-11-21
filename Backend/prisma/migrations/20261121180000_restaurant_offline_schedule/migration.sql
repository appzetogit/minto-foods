-- Restaurant app: go offline with a reason, for a while, or on a schedule.
ALTER TABLE "food_restaurants" ADD COLUMN "offlineReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "food_restaurants" ADD COLUMN "offlineFrom" TIMESTAMP(3);
ALTER TABLE "food_restaurants" ADD COLUMN "offlineUntil" TIMESTAMP(3);
