-- Pay part of an order from the wallet and the rest online, and refund each
-- part back to where it came from.

ALTER TABLE "food_orders"
    ADD COLUMN "walletAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN "onlineAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Existing orders were paid one way only.
UPDATE "food_orders" SET "walletAmount" = "total" WHERE "paymentMethod" = 'wallet';
UPDATE "food_orders" SET "onlineAmount" = "total" WHERE "paymentMethod" = 'razorpay';

CREATE TYPE "RefundSource" AS ENUM ('wallet', 'online');

CREATE TABLE "food_order_refunds" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "orderId" VARCHAR(24) NOT NULL,
    "userId" VARCHAR(24) NOT NULL,
    "source" "RefundSource" NOT NULL,
    "refundTo" "RefundTo" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'pending',
    "gatewayPaymentId" VARCHAR(64),
    "gatewayRefundId" VARCHAR(64),
    "failureReason" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "initiatedBy" VARCHAR(16) NOT NULL DEFAULT 'system',
    "initiatedById" VARCHAR(24),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_order_refunds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_order_refunds_gatewayRefundId_key" ON "food_order_refunds"("gatewayRefundId");
CREATE INDEX "food_order_refunds_orderId_status_idx" ON "food_order_refunds"("orderId", "status");
CREATE INDEX "food_order_refunds_status_createdAt_idx" ON "food_order_refunds"("status", "createdAt");
ALTER TABLE "food_order_refunds" ADD CONSTRAINT "food_order_refunds_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "food_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Refunds made before this table existed, so what is left to refund on those
-- orders is still right. One row each, against the method the order was paid by.
INSERT INTO "food_order_refunds"
    ("orderId", "userId", "source", "refundTo", "amount", "status", "gatewayRefundId",
     "reason", "initiatedBy", "processedAt", "createdAt", "updatedAt")
SELECT o."id", o."userId",
       (CASE WHEN o."paymentMethod" = 'wallet' THEN 'wallet' ELSE 'online' END)::"RefundSource",
       (CASE WHEN o."paymentMethod" = 'wallet' THEN 'wallet' ELSE 'gateway' END)::"RefundTo",
       LEAST(o."refundAmount", o."total"),
       (CASE WHEN o."refundStatus" = 'processed' THEN 'processed' ELSE 'pending' END)::"RefundStatus",
       NULLIF(o."refundId", ''),
       'Recorded before split refunds', 'system',
       o."refundProcessedAt", COALESCE(o."refundProcessedAt", o."updatedAt"), now()
  FROM "food_orders" o
 WHERE o."refundAmount" > 0
   AND o."refundStatus" IN ('processed', 'pending')
   AND o."paymentMethod" IN ('wallet', 'razorpay');
