-- "Order for someone else": the account holder orders and pays, the food goes
-- to (and the rider calls) the recipient.
ALTER TABLE "food_orders"
    ADD COLUMN "isForSomeoneElse" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "recipientName" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "recipientPhone" TEXT NOT NULL DEFAULT '';
