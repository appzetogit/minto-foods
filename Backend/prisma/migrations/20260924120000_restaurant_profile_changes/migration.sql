-- Edits to a live restaurant held for review instead of taking it offline.
CREATE TABLE "food_restaurant_profile_changes" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "restaurantId" VARCHAR(24) NOT NULL,
    "changes" JSONB NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "rejectionReason" TEXT NOT NULL DEFAULT '',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" VARCHAR(24),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "food_restaurant_profile_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "food_restaurant_profile_changes_status_requestedAt_idx" ON "food_restaurant_profile_changes"("status", "requestedAt" DESC);
CREATE INDEX "food_restaurant_profile_changes_restaurantId_status_idx" ON "food_restaurant_profile_changes"("restaurantId", "status");
ALTER TABLE "food_restaurant_profile_changes" ADD CONSTRAINT "food_restaurant_profile_changes_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "food_restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
