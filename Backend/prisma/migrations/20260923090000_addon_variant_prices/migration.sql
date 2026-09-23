-- An add-on can cost a different amount on each variant of a dish.
CREATE TABLE "food_addon_variant_prices" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "addonId" VARCHAR(24) NOT NULL,
    "variantId" VARCHAR(24) NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_addon_variant_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_addon_variant_prices_addonId_variantId_key" ON "food_addon_variant_prices"("addonId", "variantId");
CREATE INDEX "food_addon_variant_prices_variantId_idx" ON "food_addon_variant_prices"("variantId");
ALTER TABLE "food_addon_variant_prices" ADD CONSTRAINT "food_addon_variant_prices_addonId_fkey"
    FOREIGN KEY ("addonId") REFERENCES "food_addons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "food_addon_variant_prices" ADD CONSTRAINT "food_addon_variant_prices_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "food_item_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
