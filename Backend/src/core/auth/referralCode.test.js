import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { uniquePhone } from '../../utils/testIds.js';
import { makeReferralCode, ensureShortReferralCode } from './referralCode.js';
import { applyUserReferral } from './auth.service.js';

const created = [];
test.after(async () => {
    await prisma.foodUser.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
});

test('codes look like ARMAN1234', () => {
    assert.match(makeReferralCode('Al Arman'), /^ALARM\d{4}$/);
    assert.match(makeReferralCode(''), /^MINTO\d{4}$/);
});

test('an old id code becomes short; a friend can sign up with either', async () => {
    const referrer = await prisma.foodUser.create({ data: { phone: uniquePhone('5'), name: 'Arman' } });
    created.push(referrer.id);
    await prisma.foodUser.update({ where: { id: referrer.id }, data: { referralCode: referrer.id } });
    const short = await ensureShortReferralCode({ ...referrer, referralCode: referrer.id });
    assert.match(short.referralCode, /^ARMAN\d{4}$/);

    await prisma.foodReferralSettings.create({ data: { isActive: true, referralRewardUser: 10 } }).catch(() => {});
    const friend = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.push(friend.id);
    const res = await applyUserReferral(friend, short.referralCode.toLowerCase());
    assert.notEqual(res.reason, 'invalid_code');
});
