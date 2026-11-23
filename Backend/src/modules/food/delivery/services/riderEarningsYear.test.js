import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone } from '../../../../utils/testIds.js';
import { getDeliveryPartnerEarnings } from './delivery.service.js';

/**
 * The rider app's Yearly tab used to ask for 'all' (every year ever) because
 * the server had no year range; it now asks for the picked year.
 */
const created = [];

test.after(async () => {
    await prisma.foodDeliveryPartnerSession.deleteMany({ where: { deliveryPartnerId: { in: created } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
});

test('period=year counts only the picked year', async () => {
    const rider = await prisma.foodDeliveryPartner.create({
        data: { name: 'Year Rider', phone: uniquePhone('8'), status: 'approved' },
    });
    created.push(rider.id);
    // One hour on shift in mid-2025, two hours in mid-2024.
    await prisma.foodDeliveryPartnerSession.createMany({
        data: [
            { deliveryPartnerId: rider.id, wentOnlineAt: new Date(2025, 5, 10, 10), wentOfflineAt: new Date(2025, 5, 10, 11) },
            { deliveryPartnerId: rider.id, wentOnlineAt: new Date(2024, 5, 10, 10), wentOfflineAt: new Date(2024, 5, 10, 12) },
        ],
    });

    const y2025 = await getDeliveryPartnerEarnings(rider.id, { period: 'year', date: new Date(2025, 8, 1).toISOString() });
    assert.equal(y2025.summary.totalOnlineMinutes, 60);
    const y2024 = await getDeliveryPartnerEarnings(rider.id, { period: 'year', date: new Date(2024, 0, 15).toISOString() });
    assert.equal(y2024.summary.totalOnlineMinutes, 120);
    const all = await getDeliveryPartnerEarnings(rider.id, { period: 'all' });
    assert.equal(all.summary.totalOnlineMinutes, 180);
});
