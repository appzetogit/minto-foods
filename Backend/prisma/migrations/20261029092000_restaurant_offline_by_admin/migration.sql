-- An admin taking a restaurant offline (its app not working, a complaint)
-- holds until an admin puts it back: the restaurant app can no longer switch
-- itself straight back on.
ALTER TABLE "food_restaurants" ADD COLUMN "offlineByAdmin" BOOLEAN NOT NULL DEFAULT false;
