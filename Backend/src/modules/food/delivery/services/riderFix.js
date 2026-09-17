/**
 * Which rider GPS fixes are good enough to show a customer.
 *
 * Every fix used to go straight to the tracking screen. Phones return badly
 * wrong positions all the time -- under a flyover, in a narrow lane, for the
 * first seconds after waking -- and each one slid the bike onto a building and
 * back. The customer app animates smoothly between whatever it is given, so the
 * cure is not to give it those points.
 *
 * Two rules, both from what a delivery on a bike can physically do:
 *  - the phone must claim reasonable accuracy, and
 *  - reaching the new point from the last good one must not need an impossible
 *    speed.
 *
 * Neither rule may freeze the map. If nothing has been accepted for a while, a
 * rider genuinely somewhere with poor signal, or who really did move while the
 * app was asleep, is let through rather than left stranded on the last point.
 *
 * Pure, and state is kept per order in a small tracker, so the whole thing is
 * tested without a socket or a database.
 */

/** Worse than this, a fix is not trusted while better ones are arriving. */
export const MAX_ACCURACY_M = 50;
/** Never trusted, however long since the last good fix: it is noise, not a place. */
export const HARD_MAX_ACCURACY_M = 500;
/** Faster than any bike in city traffic; anything above is a GPS jump. */
export const MAX_SPEED_KMH = 120;
/** After this long without a good fix, take what comes rather than freeze. */
export const STALE_AFTER_MS = 30_000;
/** How often a rider's position is written to the database. */
export const SAVE_EVERY_MS = 15_000;
/** Orders not heard from in this long are forgotten. */
const FORGET_AFTER_MS = 15 * 60_000;

const EARTH_RADIUS_M = 6_371_000;
const rad = (deg) => (deg * Math.PI) / 180;

export function distanceMeters(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * @param {{ lat: number, lng: number, at: number } | null} previous  last accepted fix
 * @param {{ lat: number, lng: number, accuracy?: number|null, at: number }} fix
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkRiderFix(previous, fix) {
    // 0,0 is what a phone reports before it has any position at all.
    if (fix.lat === 0 && fix.lng === 0) return { ok: false, reason: 'no-position' };

    const accuracy = Number(fix.accuracy);
    const knowsAccuracy = Number.isFinite(accuracy) && accuracy > 0;
    if (knowsAccuracy && accuracy > HARD_MAX_ACCURACY_M) return { ok: false, reason: 'inaccurate' };

    const stale = !previous || fix.at - previous.at > STALE_AFTER_MS;
    if (stale) return { ok: true };

    if (knowsAccuracy && accuracy > MAX_ACCURACY_M) return { ok: false, reason: 'inaccurate' };

    // At least a second, so two fixes a few milliseconds apart cannot turn a
    // metre of jitter into a thousand km/h.
    const seconds = Math.max((fix.at - previous.at) / 1000, 1);
    const kmh = (distanceMeters(previous, fix) / seconds) * 3.6;
    if (kmh > MAX_SPEED_KMH) return { ok: false, reason: 'implausible-jump' };

    return { ok: true };
}

/**
 * Remembers the last good fix and last save for each order.
 *
 * One tracker for the process, not one per socket: a rider whose connection
 * drops and returns should be judged against where they actually were.
 */
export function createRiderFixTracker({ now = () => Date.now() } = {}) {
    const lastGood = new Map();
    const lastSaved = new Map();
    let calls = 0;

    const sweep = (at) => {
        for (const [key, fix] of lastGood) {
            if (at - fix.at > FORGET_AFTER_MS) {
                lastGood.delete(key);
                lastSaved.delete(key);
            }
        }
    };

    return {
        /** Judge a fix; a good one becomes the reference for the next. */
        accept(orderId, fix) {
            const key = String(orderId);
            const at = fix.at ?? now();
            if (++calls % 500 === 0) sweep(at);
            const verdict = checkRiderFix(lastGood.get(key) || null, { ...fix, at });
            if (verdict.ok) lastGood.set(key, { lat: fix.lat, lng: fix.lng, at });
            return verdict;
        },

        /** True at most once per SAVE_EVERY_MS for an order; records the save. */
        shouldSave(orderId, at = now()) {
            const key = String(orderId);
            const last = lastSaved.get(key) || 0;
            if (at - last < SAVE_EVERY_MS) return false;
            lastSaved.set(key, at);
            return true;
        },

        size: () => lastGood.size,
    };
}
