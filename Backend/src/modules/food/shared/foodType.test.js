import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../utils/testIds.js';
import { fromFoodTypeColumn, isVegFoodType, toFoodTypeColumn } from './foodType.util.js';
import { normalizeFoodTypeForCategory } from './categoryWorkflow.js';
import { updateRestaurantById } from '../admin/services/adminRestaurantWrite.service.js';

/**
 * A dish's diet mark: "veg" in any spelling is Veg. An exact 'Veg' match
 * stored the bulk-upload template's own "veg" as Non-Veg.
 */
test('veg in any case or spacing is Veg; anything else is Non-Veg', () => {
    for (const v of ['Veg', 'veg', 'VEG', ' Pure Veg ', 'pureveg', 'vegetarian']) {
        assert.equal(isVegFoodType(v), true, v);
        assert.equal(toFoodTypeColumn(v), 'Veg', v);
        assert.equal(fromFoodTypeColumn(v), 'Veg', v);
        assert.equal(normalizeFoodTypeForCategory(v), 'Veg', v);
    }
    for (const v of ['Non-Veg', 'nonveg', 'NonVeg', 'egg', '', null, undefined]) {
        assert.equal(toFoodTypeColumn(v), 'NonVeg', String(v));
    }
});

const created = { restaurants: [], foods: [] };
test.after(async () => {
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('a restaurant with non-veg dishes cannot be switched to pure veg', async () => {
    const tag = uniqueTag('PV');
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(r.id);
    const dish = await prisma.foodItem.create({ data: { restaurantId: r.id, name: `${tag} Chicken`, price: 100, foodType: 'NonVeg' } });
    created.foods.push(dish.id);

    await assert.rejects(() => updateRestaurantById(r.id, { pureVegRestaurant: true }), /1 dish is marked Non-veg/);
    assert.equal((await prisma.foodRestaurant.findUnique({ where: { id: r.id } })).pureVegRestaurant, false);

    await prisma.foodItem.update({ where: { id: dish.id }, data: { foodType: 'Veg' } });
    await updateRestaurantById(r.id, { pureVegRestaurant: true });
    assert.equal((await prisma.foodRestaurant.findUnique({ where: { id: r.id } })).pureVegRestaurant, true);
});
