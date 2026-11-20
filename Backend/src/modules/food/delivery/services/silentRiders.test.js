import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone } from '../../../../utils/testIds.js';
import { takeSilentRidersOffline } from './delivery.service.js';

/**
 * A rider whose app went silent (logged out with no network, killed, phone
 * dead) stayed "online" for days. The sweep takes them offline; a rider whose
 * phone is still pinging is left alone.
 */
const created = [];

test.after(async () => {
    await prisma.foodDeliveryPartnerSession.deleteMany({ where: { deliveryPartnerId: { in: created } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
});

const rider = async (minutesAgo) => {
    const at = new Date(Date.now() - minutesAgo * 60000);
    const r = await prisma.foodDeliveryPartner.create({
        data: { name: 'Sweep Rider', phone: uniquePhone('8'), status: 'approved', availabilityStatus: 'online', lastLocationAt: at },
    });
    created.push(r.id);
    await prisma.foodDeliveryPartnerSession.create({ data: { deliveryPartnerId: r.id, wentOnlineAt: at } });
    // updatedAt is @updatedAt; age it like a phone that stopped pinging.
    await prisma.$executeRawUnsafe(`UPDATE food_delivery_partners SET "updatedAt" = $2 WHERE id = $1`, r.id, at);
    return r;
};

test('a rider silent for an hour goes offline, shift closed; a pinging one stays', async () => {
    const silent = await rider(60);
    const active = await rider(2);

    await takeSilentRidersOffline();

    const s = await prisma.foodDeliveryPartner.findUnique({ where: { id: silent.id } });
    const a = await prisma.foodDeliveryPartner.findUnique({ where: { id: active.id } });
    assert.equal(s.availabilityStatus, 'offline');
    assert.equal(a.availabilityStatus, 'online');
    const open = await prisma.foodDeliveryPartnerSession.count({ where: { deliveryPartnerId: silent.id, wentOfflineAt: null } });
    assert.equal(open, 0);
});
