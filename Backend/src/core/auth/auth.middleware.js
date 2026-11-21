import { verifyAccessToken } from './token.util.js';
import { sendError } from '../../utils/response.js';
import { prisma } from '../../config/prisma.js';
import { isId } from '../../utils/helpers.js';

export const requireAdmin = (req, res, next) => {
    if (req.user?.role !== 'ADMIN') {
        return sendError(res, 403, 'Admin access required');
    }
    next();
};

/**
 * Accounts whose session version (and deletion) is checked on every request.
 *
 * Customers and riders are single-device: each login bumps the version, so the
 * previous phone is signed out. Restaurants stay here although they are
 * multi-device -- their login does not bump the version -- because this is
 * what makes "Log out all devices" and a deleted restaurant take effect.
 * Admins are absent: the panel is used across several tabs and machines.
 */
const SESSION_SCOPED_MODELS = {
    USER: () => prisma.foodUser,
    RESTAURANT: () => prisma.foodRestaurant,
    DELIVERY_PARTNER: () => prisma.foodDeliveryPartner
};

export const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

    if (!token) {
        return sendError(res, 401, 'Authentication token missing');
    }

    let decoded;
    try {
        decoded = verifyAccessToken(token);
    } catch (error) {
        return sendError(res, 401, 'Invalid or expired token');
    }

    req.user = {
        userId: decoded.userId,
        role: decoded.role,
        adminType: decoded.adminType
    };

    sessionRefusal(decoded)
        .then((reason) => (reason ? sendError(res, 401, reason) : next()))
        .catch(() => sendError(res, 401, 'Authentication failed'));
};

/**
 * Why a verified token's session no longer counts, or null when it does.
 *
 * Shared by HTTP requests and the socket handshake: a phone replaced by a
 * newer login must lose both, or its open socket keeps receiving order offers
 * meant for the rider's current phone.
 */
export const sessionRefusal = async (decoded) => {
    const delegate = SESSION_SCOPED_MODELS[decoded.role];
    if (!delegate) return null;

    // A malformed id would otherwise reach the database as a query that cannot
    // match; reject it here as the bad token it is.
    if (!isId(decoded.userId)) return 'Invalid or expired token';

    // isActive is selected for USER only: restaurants and partners use `status`,
    // which this check has never consulted.
    const doc = await delegate().findUnique({
        where: { id: decoded.userId },
        select: { tokenVersion: true, deletedAt: true, ...(decoded.role === 'USER' ? { isActive: true } : {}) },
    });
    if (!doc) return 'Account not found';
    // Checked before the version: a token issued before the delete may carry
    // no version at all, and must still stop working.
    if (doc.deletedAt) return 'This account has been deleted';
    if (decoded.role === 'USER' && doc.isActive === false) return 'User account is deactivated';

    // A token minted before the latest login belongs to a device that has since
    // been replaced. Tokens from before versioning carry none and are accepted
    // until the account next logs in.
    const stored = Number(doc.tokenVersion) || 0;
    const presented = decoded.tokenVersion;
    if (presented !== undefined && Number(presented) !== stored) {
        return 'You have been signed out because this account was used on another device';
    }
    return null;
};
export const optionalAuth = (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

    if (!token) {
        return next();
    }

    try {
        const decoded = verifyAccessToken(token);
        req.user = {
            userId: decoded.userId,
            role: decoded.role,
            adminType: decoded.adminType
        };
        next();
    } catch (error) {
        // Silently ignore invalid tokens in optional auth
        next();
    }
};
