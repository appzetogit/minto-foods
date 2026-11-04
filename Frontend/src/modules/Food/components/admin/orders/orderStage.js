/**
 * Where an order really is, for the admin order lists.
 *
 * The list's status used to fold preparing, ready for pickup and rider at the
 * restaurant into "Processing", so nobody could tell whether food was waiting
 * for a rider. These use the same stages the customer is notified about.
 */

/** Food ready this long without being picked up is shown as late. */
export const READY_LATE_MINUTES = 15

const STAGE_COLORS = {
  "Order Placed": "bg-blue-100 text-blue-700",
  "Order Accepted": "bg-green-100 text-green-700",
  "Being Prepared": "bg-orange-100 text-orange-700",
  "Ready for Pickup": "bg-purple-100 text-purple-700",
  "Rider at Restaurant": "bg-indigo-100 text-indigo-700",
  "On the Way": "bg-yellow-100 text-yellow-700",
  "Rider Has Arrived": "bg-teal-100 text-teal-700",
}

export const stageColor = (label) => STAGE_COLORS[label] || null

const minutesSince = (when, now) => {
  if (!when) return null
  const t = new Date(when).getTime()
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60000)) : null
}

const ago = (minutes) => {
  if (minutes === null) return ""
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min ago`
}

/** When the order last moved to `status`, from its history. */
const reachedAt = (order, status) => {
  const history = Array.isArray(order?.statusHistory) ? order.statusHistory : []
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (String(history[i]?.to || "").toLowerCase() === status) return history[i]?.at || null
  }
  return null
}

/** The rider's side of an order not yet picked up. */
const riderNote = (order, riderName, now) => {
  const state = order?.deliveryState || {}
  if (state.reachedPickupAt || state.currentPhase === "at_pickup" || state.status === "reached_pickup") {
    const since = minutesSince(state.reachedPickupAt, now)
    return `${riderName || "Rider"} at the restaurant${state.reachedPickupAt ? ` · ${ago(since)}` : ""}`
  }
  const dispatch = String(order?.dispatch?.status || "").toLowerCase()
  if (dispatch === "accepted") return riderName ? `Rider: ${riderName}` : "Rider assigned"
  if (dispatch === "assigned") return riderName ? `Waiting for ${riderName} to accept` : "Waiting for a rider to accept"
  return "Looking for a rider"
}

/**
 * @param {object} order the order as the API sends it, before the list's own labels
 * @param {string} backendStatus the order's status, lower case
 * @param {string} riderName
 * @returns {{label: string|null, note: string, late: boolean}} label null: keep the list's own
 */
export function orderStage(order, backendStatus, riderName = "", now = Date.now()) {
  const state = order?.deliveryState || {}
  switch (backendStatus) {
    case "created":
      return { label: "Order Placed", note: "Waiting for the restaurant to accept", late: false }
    case "confirmed":
      return { label: "Order Accepted", note: riderNote(order, riderName, now), late: false }
    case "preparing":
      return { label: "Being Prepared", note: riderNote(order, riderName, now), late: false }
    case "ready_for_pickup":
    case "reached_pickup": {
      const since = minutesSince(reachedAt(order, "ready_for_pickup"), now)
      const rider = riderNote(order, riderName, now)
      return {
        label: backendStatus === "reached_pickup" ? "Rider at Restaurant" : "Ready for Pickup",
        note: since === null ? rider : `Ready ${ago(since)} · ${rider}`,
        late: since !== null && since >= READY_LATE_MINUTES,
      }
    }
    case "picked_up": {
      if (state.currentPhase === "at_drop" || state.status === "reached_drop") {
        const since = minutesSince(state.reachedDropAt, now)
        return {
          label: "Rider Has Arrived",
          note: `${riderName || "Rider"}${state.reachedDropAt ? ` · ${ago(since)}` : ""}`,
          late: false,
        }
      }
      const since = minutesSince(state.pickedUpAt, now)
      return {
        label: "On the Way",
        note: `${riderName || "Rider"}${state.pickedUpAt ? ` · picked up ${ago(since)}` : ""}`,
        late: false,
      }
    }
    default:
      return { label: null, note: "", late: false }
  }
}
