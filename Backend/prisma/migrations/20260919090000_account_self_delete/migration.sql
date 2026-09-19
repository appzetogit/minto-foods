-- Soft delete for accounts removed by their owner from the app.
ALTER TABLE "food_users" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "deletedPhone" VARCHAR(20);
ALTER TABLE "food_restaurants" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "deletedPhone" VARCHAR(20);
ALTER TABLE "food_delivery_partners" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "deletedPhone" VARCHAR(20);
