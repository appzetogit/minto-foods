/**
 * Every rule about whether a coupon applies, in one place.
 *
 * Checkout, the public offers list and the restaurant's own offers screen all
 * ask the same questions -- is it live, is it today, has this customer used it
 * up -- and when each answered them separately they drifted: the list showed
 * codes checkout would refuse. Everything here is pure, so it is tested without
 * a database, and the callers fetch only the counts a rule actually needs.
 *
 * Times are India time. The platform operates in one timezone with no daylight
 * saving, so a fixed +05:30 offset is exact and does not depend on how the
 * server's clock is configured.
 */

export const IST_OFFSET_MINUTES = 330;
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------------------------------------------------------------------------
// Enum spellings
// ---------------------------------------------------------------------------

/**
 * The database stores 'flat-price' and 'first-time', but Prisma names those
 * values flat_price and first_time and rejects the hyphenated spelling. The
 * validator used to pass the hyphenated form straight through, so no flat or
 * first-order coupon could ever be created. Both spellings are accepted from
 * clients; only Prisma's is ever handed on.
 */
export const normalizeDiscountType = (value) => {
    const v = String(value ?? '').trim().toLowerCase().replace(/-/g, '_');
    return v === 'percentage' || v === 'flat_price' ? v : null;
};

export const normalizeCustomerScope = (value) => {
    const v = String(value ?? '').trim().toLowerCase().replace(/-/g, '_');
    return v === 'all' || v === 'first_time' || v === 'specific' ? v : null;
};

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** "HH:mm" -> minutes after midnight, or null if it is not a real time. */
export const parseClock = (value) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Day of week and minutes after midnight, in India time. */
export const istClock = (now = new Date()) => {
    const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60000);
    return { day: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
};

/**
 * Days as a sorted, de-duplicated list. All seven days is stored as the empty
 * list, so "every day" has exactly one representation.
 */
export const normalizeActiveDays = (days) => {
    if (!Array.isArray(days)) return [];
    const set = [...new Set(days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    return set.length === 7 ? [] : set;
};

/**
 * Whether now falls inside the coupon's days and daily window.
 *
 * An overnight window (22:00 -> 02:00) belongs to the day it started: the 01:00
 * after a Friday-night window counts as Friday, which is what a restaurant
 * running "late night Fridays" means.
 */
export const checkSchedule = (offer, now = new Date()) => {
    const days = normalizeActiveDays(offer?.activeDays);
    const from = parseClock(offer?.activeFromTime);
    const to = parseClock(offer?.activeToTime);
    const { day, minutes } = istClock(now);

    const hasWindow = from !== null && to !== null && from !== to;
    const overnight = hasWindow && to < from;

    // The calendar day the current window opened on.
    const windowDay = overnight && minutes < to ? (day + 6) % 7 : day;

    if (days.length && !days.includes(hasWindow ? windowDay : day)) {
        return { ok: false, code: 'wrong-day' };
    }
    if (hasWindow) {
        const inside = overnight ? minutes >= from || minutes < to : minutes >= from && minutes < to;
        if (!inside) return { ok: false, code: 'wrong-time' };
    }
    return { ok: true };
};

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const rupees = (n) => {
    const v = Number(n) || 0;
    return `₹${Number.isInteger(v) ? v : v.toFixed(2)}`;
};

/** "Mon-Fri", "Sat, Sun", or "" for every day. */
export const describeDays = (days) => {
    const list = normalizeActiveDays(days);
    if (!list.length) return '';
    // A contiguous run of three or more reads better as a range.
    const contiguous = list.length >= 3 && list.every((d, i) => i === 0 || d === list[i - 1] + 1);
    return contiguous
        ? `${DAY_NAMES[list[0]]}-${DAY_NAMES[list[list.length - 1]]}`
        : list.map((d) => DAY_NAMES[d]).join(', ');
};

/** "50% OFF up to ₹100" / "₹75 OFF". */
export const describeDiscount = (offer) => {
    const value = Number(offer?.discountValue) || 0;
    if (normalizeDiscountType(offer?.discountType) === 'percentage') {
        const cap = Number(offer?.maxDiscount) || 0;
        return cap > 0 ? `${value}% OFF up to ${rupees(cap)}` : `${value}% OFF`;
    }
    return `${rupees(value)} OFF`;
};

/** The conditions under the headline, as short phrases. */
export const describeConditions = (offer) => {
    const parts = [];
    const min = Number(offer?.minOrderValue) || 0;
    if (min > 0) parts.push(`on orders above ${rupees(min)}`);
    const days = describeDays(offer?.activeDays);
    if (days) parts.push(days);
    if (offer?.activeFromTime && offer?.activeToTime) parts.push(`${offer.activeFromTime}-${offer.activeToTime}`);
    if (offer?.newToRestaurantOnly) parts.push('new customers only');
    else if (normalizeCustomerScope(offer?.customerScope) === 'first_time' || offer?.isFirstOrderOnly) {
        parts.push('first order only');
    }
    const perUser = Number(offer?.perUserLimit) || 0;
    if (perUser === 1) parts.push('once per customer');
    else if (perUser > 1) parts.push(`${perUser} times per customer`);
    return parts;
};

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** When the coupon stops, as checkout has always read it. */
const effectiveEnd = (offer) => {
    if (!offer?.endDate) return null;
    const end = new Date(offer.endDate);
    // Unchanged from the original checkout: an end stamped exactly midnight
    // (server clock) is taken to mean the whole of that day.
    if (end.getHours() === 0 && end.getMinutes() === 0) end.setHours(23, 59, 59, 999);
    return end;
};

const MESSAGES = {
    'not-found': () => 'Invalid coupon code',
    inactive: () => 'This coupon is not active right now',
    'not-started': (o) => `This coupon starts on ${new Date(o.startDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}`,
    expired: () => 'This coupon has expired',
    'wrong-restaurant': () => 'This coupon is not valid at this restaurant',
    'not-for-you': () => 'This coupon is not available on your account',
    'first-order': () => 'This coupon is valid on your first order only',
    'new-to-restaurant': () => 'This coupon is only for your first order from this restaurant',
    'wrong-day': (o) => `This coupon works on ${describeDays(o.activeDays)} only`,
    'wrong-time': (o) => `This coupon works between ${o.activeFromTime} and ${o.activeToTime}`,
    'fully-redeemed': () => 'This coupon has been fully redeemed',
    'used-up': (o) => (Number(o.perUserLimit) === 1
        ? 'You have already used this coupon'
        : `You have used this coupon the maximum ${Number(o.perUserLimit)} times`),
    'min-order': (o, ctx) => `Add ${rupees(Math.max(0, (Number(o.minOrderValue) || 0) - (Number(ctx.subtotal) || 0)))} more to use this coupon`,
};

const refuse = (code, offer, ctx = {}) => ({ ok: false, code, message: MESSAGES[code](offer || {}, ctx) });

/**
 * Whether a coupon applies to this cart, and if not, the one reason worth
 * showing the customer.
 *
 * Checks run in the order a customer can act on them: things they cannot change
 * (expired, wrong restaurant) before things they can (add more to the cart), so
 * "Add ₹40 more" is never shown for a code that would still fail afterwards.
 *
 * Counts are passed in rather than fetched, and only matter when the offer uses
 * them: usageCount when perUserLimit is set, priorOrders for first-order-only,
 * priorOrdersHere for new-to-restaurant.
 *
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export const checkOfferEligibility = ({
    offer,
    subtotal = 0,
    restaurantId = '',
    userId = null,
    now = new Date(),
    usageCount = 0,
    priorOrders = 0,
    priorOrdersHere = 0,
} = {}) => {
    if (!offer) return refuse('not-found');
    const ctx = { subtotal };

    if (offer.status !== 'active' || offer.showInCart === false) return refuse('inactive', offer);
    if (offer.startDate && now < new Date(offer.startDate)) return refuse('not-started', offer);
    const end = effectiveEnd(offer);
    if (end && now > end) return refuse('expired', offer);

    if (offer.restaurantScope === 'selected') {
        const ids = Array.isArray(offer.restaurantIds) && offer.restaurantIds.length
            ? offer.restaurantIds
            : [offer.restaurantId].filter(Boolean);
        if (!ids.some((id) => String(id) === String(restaurantId || ''))) return refuse('wrong-restaurant', offer);
    }

    const signedIn = Boolean(userId);
    const scope = normalizeCustomerScope(offer.customerScope);

    // Without a signed-in customer there is nobody to match an allow-list against.
    if (scope === 'specific') {
        const allow = Array.isArray(offer.customerIds) ? offer.customerIds.map(String) : [];
        if (!signedIn || !allow.includes(String(userId))) return refuse('not-for-you', offer);
    }

    // History checks need a customer; an anonymous cart preview is not refused
    // on them, and the order itself is always placed signed in.
    if (signedIn && (scope === 'first_time' || offer.isFirstOrderOnly === true) && Number(priorOrders) > 0) {
        return refuse('first-order', offer);
    }
    if (signedIn && offer.newToRestaurantOnly === true && Number(priorOrdersHere) > 0) {
        return refuse('new-to-restaurant', offer);
    }

    const schedule = checkSchedule(offer, now);
    if (!schedule.ok) return refuse(schedule.code, offer);

    if (Number(offer.usageLimit) > 0 && Number(offer.usedCount || 0) >= Number(offer.usageLimit)) {
        return refuse('fully-redeemed', offer);
    }
    if (signedIn && Number(offer.perUserLimit) > 0 && Number(usageCount) >= Number(offer.perUserLimit)) {
        return refuse('used-up', offer);
    }

    if ((Number(subtotal) || 0) < (Number(offer.minOrderValue) || 0)) return refuse('min-order', offer, ctx);

    return { ok: true };
};

/**
 * The rupee discount for a cart that qualifies. Unchanged from checkout: whole
 * rupees, rounded down, never more than the item total.
 */
export const computeOfferDiscount = (offer, subtotal) => {
    const total = Number(subtotal) || 0;
    if (normalizeDiscountType(offer?.discountType) === 'percentage') {
        const raw = total * ((Number(offer.discountValue) || 0) / 100);
        const capped = Number(offer.maxDiscount) ? Math.min(raw, Number(offer.maxDiscount)) : raw;
        return Math.max(0, Math.min(total, Math.floor(capped)));
    }
    return Math.max(0, Math.min(total, Math.floor(Number(offer?.discountValue) || 0)));
};

/**
 * Where an offer is in its life, for the restaurant's list. Ignores the daily
 * schedule on purpose: a lunch offer is still "live" at 5pm, just not usable
 * that minute.
 */
export const offerLifecycle = (offer, now = new Date()) => {
    if (!offer) return 'inactive';
    const end = effectiveEnd(offer);
    if (end && now > end) return 'expired';
    if (Number(offer.usageLimit) > 0 && Number(offer.usedCount || 0) >= Number(offer.usageLimit)) return 'exhausted';
    if (offer.status === 'paused') return 'paused';
    if (offer.status !== 'active') return 'ended';
    if (offer.startDate && now < new Date(offer.startDate)) return 'scheduled';
    return 'live';
};
