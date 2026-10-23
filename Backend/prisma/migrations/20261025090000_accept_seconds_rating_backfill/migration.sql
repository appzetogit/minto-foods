-- The restaurant's new-order accept time, in seconds (30-600), set in the
-- admin panel. Starts from the minutes setting it replaces.
ALTER TABLE "food_business_settings" ADD COLUMN "orderAcceptanceTimeSeconds" INTEGER;
UPDATE "food_business_settings"
SET "orderAcceptanceTimeSeconds" = LEAST(600, GREATEST(30, "orderAcceptanceTimeMinutes" * 60));

-- Ratings from the orders, once. They were kept as a running average rounded
-- at every step, which drifted (a rider at 4.89 showed 4.8), and some rows
-- carried ratings no order backs. From here on each rating recomputes these
-- from the orders (rating.service.js).
UPDATE "food_restaurants" r
SET "rating" = COALESCE(s.avg, 0), "totalRatings" = COALESCE(s.cnt, 0)
FROM (
  SELECT fr.id,
         ROUND(AVG(o."restaurantRating")::numeric, 1) AS avg,
         COUNT(o."restaurantRating") AS cnt
  FROM "food_restaurants" fr
  LEFT JOIN "food_orders" o ON o."restaurantId" = fr.id AND o."restaurantRating" IS NOT NULL
  GROUP BY fr.id
) s
WHERE s.id = r.id;

UPDATE "food_delivery_partners" p
SET "rating" = COALESCE(s.avg, 0), "totalRatings" = COALESCE(s.cnt, 0)
FROM (
  SELECT dp.id,
         ROUND(AVG(o."partnerRating")::numeric, 1) AS avg,
         COUNT(o."partnerRating") AS cnt
  FROM "food_delivery_partners" dp
  LEFT JOIN "food_orders" o ON o."dispatchDeliveryPartnerId" = dp.id AND o."partnerRating" IS NOT NULL
  GROUP BY dp.id
) s
WHERE s.id = p.id;
