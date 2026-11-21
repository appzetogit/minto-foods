import crypto from 'node:crypto';
import { prisma } from '../../config/prisma.js';

/**
 * A short, readable referral code: up to 5 letters of the name + 4 digits,
 * ARMAN1234. Customers type it, so no 24-character id. Falls back to MINTO.
 */
export const makeReferralCode = (name) => {
    const letters = String(name || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5) || 'MINTO';
    return `${letters}${crypto.randomInt(1000, 10000)}`;
};

/** Gives a user a short code if theirs is missing or still the old id. */
export async function ensureShortReferralCode(user) {
    if (!user?.id) return user;
    const current = String(user.referralCode || '');
    if (current && current !== user.id && current.length <= 12) return user;
    for (let i = 0; i < 8; i += 1) {
        try {
            return await prisma.foodUser.update({
                where: { id: user.id },
                data: { referralCode: makeReferralCode(user.name) },
            });
        } catch (err) {
            if (err?.code !== 'P2002') throw err; // taken: try another
        }
    }
    return user;
}
