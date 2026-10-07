import { prisma } from '../../config/prisma.js';
import { ForbiddenError, NotFoundError } from './errors.js';
import { FEATURE_KEYS, isFeatureEnabled } from '../../modules/food/admin/services/featureSettings.service.js';

/**
 * Whether restaurants and riders may sign themselves up.
 *
 * Two admin switches (Feature Settings). When one is off, a phone number with
 * no account is told "Account not found" -- at the OTP request, so no SMS is
 * spent on it, and again at verify for an OTP sent before the switch went off
 * -- and the register endpoints refuse. Existing accounts are never affected:
 * every check here only fires when there is no account for the number.
 *
 * The messages are shown as-is by the shipped restaurant and rider apps.
 */

export const RESTAURANT_NOT_FOUND = 'Account not found. Please contact Minto to register your restaurant.';
export const DELIVERY_NOT_FOUND = 'Account not found. Please contact Minto to join as a delivery partner.';

export const isRestaurantSelfOnboardingOpen = () =>
    isFeatureEnabled(FEATURE_KEYS.RESTAURANT_SELF_ONBOARDING, true);

export const isDeliverySelfOnboardingOpen = () =>
    isFeatureEnabled(FEATURE_KEYS.DELIVERY_SELF_ONBOARDING, true);

const digitsOf = (phone) => String(phone || '').replace(/\D/g, '');

/**
 * The restaurant a phone number logs in as. Owner phone or primary contact,
 * matched exactly, as digits, or by the last 10 digits -- onboarding and OTP
 * login store country codes differently.
 */
export function findRestaurantByPhone(phone) {
    const digits = digitsOf(phone);
    const last10 = digits.slice(-10);
    const candidates = [phone, digits, last10].filter(Boolean);
    const on = (field) => [
        { [field]: { in: candidates } },
        ...(last10 ? [{ [field]: { endsWith: last10 } }] : []),
    ];
    if (!candidates.length) return null;
    return prisma.foodRestaurant.findFirst({
        where: { OR: [...on('ownerPhone'), ...on('primaryContactNumber')] },
    });
}

/** The rider a phone number logs in as (last 10 digits). */
export function findDeliveryPartnerByPhone(phone) {
    const normalized = digitsOf(phone).slice(-10);
    if (!normalized) return null;
    return prisma.foodDeliveryPartner.findFirst({
        where: { OR: [{ phone: normalized }, { phone: { endsWith: normalized } }] },
    });
}

/** Before an OTP is sent: an unknown number is refused while sign-up is off. */
export async function assertRestaurantLoginAllowed(phone) {
    if (await isRestaurantSelfOnboardingOpen()) return;
    if (await findRestaurantByPhone(phone)) return;
    throw new NotFoundError(RESTAURANT_NOT_FOUND);
}

export async function assertDeliveryLoginAllowed(phone) {
    if (await isDeliverySelfOnboardingOpen()) return;
    if (await findDeliveryPartnerByPhone(phone)) return;
    throw new NotFoundError(DELIVERY_NOT_FOUND);
}

/** The register endpoints themselves, so the login screen can't be skipped. */
export async function assertRestaurantSignupOpen() {
    if (!(await isRestaurantSelfOnboardingOpen())) throw new ForbiddenError(RESTAURANT_NOT_FOUND);
}

export async function assertDeliverySignupOpen() {
    if (!(await isDeliverySelfOnboardingOpen())) throw new ForbiddenError(DELIVERY_NOT_FOUND);
}
