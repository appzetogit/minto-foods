-- Per-km rate on a delivery fee band, so a fare can be exact for fractional
-- distances instead of being rounded up to the next whole-km band.
-- Default 0 leaves every existing band a flat fee.
ALTER TABLE "delivery_fee_bands" ADD COLUMN "feePerKm" DECIMAL(14,2) NOT NULL DEFAULT 0;
