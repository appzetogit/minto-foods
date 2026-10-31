import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { assertOrderingNotPaused, getOrderPause, updateOrderPause } from './businessSettings.service.js';

/** Stopping new orders for a while, everywhere or in chosen zones. */
const ZONE_A = 'a'.repeat(24);
const ZONE_B = 'b'.repeat(24);

test.after(async () => {
    await updateOrderPause({ paused: false });
    await prisma.$disconnect();
});

test('paused everywhere refuses every order with the message', async () => {
    await updateOrderPause({ paused: true, message: 'Back at 6 pm' });
    await assert.rejects(() => assertOrderingNotPaused([ZONE_A]), /Back at 6 pm/);
    await assert.rejects(() => assertOrderingNotPaused([]), /Back at 6 pm/);
});

test('paused in one zone leaves the others ordering', async () => {
    await updateOrderPause({ paused: true, zoneIds: [ZONE_A] });
    await assert.rejects(() => assertOrderingNotPaused([ZONE_A]), /not taking orders/);
    await assertOrderingNotPaused([ZONE_B]);
});

test('a pause with a resume time lifts by itself', async () => {
    await assert.rejects(() => updateOrderPause({ paused: true, until: new Date(Date.now() - 1000) }), /future/);
    await updateOrderPause({ paused: true, until: new Date(Date.now() + 60_000) });
    assert.equal((await getOrderPause()).active, true);
    await prisma.foodBusinessSettings.updateMany({ data: { ordersPausedUntil: new Date(Date.now() - 1000) } });
    assert.equal((await getOrderPause()).active, false);
    await assertOrderingNotPaused([ZONE_A]);
});

test('resuming clears it', async () => {
    await updateOrderPause({ paused: true });
    const off = await updateOrderPause({ paused: false });
    assert.equal(off.active, false);
    assert.deepEqual(off.zoneIds, []);
    await assertOrderingNotPaused([ZONE_A]);
});
