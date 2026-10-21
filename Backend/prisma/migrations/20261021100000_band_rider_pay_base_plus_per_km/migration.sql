-- Rider pay per band is now base pay plus per-km for the km past the band
-- start (the same shape as the customer fee), so a band may set both.
ALTER TABLE "delivery_fee_bands" DROP CONSTRAINT IF EXISTS "delivery_fee_band_pay_exclusive";
