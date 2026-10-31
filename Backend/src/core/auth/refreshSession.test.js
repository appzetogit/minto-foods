import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { prisma } from '../../config/prisma.js';
import { config } from '../../config/env.js';
import { uniquePhone } from '../../utils/testIds.js';
import { refreshAccessToken } from './auth.service.js';

/**
 * Riders were logged out mid-shift: the refresh token came back unchanged on
 * every refresh and hard-expired 7 days after the OTP login. And once logged
 * out they stayed online, so offers kept arriving on a phone at the login
 * screen -- tap Accept, land on login.
 */
const created = { partners: [] };
let rider;

test.before(async () => {
    rider = await prisma.foodDeliveryPartner.create({
        data: { name: 'Session Rider', phone: uniquePhone('8'), status: 'approved', availabilityStatus: 'online', tokenVersion: 3 },
    });
    created.partners.push(rider.id);
});

test.after(async () => {
    await prisma.foodRefreshToken.deleteMany({ where: { userId: { in: created.partners } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.$disconnect();
});

/** A refresh token as a login issues it, stored like a login stores it. */
const issue = async (claims, expiresIn = '7d') => {
    const token = jwt.sign(claims, config.jwtRefreshSecret, { expiresIn, jwtid: `${Date.now()}${Math.random()}` });
    await prisma.foodRefreshToken.create({
        data: { userId: claims.userId, token, expiresAt: new Date(Date.now() + 7 * 864e5) },
    });
    return token;
};

test('every refresh hands out a new refresh token, and the old one still works', async () => {
    const first = await issue({ userId: rider.id, role: 'DELIVERY_PARTNER', tokenVersion: 3 });
    const a = await refreshAccessToken(first);
    assert.ok(a.accessToken);
    assert.notEqual(a.refreshToken, first, 'a fresh token, so the session slides');
    assert.equal(jwt.verify(a.refreshToken, config.jwtRefreshSecret).tokenVersion, 3);

    const b = await refreshAccessToken(a.refreshToken);
    assert.ok(b.accessToken, 'the new token is accepted');
    assert.ok((await refreshAccessToken(first)).accessToken, 'an app that kept the old one is not logged out');
});

test('a refused session takes the rider offline so offers stop', async () => {
    await prisma.foodDeliveryPartner.update({ where: { id: rider.id }, data: { availabilityStatus: 'online' } });
    const evicted = await issue({ userId: rider.id, role: 'DELIVERY_PARTNER', tokenVersion: 2 });
    await assert.rejects(() => refreshAccessToken(evicted), /another device/);
    const after = await prisma.foodDeliveryPartner.findUnique({ where: { id: rider.id } });
    assert.equal(after.availabilityStatus, 'offline');

    await prisma.foodDeliveryPartner.update({ where: { id: rider.id }, data: { availabilityStatus: 'online' } });
    const expired = await issue({ userId: rider.id, role: 'DELIVERY_PARTNER', tokenVersion: 3 }, '-1s');
    await assert.rejects(() => refreshAccessToken(expired), /Invalid refresh token/);
    assert.equal((await prisma.foodDeliveryPartner.findUnique({ where: { id: rider.id } })).availabilityStatus, 'offline');
});

test('a token we never issued changes nothing', async () => {
    await prisma.foodDeliveryPartner.update({ where: { id: rider.id }, data: { availabilityStatus: 'online' } });
    const forged = jwt.sign({ userId: rider.id, role: 'DELIVERY_PARTNER' }, 'not-our-secret');
    await assert.rejects(() => refreshAccessToken(forged), /Invalid refresh token/);
    assert.equal((await prisma.foodDeliveryPartner.findUnique({ where: { id: rider.id } })).availabilityStatus, 'online');
});
