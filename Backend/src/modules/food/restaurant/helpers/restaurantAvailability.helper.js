import {
  getPreviousDayName,
  getRestaurantLocalTimeParts,
  toRestaurantIsoString,
} from '../../../../utils/timezone.js';
import { readSlots } from './daySlots.helper.js';

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const normalizeDay = (value) => {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  const match = DAY_NAMES.find((day) => day.toLowerCase() === trimmed);
  if (match) return match;
  const abbreviatedMatch = DAY_NAMES.find((day) =>
    day.toLowerCase().startsWith(trimmed.slice(0, 3)),
  );
  return abbreviatedMatch || null;
};

const parseTimeToMinutes = (timeValue) => {
  if (!timeValue || typeof timeValue !== 'string') return null;
  const raw = timeValue.trim();
  if (!raw) return null;

  const normalized = raw.toLowerCase();
  const meridiemMatch = normalized.match(/^(\d{1,2}):(\d{2})\s*([ap]m)$/);
  if (meridiemMatch) {
    let hour = Number(meridiemMatch[1]);
    const minute = Number(meridiemMatch[2]);
    const period = meridiemMatch[3];
    if (Number.isNaN(hour) || Number.isNaN(minute) || minute < 0 || minute > 59) return null;
    if (period === 'pm' && hour < 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
    if (hour < 0 || hour > 23) return null;
    return hour * 60 + minute;
  }

  const twentyFourHourMatch = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (!twentyFourHourMatch) return null;

  const hour = Number(twentyFourHourMatch[1]);
  const minute = Number(twentyFourHourMatch[2]);
  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return hour * 60 + minute;
};

const getTimingForSource = (source, dayName) => {
  if (!source || typeof source !== 'object') return null;

  const outletTimingsArray = source?.timings;
  if (Array.isArray(outletTimingsArray)) {
    const exact = outletTimingsArray.find((entry) => normalizeDay(entry?.day) === dayName);
    if (exact) return exact;
  }

  if (!Array.isArray(source)) {
    const direct = source[dayName];
    if (direct && typeof direct === 'object') return direct;
  }

  return null;
};

const getTodayTiming = (restaurant, dayName) => {
  const fromOutlet = getTimingForSource(restaurant?.outletTimings, dayName);
  if (fromOutlet) return fromOutlet;
  return null;
};

/**
 * One day's opening windows, in minutes, or a closed day.
 *
 * Reads `slots` when the day has them (lunch and dinner), otherwise the single
 * opening/closing pair -- from the day, the delivery timings or the restaurant,
 * in that order, as before.
 */
const readDay = (restaurant, dayName) => {
  const timing = getTodayTiming(restaurant, dayName);
  if (timing && timing.isOpen === false) {
    return { dayName, closedDay: true, windows: [], hasWindow: true };
  }

  const openDays = Array.isArray(restaurant?.openDays) ? restaurant.openDays : [];
  if (!timing && openDays.length > 0) {
    const normalizedOpenDays = new Set(openDays.map((d) => normalizeDay(d)).filter(Boolean));
    if (normalizedOpenDays.size > 0 && !normalizedOpenDays.has(dayName)) {
      return { dayName, closedDay: true, windows: [], hasWindow: true };
    }
  }

  let windows = readSlots(timing).map((slot) => ({
    open: parseTimeToMinutes(slot.open),
    close: parseTimeToMinutes(slot.close),
    openingTime: slot.open,
    closingTime: slot.close,
  }));

  let hasWindow = windows.length > 0;
  if (!windows.length) {
    const openingTime =
      timing?.openingTime || restaurant?.deliveryTimings?.openingTime || restaurant?.openingTime || null;
    const closingTime =
      timing?.closingTime || restaurant?.deliveryTimings?.closingTime || restaurant?.closingTime || null;
    hasWindow = Boolean(openingTime || closingTime);
    const open = parseTimeToMinutes(openingTime);
    const close = parseTimeToMinutes(closingTime);
    if (open !== null && close !== null) windows = [{ open, close, openingTime, closingTime }];
  }

  return { dayName, closedDay: false, windows: windows.filter((w) => w.open !== null && w.close !== null), hasWindow };
};

/**
 * Is the restaurant open at `now`, and which window is it in?
 *
 * A window whose closing time is earlier than its opening time runs past
 * midnight: Wednesday 16:00-02:00 is open Wednesday from 16:00 to midnight AND
 * Thursday from midnight to 02:00. The part after midnight belongs to the day
 * it started on -- it used to be credited to the current day's own window, so
 * a restaurant shut on Wednesday still showed open at 1am Thursday. And every
 * window of yesterday is checked, not just the first, so "lunch, then dinner
 * until 2am" stays open after midnight.
 */
const evaluateSchedule = (restaurant, now) => {
  const { dayName, nowMinutes } = getRestaurantLocalTimeParts(now);
  const today = readDay(restaurant, dayName);
  const yesterday = readDay(restaurant, getPreviousDayName(dayName));

  // No hours set anywhere for today is no restriction, as it always was.
  const unrestricted = !today.closedDay && !today.hasWindow;

  const todayWindow = today.windows.find((w) => {
    if (w.open === w.close) return true; // all day
    return w.close > w.open
      ? nowMinutes >= w.open && nowMinutes <= w.close
      : nowMinutes >= w.open; // overnight: today's part runs to midnight
  });
  const carriedWindow = yesterday.closedDay
    ? null
    : yesterday.windows.find((w) => w.close < w.open && nowMinutes <= w.close);

  const isOpen = unrestricted || Boolean(todayWindow) || Boolean(carriedWindow);
  const active = todayWindow || carriedWindow || today.windows[0] || null;

  return {
    isOpen,
    todayClosedDay: today.closedDay,
    carriedOver: !todayWindow && Boolean(carriedWindow),
    hasWindow: carriedWindow ? true : today.hasWindow,
    openingTime: active?.openingTime || null,
    closingTime: active?.closingTime || null,
    dayName: carriedWindow && !todayWindow ? yesterday.dayName : dayName,
  };
};

export function getOutletScheduleStatus(restaurant, now = new Date()) {
  if (!restaurant) {
    return {
      isOpen: true,
      isDayClosed: false,
      isWithinTimings: true,
      hasConfiguredHours: false,
      reason: 'no-restaurant',
    };
  }

  const schedule = evaluateSchedule(restaurant, now);
  const scheduleOpen = schedule.isOpen;

  return {
    isOpen: scheduleOpen,
    isDayClosed: schedule.todayClosedDay && !schedule.carriedOver,
    isWithinTimings: scheduleOpen,
    hasConfiguredHours: schedule.hasWindow,
    openingTime: schedule.openingTime,
    closingTime: schedule.closingTime,
    dayName: schedule.dayName,
    reason: scheduleOpen
      ? 'within-hours'
      : schedule.todayClosedDay
        ? 'closed-day'
        : schedule.hasWindow
          ? 'outside-hours'
          : 'no-timings',
  };
}

export function getRestaurantOperationalStatus(restaurant, now = new Date()) {
  const schedule = getOutletScheduleStatus(restaurant, now);
  // Manual toggle OFF (isAcceptingOrders=false) always wins over outlet timings.
  // Toggle ON only clears the override — availability then follows outlet timings.
  const isAcceptingOrders = restaurant?.isAcceptingOrders !== false;
  const outsideHoursOverride = false;
  const isEffectivelyOnline = isAcceptingOrders && schedule.isOpen;

  return {
    ...schedule,
    isAcceptingOrders,
    outsideHoursOverride,
    isEffectivelyOnline,
    reason: !isAcceptingOrders
      ? 'not-accepting-orders'
      : schedule.isOpen
        ? 'open'
        : schedule.reason,
  };
}

export function getRestaurantAvailabilityStatus(restaurant, now = new Date(), options = {}) {
  if (!restaurant) {
    return {
      isOpen: false,
      isActive: false,
      isAcceptingOrders: false,
      isWithinTimings: false,
      reason: 'missing-restaurant',
    };
  }

  const ignoreOperationalStatus = options?.ignoreOperationalStatus === true;
  const isActive = restaurant.isActive !== false;
  const isAcceptingOrders = restaurant.isAcceptingOrders !== false;

  if (!ignoreOperationalStatus && !isActive) {
    return {
      isOpen: false,
      isActive,
      isAcceptingOrders,
      isWithinTimings: false,
      reason: 'inactive',
    };
  }

  if (!ignoreOperationalStatus && !isAcceptingOrders) {
    return {
      isOpen: false,
      isActive,
      isAcceptingOrders,
      isWithinTimings: false,
      reason: 'not-accepting-orders',
    };
  }

  const schedule = evaluateSchedule(restaurant, now);
  const isOpenNow = schedule.isOpen;

  return {
    isOpen: isOpenNow,
    isActive,
    isAcceptingOrders,
    isWithinTimings: isOpenNow,
    openingTime: schedule.openingTime,
    closingTime: schedule.closingTime,
    reason: isOpenNow
      ? isAcceptingOrders
        ? 'open'
        : 'open-by-timings'
      : schedule.hasWindow
        ? 'outside-hours'
        : 'no-timings',
  };
}

export function assertRestaurantAcceptingOrders(restaurant, at = new Date()) {
  const availability = getRestaurantAvailabilityStatus(restaurant, at);
  if (availability.isOpen) return availability;

  if (availability.reason === 'not-accepting-orders') {
    throw new Error('RESTAURANT_OFFLINE');
  }

  throw new Error('RESTAURANT_CLOSED');
}

/**
 * When a closed restaurant next opens by its hours, as a Date, or null when no
 * opening is found in the coming week.
 *
 * Walks today's remaining windows, then each following day's, in order. A day
 * with no hours of its own is open from midnight, as the open-now check reads
 * it. Ignores the manual switch: callers decide whether a switched-off
 * restaurant gets a time at all.
 */
export function getNextOpeningAt(restaurant, now = new Date()) {
  if (!restaurant) return null;
  const { dayName, nowMinutes } = getRestaurantLocalTimeParts(now);
  const todayIndex = Math.max(0, DAY_NAMES.indexOf(dayName));
  const minuteStart = now.getTime() - (now.getTime() % 60000);
  const at = (minutesFromTodayMidnight) =>
    new Date(minuteStart + (minutesFromTodayMidnight - nowMinutes) * 60000);

  for (let offset = 0; offset <= 7; offset += 1) {
    const day = readDay(restaurant, DAY_NAMES[(todayIndex + offset) % 7]);
    if (day.closedDay) continue;
    if (!day.hasWindow) {
      // Today with no hours would already be open, so only a later day counts.
      if (offset > 0) return at(offset * 1440);
      continue;
    }
    const opens = day.windows
      .map((w) => w.open)
      .filter((open) => offset > 0 || open > nowMinutes)
      .sort((a, b) => a - b);
    if (opens.length) return at(offset * 1440 + opens[0]);
  }
  return null;
}

/**
 * A restaurant with the open-now fields every customer list returns:
 * isOpenNow / isOpen / openStatusReason, the effective isAcceptingOrders, the
 * window's hours, and nextOpeningAt when it is closed by its hours.
 *
 * Open means the restaurant's switch AND its hours (overnight hours included).
 * The apps read `isAcceptingOrders` as "can I order from here now". It used to
 * be only the switch in the restaurant panel, so a restaurant open 4pm-2am
 * showed as open at 11am and the order was then refused. It is now the real
 * answer; the switch itself is still there as `manualAcceptingOrders`.
 * `openingTime`/`closingTime` become today's current (or next) window.
 *
 * nextOpeningAt is null while open, and when switched off by hand -- the
 * hours cannot say when someone will switch it back on.
 */
export function withOpenStatus(restaurant, now = new Date()) {
  if (!restaurant) return restaurant;
  const status = getRestaurantOperationalStatus({ ...restaurant, outsideHoursOverride: false }, now);
  const next = status.isEffectivelyOnline || status.reason === 'not-accepting-orders'
    ? null
    : getNextOpeningAt(restaurant, now);
  return {
    ...restaurant,
    manualAcceptingOrders: restaurant.isAcceptingOrders !== false,
    isAcceptingOrders: status.isEffectivelyOnline,
    isOpen: status.isEffectivelyOnline,
    isOpenNow: status.isEffectivelyOnline,
    openStatusReason: status.reason,
    openingTime: status.openingTime || restaurant.openingTime || null,
    closingTime: status.closingTime || restaurant.closingTime || null,
    nextOpeningAt: next ? toRestaurantIsoString(next) : null,
  };
}

export function shouldAutoTurnOffAcceptingOrders(restaurant, now = new Date()) {
  // Toggle ON must remain sticky so outlet timings can control availability.
  // Never auto-flip isAcceptingOrders off just because the schedule is closed.
  void restaurant;
  void now;
  return false;
}
