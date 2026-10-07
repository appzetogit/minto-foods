import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { formatOrderDisplayId } from './order.service.js';

/** Order numbers: MFB + DDMMYY (India time) + a running number that never resets. */

test('the format matches MFB03102610004', () => {
    // 3 Oct 2026, 10:00 IST.
    assert.equal(formatOrderDisplayId('10004', new Date('2026-10-03T04:30:00Z')), 'MFB03102610004');
});

test('the date is the India date, not UTC', () => {
    // 2 Oct 2026, 20:00 UTC is already 3 Oct 01:30 in India.
    assert.equal(formatOrderDisplayId('10005', new Date('2026-10-02T20:00:00Z')), 'MFB03102610005');
});

test('the running number comes from the sequence and only goes up', async () => {
    const [a] = await prisma.$queryRaw`SELECT nextval('food_order_number_seq')::bigint AS n`;
    const [b] = await prisma.$queryRaw`SELECT nextval('food_order_number_seq')::bigint AS n`;
    assert.ok(Number(a.n) >= 10001);
    assert.equal(Number(b.n), Number(a.n) + 1);
    await prisma.$disconnect();
});
