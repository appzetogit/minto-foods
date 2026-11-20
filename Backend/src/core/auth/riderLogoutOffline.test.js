import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { prisma } from '../../config/prisma.js';
import { config } from '../../config/env.js';
import { uniquePhone } from '../../utils/testIds.js';
import { logout } from './auth.service.js';

/**
 * A rider who logs out must stop showing as active: the admin panel still
 * listed them online, and dispatch kept offering them orders.
 */
const created = [];

test.after(async () => {
    await prisma.foodDeliveryPartnerSession.deleteMany({ where: { deliveryPartnerId: { in: created } } });
    await prisma.foodRefreshToken.deleteMany({ where: { userId: { in: created } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
});

const onlineRider = async () => {
    const rider = await prisma.foodDeliveryPartner.create({
        data: { name: 'Logout Rider', phone: uniquePhone('8'), status: 'approved', availabilityStatus: 'online' },
    });
    created.push(rider.id);
    await prisma.foodDeliveryPartnerSession.create({ data: { deliveryPartnerId: rider.id, wentOnlineAt: new Date() } });
    return rider;
};

const issue = async (claims) => {
    const token = jwt.sign(claims, config.jwtRefreshSecret, { expiresIn: '7d', jwtid: `${Date.now()}${Math.random()}` });
    await prisma.foodRefreshToken.create({ data: { userId: claims.userId, token, expiresAt: new Date(Date.now() + 7 * 864e5) } });
    return token;
};

test('logging out takes the rider offline and closes the shift', async () => {
    const rider = await onlineRider();
    const token = await issue({ userId: rider.id, role: 'DELIVERY_PARTNER' });

    await logout(token);

    const after = await prisma.foodDeliveryPartner.findUnique({ where: { id: rider.id } });
    assert.equal(after.availabilityStatus, 'offline');
    const open = await prisma.foodDeliveryPartnerSession.count({ where: { deliveryPartnerId: rider.id, wentOfflineAt: null } });
    assert.equal(open, 0);
});

test('a token we never issued takes nobody offline', async () => {
    const rider = await onlineRider();
    const forged = jwt.sign({ userId: rider.id, role: 'DELIVERY_PARTNER' }, config.jwtRefreshSecret);

    await logout(forged);

    const after = await prisma.foodDeliveryPartner.findUnique({ where: { id: rider.id } });
    assert.equal(after.availabilityStatus, 'online');
});
