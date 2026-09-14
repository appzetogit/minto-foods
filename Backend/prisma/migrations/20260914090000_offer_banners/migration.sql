-- Offer banners: their own screen under Promotions, separate from the home
-- promotion strip so editing one cannot move the other.
CREATE TABLE "food_offer_banners" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "imageUrl" TEXT NOT NULL,
    "publicId" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "ctaLink" TEXT NOT NULL DEFAULT '',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_offer_banners_pkey" PRIMARY KEY ("id")
);

-- The app asks for active banners in display order; the admin list asks for
-- all of them in the same order.
CREATE INDEX "food_offer_banners_isActive_sortOrder_idx" ON "food_offer_banners"("isActive", "sortOrder");
