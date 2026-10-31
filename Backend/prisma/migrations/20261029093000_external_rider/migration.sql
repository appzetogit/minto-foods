-- A rider from outside (Rapido, Shadowfax, a temporary hand) assigned by an
-- admin in an emergency: not a Minto rider account, so the name and phone are
-- kept on the order and shown to the customer like any rider's.
ALTER TABLE "food_orders" ADD COLUMN "externalRiderProvider" VARCHAR(40);
ALTER TABLE "food_orders" ADD COLUMN "externalRiderName" VARCHAR(80);
ALTER TABLE "food_orders" ADD COLUMN "externalRiderPhone" VARCHAR(20);
