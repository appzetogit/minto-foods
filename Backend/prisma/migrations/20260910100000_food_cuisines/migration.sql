-- A vocabulary for cuisines.
--
-- FoodRestaurant.cuisines was free text, so the "options" were whatever anyone
-- had ever typed -- "North Indian", "north indian" and "North  Indian" all
-- existing side by side, none of them selectable as the same thing.
--
-- The String[] on the restaurant stays. It is denormalised deliberately: the
-- customer app filters and displays by name on nearly every screen, and a join
-- for a label that changes once a year is not worth paying for. This table is
-- the picker, not a foreign key.
CREATE TABLE "food_cuisines" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "image" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_cuisines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "food_cuisines_name_key" ON "food_cuisines" ("name");
CREATE UNIQUE INDEX "food_cuisines_slug_key" ON "food_cuisines" ("slug");
CREATE INDEX "food_cuisines_isActive_sortOrder_idx" ON "food_cuisines" ("isActive", "sortOrder");

-- Seed from what restaurants already use, so the picker opens with the real
-- vocabulary rather than empty. Collapsed on the slug: the first spelling of a
-- cuisine wins and the variants fold into it.
INSERT INTO "food_cuisines" ("name", "slug", "updatedAt")
SELECT DISTINCT ON (slug) name, slug, NOW()
FROM (
    SELECT
        btrim(c) AS name,
        regexp_replace(lower(btrim(c)), '\s+', ' ', 'g') AS slug
    FROM "food_restaurants" r, unnest(r."cuisines") AS c
    WHERE btrim(c) <> ''
) AS used
ORDER BY slug, name;
