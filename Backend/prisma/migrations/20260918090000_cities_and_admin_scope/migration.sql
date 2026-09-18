-- Cities, the zones under them, and the cities each sub-admin looks after.

CREATE TABLE "food_cities" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "state" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_cities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_cities_nameKey_key" ON "food_cities"("nameKey");

CREATE TABLE "food_admin_cities" (
    "adminId" VARCHAR(24) NOT NULL,
    "cityId" VARCHAR(24) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "food_admin_cities_pkey" PRIMARY KEY ("adminId","cityId")
);
CREATE INDEX "food_admin_cities_cityId_idx" ON "food_admin_cities"("cityId");
ALTER TABLE "food_admin_cities" ADD CONSTRAINT "food_admin_cities_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "food_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "food_admin_cities" ADD CONSTRAINT "food_admin_cities_cityId_fkey"
    FOREIGN KEY ("cityId") REFERENCES "food_cities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "food_zones" ADD COLUMN "cityId" VARCHAR(24);
CREATE INDEX "food_zones_cityId_idx" ON "food_zones"("cityId");
ALTER TABLE "food_zones" ADD CONSTRAINT "food_zones_cityId_fkey"
    FOREIGN KEY ("cityId") REFERENCES "food_cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one city per distinct typed city name, matched case- and
-- space-insensitively, then point each zone at its city.
INSERT INTO "food_cities" ("name", "nameKey", "updatedAt")
-- A name typed all in lowercase ("bhiwandi") is capitalised; anything else is
-- kept as the admin wrote it.
SELECT CASE WHEN MIN(btrim(regexp_replace("city", '\s+', ' ', 'g'))) = lower(MIN(btrim(regexp_replace("city", '\s+', ' ', 'g'))))
            THEN initcap(MIN(btrim(regexp_replace("city", '\s+', ' ', 'g'))))
            ELSE MIN(btrim(regexp_replace("city", '\s+', ' ', 'g'))) END,
       lower(btrim(regexp_replace("city", '\s+', ' ', 'g'))),
       CURRENT_TIMESTAMP
FROM "food_zones"
WHERE btrim(coalesce("city", '')) <> ''
GROUP BY lower(btrim(regexp_replace("city", '\s+', ' ', 'g')));

UPDATE "food_zones" z SET "cityId" = c."id", "city" = c."name"
FROM "food_cities" c
WHERE c."nameKey" = lower(btrim(regexp_replace(z."city", '\s+', ' ', 'g')));
