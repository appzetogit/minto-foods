const RESTAURANT_TIMEZONE =
  process.env.RESTAURANT_TIMEZONE?.trim() || 'Asia/Kolkata';

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const getPartValue = (parts, type) =>
  parts.find((part) => part.type === type)?.value ?? null;

export const getRestaurantTimezone = () => RESTAURANT_TIMEZONE;

export const getRestaurantLocalTimeParts = (
  date = new Date(),
  timeZone = RESTAURANT_TIMEZONE,
) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  let hour = Number(getPartValue(parts, 'hour'));
  if (!Number.isFinite(hour)) hour = 0;
  if (hour === 24) hour = 0;

  const minute = Number(getPartValue(parts, 'minute'));
  const dayName = getPartValue(parts, 'weekday');

  return {
    dayName: DAY_NAMES.includes(dayName) ? dayName : DAY_NAMES[date.getDay()],
    nowMinutes: hour * 60 + (Number.isFinite(minute) ? minute : 0),
  };
};

export const getPreviousDayName = (dayName) => {
  const index = DAY_NAMES.indexOf(dayName);
  if (index < 0) return DAY_NAMES[6];
  return DAY_NAMES[(index + 6) % 7];
};

/**
 * A schedule bound typed by an admin, in India time.
 *
 * Date pickers send a bare day like "2026-09-25". Read with `new Date()` that
 * is midnight UTC -- 5:30 AM in India -- so a banner or campaign "ending on
 * the 25th" stopped at 5:30 that morning instead of that night. A bare day is
 * now the whole day: a start begins at 00:00 IST and an end runs to 23:59:59
 * IST. A value that already carries a time is taken as it is.
 *
 * Returns undefined for blank, null for an unreadable value, else a Date.
 */
export const parseDayBound = (value, edge = 'start') => {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (!raw || raw === 'null') return undefined;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T${edge === 'end' ? '23:59:59.999' : '00:00:00.000'}+05:30`)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * A from/to filter from a list's query string, as whole India days, or null
 * when neither is given. Accepts from/to or startDate/endDate.
 */
export const dayRange = (query = {}) => {
  const from = parseDayBound(query.from ?? query.startDate ?? query.fromDate, 'start');
  const to = parseDayBound(query.to ?? query.endDate ?? query.toDate, 'end');
  if (!from && !to) return null;
  return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
};
