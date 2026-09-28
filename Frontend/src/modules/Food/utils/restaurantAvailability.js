import { evaluateOpeningHours, manualSwitchOn, parseTimeToMinutes } from "./openingHours"

const formatTimeLabel = (timeValue) => {
  const totalMinutes = parseTimeToMinutes(timeValue)
  if (totalMinutes === null) return timeValue || null

  const hours24 = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const period = hours24 >= 12 ? "PM" : "AM"
  const hours12 = hours24 % 12 || 12

  return `${hours12}:${String(minutes).padStart(2, "0")} ${period}`
}

const formatClosingCountdown = (minutesUntilClose, closingTime) => {
  if (minutesUntilClose === null || minutesUntilClose === undefined) return null

  if (minutesUntilClose <= 0) {
    const closingLabel = formatTimeLabel(closingTime)
    return closingLabel ? `Closes at ${closingLabel}` : null
  }

  if (minutesUntilClose < 60) {
    return `Closes in ${minutesUntilClose} min`
  }

  const hours = Math.floor(minutesUntilClose / 60)
  const minutes = minutesUntilClose % 60

  if (minutes === 0) {
    return `Closes in ${hours}h`
  }

  return `Closes in ${hours}h ${minutes}m`
}

export const getRestaurantAvailabilityStatus = (restaurant, now = new Date(), options = {}) => {
  if (!restaurant) {
    return {
      isOpen: false,
      isActive: false,
      isAcceptingOrders: false,
      isWithinTimings: false,
      reason: "missing-restaurant",
    }
  }

  const ignoreOperationalStatus = options?.ignoreOperationalStatus === true
  const isActive = restaurant.isActive !== false
  const isAcceptingOrders = manualSwitchOn(restaurant)

  if (!ignoreOperationalStatus && !isActive) {
    return {
      isOpen: false,
      isActive,
      isAcceptingOrders,
      isWithinTimings: false,
      reason: "inactive",
    }
  }

  if (!ignoreOperationalStatus && !isAcceptingOrders) {
    return {
      isOpen: false,
      isActive,
      isAcceptingOrders,
      isWithinTimings: false,
      reason: "not-accepting-orders",
    }
  }

  // Day-correct, overnight-aware, India time: see openingHours.js.
  const hours = evaluateOpeningHours(restaurant, now)
  const isOpenNow = hours.isOpen
  const minutesUntilClose = isOpenNow ? hours.minutesUntilClose : null

  return {
    isOpen: isOpenNow,
    isActive,
    isAcceptingOrders,
    isWithinTimings: isOpenNow,
    openingTime: hours.openingTime,
    closingTime: hours.closingTime,
    minutesUntilClose,
    closingCountdownLabel: isOpenNow
      ? formatClosingCountdown(minutesUntilClose, hours.closingTime)
      : null,
    reason: isOpenNow
      ? (isAcceptingOrders ? "open" : "open-by-timings")
      : (hours.hasWindow ? "outside-hours" : "no-timings"),
  }
}
