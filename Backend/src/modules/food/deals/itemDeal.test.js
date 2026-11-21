import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../utils/testIds.js';
import { createDeal, setDealStatus, listLiveFlashDeals } from './itemDeal.service.js';
import { resolveOrderCartItems } from '../orders/helpers/order-cart-items.helper.js';
import { splitDealLines, couponEligibleTotal } from '../orders/services/order-pricing.service.js';

/**
 * Flash deals cut a dish's price for a while; Buy 1 Get 1 frees every second
 * unit; dishes under a deal, or marked not eligible, do not count for coupons.
 */
const created = { restaurants: [], foods: [] };
let restaurant;
let biryani;
let burger;
let coke;

test.before(async () => {
    restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${uniqueTag('Deal')} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(restaurant.id);
    const food = (name, price, extra = {}) =>
        prisma.foodItem.create({ data: { restaurantId: restaurant.id, name, price, foodType: 'Veg', approvalStatus: 'approved', ...extra } });
    biryani = await food('Biryani', 100);
    burger = await food('Burger', 80);
    coke = await food('Coke', 40, { couponEligible: false });
    created.foods.push(biryani.id, burger.id, coke.id);
});

test.after(async () => {
    await prisma.foodItemDeal.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('flash 50% for 2 hours sells the biryani at 50 and lists it as a flash deal', async () => {
    const deal = await createDeal(restaurant.id, {
        kind: 'flash', itemIds: [biryani.id], discountType: 'percentage', discountValue: 50, durationMinutes: 120,
    });
    assert.equal(deal.live, true);
    const [line] = await resolveOrderCartItems(restaurant.id, [{ itemId: biryani.id, quantity: 2 }]);
    assert.equal(line.price, 50);
    assert.equal(line.basePrice, 50); // the restaurant funds it
    assert.equal(line.couponEligible, false);
    const { dealDiscount } = splitDealLines([line]);
    assert.equal(dealDiscount, 100);

    const live = await listLiveFlashDeals();
    const mine = live.find((d) => d.id === deal.id);
    assert.equal(mine.items[0].price, 50);
    assert.equal(mine.items[0].originalPrice, 100);

    await setDealStatus(deal.id, 'inactive');
    const [after] = await resolveOrderCartItems(restaurant.id, [{ itemId: biryani.id, quantity: 1 }]);
    assert.equal(after.price, 100);
    assert.equal(after.couponEligible, true);
});

test('buy 1 get 1: 3 burgers bill as 2, the free one is its own ₹0 line', async () => {
    await createDeal(restaurant.id, { kind: 'bogo', itemIds: [burger.id] });
    const lines = await resolveOrderCartItems(restaurant.id, [{ itemId: burger.id, quantity: 3 }]);
    const { items, dealDiscount } = splitDealLines(lines);
    assert.equal(items.length, 2);
    assert.equal(items[0].quantity, 2);
    assert.equal(items[1].quantity, 1);
    assert.equal(items[1].price, 0);
    assert.equal(items[1].basePrice, 0);
    assert.match(items[1].name, /Buy 1 Get 1 free/);
    assert.equal(dealDiscount, 80);
});

test('coupons count only eligible dishes without a deal', async () => {
    const lines = await resolveOrderCartItems(restaurant.id, [
        { itemId: biryani.id, quantity: 1 }, // no deal now: eligible, 100
        { itemId: burger.id, quantity: 1 }, // under BOGO: not eligible
        { itemId: coke.id, quantity: 2 }, // marked not eligible
    ]);
    assert.equal(couponEligibleTotal(splitDealLines(lines).items), 100);
});

test('a flash deal needs a duration and a sane discount', async () => {
    await assert.rejects(createDeal(restaurant.id, { kind: 'flash', itemIds: [biryani.id], discountValue: 50 }), /how long/);
    await assert.rejects(
        createDeal(restaurant.id, { kind: 'flash', itemIds: [biryani.id], discountValue: 95, durationMinutes: 60 }),
        /at most 90%/,
    );
});
