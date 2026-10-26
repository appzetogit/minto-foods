import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { buildReferralLinkFromTemplate } from '../../delivery/services/deliveryReferral.service.js';
import { applyUserReferral } from '../../../../core/auth/auth.service.js';

/**
 * The three rows every referral view needs: the referrer, their wallet (for
 * lifetime referral earnings) and the active settings.
 */
const loadReferralContext = async (userId) => {
    const id = String(userId || '');
    if (!isId(id)) throw new ValidationError('User not found');

    const [user, wallet, settingsDoc] = await Promise.all([
        prisma.foodUser.findUnique({
            where: { id },
            select: { id: true, referralCount: true, referralCode: true },
        }),
        prisma.wallet.findUnique({
            where: { entityType_entityId: { entityType: 'user', entityId: id } },
            select: { referralEarnings: true },
        }),
        prisma.foodReferralSettings.findFirst({
            where: { isActive: true },
            orderBy: { createdAt: 'desc' },
        }),
    ]);

    return { id, user, wallet, settingsDoc };
};

const buildStats = ({ user, wallet, settingsDoc }) => ({
    // referralCode is what the customer shares; it falls back to their id.
    referralCode: String(user?.referralCode || user?.id || ''),
    referralLink: buildReferralLinkFromTemplate(
        settingsDoc?.referralLinkUser,
        user?.referralCode || user?.id,
        '',
    ),
    referralCount: Number(user?.referralCount) || 0,
    totalReferralEarnings: Number(wallet?.referralEarnings) || 0,
    rewardAmount: Math.max(0, Number(settingsDoc?.referralRewardUser) || 0),
    referralLimit: Math.max(0, Number(settingsDoc?.referralLimitUser) || 0),
});

export const getUserReferralStats = async (userId) => buildStats(await loadReferralContext(userId));

const maskPhone = (phone) => {
    const raw = String(phone || '');
    if (!raw) return '';
    return `${raw.slice(0, Math.min(3, raw.length))}${'*'.repeat(Math.max(raw.length - 5, 0))}${raw.slice(-2)}`;
};

export const getUserReferralDetails = async (userId) => {
    const context = await loadReferralContext(userId);

    const logs = await prisma.foodReferralLog.findMany({
        where: { referrerId: context.id, role: 'USER' },
        orderBy: { createdAt: 'desc' },
        take: 100,
    });

    const refereeIds = [...new Set(logs.map((log) => log.refereeId).filter(isId))];

    const referees = refereeIds.length
        ? await prisma.foodUser.findMany({
            where: { id: { in: refereeIds } },
            select: { id: true, name: true, phone: true, profileImage: true },
        })
        : [];

    const refereeMap = new Map(referees.map((entry) => [entry.id, entry]));

    const invitedFriends = logs.map((log) => {
        const referee = refereeMap.get(log.refereeId);
        const rewardAmount = Math.max(0, Number(log?.rewardAmount) || 0);

        return {
            id: log.id,
            refereeId: log.refereeId,
            name: String(referee?.name || '').trim() || 'Friend',
            phone: maskPhone(referee?.phone),
            profileImage: String(referee?.profileImage || '').trim(),
            status: String(log?.status || 'pending'),
            reason: String(log?.reason || ''),
            rewardAmount,
            earnedAmount: log?.status === 'credited' ? rewardAmount : 0,
            invitedAt: log?.createdAt || null,
        };
    });

    const countBy = (status) => invitedFriends.filter((entry) => entry.status === status).length;

    return {
        stats: {
            ...buildStats(context),
            totalInvited: invitedFriends.length,
            creditedCount: countBy('credited'),
            pendingCount: countBy('pending'),
            rejectedCount: countBy('rejected'),
        },
        invitedFriends,
    };
};

const APPLY_MESSAGES = {
    invalid_code: 'This referral code is not valid',
    own_code: 'You cannot use your own referral code',
    already_referred: 'A referral code has already been applied to your account',
    not_new: 'Referral codes can only be used before your first order',
    referral_disabled: 'Referrals are not active right now',
    reward_disabled: 'Referrals are not active right now',
    limit_disabled: 'Referrals are not active right now',
    limit_reached: 'This referral code has reached its limit',
};

/**
 * Applies a friend's code after signup (the app asks for it on the profile
 * step, which runs after the OTP login has already created the account).
 * Only a customer who has not ordered yet counts as new.
 */
export const applyReferralCode = async (userId, code) => {
    const id = String(userId || '');
    if (!isId(id)) throw new ValidationError('User not found');
    const [user, orders] = await Promise.all([
        prisma.foodUser.findUnique({ where: { id } }),
        prisma.foodOrder.count({ where: { userId: id } }),
    ]);
    if (!user) throw new ValidationError('User not found');

    let result;
    if (orders > 0) result = { applied: false, reason: 'not_new' };
    else {
        try {
            result = await applyUserReferral(user, code);
        } catch (e) {
            // (refereeId, role) is unique: a log row already exists.
            if (e?.code !== 'P2002') throw e;
            result = { applied: false, reason: 'already_referred' };
        }
    }
    if (!result.applied) throw new ValidationError(APPLY_MESSAGES[result.reason] || 'Referral code could not be applied');
    return { applied: true, reward: result.reward };
};
