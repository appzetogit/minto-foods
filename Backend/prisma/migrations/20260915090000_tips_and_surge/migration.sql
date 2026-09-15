-- The tip a customer left, kept beside the fees on the order it belongs to.
-- Defaults to 0, so every existing order reads as "no tip" rather than null.
ALTER TABLE "food_orders" ADD COLUMN "tipAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Tip options, admin-managed. The app offers these amounts and no others.
ALTER TABLE "food_business_settings" ADD COLUMN "tipsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "food_business_settings" ADD COLUMN "tipPresets" INTEGER[] NOT NULL DEFAULT ARRAY[10, 20, 30];
ALTER TABLE "food_business_settings" ADD COLUMN "tipMaxAmount" DECIMAL(14,2);

-- Surge: a flat amount on the delivery fee, immediately or on a schedule.
CREATE TABLE "food_surge_rules" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "label" TEXT NOT NULL DEFAULT '',
    "surgeFee" DECIMAL(14,2) NOT NULL,
    "zoneId" VARCHAR(24),
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_surge_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "food_surge_rules_isActive_startAt_endAt_idx" ON "food_surge_rules"("isActive", "startAt", "endAt");
CREATE INDEX "food_surge_rules_zoneId_idx" ON "food_surge_rules"("zoneId");

-- Deleting a zone widens its rule to every zone rather than dropping it.
ALTER TABLE "food_surge_rules"
    ADD CONSTRAINT "food_surge_rules_zoneId_fkey"
    FOREIGN KEY ("zoneId") REFERENCES "food_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A surge that takes money off is a discount nobody asked for.
ALTER TABLE "food_surge_rules" ADD CONSTRAINT "food_surge_rule_fee_positive" CHECK ("surgeFee" > 0);

-- A window has to run forwards.
ALTER TABLE "food_surge_rules" ADD CONSTRAINT "food_surge_rule_window_valid"
    CHECK ("startAt" IS NULL OR "endAt" IS NULL OR "endAt" > "startAt");

-- A tip cannot be negative.
ALTER TABLE "food_orders" ADD CONSTRAINT "food_order_tip_non_negative" CHECK ("tipAmount" >= 0);
