-- What a rider is paid for an order that was cancelled while they were on it.
-- NULL on orders that were not cancelled with a rider (and on cancellations
-- from before this rule), which pays nothing.
ALTER TABLE "food_orders" ADD COLUMN "riderCancelPay" DECIMAL(14,2);
ALTER TABLE "food_orders" ADD COLUMN "riderCancelPayReason" TEXT;

-- Paid when the rider had reached the restaurant and the order was cancelled
-- before pickup. Borne by the platform.
ALTER TABLE "food_settings" ADD COLUMN "riderPayCancelAtRestaurant" DECIMAL(14,2) NOT NULL DEFAULT 10;

-- Set on every path that cancels an order (customer, restaurant, admin, the
-- expiry sweep), so none of them can forget it:
--   not yet at the restaurant  -> 0
--   at the restaurant          -> the admin's amount (food_settings 'dispatch')
--   after pickup               -> the full trip pay; an admin sets it to 0 when
--                                 the rider was at fault
CREATE OR REPLACE FUNCTION food_order_rider_cancel_pay() RETURNS trigger AS $$
DECLARE
  at_restaurant DECIMAL(14,2);
BEGIN
  IF NEW."orderStatus"::text LIKE 'cancelled%'
     AND OLD."orderStatus"::text NOT LIKE 'cancelled%'
     AND NEW."dispatchDeliveryPartnerId" IS NOT NULL
     AND NEW."riderCancelPay" IS NULL THEN
    IF NEW."pickedUpAt" IS NOT NULL THEN
      NEW."riderCancelPay" := COALESCE(NEW."riderEarning", 0);
      NEW."riderCancelPayReason" := 'Cancelled after pickup: full trip pay';
    ELSIF NEW."reachedPickupAt" IS NOT NULL THEN
      SELECT "riderPayCancelAtRestaurant" INTO at_restaurant FROM "food_settings" WHERE "key" = 'dispatch';
      NEW."riderCancelPay" := COALESCE(at_restaurant, 10);
      NEW."riderCancelPayReason" := 'Cancelled after the rider reached the restaurant';
    ELSE
      NEW."riderCancelPay" := 0;
      NEW."riderCancelPayReason" := 'Cancelled before the rider reached the restaurant';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER food_order_rider_cancel_pay
  BEFORE UPDATE OF "orderStatus" ON "food_orders"
  FOR EACH ROW EXECUTE FUNCTION food_order_rider_cancel_pay();
