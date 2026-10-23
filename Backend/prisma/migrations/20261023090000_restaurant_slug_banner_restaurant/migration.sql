-- Restaurant links by slug, and banners that link by restaurant id.
--
-- Promotion banners stored their restaurant as a name slug
-- (/food/user/restaurants/zinger-madness-crunchy-burgers-and-more), and the
-- lookup matched it against restaurantNameNormalized -- which only turns
-- hyphens into spaces, and is empty on restaurants an admin created. So any
-- name with punctuation, and every admin-created restaurant, opened
-- "Restaurant not found". Renaming a restaurant broke its banners outright.

-- ─── restaurant name slug ───────────────────────────────────────────────────
-- Lowercase, every run of non-alphanumerics becomes one hyphen, hyphens trimmed
-- from the ends. slugifyRestaurantName() in restaurantSlug.js is the same rule.
CREATE OR REPLACE FUNCTION restaurant_name_slug(name text) RETURNS text AS $$
  SELECT NULLIF(btrim(regexp_replace(lower(coalesce(name, '')), '[^a-z0-9]+', '-', 'g'), '-'), '')
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE "food_restaurants" ADD COLUMN "nameSlug" TEXT;

-- Kept in step with the name by the database, so no write path can forget it.
CREATE OR REPLACE FUNCTION sync_restaurant_name_slug() RETURNS trigger AS $$
BEGIN
  NEW."nameSlug" := restaurant_name_slug(NEW."restaurantName");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS restaurant_name_slug_sync ON "food_restaurants";
CREATE TRIGGER restaurant_name_slug_sync
  BEFORE INSERT OR UPDATE OF "restaurantName", "nameSlug" ON "food_restaurants"
  FOR EACH ROW EXECUTE FUNCTION sync_restaurant_name_slug();

UPDATE "food_restaurants" SET "nameSlug" = restaurant_name_slug("restaurantName");

CREATE INDEX "food_restaurants_nameSlug_idx" ON "food_restaurants"("nameSlug");

-- ─── banners link by restaurant id ──────────────────────────────────────────
ALTER TABLE "food_home_promotion_banners" ADD COLUMN "restaurantId" VARCHAR(24);
ALTER TABLE "food_offer_banners" ADD COLUMN "restaurantId" VARCHAR(24);

-- Existing restaurant links: resolve the id or slug after /restaurants/ and
-- rewrite the link to the id. An approved restaurant wins a shared slug.
-- Links that match nothing are left as they are; the admin banner list flags
-- them.
CREATE OR REPLACE FUNCTION banner_link_restaurant_id(link text) RETURNS varchar AS $$
  SELECT fr.id FROM "food_restaurants" fr
  WHERE fr.id = substring(link from '/restaurants/([^/?#]+)')
     OR fr."nameSlug" = restaurant_name_slug(substring(link from '/restaurants/([^/?#]+)'))
  ORDER BY (fr.status = 'approved') DESC, fr."createdAt" ASC
  LIMIT 1
$$ LANGUAGE sql STABLE;

UPDATE "food_home_promotion_banners"
SET "restaurantId" = banner_link_restaurant_id("ctaLink")
WHERE "restaurantId" IS NULL AND "ctaLink" ~ '/restaurants/[^/?#]+';

UPDATE "food_offer_banners"
SET "restaurantId" = banner_link_restaurant_id("ctaLink")
WHERE "restaurantId" IS NULL AND "ctaLink" ~ '/restaurants/[^/?#]+';

UPDATE "food_home_promotion_banners"
SET "ctaLink" = '/food/user/restaurants/' || "restaurantId"
WHERE "restaurantId" IS NOT NULL;

UPDATE "food_offer_banners"
SET "ctaLink" = '/food/user/restaurants/' || "restaurantId"
WHERE "restaurantId" IS NOT NULL;

-- Only needed for the backfill above.
DROP FUNCTION banner_link_restaurant_id(text);
