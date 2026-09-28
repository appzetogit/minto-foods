-- One short video per dish, alongside its images.
ALTER TABLE "food_items" ADD COLUMN "videoUrl" TEXT NOT NULL DEFAULT '';
