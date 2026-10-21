-- Restaurant highlight tags (Bestseller, Popular, ...), managed by the admin
-- instead of hard-coded in three places.
CREATE TABLE "food_highlight_badges" (
    "id" VARCHAR(24) NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
    "key" VARCHAR(20) NOT NULL,
    "label" VARCHAR(40) NOT NULL,
    "color" VARCHAR(16) NOT NULL DEFAULT '#E23744',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "food_highlight_badges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "food_highlight_badges_key_key" ON "food_highlight_badges"("key");

-- The two tags that existed before.
INSERT INTO "food_highlight_badges" ("key", "label", "color", "sortOrder") VALUES
    ('bestseller', 'Bestseller', '#E23744', 1),
    ('popular', 'Popular', '#F59E0B', 2);
