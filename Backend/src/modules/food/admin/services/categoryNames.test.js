import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { categoryNameKey } from '../../shared/categoryWorkflow.js';
import { createCategory, makeCategoryGlobal, updateCategory } from './adminCategory.service.js';
import { createRestaurantCategory } from '../../restaurant/services/restaurantCategory.service.js';

/** A category name is taken once: "Dessert" appeared three times when adding a dish. */
const created = { categories: [], restaurants: [] };
let tag;
let restaurant;

const track = (c) => { created.categories.push(c.id); return c; };

test.before(async () => {
    tag = uniqueTag('Cat');
    restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(restaurant.id);
});

test.after(async () => {
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('names match ignoring case and extra spaces', () => {
    assert.equal(categoryNameKey('  Main   Course '), 'main course');
});

test('the admin cannot create or rename into a name already taken', async () => {
    const name = `${tag} Dessert`;
    const first = track(await createCategory({ name }));
    await assert.rejects(() => createCategory({ name: `  ${name.toUpperCase()} ` }), /already exists/);

    const other = track(await createCategory({ name: `${tag} Starters` }));
    await assert.rejects(() => updateCategory(other.id, { name }), /already exists/);
    // Renaming to its own name (a save with nothing changed) is fine.
    await updateCategory(first.id, { name });

    // A disabled one still holds the name, and says so.
    await updateCategory(first.id, { isActive: false });
    await assert.rejects(() => createCategory({ name }), /disabled -- enable it instead/);

    // A rejected one does not.
    await prisma.foodCategory.update({ where: { id: first.id }, data: { approvalStatus: 'rejected' } });
    track(await createCategory({ name }));
});

test('a restaurant cannot recreate a shared category or its own twice', async () => {
    const shared = track(await createCategory({ name: `${tag} Biryani` }));
    await assert.rejects(
        () => createRestaurantCategory(restaurant.id, { name: shared.name.toLowerCase(), foodTypeScope: 'Both' }),
        /every restaurant can use/,
    );

    const own = track(await createRestaurantCategory(restaurant.id, { name: `${tag} House Special`, foodTypeScope: 'Both' }));
    await assert.rejects(
        () => createRestaurantCategory(restaurant.id, { name: own.name, foodTypeScope: 'Both' }),
        /already exists/,
    );

    // Promoting it is refused while a shared one has the same name.
    await prisma.foodCategory.update({ where: { id: own.id }, data: { approvalStatus: 'approved', isApproved: true } });
    track(await createCategory({ name: `${tag} House Special (shared)` }));
    const twin = await prisma.foodCategory.findFirst({ where: { id: { in: created.categories }, name: `${tag} House Special (shared)` } });
    await prisma.foodCategory.update({ where: { id: twin.id }, data: { name: own.name } });
    await assert.rejects(() => makeCategoryGlobal(own.id), /already exists/);
});
