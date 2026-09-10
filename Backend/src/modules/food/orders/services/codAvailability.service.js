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

/** The platform-wide switch. Off here means off everywhere, whatever a zone says. */
export const platformCodEnabled = () => String(process.env.COD_ENABLED || 'true') === 'true';

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
    if (!platformCodEnabled()) {
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
