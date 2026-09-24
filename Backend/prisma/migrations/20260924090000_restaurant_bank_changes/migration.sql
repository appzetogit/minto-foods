-- Bank and UPI changes requested by a restaurant, held until an admin approves.
CREATE TABLE "food_restaurant_bank_changes" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "accountHolderName" TEXT,
    "accountNumber" TEXT,
    "ifscCode" TEXT,
    "accountType" TEXT,
    "upiId" TEXT,
    "upiQrImage" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "rejectionReason" TEXT NOT NULL DEFAULT '',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" VARCHAR(24),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_restaurant_bank_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_restaurant_bank_changes_status_requestedAt_idx" ON "food_restaurant_bank_changes"("status", "requestedAt" DESC);
CREATE INDEX "food_restaurant_bank_changes_restaurantId_status_idx" ON "food_restaurant_bank_changes"("restaurantId", "status");
ALTER TABLE "food_restaurant_bank_changes" ADD CONSTRAINT "food_restaurant_bank_changes_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
