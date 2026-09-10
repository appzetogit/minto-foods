-- Owner Aadhaar for a restaurant.
--
-- PAN, GST and FSSAI were all collected and Aadhaar was not, so onboarding
-- could not complete the identity set the other partner types already provide.
ALTER TABLE "food_restaurants"
  ADD COLUMN "aadhaarNumber" TEXT,
  ADD COLUMN "aadhaarImage" TEXT;
