import { evaluateOpeningHours, indiaTimeParts, manualSwitchOn } from "./openingHours"

export function getOutletScheduleStatus(restaurant, now = new Date()) {
  if (!restaurant) {
    return {
      isOpen: true,
      isDayClosed: false,
      isWithinTimings: true,
      hasConfiguredHours: false,
      reason: "no-restaurant",
    }
  }

  // Day-correct, overnight-aware, India time: see openingHours.js.
  const hours = evaluateOpeningHours(restaurant, now)
  const scheduleOpen = hours.isOpen

  return {
    isOpen: scheduleOpen,
    isDayClosed: hours.todayClosedDay && !hours.carriedOver,
    isWithinTimings: scheduleOpen,
    hasConfiguredHours: hours.hasWindow,
    openingTime: hours.openingTime,
    closingTime: hours.closingTime,
    dayName: hours.dayName || indiaTimeParts(now).dayName,
    reason: scheduleOpen
      ? "within-hours"
      : hours.todayClosedDay
        ? "closed-day"
        : hours.hasWindow
          ? "outside-hours"
          : "no-timings",
  }
}

export function getRestaurantOperationalStatus(restaurant, now = new Date()) {
  const schedule = getOutletScheduleStatus(restaurant, now)
  // Manual toggle OFF always wins. Toggle ON resumes outlet-timing control only.
  const isAcceptingOrders = manualSwitchOn(restaurant)
  const outsideHoursOverride = false
  const isEffectivelyOnline = isAcceptingOrders && schedule.isOpen

  return {
    ...schedule,
    isAcceptingOrders,
    outsideHoursOverride,
    isEffectivelyOnline,
    reason: !isAcceptingOrders
      ? "not-accepting-orders"
      : schedule.isOpen
        ? "open"
        : schedule.reason,
  }
}

export function shouldAutoTurnOffAcceptingOrders(restaurant, now = new Date()) {
  void restaurant
  void now
  return false
}

export const RESTAURANT_ONLINE_STATUS_KEY = "restaurant_online_status"

export function broadcastRestaurantOperationalStatus(operational) {
  const isOnline = Boolean(operational?.isEffectivelyOnline)
  try {
    localStorage.setItem(RESTAURANT_ONLINE_STATUS_KEY, JSON.stringify(isOnline))
  } catch (_) {}
  window.dispatchEvent(
    new CustomEvent("restaurantStatusChanged", {
      detail: {
        isOnline,
        isEffectivelyOnline: isOnline,
        isAcceptingOrders: operational?.isAcceptingOrders === true,
        outsideHoursOverride: operational?.outsideHoursOverride === true,
        scheduleOpen: operational?.isOpen === true,
        reason: operational?.reason || "",
      },
    }),
  )
}
