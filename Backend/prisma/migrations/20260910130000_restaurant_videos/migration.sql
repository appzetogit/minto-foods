-- Storefront videos for a restaurant.
--
-- Photos already had coverImages, galleryImages and banners. Video had nowhere
-- to go at all, and the storage layer accepted images only.
--
-- Json[] rather than String[]: a video needs its mime type and a poster frame
-- stored beside it, and a player given neither renders a black box until
-- someone presses play. Paths, never urls -- urls are signed per response and
-- expire within the hour.
ALTER TABLE "food_restaurants"
  ADD COLUMN "videos" JSONB[] NOT NULL DEFAULT ARRAY[]::JSONB[];
