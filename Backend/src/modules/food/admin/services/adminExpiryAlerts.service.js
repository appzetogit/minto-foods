import { prisma } from '../../../../config/prisma.js';
import { currentAdminScope } from '../../../../core/roles/adminScope.context.js';
import { parseDayBound, getRestaurantTimezone } from '../../../../utils/timezone.js';

/**
 * Promotion banners, offer banners and admin coupons that stop running within
 * the next few days, for the admin notification bell.
 *
 * Nothing is stored: the list is worked out on each read, so extending a
 * banner's end date or switching it off makes its alert go away by itself.
 * The bell keys each alert on the end date, so a banner that is extended and
 * then nears its new end is announced again.
 *
 * Zones: banners carry a zone and the Prisma scope extension already limits
 * them to the admin's zones (a banner for every zone is everyone's). Coupons
 * have no zone; one for all restaurants is everyone's, one for chosen
 * restaurants belongs to the zones those restaurants are in.
 */

export const DEFAULT_ALERT_DAYS = 3;
export const MAX_ALERT_DAYS = 30;

const dayKey = (date) => new Date(date).toLocaleDateString('en-CA', { timeZone: getRestaurantTimezone() });
const addDays = (key, days) => {
    const d = new Date(`${key}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};
/** Whole India days from today to the end date: 0 = ends today. */
const daysBetween = (fromKey, toKey) =>
    Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86400000);

export const endingLabel = (daysLeft) =>
    daysLeft <= 0 ? 'ends today' : daysLeft === 1 ? 'ends tomorrow' : `ends in ${daysLeft} days`;

const displayDate = (date) =>
    new Date(date).toLocaleDateString('en-IN', {
        timeZone: getRestaurantTimezone(), day: 'numeric', month: 'short', year: 'numeric',
    });

const isSuperAdmin = (admin) => !admin?.adminType || admin.adminType === 'super_admin';
const canView = (admin, section) =>
    isSuperAdmin(admin) || (Array.isArray(admin?.permissions?.[section]) && admin.permissions[section].includes('view'));

export async function getAlertDays() {
    const row = await prisma.foodBusinessSettings.findFirst({ select: { expiryAlertDays: true } });
    const days = Number(row?.expiryAlertDays);
    return Number.isInteger(days) && days >= 1 ? Math.min(days, MAX_ALERT_DAYS) : DEFAULT_ALERT_DAYS;
}

/**
 * Coupons for chosen restaurants, kept only when one of those restaurants is
 * in the admin's zones. The restaurant lookup runs under the same scope, so it
 * only ever finds restaurants this admin can see.
 */
async function couponsInScope(coupons) {
    if (!currentAdminScope()) return coupons;
    const chosen = coupons.filter((c) => c.restaurantScope === 'selected');
    const ids = [...new Set(chosen.flatMap((c) => [c.restaurantId, ...(c.restaurantIds || [])]).filter(Boolean))];
    const visible = ids.length
        ? new Set((await prisma.foodRestaurant.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id))
        : new Set();
    return coupons.filter((c) =>
        c.restaurantScope !== 'selected'
        || [c.restaurantId, ...(c.restaurantIds || [])].some((id) => id && visible.has(id)));
}

/**
 * @param {object} [admin] req.adminAccess: which sections the admin may see
 * @param {Date} [now]
 * @returns {Promise<{days: number, items: object[]}>}
 */
export async function getEndingSoon(admin = null, now = new Date()) {
    const days = await getAlertDays();
    const todayKey = dayKey(now);
    // From now until the end of the last day in the window, India time.
    const window = { gte: now, lte: parseDayBound(addDays(todayKey, days), 'end') };

    const showBanners = canView(admin, 'banner_management');
    const showCoupons = canView(admin, 'promotions_management');
    const bannerSelect = { id: true, title: true, imageUrl: true, endDate: true, zoneId: true };

    const [promotion, offer, coupons] = await Promise.all([
        showBanners
            ? prisma.homePromotionBanner.findMany({ where: { isActive: true, endDate: window }, select: bannerSelect })
            : [],
        showBanners
            ? prisma.foodOfferBanner.findMany({ where: { isActive: true, endDate: window }, select: bannerSelect })
            : [],
        showCoupons
            ? prisma.foodOffer.findMany({
                where: { status: 'active', createdByRole: 'ADMIN', endDate: window },
                select: {
                    id: true, couponCode: true, endDate: true, discountType: true, discountValue: true,
                    restaurantScope: true, restaurantId: true, restaurantIds: true,
                },
            })
            : [],
    ]);
    const scopedCoupons = await couponsInScope(coupons);

    const zoneIds = [...new Set([...promotion, ...offer].map((b) => b.zoneId).filter(Boolean))];
    const zones = zoneIds.length
        ? await prisma.foodZone.findMany({ where: { id: { in: zoneIds } }, select: { id: true, name: true } })
        : [];
    const zoneName = (id) => (id ? zones.find((z) => z.id === id)?.name || 'One zone' : 'All zones');

    const item = (kind, row, fields) => {
        const daysLeft = daysBetween(todayKey, dayKey(row.endDate));
        return {
            kind,
            id: row.id,
            endDate: row.endDate,
            endDateLabel: displayDate(row.endDate),
            daysLeft,
            endingLabel: endingLabel(daysLeft),
            ...fields,
        };
    };

    const items = [
        ...promotion.map((b) => item('promotion_banner', b, {
            typeLabel: 'Promotional banner',
            title: b.title || 'Untitled banner',
            imageUrl: b.imageUrl,
            zoneName: zoneName(b.zoneId),
            path: '/admin/food/promotional-banner',
        })),
        ...offer.map((b) => item('offer_banner', b, {
            typeLabel: 'Offer banner',
            title: b.title || 'Untitled banner',
            imageUrl: b.imageUrl,
            zoneName: zoneName(b.zoneId),
            path: '/admin/food/offer-banners',
        })),
        ...scopedCoupons.map((c) => item('coupon', c, {
            typeLabel: 'Coupon',
            title: c.couponCode,
            zoneName: c.restaurantScope === 'selected' ? 'Selected restaurants' : 'All restaurants',
            path: '/admin/food/coupons',
        })),
    ].sort((a, b) => new Date(a.endDate) - new Date(b.endDate));

    return { days, items };
}
