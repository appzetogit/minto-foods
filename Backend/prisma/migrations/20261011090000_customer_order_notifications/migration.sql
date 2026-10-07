-- Customer order pushes: each one sent once per order.
CREATE TABLE "food_order_notifications" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "orderId" VARCHAR(24) NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "event" VARCHAR(32) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "food_order_notifications_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_order_notifications_orderId_key_key" ON "food_order_notifications"("orderId", "key");
