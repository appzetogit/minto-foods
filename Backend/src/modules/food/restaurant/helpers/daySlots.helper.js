/**
 * A day's opening hours, as one or more windows.
 *
 * A restaurant that shuts between lunch and dinner could not say so: a day held
 * exactly one `openingTime`/`closingTime` pair, so the only way to express
 * "11–3 and 7–11" was to claim to be open through the afternoon and take orders
 * nobody was there to cook.
 *
 * The stored shape gains `slots` and **keeps** `openingTime`/`closingTime`,
 * which mirror the first slot. That is deliberate: every reader of this JSON --
 * the open-now check, the storefront, the admin editor, dispatch, and whatever
 * app build a customer happens to have installed -- reads the pair, and changing
 * the shape underneath them would make restaurants silently appear closed. A
 * restaurant wrongly shown shut loses real orders and nobody reports it as a
 * bug. So old readers keep seeing the first window and behave exactly as before;
 * new ones read `slots` and see all of them.
 *
 * The pair can be dropped once nothing reads it, which is a separate decision
 * from this one.
 */

/** Minutes since midnight, or null when it is not a time. */
export const parseTimeToMinutes = (value) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
};

const toTime = (value, fallback = null) => {
    const minutes = parseTimeToMinutes(value);
    if (minutes === null) return fallback;
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

/** How many windows a single day may have. Two covers lunch and dinner. */
export const MAX_SLOTS_PER_DAY = 3;

/**
 * Read whatever shape a stored day is in and return its windows.
 *
 * Accepts a day carrying `slots`, a day carrying only the legacy pair, or both.
 * A day with neither returns no windows, which callers read as "no explicit
 * hours" rather than "closed" -- the same thing the pair meant when absent.
 */
export const readSlots = (entry) => {
    if (!entry || typeof entry !== 'object') return [];

    if (Array.isArray(entry.slots) && entry.slots.length) {
        return entry.slots
            .map((slot) => ({
                open: toTime(slot?.open ?? slot?.openingTime),
                close: toTime(slot?.close ?? slot?.closingTime),
            }))
            .filter((slot) => slot.open && slot.close);
    }

    const open = toTime(entry.openingTime);
    const close = toTime(entry.closingTime);
    return open && close ? [{ open, close }] : [];
};

/**
 * Is a moment inside any of the day's windows?
 *
 * A window whose close is earlier than its open runs past midnight -- 22:00 to
 * 02:00 is a real thing a kitchen does, and treating it as an empty range would
 * shut the restaurant at ten.
 */
export const isWithinAnySlot = (slots, nowMinutes) => {
    if (!Array.isArray(slots) || !slots.length) return true;

    return slots.some((slot) => {
        const open = parseTimeToMinutes(slot.open);
        const close = parseTimeToMinutes(slot.close);
        if (open === null || close === null) return true;
        // Open and close the same is "all day", which is how the single-pair
        // reader has always treated it.
        if (open === close) return true;
        return close > open
            ? nowMinutes >= open && nowMinutes <= close
            : nowMinutes >= open || nowMinutes <= close;
    });
};

/**
 * Put a day into the stored shape.
 *
 * Writes `slots` and mirrors the first window into the legacy pair, so a reader
 * that knows nothing about slots still sees a coherent day.
 */
export const normalizeDaySlots = (entry, { day, defaultOpen = '09:00', defaultClose = '22:00' } = {}) => {
    const isOpen = entry?.isOpen !== false;

    if (!isOpen) {
        return { day, isOpen: false, openingTime: '', closingTime: '', slots: [] };
    }

    let slots = readSlots(entry);
    if (!slots.length) slots = [{ open: defaultOpen, close: defaultClose }];

    // Ordered by opening time so "lunch, then dinner" reads in that order
    // wherever it is shown, whatever order it was entered in.
    slots = slots
        .slice(0, MAX_SLOTS_PER_DAY)
        .sort((a, b) => parseTimeToMinutes(a.open) - parseTimeToMinutes(b.open));

    return {
        day,
        isOpen: true,
        // The first window, for every reader that predates slots.
        openingTime: slots[0].open,
        closingTime: slots[0].close,
        slots,
    };
};
