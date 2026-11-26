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
 * `nextOpeningAt` is when the hours next open it. It is given for the manual
 * cases too, so the admin can see whether the outlet would be open anyway.
 */
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
    };
}

