import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../utils/testIds.js';
import {
    MAX_RESTAURANT_DEVICES,
    logoutAllRestaurantDevices,
    requestRestaurantOtp,
    verifyRestaurantOtpAndLogin,
} from './auth.service.js';
import { authMiddleware } from './auth.middleware.js';
import { listOwnerTokens } from '../notifications/firebase.service.js';

/**
 * A restaurant runs on several phones at once -- the counter, the kitchen, the
 * owner -- and signing in on one must not sign the others out or take their
 * new-order alerts away.
 */
const created = { restaurants: [], phones: [] };
let restaurant;

test.before(async () => {
    const phone = uniquePhone('9');
    created.phones.push(phone);
    restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${uniqueTag('Multi')} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: phone,
            status: 'approved',
            approvedAt: new Date(),
        },
    });
    created.restaurants.push(restaurant.id);
});

test.after(async () => {
    await prisma.foodRefreshToken.deleteMany({ where: { userId: { in: created.restaurants } } });
    await prisma.foodOtp.deleteMany({ where: { phone: { in: created.phones } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

const otpFor = async (phone) => (await prisma.foodOtp.findUnique({ where: { phone } }))?.otp;

/** One phone signing in, with its own push token. */
const signIn = async (fcmToken) => {
    await requestRestaurantOtp(restaurant.ownerPhone);
    return verifyRestaurantOtpAndLogin(restaurant.ownerPhone, await otpFor(restaurant.ownerPhone), fcmToken, 'android');
};

/** Runs authMiddleware for a token: true when the request is let through. */
const passes = (accessToken) => new Promise((resolve) => {
    const res = {
        status() { return this; },
        json() { resolve(false); return this; },
    };
    authMiddleware({ headers: { authorization: `Bearer ${accessToken}` } }, res, () => resolve(true));
});

test('two phones stay signed in together, and both keep their push token', async () => {
    const kitchen = await signIn(`fcm-kitchen-${uniqueTag('t')}`);
    const counter = await signIn(`fcm-counter-${uniqueTag('t')}`);

    assert.equal(await passes(kitchen.accessToken), true, 'the first phone is not signed out');
    assert.equal(await passes(counter.accessToken), true);

    const tokens = await listOwnerTokens({ ownerType: 'RESTAURANT', ownerId: restaurant.id });
    assert.equal(tokens.length, 2, 'both phones ring for a new order');
});

test(`at most ${MAX_RESTAURANT_DEVICES} sessions; the oldest drops off`, async () => {
    const first = await signIn(`fcm-a-${uniqueTag('t')}`);
    for (let i = 0; i < MAX_RESTAURANT_DEVICES; i += 1) await signIn(`fcm-${i}-${uniqueTag('t')}`);

    const sessions = await prisma.foodRefreshToken.findMany({ where: { userId: restaurant.id } });
    assert.equal(sessions.length, MAX_RESTAURANT_DEVICES);
    assert.ok(!sessions.some((s) => s.token === first.refreshToken), 'the oldest session was dropped');

    const tokens = await listOwnerTokens({ ownerType: 'RESTAURANT', ownerId: restaurant.id });
    assert.equal(tokens.length, MAX_RESTAURANT_DEVICES, 'five phones ring, not three');
});

test('"Log out all devices" signs every phone out', async () => {
    const phoneA = await signIn(`fcm-x-${uniqueTag('t')}`);
    const phoneB = await signIn(`fcm-y-${uniqueTag('t')}`);

    await logoutAllRestaurantDevices(restaurant.id);

    assert.equal(await passes(phoneA.accessToken), false);
    assert.equal(await passes(phoneB.accessToken), false);
    assert.equal(await prisma.foodRefreshToken.count({ where: { userId: restaurant.id } }), 0);
    assert.deepEqual(await listOwnerTokens({ ownerType: 'RESTAURANT', ownerId: restaurant.id }), []);

    // And signing in again afterwards works.
    const again = await signIn(`fcm-z-${uniqueTag('t')}`);
    assert.equal(await passes(again.accessToken), true);
});
