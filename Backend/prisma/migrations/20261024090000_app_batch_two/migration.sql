-- Fields the customer, rider and restaurant apps now send or read.

-- "Save as": an address the customer named ("Mom's house"), label stays Other.
ALTER TABLE "food_user_addresses" ADD COLUMN "customLabel" VARCHAR(40);

-- Admin-set limits. Null COD limit means the ₹2000 default; 0 means no limit.
ALTER TABLE "food_fee_settings" ADD COLUMN "codMaxOrderValue" DECIMAL(14,2);
ALTER TABLE "food_fee_settings" ADD COLUMN "maxItemQuantity" INTEGER NOT NULL DEFAULT 50;

-- Home promotion banners show on the home screen or the order tracking page.
ALTER TABLE "food_home_promotion_banners" ADD COLUMN "placement" VARCHAR(20) NOT NULL DEFAULT 'home';
CREATE INDEX "food_home_promotion_banners_placement_idx" ON "food_home_promotion_banners"("placement");

-- Hero banners were the one banner kind with no zone. Null = every zone.
ALTER TABLE "food_hero_banners" ADD COLUMN "zoneId" VARCHAR(24);
CREATE INDEX "food_hero_banners_zoneId_idx" ON "food_hero_banners"("zoneId");

-- A broadcast can carry a picture.
ALTER TABLE "food_notification_broadcasts" ADD COLUMN "imageUrl" TEXT NOT NULL DEFAULT '';

-- Coupon category for the app's "Top Coupon Categories" chips.
ALTER TABLE "food_offers" ADD COLUMN "category" VARCHAR(30);

-- When the rider's position on the order was last written, and the live ETA.
ALTER TABLE "food_orders" ADD COLUMN "riderLocationAt" TIMESTAMP(3);
ALTER TABLE "food_orders" ADD COLUMN "etaMinutes" INTEGER;
ALTER TABLE "food_orders" ADD COLUMN "estimatedDeliveryAt" TIMESTAMP(3);
ALTER TABLE "food_orders" ADD COLUMN "etaComputedAt" TIMESTAMP(3);

-- Old slugs keep working after a rename: the trigger records the slug a name
-- change replaces.
CREATE TABLE "food_restaurant_slug_history" (
    "slug" TEXT NOT NULL,
    "restaurantId" VARCHAR(24) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "food_restaurant_slug_history_pkey" PRIMARY KEY ("slug"),
    CONSTRAINT "food_restaurant_slug_history_restaurantId_fkey" FOREIGN KEY ("restaurantId")
        REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "food_restaurant_slug_history_restaurantId_idx" ON "food_restaurant_slug_history"("restaurantId");

CREATE OR REPLACE FUNCTION sync_restaurant_name_slug() RETURNS trigger AS $$
BEGIN
  NEW."nameSlug" := restaurant_name_slug(NEW."restaurantName");
  -- A rename keeps the old slug resolving to this restaurant. The newest owner
  -- of a slug wins it; a restaurant taking back its own old slug drops the row.
  IF TG_OP = 'UPDATE' AND OLD."nameSlug" IS NOT NULL AND OLD."nameSlug" IS DISTINCT FROM NEW."nameSlug" THEN
    INSERT INTO "food_restaurant_slug_history" ("slug", "restaurantId")
    VALUES (OLD."nameSlug", NEW."id")
    ON CONFLICT ("slug") DO UPDATE SET "restaurantId" = EXCLUDED."restaurantId", "createdAt" = CURRENT_TIMESTAMP;
  END IF;
  IF NEW."nameSlug" IS NOT NULL THEN
    DELETE FROM "food_restaurant_slug_history" WHERE "slug" = NEW."nameSlug" AND "restaurantId" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
