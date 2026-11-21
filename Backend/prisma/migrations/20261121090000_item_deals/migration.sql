ALTER TABLE "food_items" ADD COLUMN "couponEligible" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "food_item_deals" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "title" VARCHAR(80) NOT NULL DEFAULT '',
    "itemIds" TEXT[],
    "discountType" "DiscountType",
    "discountValue" DECIMAL(14,2),
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "status" "OfferStatus" NOT NULL DEFAULT 'active',
    "createdByRole" "CreatorRole" NOT NULL DEFAULT 'RESTAURANT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_item_deals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "food_item_deals_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "food_item_deals_restaurantId_status_idx" ON "food_item_deals"("restaurantId", "status");
