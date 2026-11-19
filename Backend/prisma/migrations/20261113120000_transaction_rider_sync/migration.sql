-- The rider on an order's money split (food_transactions) was only written when
-- a rider accepted through the app, so orders delivered before that existed,
-- or assigned another way, had none: the balance sheet's rider section, which
-- groups by it, left those riders out of the week.

UPDATE "food_transactions" t
SET "deliveryPartnerId" = o."dispatchDeliveryPartnerId"
FROM "food_orders" o
WHERE o."id" = t."orderId"
  AND o."dispatchDeliveryPartnerId" IS NOT NULL
  AND t."deliveryPartnerId" IS DISTINCT FROM o."dispatchDeliveryPartnerId";

-- From now on it follows the order: whoever holds the order holds its split,
-- so the rider who finally delivers it is the one paid for it.
CREATE OR REPLACE FUNCTION food_order_sync_transaction_rider() RETURNS trigger AS $$
BEGIN
  IF NEW."dispatchDeliveryPartnerId" IS NOT NULL
     AND NEW."dispatchDeliveryPartnerId" IS DISTINCT FROM OLD."dispatchDeliveryPartnerId" THEN
    UPDATE "food_transactions"
    SET "deliveryPartnerId" = NEW."dispatchDeliveryPartnerId"
    WHERE "orderId" = NEW."id"
      AND "isRiderSettled" = false
      AND "deliveryPartnerId" IS DISTINCT FROM NEW."dispatchDeliveryPartnerId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER food_order_sync_transaction_rider
  AFTER UPDATE OF "dispatchDeliveryPartnerId" ON "food_orders"
  FOR EACH ROW EXECUTE FUNCTION food_order_sync_transaction_rider();
