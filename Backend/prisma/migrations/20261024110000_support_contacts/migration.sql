ALTER TABLE "food_business_settings" ADD COLUMN IF NOT EXISTS "supportPhones" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "food_business_settings" ADD COLUMN IF NOT EXISTS "whatsappNumber" VARCHAR(20) NOT NULL DEFAULT '';
