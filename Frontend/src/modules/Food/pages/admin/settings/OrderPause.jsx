import { useEffect, useState } from "react"
import { Loader2, PauseCircle, PlayCircle } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

/**
 * Stop all ordering for a while -- a city outage, a strike, bad weather --
 * everywhere or in chosen zones, with the message customers see and an
 * optional time it lifts by itself. Restaurants keep their own on/off, and
 * orders already placed carry on.
 */

const errText = (e, fallback) => e?.response?.data?.message || e?.message || fallback
const dataOf = (res) => res?.data?.data || {}

/** A Date as the value a datetime-local input wants, in local time. */
const toLocalInput = (value) => {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function OrderPause() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [state, setState] = useState(null)
  const [zones, setZones] = useState([])
  const [scope, setScope] = useState("all") // all | zones
  const [zoneIds, setZoneIds] = useState([])
  const [message, setMessage] = useState("")
  const [until, setUntil] = useState("")

  const apply = (data) => {
    setState(data)
    setZoneIds(Array.isArray(data.zoneIds) ? data.zoneIds : [])
    setScope(data.zoneIds?.length ? "zones" : "all")
    setMessage(data.message || "")
    setUntil(toLocalInput(data.until))
  }

  useEffect(() => {
    let alive = true
    Promise.all([adminAPI.getOrderPause(), adminAPI.getZones()])
      .then(([pause, zoneRes]) => {
        if (!alive) return
        apply(dataOf(pause))
        const list = zoneRes?.data?.data?.zones || zoneRes?.data?.data || []
        setZones(Array.isArray(list) ? list : [])
      })
      .catch((e) => alive && toast.error(errText(e, "Could not load")))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const save = async (paused) => {
    if (paused && scope === "zones" && !zoneIds.length) {
      toast.error("Pick at least one zone, or choose All zones")
      return
    }
    const where = scope === "all" ? "every zone" : `${zoneIds.length} zone(s)`
    if (paused && !window.confirm(`Stop taking new orders in ${where}? Customers will see your message at checkout.`)) return
    try {
      setSaving(true)
      const res = await adminAPI.updateOrderPause({
        paused,
        zoneIds: scope === "all" ? [] : zoneIds,
        message: message.trim(),
        until: paused && until ? new Date(until).toISOString() : null,
      })
      apply(dataOf(res))
      toast.success(paused ? "New orders are paused" : "Ordering is back on")
    } catch (e) {
      toast.error(errText(e, "Could not save"))
    } finally {
      setSaving(false)
    }
  }

  const toggleZone = (id) =>
    setZoneIds((prev) => (prev.includes(id) ? prev.filter((z) => z !== id) : [...prev, id]))

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-slate-500 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    )
  }

  const active = Boolean(state?.active)

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <PauseCircle className="w-5 h-5 text-slate-600" />
          <h1 className="text-2xl font-bold text-slate-900">Pause Orders</h1>
        </div>
        <p className="text-sm text-slate-600">
          Stop new orders for a while, for example during a city outage. Customers see your message in the cart and
          at checkout. Orders already placed carry on, and restaurants keep their own online/offline setting.
        </p>

        <div className={`rounded-xl border p-4 ${active ? "border-red-200 bg-red-50" : "border-emerald-200 bg-emerald-50"}`}>
          <p className={`font-semibold ${active ? "text-red-800" : "text-emerald-800"}`}>
            {active
              ? `New orders are paused in ${state.zoneIds?.length ? `${state.zoneIds.length} zone(s)` : "every zone"}`
              : "Orders are being taken normally"}
          </p>
          {active && state.until ? (
            <p className="text-sm text-red-700">Resumes by itself at {new Date(state.until).toLocaleString("en-IN")}</p>
          ) : null}
          {active && state.message ? <p className="text-sm text-red-700 mt-1">“{state.message}”</p> : null}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">Where</p>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /> All zones
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={scope === "zones"} onChange={() => setScope("zones")} /> Only these zones
            </label>
            {scope === "zones" ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 pl-6">
                {zones.length === 0 ? <p className="text-xs text-slate-500">No zones found.</p> : null}
                {zones.map((z) => {
                  const id = z.id || z._id
                  return (
                    <label key={id} className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={zoneIds.includes(id)} onChange={() => toggleZone(id)} />
                      {z.name || z.zoneName || id}
                    </label>
                  )
                })}
              </div>
            ) : null}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700">Message customers see</label>
            <textarea
              value={message}
              maxLength={300}
              rows={2}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="We are not taking orders right now. Please try again a little later."
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700">Resume automatically at (optional)</label>
            <input
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="px-3 py-2 text-sm rounded-lg border border-slate-300"
            />
            <p className="text-xs text-slate-500">Leave empty to keep it paused until you resume it here.</p>
          </div>

          <div className="flex flex-wrap gap-3 pt-2">
            <button
              type="button"
              onClick={() => save(true)}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-60"
            >
              <PauseCircle className="w-4 h-4" /> {active ? "Update pause" : "Pause new orders"}
            </button>
            {state?.paused ? (
              <button
                type="button"
                onClick={() => save(false)}
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-60"
              >
                <PlayCircle className="w-4 h-4" /> Resume orders
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
