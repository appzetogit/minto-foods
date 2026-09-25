import { useEffect, useState } from "react"
import { MapPin } from "lucide-react"
import { adminAPI } from "@food/api"

export const ADMIN_ZONE_KEY = "admin_zone_filter"

/** The zone the admin is viewing, or "" for every zone. */
export const getAdminZone = () => {
  try {
    return localStorage.getItem(ADMIN_ZONE_KEY) || ""
  } catch {
    return ""
  }
}

/**
 * Pick one zone and every admin screen shows only that zone's restaurants,
 * orders, riders and figures.
 *
 * The choice travels with each request as a header and the server narrows
 * what it reads, so no screen needs a zone filter of its own and a new screen
 * gets it for free. It only affects what is shown -- saving a platform-wide
 * setting still works with a zone picked.
 */
export default function AdminZonePicker() {
  const [zones, setZones] = useState([])
  const [zone, setZone] = useState(getAdminZone)

  useEffect(() => {
    adminAPI
      .getZones({ isActive: true, limit: 500 })
      .then((res) => {
        const payload = res?.data?.data || {}
        const rows = payload.zones || payload.items || (Array.isArray(payload) ? payload : [])
        setZones(Array.isArray(rows) ? rows : [])
      })
      .catch(() => setZones([]))
  }, [])

  const choose = (value) => {
    try {
      if (value) localStorage.setItem(ADMIN_ZONE_KEY, value)
      else localStorage.removeItem(ADMIN_ZONE_KEY)
    } catch {
      // Private mode: the pick lasts for this page only.
    }
    setZone(value)
    // Every screen reloads its data under the new zone.
    window.location.reload()
  }

  // A zone that no longer exists would silently empty every screen.
  const known = !zone || zones.some((z) => (z._id || z.id) === zone)
  useEffect(() => {
    if (zones.length && zone && !known) choose("")
  }, [zones.length]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <label
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${zone ? "border-blue-300 bg-blue-50 text-blue-800" : "border-neutral-200 bg-white text-neutral-700"}`}
      title="Show only this zone on every screen"
    >
      <MapPin className="h-4 w-4 shrink-0" />
      <select
        value={zone}
        onChange={(e) => choose(e.target.value)}
        className="max-w-[140px] bg-transparent text-sm font-medium outline-none"
        aria-label="Zone shown on every screen"
      >
        <option value="">All zones</option>
        {zones.map((z) => (
          <option key={z._id || z.id} value={z._id || z.id}>
            {z.name || z.zoneName}
          </option>
        ))}
      </select>
    </label>
  )
}
