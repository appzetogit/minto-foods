import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { uniquePhone } from '../../utils/testIds.js';
import { requestDeliveryOtp, verifyDeliveryOtpAndLogin } from './auth.service.js';

/**
 * Signing in on a new phone drops the old phone's push tokens, so a phone
 * that logged out or was replaced stops ringing with new-order offers.
 */
let riderId = null;
test.after(async () => {
    if (riderId) {
        await prisma.foodRefreshToken.deleteMany({ where: { userId: riderId } });
        await prisma.foodDeliveryPartner.delete({ where: { id: riderId } });
    }
    await prisma.$disconnect();
});

test("a rider's login keeps only this phone's push token", async () => {
    const phone = uniquePhone('7');
    const rider = await prisma.foodDeliveryPartner.create({
        data: { name: 'One Phone', phone, status: 'approved', fcmTokens: ['old-phone-a'], fcmTokenMobile: ['old-phone-b'] },
    });
    riderId = rider.id;

    await requestDeliveryOtp(phone);
    const otp = (await prisma.foodOtp.findUnique({ where: { phone } }))?.otp;
    await verifyDeliveryOtpAndLogin(phone, otp, 'new-phone', 'mobile');

    const after = await prisma.foodDeliveryPartner.findUnique({ where: { id: riderId } });
    const all = [...after.fcmTokens, ...after.fcmTokenMobile];
    assert.ok(!all.includes('old-phone-a') && !all.includes('old-phone-b'), 'old phones dropped');
    assert.ok(all.includes('new-phone'), 'this phone kept');
    await prisma.foodOtp.deleteMany({ where: { phone } });
});
