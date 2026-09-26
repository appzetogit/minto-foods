-- Days of warning before a banner or admin coupon ends (admin bell).
ALTER TABLE "food_business_settings" ADD COLUMN "expiryAlertDays" INTEGER NOT NULL DEFAULT 3;
