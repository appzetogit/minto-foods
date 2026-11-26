import { getNextOpeningAt, getRestaurantOperationalStatus } from './restaurantAvailability.helper.js';
import { toRestaurantIsoString } from '../../../../utils/timezone.js';

/**
 * Online or offline right now, why, and until when -- what the customer apps
 * see, explained for the admin list.
 *
 *   online              taking orders; open till the current slot closes
 *   offline-admin       switched off by an admin; stays off until an admin
 *                       turns it back on
 *   offline-restaurant  switched off from the restaurant app; stays off until
 *                       the restaurant (or an admin) turns it back on
 *   outside-hours       switch is on but now is outside today's slots; comes
 *                       back by itself at the next slot
 *   closed-day          switch is on but today is marked closed
 *   zone-inactive       its zone is switched off, so no customer sees it
 *
 * The restaurant app can also go offline with a reason, for a while
 * (offlineUntil) or on a schedule (offlineFrom); those come back as
 * offlineReason, backOnlineAt and breakFrom/breakUntil.
 *
 * `nextOpeningAt` is when the hours next open it. It is given for the manual
 * cases too, so the admin can see whether the outlet would be open anyway.
 */
const isoOrNull = (value) => {
    if (!value) return null;
    const at = value instanceof Date ? value : new Date(value);
    return Number.isNaN(at.getTime()) ? null : toRestaurantIsoString(at);
};

export const LIVE_STATUS_CODES = [
    'online', 'offline-admin', 'offline-restaurant', 'outside-hours', 'closed-day', 'zone-inactive',
];

export function describeLiveStatus(restaurant, now = new Date()) {
    const op = getRestaurantOperationalStatus(restaurant, now);
    const nextOpen = op.isOpen ? null : getNextOpeningAt(restaurant, now);

    let code;
    if (restaurant?.zone && restaurant.zone.isActive === false) code = 'zone-inactive';
    else if (!op.isAcceptingOrders) code = restaurant?.offlineByAdmin ? 'offline-admin' : 'offline-restaurant';
    else if (op.isOpen) code = 'online';
    else if (op.reason === 'closed-day') code = 'closed-day';
    else code = 'outside-hours';

    return {
        code,
        online: code === 'online',
        switchOn: op.isAcceptingOrders,
        withinHours: op.isOpen,
        openingTime: op.openingTime || null,
        closingTime: op.closingTime || null,
        nextOpeningAt: nextOpen ? toRestaurantIsoString(nextOpen) : null,
        // What the restaurant typed when it went offline ("Kitchen is full").
        offlineReason: String(restaurant?.offlineReason || '').trim(),
        // "Offline for 2 hours": the scheduler turns it back on at this time.
        // Never for an admin's offline, which the scheduler leaves alone.
        backOnlineAt: !op.isAcceptingOrders && !restaurant?.offlineByAdmin
            ? isoOrNull(restaurant?.offlineUntil)
            : null,
        // A break booked for later, while it is still on.
        breakFrom: isoOrNull(restaurant?.offlineFrom),
        breakUntil: restaurant?.offlineFrom ? isoOrNull(restaurant?.offlineUntil) : null,
    };
}

