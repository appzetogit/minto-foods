import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../utils/testIds.js';
import { testPatch } from '../../../utils/testGeo.js';
import { toAppPrice, resolveRule, isRuleLive, resetPriceRuleCache } from './priceRules.service.js';
import {
    createPriceRule,
    updatePriceRule,
    togglePriceRule,
    deletePriceRule,
    previewPriceRule,
    effectivePrices,
} from './priceRulesAdmin.service.js';
import { calculateOrder, createOrder, getOrderById } from '../orders/services/order.service.js';
import { getPublicApprovedRestaurantMenu, getRestaurantMenu } from '../restaurant/services/restaurantMenu.service.js';
import { setRestaurantCommissionForRestaurant } from '../admin/services/adminCommission.service.js';

/**
 * Global price management.
 *
 * The promise to the restaurant: its own price is never touched, it never
 * sees the marked-up price, and it is paid (and charged commission) on its
 * own price. The promise to the customer: they pay exactly the app price
 * they were shown. Both are checked here through the real entry points.
 */

// ---- the arithmetic, no database -------------------------------------------

test('rounding: nearest rupee, exact, and up to a price ending in 9', () => {
    assert.equal(toAppPrice(200, { percent: 10, rounding: 'nearest_1' }), 220);
    assert.equal(toAppPrice(199, { percent: 10, rounding: 'nearest_1' }), 219); // 218.9
    assert.equal(toAppPrice(199, { percent: 10, rounding: 'none' }), 218.9);
    assert.equal(toAppPrice(195.45, { percent: 10, rounding: 'end_9' }), 219); // 215.0 -> 219
    assert.equal(toAppPrice(201, { percent: 10, rounding: 'end_9' }), 229); // 221.1 -> 229
    assert.equal(toAppPrice(181, { percent: 10, rounding: 'end_9' }), 209); // 199.1 -> 209 (always up)
});

test('no rule, zero percent and free items leave the price alone; never below ₹1', () => {
    assert.equal(toAppPrice(150, null), 150);
    assert.equal(toAppPrice(150, { percent: 0, rounding: 'nearest_1' }), 150);
    assert.equal(toAppPrice(0, { percent: 50, rounding: 'nearest_1' }), 0);
    assert.equal(toAppPrice(1, { percent: -50, rounding: 'nearest_1' }), 1);
    assert.equal(toAppPrice(100, { percent: -20, rounding: 'nearest_1' }), 80);
});

test('the most specific rule wins and rules never stack', () => {
    const dish = { id: 'd1', categoryId: 'c1', restaurantId: 'r1', zoneId: 'z1' };
    const all = { id: 'a', scope: 'all', percent: 5 };
    const zone = { id: 'z', scope: 'zone', zoneId: 'z1', percent: 7 };
    const rest = { id: 'r', scope: 'restaurant', restaurantIds: ['r1'], percent: 12 };
    const cat = { id: 'c', scope: 'category', categoryIds: ['c1'], percent: 15 };
    const item = { id: 'i', scope: 'item', itemIds: ['d1'], percent: 0 };

    assert.equal(resolveRule(dish, [all]).id, 'a');
    assert.equal(resolveRule(dish, [all, zone]).id, 'z');
    assert.equal(resolveRule(dish, [rest, zone, all]).id, 'r');
    assert.equal(resolveRule(dish, [cat, rest]).id, 'c');
    // A 0% dish rule takes one dish out of a wider rule.
    assert.equal(resolveRule(dish, [all, rest, item]).id, 'i');
    assert.equal(toAppPrice(300, resolveRule(dish, [all, rest, item])), 300);
});

test('a rule limited to a zone does not reach other zones', () => {
    const rest = { id: 'r', scope: 'restaurant', restaurantIds: ['r1'], zoneId: 'z2', percent: 12 };
    assert.equal(resolveRule({ id: 'd', restaurantId: 'r1', zoneId: 'z1' }, [rest]), null);
    assert.equal(resolveRule({ id: 'd', restaurantId: 'r1', zoneId: 'z2' }, [rest]).id, 'r');
});

test('a scheduled rule is only live inside its window', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    assert.equal(isRuleLive({ isActive: true }, now), true);
    assert.equal(isRuleLive({ isActive: false }, now), false);
    assert.equal(isRuleLive({ isActive: true, startsAt: '2026-10-06T00:00:00Z' }, now), false);
    assert.equal(isRuleLive({ isActive: true, endsAt: '2026-10-04T00:00:00Z' }, now), false);
    assert.equal(isRuleLive({ isActive: true, startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-10T00:00:00Z' }, now), true);
});

// ---- through the real entry points -----------------------------------------

const HERE = testPatch(11);
const created = { zones: [], restaurants: [], users: [], foods: [], categories: [], rules: [] };
let restaurantId;
let otherRestaurantId;
let userId;
let foodId;
let sizedFoodId;
let largeId;
let tag;

const address = () => ({
    label: 'Home',
    fullName: 'Test Customer',
    street: '1 Test Street',
    city: 'Indore',
    state: 'MP',
    zipCode: '452001',
    phone: uniquePhone('5'),
    latitude: HERE.lat,
    longitude: HERE.lng,
});

const cart = (items) => ({ restaurantId, items, address: address(), paymentMethod: 'cash' });

const makeRestaurant = async (zoneId, name) => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} ${name}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            zoneId,
            latitude: HERE.lat,
            longitude: HERE.lng,
            isAcceptingOrders: true,
            outsideHoursOverride: true,
        },
    });
    created.restaurants.push(r.id);
    return r;
};

test.before(async () => {
    tag = uniqueTag('Price');
    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    created.zones.push(zone.id);

    restaurantId = (await makeRestaurant(zone.id, 'Kitchen')).id;
    otherRestaurantId = (await makeRestaurant(zone.id, 'Other')).id;

    // 10% commission, so "charged on the restaurant's price" is checkable.
    await setRestaurantCommissionForRestaurant(restaurantId, { type: 'percentage', value: 10 });

    const category = await prisma.foodCategory.create({
        data: { name: `${tag} Mains`, restaurantId, approvalStatus: 'approved' },
    });
    created.categories.push(category.id);

    const food = await prisma.foodItem.create({
        data: { restaurantId, categoryId: category.id, categoryName: category.name, name: `${tag} Tikka`, price: 200, approvalStatus: 'approved', isAvailable: true },
    });
    foodId = food.id;
    const sized = await prisma.foodItem.create({
        data: {
            restaurantId, categoryId: category.id, categoryName: category.name, name: `${tag} Pizza`, price: 300,
            approvalStatus: 'approved', isAvailable: true,
            variants: { create: [{ name: 'Regular', price: 300, sortOrder: 0 }, { name: 'Large', price: 500, sortOrder: 1 }] },
        },
        include: { variants: true },
    });
    sizedFoodId = sized.id;
    largeId = sized.variants.find((v) => v.name === 'Large').id;
    created.foods.push(food.id, sized.id);

    const otherFood = await prisma.foodItem.create({
        data: { restaurantId: otherRestaurantId, name: `${tag} Dosa`, price: 100, approvalStatus: 'approved', isAvailable: true },
    });
    created.foods.push(otherFood.id);

    const user = await prisma.foodUser.create({ data: { name: `${tag} Customer`, phone: uniquePhone('5') } });
    created.users.push(user.id);
    userId = user.id;
});

test.after(async () => {
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodPriceRuleLog.deleteMany({ where: { ruleId: { in: created.rules } } });
    await prisma.foodPriceRule.deleteMany({ where: { id: { in: created.rules } } });
    await prisma.foodRestaurantCommission.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodItemVariant.deleteMany({ where: { foodItemId: { in: created.foods } } }).catch(() => {});
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

const rule = async (body) => {
    const r = await createPriceRule({ rounding: 'nearest_1', ...body, name: `${tag} ${body.name || 'rule'}` }, null);
    created.rules.push(r.id);
    resetPriceRuleCache();
    return r;
};

test('with no rule, prices are exactly the restaurant prices', async () => {
    const quote = await calculateOrder(userId, cart([{ itemId: foodId, quantity: 1 }]));
    assert.equal(Number(quote.pricing.subtotal), 200);
});

test('a restaurant rule raises what customers see and pay, not the dish itself', async () => {
    const r = await rule({ name: '+10%', scope: 'restaurant', restaurantIds: [restaurantId], percent: 10 });

    const menu = await getPublicApprovedRestaurantMenu(restaurantId);
    const items = menu.sections.flatMap((s) => s.items);
    assert.equal(items.find((i) => i.id === foodId).price, 220);
    const pizza = items.find((i) => i.id === sizedFoodId);
    assert.deepEqual(pizza.variants.map((v) => Number(v.price)).sort((a, b) => a - b), [330, 550]);

    // The restaurant's own menu and the stored dish are untouched.
    const own = await getRestaurantMenu(restaurantId);
    assert.equal(own.sections.flatMap((s) => s.items).find((i) => i.id === foodId).price, 200);
    const row = await prisma.foodItem.findUnique({ where: { id: foodId } });
    assert.equal(Number(row.price), 200);

    // Another restaurant is not covered.
    const otherMenu = await getPublicApprovedRestaurantMenu(otherRestaurantId);
    assert.equal(otherMenu.sections.flatMap((s) => s.items)[0].price, 100);

    await togglePriceRule(r.id, false, null);
    resetPriceRuleCache();
});

test('the order: customer pays app prices, restaurant is paid and charged on its own', async () => {
    const r = await rule({ name: 'order +10%', scope: 'restaurant', restaurantIds: [restaurantId], percent: 10 });

    const items = [
        { itemId: foodId, quantity: 2 }, // 2 x 200 -> 2 x 220
        { itemId: sizedFoodId, variantId: largeId, quantity: 1 }, // 500 -> 550
    ];
    const quote = await calculateOrder(userId, cart(items));
    assert.equal(Number(quote.pricing.subtotal), 990);

    const { order } = await createOrder(userId, cart(items));
    const id = order._id || order.id;
    assert.equal(Number(order.pricing.subtotal), 990);
    assert.equal(Number(order.pricing.total), Number(quote.pricing.total));

    const lines = await prisma.orderItem.findMany({ where: { orderId: id } });
    const tikka = lines.find((l) => l.itemId === foodId);
    assert.equal(Number(tikka.price), 220);
    assert.equal(Number(tikka.basePrice), 200);
    assert.equal(Number(tikka.markupPercent), 10);

    const row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(Number(row.priceMarkupAmount), 90); // 2 x 20 + 50

    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: id } });
    assert.equal(Number(tx.priceMarkupAmount), 90);
    // Commission: 10% of the restaurant's 900, not of the customer's 990.
    assert.equal(Number(tx.commissionAmount), 90);
    // Restaurant gets 900 - 90.
    assert.equal(Number(tx.restaurantShare), 810);

    // What the restaurant sees: its own prices throughout.
    const seen = await getOrderById(id, { restaurantId });
    const seenTikka = seen.items.find((i) => i.itemId === foodId);
    assert.equal(Number(seenTikka.price), 200);
    assert.equal(seenTikka.basePrice, undefined);
    assert.equal(Number(seen.pricing.subtotal), 900);
    assert.equal(seen.priceMarkupAmount, undefined);
    assert.equal(seen.finance.itemTotal, 900);
    assert.equal(seen.finance.commission, 90);
    assert.equal(seen.finance.netPayout, 810);

    // The customer sees what they paid.
    const mine = await getOrderById(id, { userId });
    assert.equal(Number(mine.pricing.subtotal), 990);

    await togglePriceRule(r.id, false, null);
    resetPriceRuleCache();
});

test('a lowered price: customer pays less, restaurant still gets its full price', async () => {
    const r = await rule({ name: '-25%', scope: 'item', itemIds: [foodId], percent: -25 });

    const { order } = await createOrder(userId, cart([{ itemId: foodId, quantity: 1 }]));
    const id = order._id || order.id;
    assert.equal(Number(order.pricing.subtotal), 150);

    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: id } });
    assert.equal(Number(tx.priceMarkupAmount), -50);
    assert.equal(Number(tx.commissionAmount), 20); // 10% of 200
    assert.equal(Number(tx.restaurantShare), 180);

    await deletePriceRule(r.id, null);
    resetPriceRuleCache();
});

test('preview lists the dishes a draft covers and which keep a more specific rule', async () => {
    const dishRule = await rule({ name: 'dish 0%', scope: 'item', itemIds: [foodId], percent: 0 });

    const preview = await previewPriceRule({ name: 'draft', scope: 'restaurant', restaurantIds: [restaurantId], percent: 20 });
    assert.equal(preview.total, 2);
    const tikka = preview.dishes.find((d) => d.id === foodId);
    assert.equal(tikka.followsThisRule, false);
    assert.equal(tikka.keepsRule.id, dishRule.id);
    const pizza = preview.dishes.find((d) => d.id === sizedFoodId);
    assert.equal(pizza.followsThisRule, true);
    assert.deepEqual(pizza.sizes.map((s) => s.app), [360, 600]);

    // Nothing was saved by previewing.
    const effective = await effectivePrices(restaurantId);
    assert.equal(effective.dishes.find((d) => d.id === sizedFoodId).rule, null);

    await deletePriceRule(dishRule.id, null);
    resetPriceRuleCache();
});

test('bad rules are refused', async () => {
    await assert.rejects(() => createPriceRule({ name: 'x', scope: 'all', percent: 150 }), /between/);
    await assert.rejects(() => createPriceRule({ name: 'x', scope: 'all', percent: -60 }), /between/);
    await assert.rejects(() => createPriceRule({ name: 'x', scope: 'restaurant', percent: 10 }), /restaurant/);
    await assert.rejects(() => createPriceRule({ name: 'x', scope: 'zone', percent: 10 }), /zone/);
    await assert.rejects(
        () => createPriceRule({ name: 'x', scope: 'item', itemIds: ['aaaaaaaaaaaaaaaaaaaaaaaa'], percent: 10 }),
        /not found/,
    );
    await assert.rejects(
        () => createPriceRule({ name: 'x', scope: 'all', percent: 10, startsAt: '2026-10-10', endsAt: '2026-10-01' }),
        /after start/,
    );
});

test('every change is logged', async () => {
    const r = await rule({ name: 'logged', scope: 'item', itemIds: [foodId], percent: 5 });
    await updatePriceRule(r.id, { percent: 6 }, null);
    await togglePriceRule(r.id, false, null);
    await deletePriceRule(r.id, null);
    const logs = await prisma.foodPriceRuleLog.findMany({ where: { ruleId: r.id }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(logs.map((l) => l.action), ['create', 'update', 'deactivate', 'delete']);
    assert.equal(Number(logs[1].before.percent), 5);
    assert.equal(Number(logs[1].after.percent), 6);
});
