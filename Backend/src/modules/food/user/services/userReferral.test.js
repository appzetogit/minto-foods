import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { applyReferralCode } from './userReferral.service.js';
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * The app asks for a friend's code on the profile step, after the OTP login has
 * already created the account, so the code is applied by its own call.
 */
const ids = [];
let settingsId;

const newUser = async () => {
    const u = await prisma.foodUser.create({ data: { phone: uniquePhone('8') } });
    ids.push(u.id);
    return u;
};

test.before(async () => {
    const s = await prisma.foodReferralSettings.create({
        data: { referralRewardUser: 50, referralLimitUser: 5, isActive: true },
    });
    settingsId = s.id;
});

test.after(async () => {
    await prisma.foodReferralLog.deleteMany({ where: { refereeId: { in: ids } } });
    await prisma.foodUser.updateMany({ where: { id: { in: ids } }, data: { referredById: null } });
    await prisma.foodUser.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    if (settingsId) await prisma.foodReferralSettings.delete({ where: { id: settingsId } }).catch(() => {});
    await prisma.$disconnect();
});

test('a friend code credits the referrer once', async () => {
    const referrer = await newUser();
    const friend = await newUser();

    const res = await applyReferralCode(friend.id, referrer.id.toUpperCase());
    assert.equal(res.applied, true);
    assert.equal(res.reward, 50);

    const after = await prisma.foodUser.findUnique({ where: { id: referrer.id } });
    assert.equal(after.referralCount, 1);
    const me = await prisma.foodUser.findUnique({ where: { id: friend.id } });
    assert.equal(me.referredById, referrer.id);

    await assert.rejects(applyReferralCode(friend.id, referrer.id), /already been applied/);
});

test('own, unknown and malformed codes are refused', async () => {
    const u = await newUser();
    await assert.rejects(applyReferralCode(u.id, u.id), /own referral code/);
    await assert.rejects(applyReferralCode(u.id, 'abc'), /not valid/);
    await assert.rejects(applyReferralCode(u.id, 'f'.repeat(24)), /not valid/);
});
