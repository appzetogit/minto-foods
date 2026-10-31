-- Orders placed at a restaurant with no zone set got no zone, and an order
-- with no zone is hidden from every city view in the admin panel (Pending
-- included). Give each the zone its restaurant stands in, else the zone of
-- the delivery address; smallest zone wins where zones overlap.
UPDATE "food_orders" o
SET "zoneId" = z."id"
FROM "food_restaurants" r, LATERAL (
  SELECT zz."id" FROM "food_zones" zz
  WHERE zz."isActive" = true AND zz."boundary" IS NOT NULL
    AND r."latitude" IS NOT NULL AND r."longitude" IS NOT NULL
    AND ST_Contains(zz."boundary"::geometry, ST_SetSRID(ST_MakePoint(r."longitude"::float8, r."latitude"::float8), 4326))
  ORDER BY ST_Area(zz."boundary"::geometry) ASC
  LIMIT 1
) z
WHERE o."zoneId" IS NULL AND r."id" = o."restaurantId";

UPDATE "food_orders" o
SET "zoneId" = (
  SELECT zz."id" FROM "food_zones" zz
  WHERE zz."isActive" = true AND zz."boundary" IS NOT NULL
    AND ST_Contains(zz."boundary"::geometry, ST_SetSRID(ST_MakePoint(o."addrLng"::float8, o."addrLat"::float8), 4326))
  ORDER BY ST_Area(zz."boundary"::geometry) ASC
  LIMIT 1
)
WHERE o."zoneId" IS NULL AND o."addrLat" IS NOT NULL AND o."addrLng" IS NOT NULL;
