import { useEffect, useState } from "react"
import { adminAPI } from "@food/api"
import { Button } from "@food/components/ui/button"
import { Loader2, Plus, Trash2 } from "lucide-react"

/**
 * Opening hours for one restaurant, edited by an admin.
 *
 * A day holds a list of slots rather than one pair of times, because a kitchen
 * that shuts between lunch and dinner cannot be described by a single window —
 * "11:00 to 23:00" would take orders through the afternoon it is closed.
 *
 * The server mirrors the first slot back into openingTime/closingTime, so
 * anything still reading those two fields keeps working.
 */

// Capitalised, because that is how the server keys a day; a lowercase key is
// simply not found, and saving one would reset every day to the defaults.
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const label = (d) => d
const MAX_SLOTS = 4

const emptyDay = () => ({ isOpen: true, slots: [{ openingTime: "09:00", closingTime: "22:00" }] })

/** The server sends slots; older rows may only carry the single pair. */
const toEditable = (map = {}) => {
  const out = {}
  for (const day of DAYS) {
    const src = map?.[day] || {}
    const slots = Array.isArray(src.slots) && src.slots.length
      // The server sends open/close; the legacy pair is still accepted on write.
      ? src.slots.map((s) => ({ openingTime: s.open || s.openingTime || "09:00", closingTime: s.close || s.closingTime || "22:00" }))
      : [{ openingTime: src.openingTime || "09:00", closingTime: src.closingTime || "22:00" }]
    out[day] = { isOpen: src.isOpen !== false, slots }
  }
  return out
}

export default function RestaurantOpeningHours({ restaurantId }) {
  const [timings, setTimings] = useState(() => toEditable({}))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    if (!restaurantId) return undefined
    setLoading(true)
    adminAPI
      .getRestaurantOutletTimings(restaurantId)
      .then((res) => {
        if (!alive) return
        const map = res?.data?.data?.outletTimings ?? res?.data?.outletTimings ?? {}
        setTimings(toEditable(map))
      })
      .catch(() => { if (alive) setError("Could not load the opening hours.") })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [restaurantId])

  const editDay = (day, patch) => {
    setSaved(false)
    setTimings((prev) => ({ ...prev, [day]: { ...prev[day], ...patch } }))
  }

  const editSlot = (day, index, patch) => {
    setSaved(false)
    setTimings((prev) => ({
      ...prev,
      [day]: { ...prev[day], slots: prev[day].slots.map((s, i) => (i === index ? { ...s, ...patch } : s)) },
    }))
  }

  const addSlot = (day) => {
    setSaved(false)
    setTimings((prev) => {
      const slots = prev[day].slots
      if (slots.length >= MAX_SLOTS) return prev
      // Start the new window after the last one, which is what a split shift
      // looks like, rather than a duplicate that fails validation.
      const last = slots[slots.length - 1]
      const next = { openingTime: last?.closingTime || "15:00", closingTime: "22:00" }
      return { ...prev, [day]: { ...prev[day], slots: [...slots, next] } }
    })
  }

  const removeSlot = (day, index) => {
    setSaved(false)
    setTimings((prev) => {
      const slots = prev[day].slots.filter((_, i) => i !== index)
      return { ...prev, [day]: { ...prev[day], slots: slots.length ? slots : emptyDay().slots } }
    })
  }

  const handleSave = async () => {
    setError("")
    setSaved(false)
    // Catch the obvious mistakes here; the server checks them again.
    for (const day of DAYS) {
      const d = timings[day]
      if (!d.isOpen) continue
      for (const s of d.slots) {
        if (!s.openingTime || !s.closingTime) return setError(`${label(day)}: fill both times in every slot.`)
        // A close earlier than the open runs past midnight, which is a real
        // shift; only the two being identical says nothing at all.
        if (s.closingTime === s.openingTime) return setError(`${label(day)}: opening and closing time cannot be the same.`)
      }
    }
    try {
      setSaving(true)
      const payload = {}
      for (const day of DAYS) {
        payload[day] = timings[day].isOpen
          ? { isOpen: true, slots: timings[day].slots.map((s) => ({ open: s.openingTime, close: s.closingTime })) }
          : { isOpen: false, slots: [] }
      }
      await adminAPI.updateRestaurantOutletTimings(restaurantId, payload)
      setSaved(true)
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not save the opening hours.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 mb-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold text-slate-900">Opening Hours</h2>
        <Button onClick={handleSave} disabled={saving || loading}>
          {saving ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving</>) : "Save Hours"}
        </Button>
      </div>
      <p className="text-xs text-slate-500 mb-3">
        A day can have more than one slot &mdash; add a second for a kitchen that closes between lunch and dinner.
      </p>

      {error ? <p className="text-sm text-red-600 mb-3">{error}</p> : null}
      {saved ? <p className="text-sm text-emerald-600 mb-3">Opening hours saved.</p> : null}

      {loading ? (
        <div className="flex items-center gap-2 text-slate-500 text-sm py-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading hours&hellip;
        </div>
      ) : (
        <div className="space-y-2">
          {DAYS.map((day) => {
            const d = timings[day]
            return (
              <div key={day} className="border border-slate-200 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
                    <input
                      type="checkbox"
                      checked={d.isOpen}
                      onChange={(e) => editDay(day, { isOpen: e.target.checked })}
                    />
                    {label(day)}
                    {!d.isOpen ? <span className="text-xs font-normal text-slate-500">(closed)</span> : null}
                  </label>
                  {d.isOpen ? (
                    <button
                      type="button"
                      onClick={() => addSlot(day)}
                      disabled={d.slots.length >= MAX_SLOTS}
                      className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 disabled:text-slate-400"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add slot
                    </button>
                  ) : null}
                </div>

                {d.isOpen ? (
                  <div className="space-y-2">
                    {d.slots.map((slot, i) => (
                      <div key={`${day}-${i}`} className="flex items-center gap-2">
                        <input
                          type="time"
                          value={slot.openingTime}
                          onChange={(e) => editSlot(day, i, { openingTime: e.target.value })}
                          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                        />
                        <span className="text-slate-400 text-sm">to</span>
                        <input
                          type="time"
                          value={slot.closingTime}
                          onChange={(e) => editSlot(day, i, { closingTime: e.target.value })}
                          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                        />
                        {d.slots.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => removeSlot(day, i)}
                            className="p-1 text-slate-400 hover:text-red-600"
                            title="Remove this slot"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
