-- Customer's own name for a saved address.
ALTER TABLE "food_user_addresses" ADD COLUMN IF NOT EXISTS "customLabel" VARCHAR(40) NOT NULL DEFAULT '';

-- Admin-set Cash on Delivery cut-off and per-dish quantity cap.
ALTER TABLE "food_fee_settings" ADD COLUMN IF NOT EXISTS "codMaxOrderValue" DECIMAL(14,2);
ALTER TABLE "food_fee_settings" ADD COLUMN IF NOT EXISTS "maxItemQuantity" INTEGER NOT NULL DEFAULT 50;

-- Picture on a notification broadcast.
ALTER TABLE "food_notification_broadcasts" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT NOT NULL DEFAULT '';

-- Promotion banners on the order tracking page as well as Home.
ALTER TABLE "food_home_promotion_banners" ADD COLUMN IF NOT EXISTS "placement" VARCHAR(20) NOT NULL DEFAULT 'home';
CREATE INDEX IF NOT EXISTS "food_home_promotion_banners_placement_idx" ON "food_home_promotion_banners"("placement");
