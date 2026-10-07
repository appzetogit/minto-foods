-- Admin price rules: app price = restaurant price adjusted by a percentage.
CREATE TYPE "PriceRuleScope" AS ENUM ('all', 'zone', 'restaurant', 'category', 'item');
CREATE TYPE "PriceRounding" AS ENUM ('none', 'nearest_1', 'end_9');

CREATE TABLE "food_price_rules" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "name" VARCHAR(120) NOT NULL,
    "scope" "PriceRuleScope" NOT NULL,
    "zoneId" VARCHAR(24),
    "restaurantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "itemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "percent" DECIMAL(6,2) NOT NULL,
    "rounding" "PriceRounding" NOT NULL DEFAULT 'nearest_1',
    "applyToAddons" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdById" VARCHAR(24),
    "updatedById" VARCHAR(24),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_price_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_price_rules_isActive_deletedAt_idx" ON "food_price_rules"("isActive", "deletedAt");
CREATE INDEX "food_price_rules_zoneId_idx" ON "food_price_rules"("zoneId");

CREATE TABLE "food_price_rule_logs" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "ruleId" VARCHAR(24) NOT NULL,
    "action" VARCHAR(24) NOT NULL,
    "adminId" VARCHAR(24),
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "food_price_rule_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_price_rule_logs_ruleId_createdAt_idx" ON "food_price_rule_logs"("ruleId", "createdAt" DESC);
ALTER TABLE "food_price_rule_logs" ADD CONSTRAINT "food_price_rule_logs_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "food_price_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Minto's share of the gap between customer price and restaurant price.
ALTER TABLE "food_transactions" ADD COLUMN "priceMarkupAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "food_orders" ADD COLUMN "priceMarkupAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Each order line keeps the restaurant's own price beside what the customer paid.
ALTER TABLE "food_order_items"
    ADD COLUMN "basePrice" DECIMAL(14,2),
    ADD COLUMN "baseVariantPrice" DECIMAL(14,2),
    ADD COLUMN "markupPercent" DECIMAL(6,2) NOT NULL DEFAULT 0,
    ADD COLUMN "priceRuleId" VARCHAR(24);
