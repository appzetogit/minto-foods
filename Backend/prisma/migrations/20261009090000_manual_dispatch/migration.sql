-- Manual rider assignment: global default + per-zone override, and the queue.
ALTER TABLE "food_settings"
    ADD COLUMN "manualAcceptWindowSeconds" INTEGER NOT NULL DEFAULT 120,
    ADD COLUMN "manualQueueAlertMinutes" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "food_zones" ADD COLUMN "dispatchMode" VARCHAR(8);
ALTER TABLE "food_orders" ADD COLUMN "awaitingManualAt" TIMESTAMP(3);
ALTER TYPE "DispatchOfferAction" ADD VALUE IF NOT EXISTS 'withdrawn';
