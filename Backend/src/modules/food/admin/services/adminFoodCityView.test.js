import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { applyZoneView } from '../../../../core/roles/adminScope.service.js';
import { runWithAdminScope } from '../../../../core/roles/adminScope.context.js';
import { getFoods } from './adminFood.service.js';

/**
 * Admin › Foods with a city picked in the header shows only that city's
 * restaurants' dishes. It showed every city's.
 */
const A = testPatch(22);
const B = testPatch(23);
const created = { cities: [], zones: [], restaurants: [], foods: [] };
let tag;
let cityA;
let dishA;
let dishB;

const kitchen = async (name, zoneId) => {
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} ${name}`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved', zoneId },
    });
    created.restaurants.push(r.id);
    const f = await prisma.foodItem.create({
        data: { restaurantId: r.id, name: `${tag} ${name} Dish`, price: 100, approvalStatus: 'approved', isAvailable: true },
    });
    created.foods.push(f.id);
    return f;
};

test.before(async () => {
    tag = uniqueTag('FCV');
    cityA = await prisma.foodCity.create({ data: { name: `${tag} CityA`, nameKey: `${tag} citya`.toLowerCase() } });
    const cityB = await prisma.foodCity.create({ data: { name: `${tag} CityB`, nameKey: `${tag} cityb`.toLowerCase() } });
    created.cities.push(cityA.id, cityB.id);
    const zoneA = await prisma.foodZone.create({ data: { name: `${tag} ZA`, coordinates: A.ring, isActive: true, cityId: cityA.id } });
    const zoneB = await prisma.foodZone.create({ data: { name: `${tag} ZB`, coordinates: B.ring, isActive: true, cityId: cityB.id } });
    created.zones.push(zoneA.id, zoneB.id);
    dishA = await kitchen('A', zoneA.id);
    dishB = await kitchen('B', zoneB.id);
});

test.after(async () => {
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.foodCity.deleteMany({ where: { id: { in: created.cities } } });
    await prisma.$disconnect();
});

test('with a city picked, the food list shows only that city\'s dishes', async () => {
    const scope = await applyZoneView(null, null, `city:${cityA.id}`);
    const { foods } = await runWithAdminScope(scope, () => getFoods({ search: tag, limit: 50 }));
    const ids = foods.map((f) => String(f._id || f.id));
    assert.ok(ids.includes(dishA.id), 'city A dish listed');
    assert.ok(!ids.includes(dishB.id), 'city B dish hidden');

    const all = await getFoods({ search: tag, limit: 50 });
    assert.equal(all.foods.length, 2, 'nothing picked: both');
});
