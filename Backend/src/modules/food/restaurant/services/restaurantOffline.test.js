import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { updateRestaurantAcceptingOrders } from './restaurant.service.js';
import { applyRestaurantOfflineSchedule } from './restaurantOffline.service.js';

const ids = [];
const make = async (data = {}) => {
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: uniqueTag('Offline'), ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved', ...data },
    });
    ids.push(r.id);
    return r;
};
const row = (id) => prisma.foodRestaurant.findUnique({ where: { id } });
const inMin = (m) => new Date(Date.now() + m * 60000);

test.after(async () => {
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
});

test('offline for 2 hours with a reason, then back online by itself', async () => {
    const r = await make();
    const profile = await updateRestaurantAcceptingOrders(r.id, false, { offlineReason: 'Kitchen is full', offlineUntil: inMin(120) });
    assert.equal(profile.offlineReason, 'Kitchen is full');
    let now = await row(r.id);
    assert.equal(now.isAcceptingOrders, false);

    await applyRestaurantOfflineSchedule(inMin(60));
    assert.equal((await row(r.id)).isAcceptingOrders, false, 'still inside the 2 hours');
    await applyRestaurantOfflineSchedule(inMin(121));
    now = await row(r.id);
    assert.equal(now.isAcceptingOrders, true);
    assert.equal(now.offlineUntil, null);
    assert.equal(now.offlineReason, '');
});

test('a scheduled break stays online until it starts, then ends by itself', async () => {
    const r = await make();
    await updateRestaurantAcceptingOrders(r.id, false, { offlineReason: 'Temporarily closed', offlineFrom: inMin(30), offlineUntil: inMin(90) });
    assert.equal((await row(r.id)).isAcceptingOrders, true, 'not before the break');
    await applyRestaurantOfflineSchedule(inMin(31));
    assert.equal((await row(r.id)).isAcceptingOrders, false, 'break started');
    await applyRestaurantOfflineSchedule(inMin(91));
    assert.equal((await row(r.id)).isAcceptingOrders, true, 'break over');
});

test('going online clears any break; admin offline is never lifted by the scheduler', async () => {
    const r = await make();
    await updateRestaurantAcceptingOrders(r.id, false, { offlineUntil: inMin(60) });
    await updateRestaurantAcceptingOrders(r.id, true);
    const back = await row(r.id);
    assert.equal(back.isAcceptingOrders, true);
    assert.equal(back.offlineUntil, null);

    const admin = await make({ isAcceptingOrders: false, offlineByAdmin: true, offlineUntil: inMin(-5) });
    await applyRestaurantOfflineSchedule();
    assert.equal((await row(admin.id)).isAcceptingOrders, false);
});

test('a time in the past is refused', async () => {
    const r = await make();
    await assert.rejects(() => updateRestaurantAcceptingOrders(r.id, false, { offlineUntil: inMin(-1) }), /future/);
});
