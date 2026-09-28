/**
 * Is a restaurant open at a moment, by its hours -- the same rules as the
 * server's restaurantAvailability.helper.js, so the website and the server
 * agree.
 *
 * Times are India time whatever the visitor's own clock says. A window whose
 * closing time is earlier than its opening time runs past midnight:
 * Wednesday 16:00-02:00 is open Wednesday 16:00-24:00 and Thursday 00:00-02:00.
 * The part after midnight belongs to the day it started on, and every window
 * of a day is checked (lunch, then dinner until 2am).
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const TIME_ZONE = "Asia/Kolkata"

export const normalizeDay = (value) => {
  if (!value || typeof value !== "string") return null
  const trimmed = value.trim().toLowerCase()
  const match = DAY_NAMES.find((day) => day.toLowerCase() === trimmed)
  if (match) return match
  return DAY_NAMES.find((day) => day.toLowerCase().startsWith(trimmed.slice(0, 3))) || null
}

export const parseTimeToMinutes = (timeValue) => {
  if (!timeValue || typeof timeValue !== "string") return null
  const normalized = timeValue.trim().toLowerCase()
  if (!normalized) return null

  const meridiem = normalized.match(/^(\d{1,2}):(\d{2})\s*([ap]m)$/)
  if (meridiem) {
    let hour = Number(meridiem[1])
    const minute = Number(meridiem[2])
    if (minute > 59) return null
    if (meridiem[3] === "pm" && hour < 12) hour += 12
    if (meridiem[3] === "am" && hour === 12) hour = 0
    return hour > 23 ? null : hour * 60 + minute
  }

  const plain = normalized.match(/^(\d{1,2}):(\d{2})$/)
  if (!plain) return null
  const hour = Number(plain[1])
  const minute = Number(plain[2])
  return hour > 23 || minute > 59 ? null : hour * 60 + minute
}

/** Day name and minutes past midnight, in India time. */
export const indiaTimeParts = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now)
  const get = (type) => parts.find((p) => p.type === type)?.value
  const dayName = get("weekday")
  const minutes = Number(get("hour")) * 60 + Number(get("minute"))
  return { dayName, nowMinutes: minutes, previousDayName: DAY_NAMES[(DAY_NAMES.indexOf(dayName) + 6) % 7] }
}

const timingFor = (restaurant, dayName) => {
  const source = restaurant?.outletTimings
  if (!source || typeof source !== "object") return null
  if (Array.isArray(source.timings)) {
    const exact = source.timings.find((entry) => normalizeDay(entry?.day) === dayName)
    if (exact) return exact
  }
  if (!Array.isArray(source)) {
    const direct = source[dayName]
    if (direct && typeof direct === "object") return direct
  }
  return null
}

const readDay = (restaurant, dayName) => {
  const timing = timingFor(restaurant, dayName)
  if (timing && timing.isOpen === false) return { dayName, closedDay: true, windows: [], hasWindow: true }

  const openDays = Array.isArray(restaurant?.openDays) ? restaurant.openDays : []
  if (!timing && openDays.length > 0) {
    const allowed = new Set(openDays.map(normalizeDay).filter(Boolean))
    if (allowed.size > 0 && !allowed.has(dayName)) return { dayName, closedDay: true, windows: [], hasWindow: true }
  }

  const slots = Array.isArray(timing?.slots) ? timing.slots : []
  let windows = slots
    .map((slot) => {
      const openingTime = slot?.open ?? slot?.openingTime
      const closingTime = slot?.close ?? slot?.closingTime
      return { open: parseTimeToMinutes(openingTime), close: parseTimeToMinutes(closingTime), openingTime, closingTime }
    })
    .filter((w) => w.open !== null && w.close !== null)

  let hasWindow = windows.length > 0
  if (!windows.length) {
    const openingTime = timing?.openingTime || restaurant?.deliveryTimings?.openingTime || restaurant?.openingTime || null
    const closingTime = timing?.closingTime || restaurant?.deliveryTimings?.closingTime || restaurant?.closingTime || null
    hasWindow = Boolean(openingTime || closingTime)
    const open = parseTimeToMinutes(openingTime)
    const close = parseTimeToMinutes(closingTime)
    if (open !== null && close !== null) windows = [{ open, close, openingTime, closingTime }]
  }
  return { dayName, closedDay: false, windows, hasWindow }
}

/**
 * @returns {{isOpen: boolean, todayClosedDay: boolean, carriedOver: boolean,
 *   hasWindow: boolean, openingTime: string|null, closingTime: string|null,
 *   minutesUntilClose: number|null, dayName: string}}
 */
export const evaluateOpeningHours = (restaurant, now = new Date()) => {
  const { dayName, nowMinutes, previousDayName } = indiaTimeParts(now)
  const today = readDay(restaurant, dayName)
  const yesterday = readDay(restaurant, previousDayName)
  const unrestricted = !today.closedDay && !today.hasWindow

  const todayWindow = today.windows.find((w) => {
    if (w.open === w.close) return true
    return w.close > w.open ? nowMinutes >= w.open && nowMinutes <= w.close : nowMinutes >= w.open
  })
  const carriedWindow = yesterday.closedDay
    ? null
    : yesterday.windows.find((w) => w.close < w.open && nowMinutes <= w.close)

  const isOpen = unrestricted || Boolean(todayWindow) || Boolean(carriedWindow)
  const active = todayWindow || carriedWindow || today.windows[0] || null

  let minutesUntilClose = null
  if (todayWindow && todayWindow.open !== todayWindow.close) {
    minutesUntilClose = todayWindow.close > todayWindow.open
      ? todayWindow.close - nowMinutes
      : 24 * 60 - nowMinutes + todayWindow.close
  } else if (!todayWindow && carriedWindow) {
    minutesUntilClose = carriedWindow.close - nowMinutes
  }

  return {
    isOpen,
    todayClosedDay: today.closedDay,
    carriedOver: !todayWindow && Boolean(carriedWindow),
    hasWindow: carriedWindow ? true : today.hasWindow,
    openingTime: active?.openingTime || null,
    closingTime: active?.closingTime || null,
    minutesUntilClose,
    dayName: carriedWindow && !todayWindow ? yesterday.dayName : dayName,
  }
}

/**
 * The switch in the restaurant panel. The public restaurant APIs now send
 * `isAcceptingOrders` as "open right now" (switch AND hours) and the switch on
 * its own as `manualAcceptingOrders`; older responses only had the switch.
 */
export const manualSwitchOn = (restaurant) =>
  restaurant?.manualAcceptingOrders !== undefined
    ? restaurant.manualAcceptingOrders !== false
    : restaurant?.isAcceptingOrders !== false
