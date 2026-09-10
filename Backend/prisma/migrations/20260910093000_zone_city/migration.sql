-- The city a zone serves.
--
-- serviceLocation looks like it already does this and cannot: it is free text
-- typed for display, so "Indore", "indore " and "Indore MP" are three different
-- cities to a GROUP BY. Left alone -- it is what the admin screens show.
--
-- Nullable and unbackfilled on purpose. Guessing a city from a polygon without
-- a geocoder would put wrong ones in, and a zone with no city set simply does
-- not appear under a city filter, which is honest.
ALTER TABLE "food_zones" ADD COLUMN "city" TEXT;

CREATE INDEX "food_zones_city_name_idx" ON "food_zones" ("city", "name");
