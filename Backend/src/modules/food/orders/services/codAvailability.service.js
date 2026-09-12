import { prisma } from '../../../../config/prisma.js';

/**
 * Whether cash on delivery may be offered.
 *
 * It used to be one environment variable for the whole platform, so a zone with
 * a recovery problem could not be switched off without taking COD from every
 * other zone at the same time.
 *
 * Three inputs, in order of specificity: the platform switch, the zone's own
 * setting, and how many orders the customer has actually completed. A zone that
 * says nothing follows the platform, which is how every zone that predates this
 * keeps behaving as it did.
 */

/**
 * The platform-wide switch as the deploy configured it.
 *
 * Kept because it is the fallback for an install whose settings row does not
 * exist yet, and because callers that cannot await still need an answer.
 * Anything on the order path should use resolvePlatformCodEnabled().
 */
export const platformCodEnabled = () => String(process.env.COD_ENABLED || 'true') === 'true';

/**
 * The platform-wide switch as it actually stands.
 *
 * Moved out of the environment because turning COD off during a recovery
 * incident needed a deploy, which is the one thing nobody has time for while it
 * is happening. The env var survives only as the answer for an install that has
 * never opened the settings screen.
 */
export async function resolvePlatformCodEnabled() {
    const settings = await prisma.foodBusinessSettings.findFirst({ select: { codEnabled: true } });
    return typeof settings?.codEnabled === 'boolean' ? settings.codEnabled : platformCodEnabled();
}

/** Flip the platform switch, creating the single settings row if this is its first use. */
export async function setPlatformCodEnabled(enabled) {
    const row = await prisma.foodBusinessSettings.findFirst({ select: { id: true } });
    const codEnabled = Boolean(enabled);
    if (!row) {
        const created = await prisma.foodBusinessSettings.create({
            data: { codEnabled },
            select: { codEnabled: true },
        });
        return created.codEnabled;
    }
    const updated = await prisma.foodBusinessSettings.update({
        where: { id: row.id },
        data: { codEnabled },
        select: { codEnabled: true },
    });
    return updated.codEnabled;
}

/**
 * Decide from values already in hand.
 *
 * Split out from the lookup so the rule can be read and tested on its own —
 * refusing a payment method is not somewhere to discover a surprise.
 *
 * @param {{codEnabled?: boolean|null, codMinDeliveredOrders?: number}|null} zone
 * @param {number} deliveredOrders orders this customer has completed, platform-wide
 * @returns {{allowed: boolean, reason: string}}
 */
export const decideCod = (zone, deliveredOrders = 0, platformEnabled = platformCodEnabled()) => {
    if (!platformEnabled) {
        return { allowed: false, reason: 'platform-off' };
    }

    // Null, not false: a zone that has never been configured is not a zone that
    // has been switched off.
    if (zone && zone.codEnabled === false) {
        return { allowed: false, reason: 'zone-off' };
    }

    const required = Number(zone?.codMinDeliveredOrders) || 0;
    if (required > 0 && Number(deliveredOrders) < required) {
        return { allowed: false, reason: 'new-customer' };
    }

    return { allowed: true, reason: 'ok' };
};

/**
 * What a zone's settings mean in practice, for the admin screen.
 *
 * Runs the same decideCod the order path runs rather than restating the rule in
 * the panel, so what an admin is shown cannot drift from what checkout does.
 *
 * @param {{codEnabled?: boolean|null, codMinDeliveredOrders?: number}|null} zone
 * @param {boolean} platformEnabled
 */
export const effectiveCod = (zone, platformEnabled) => {
    // A returning customer is anyone who has cleared this zone's own threshold;
    // the boundary is the interesting case, so that is the count to ask about.
    const required = Number(zone?.codMinDeliveredOrders) || 0;
    return {
        newCustomer: decideCod(zone, 0, platformEnabled),
        returningCustomer: decideCod(zone, required, platformEnabled),
    };
};

/**
 * Read a zone's COD patch off an admin request body.
 *
 * codEnabled is tri-state, so an absent key ("leave it alone") and an explicit
 * null ("follow the platform") are two different instructions and are told
 * apart by the key being there at all, never by the value being falsy.
 *
 * @returns {{data: object, error: string|null}}
 */
export const parseZoneCodSettings = (body = {}) => {
    const payload = body && typeof body === 'object' ? body : {};
    const has = (key) => Object.prototype.hasOwnProperty.call(payload, key);
    const data = {};

    if (has('codEnabled')) {
        const raw = payload.codEnabled;
        // Strings are accepted because a form post has no booleans to send.
        if (raw === true || raw === 'true') data.codEnabled = true;
        else if (raw === false || raw === 'false') data.codEnabled = false;
        else if (raw === null || raw === 'null' || raw === '') data.codEnabled = null;
        else return { data: {}, error: 'codEnabled must be true, false, or null' };
    }

    if (has('codMinDeliveredOrders')) {
        const raw = payload.codMinDeliveredOrders;
        const numeric = Number(raw);
        if (raw === null || raw === '' || !Number.isInteger(numeric) || numeric < 0) {
            return { data: {}, error: 'codMinDeliveredOrders must be a whole number of 0 or more' };
        }
        data.codMinDeliveredOrders = numeric;
    }

    if (!Object.keys(data).length) {
        return { data: {}, error: 'Nothing to update: send codEnabled or codMinDeliveredOrders' };
    }
    return { data, error: null };
};

/** What the customer is told. Never the internal reason. */
export const codMessage = (reason) => {
    if (reason === 'new-customer') {
        return 'Cash on delivery becomes available after your first delivered order. Please pay online this time.';
    }
    if (reason === 'zone-off') {
        return 'Cash on delivery is not available in this area. Please pay online.';
    }
    return 'Cash on Delivery is no longer available. Please pay online.';
};

/**
 * Orders this customer has actually taken delivery of.
 *
 * Delivered only. Cancelled and rejected orders are exactly the signal the
 * threshold exists to catch, so counting them would hand COD to the customers
 * it is meant to hold back.
 */
export const countDeliveredOrders = async (userId) => {
    if (!userId) return 0;
    return prisma.foodOrder.count({
        where: { userId: String(userId), orderStatus: 'delivered' },
    });
};

/**
 * The full check, for the order path and the checkout screen alike.
 *
 * Both must agree, or the customer picks a method that is refused after they
 * have committed to it.
 */
export async function isCodAvailable({ userId, zoneId }) {
    // Not cached: one read per order placement, and a stale cache here would
    // keep taking cash after an admin has switched COD off, which is the exact
    // moment the switch exists for.
    if (!(await resolvePlatformCodEnabled())) {
        return { allowed: false, reason: 'platform-off', message: codMessage('platform-off') };
    }

    const zone = zoneId
        ? await prisma.foodZone.findUnique({
              where: { id: String(zoneId) },
              select: { codEnabled: true, codMinDeliveredOrders: true },
          })
        : null;

    // Only counted when a threshold is actually set — otherwise every checkout
    // would pay for a count nothing reads.
    const required = Number(zone?.codMinDeliveredOrders) || 0;
    const delivered = required > 0 ? await countDeliveredOrders(userId) : 0;

    const decision = decideCod(zone, delivered, true);
    return { ...decision, message: decision.allowed ? '' : codMessage(decision.reason) };
}
