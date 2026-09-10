-- Money that did not come from an order.
--
-- The balance sheet is derived entirely from the order ledger, so rent, a
-- fine, a marketing spend or a one-off recovery had nowhere to go and the
-- sheet never reconciled against the bank.
--
-- These are reported beside the derived figures rather than folded into them.
-- A "restaurant owes" number that silently includes a hand-typed expense is a
-- number nobody can trace back to orders, and therefore nobody trusts.
CREATE TYPE "LedgerEntryType" AS ENUM ('income', 'expense');

CREATE TABLE "food_ledger_entries" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "type" "LedgerEntryType" NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    -- When the money moved, which is not when someone typed it in.
    "occurredAt" TIMESTAMP(3) NOT NULL,
    -- A plain column, not a relation: a deleted admin must not take the ledger
    -- row with them.
    "createdByAdminId" VARCHAR(24),
    -- The stored path. Urls are signed per response and expire.
    "attachmentPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "food_ledger_entries_occurredAt_idx"
  ON "food_ledger_entries" ("occurredAt" DESC);
CREATE INDEX "food_ledger_entries_type_occurredAt_idx"
  ON "food_ledger_entries" ("type", "occurredAt" DESC);
