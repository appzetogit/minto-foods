/**
 * FoodType's Prisma name for 'Non-Veg' is NonVeg — the hyphen is a `@map`, so
 * the value on the wire and the value in the client differ and have to be
 * translated in both directions. Getting this wrong does not throw; it silently
 * marks a dish as the wrong diet, which is why it lives in one place.
 */

/**
 * Whether a food type value means vegetarian. Case and spacing are ignored:
 * an exact 'Veg' match turned 'veg' (the bulk-upload template's own sample),
 * 'VEG' or 'Pure Veg' into Non-Veg without a word.
 */
export const isVegFoodType = (value) => /^(pure\s*)?veg(etarian)?$/i.test(String(value || '').trim());

/** Client value → Prisma enum member. */
export const toFoodTypeColumn = (value) => (isVegFoodType(value) ? 'Veg' : 'NonVeg');

/**
 * Prisma enum member (or a client value) → the hyphenated form the apps read.
 * 'Egg' and anything unrecognised have always counted as non-veg.
 */
export const fromFoodTypeColumn = (value) => (isVegFoodType(value) ? 'Veg' : 'Non-Veg');
