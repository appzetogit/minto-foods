import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { setRestaurantCommissionForRestaurant } from './adminCommission.service.js';

/** Setting a restaurant's overall commission from the Billing Mode screen. */
let restaurantId;

test.before(async () => {
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: `${uniqueTag('Rate')} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    restaurantId = r.id;
});

test.after(async () => {
    await prisma.foodRestaurantCommission.deleteMany({ where: { restaurantId } });
    await prisma.foodRestaurant.deleteMany({ where: { id: restaurantId } });
    await prisma.$disconnect();
});

const rowFor = () => prisma.foodRestaurantCommission.findMany({ where: { restaurantId } });

test('the first save creates the rate, a second updates it in place', async () => {
    await setRestaurantCommissionForRestaurant(restaurantId, { type: 'percentage', value: 15 });
    let rows = await rowFor();
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].commissionValue), 15);

    await setRestaurantCommissionForRestaurant(restaurantId, { type: 'amount', value: 20 });
    rows = await rowFor();
    assert.equal(rows.length, 1, 'still one row');
    assert.equal(rows[0].commissionType, 'amount');
    assert.equal(Number(rows[0].commissionValue), 20);
});

test('a switched-off rate is switched back on when set', async () => {
    await prisma.foodRestaurantCommission.updateMany({ where: { restaurantId }, data: { status: false } });
    await setRestaurantCommissionForRestaurant(restaurantId, { type: 'percentage', value: 10 });
    const [row] = await rowFor();
    assert.equal(row.status, true);
});

test('impossible rates and unknown restaurants are refused', async () => {
    await assert.rejects(() => setRestaurantCommissionForRestaurant(restaurantId, { type: 'percentage', value: 120 }), /cannot exceed 100/);
    await assert.rejects(() => setRestaurantCommissionForRestaurant(restaurantId, { type: 'amount', value: -5 }), /non-negative/);
    await assert.rejects(() => setRestaurantCommissionForRestaurant('a'.repeat(24), { type: 'percentage', value: 5 }), /not found/i);
});
