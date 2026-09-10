import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { AlertTriangle } from "lucide-react"

import { restaurantAPI } from "@food/api"
import { daysUntilExpiry, expiryLevel, expiryMessage } from "./fssaiExpiry"

/**
 * Warns a restaurant that its FSSAI licence is running out.
 *
 * There was already a notification for this, but only once the licence had
 * *expired* — an inbox entry telling someone about a deadline they have already
 * missed. Renewal takes days, so the warning has to arrive before the date, and
 * on the screen they actually open rather than in a list they might not.
 *
 * Computed here from the expiry date the profile already carries, so nothing new
 * is needed from the server. The existing after-the-fact notification still runs;
 * this is the part that gives them time to act.
 */

const STYLES = {
  expired: {
    box: "border-red-300 bg-red-50 text-red-900",
    icon: "text-red-600",
    action: "bg-red-600 hover:bg-red-700",
  },
  urgent: {
    box: "border-red-200 bg-red-50 text-red-900",
    icon: "text-red-500",
    action: "bg-red-600 hover:bg-red-700",
  },
  warning: {
    box: "border-amber-200 bg-amber-50 text-amber-900",
    icon: "text-amber-500",
    action: "bg-amber-600 hover:bg-amber-700",
  },
}

export default function FssaiExpiryBanner({ className = "" }) {
  const [expiry, setExpiry] = useState(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const response = await restaurantAPI.getCurrentRestaurant()
        const restaurant =
          response?.data?.data?.restaurant || response?.data?.restaurant || response?.data?.data
        if (!cancelled) setExpiry(restaurant?.fssaiExpiry || null)
      } catch {
        // A compliance banner is not worth a toast on top of whatever else
        // failed; the screen behind it still works.
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  const days = daysUntilExpiry(expiry)
  const level = expiryLevel(days)
  if (!level) return null

  const style = STYLES[level]
  const { title, body } = expiryMessage(days, expiry)

  return (
    <div
      role="status"
      className={`flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${style.box} ${className}`}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className={`mt-0.5 h-5 w-5 flex-shrink-0 ${style.icon}`} />
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-sm opacity-90">{body}</p>
        </div>
      </div>
      <Link
        to="/food/restaurant/fssai/update"
        className={`flex-shrink-0 rounded-lg px-4 py-2 text-center text-sm font-medium text-white ${style.action}`}
      >
        Update licence
      </Link>
    </div>
  )
}
