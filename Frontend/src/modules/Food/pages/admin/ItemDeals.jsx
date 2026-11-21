import { useCallback, useEffect, useMemo, useState } from "react"
import { Zap, Gift, Trash2, Square } from "lucide-react"
import { toast } from "sonner"
import apiClient, { adminAPI } from "@/services/api"

/**
 * Flash deals and Buy 1 Get 1 on a restaurant's dishes, applied without a
 * code. The restaurant funds them (they lower its own price) and dishes under
 * a deal are not eligible for coupons. Restaurants can create the same from
 * their app; this page lets the team run them on a restaurant's behalf.
 */
const DURATIONS = [
  [60, "1 hour"],
  [120, "2 hours"],
  [240, "4 hours"],
  [480, "8 hours"],
]

const left = (end) => {
  const ms = new Date(end).getTime() - Date.now()
  if (!(ms > 0)) return "Ended"
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return h ? `${h}h ${m}m left` : `${m}m ${String(s).padStart(2, "0")}s left`
}

const api = {
  list: (restaurantId) =>
    apiClient.get("/food/admin/item-deals", { params: { restaurantId }, contextModule: "admin" }),
  create: (body) => apiClient.post("/food/admin/item-deals", body, { contextModule: "admin" }),
  status: (id, status) => apiClient.patch(`/food/admin/item-deals/${id}`, { status }, { contextModule: "admin" }),
  remove: (id) => apiClient.delete(`/food/admin/item-deals/${id}`, { contextModule: "admin" }),
}

export default function ItemDeals() {
  const [restaurants, setRestaurants] = useState([])
  const [restaurantId, setRestaurantId] = useState("")
  const [foods, setFoods] = useState([])
  const [deals, setDeals] = useState([])
  const [, setNow] = useState(0)
  const [form, setForm] = useState({ kind: "flash", percent: true, value: "50", minutes: 120, endAt: "", title: "", itemIds: [] })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    adminAPI
      .getRestaurants({ page: 1, limit: 500 })
      .then((res) => setRestaurants(res?.data?.data?.restaurants || []))
      .catch(() => toast.error("Could not load restaurants"))
  }, [])

  const loadDeals = useCallback(() => {
    if (!restaurantId) return
    api
      .list(restaurantId)
      .then((res) => setDeals(res?.data?.data?.deals || []))
      .catch(() => toast.error("Could not load deals"))
  }, [restaurantId])

  useEffect(() => {
    setDeals([])
    setFoods([])
    setForm((f) => ({ ...f, itemIds: [] }))
    if (!restaurantId) return
    loadDeals()
    adminAPI
      .getFoods({ restaurantId, limit: 500 })
      .then((res) => setFoods((res?.data?.data?.foods || []).filter((f) => f.approvalStatus === "approved")))
      .catch(() => toast.error("Could not load dishes"))
  }, [restaurantId, loadDeals])

  const foodName = useMemo(() => new Map(foods.map((f) => [String(f.id || f._id), f.name])), [foods])

  const toggleItem = (id) =>
    setForm((f) => ({ ...f, itemIds: f.itemIds.includes(id) ? f.itemIds.filter((x) => x !== id) : [...f.itemIds, id] }))

  const submit = async () => {
    if (!restaurantId) return toast.error("Choose a restaurant")
    if (!form.itemIds.length) return toast.error("Select at least one dish")
    const body = { restaurantId, kind: form.kind, itemIds: form.itemIds, title: form.title.trim() }
    if (form.kind === "flash") {
      body.discountType = form.percent ? "percentage" : "flat-price"
      body.discountValue = Number(form.value)
    }
    if (form.endAt) body.endAt = new Date(form.endAt).toISOString()
    else if (form.minutes) body.durationMinutes = form.minutes
    setSaving(true)
    try {
      await api.create(body)
      toast.success("Deal started")
      setForm((f) => ({ ...f, itemIds: [], title: "" }))
      loadDeals()
    } catch (e) {
      toast.error(e?.response?.data?.message || "Could not create the deal")
    } finally {
      setSaving(false)
    }
  }

  const act = async (fn) => {
    try {
      await fn()
      loadDeals()
    } catch (e) {
      toast.error(e?.response?.data?.message || "Something went wrong")
    }
  }

  const chip = (on) =>
    `px-3 py-1.5 rounded-full text-sm border ${on ? "bg-teal-50 border-teal-500 text-teal-700 font-semibold" : "border-slate-300 text-slate-600"}`

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <h1 className="text-2xl font-bold text-slate-900">Flash Deals & Buy 1 Get 1</h1>
      <p className="text-sm text-slate-500 mb-4">
        No-code offers on a restaurant&apos;s dishes. Funded by the restaurant; dishes under a deal are not eligible for coupons.
      </p>

      <select
        value={restaurantId}
        onChange={(e) => setRestaurantId(e.target.value)}
        className="w-full md:w-96 px-3 py-2.5 border border-slate-300 rounded-lg bg-white mb-6"
      >
        <option value="">Choose a restaurant…</option>
        {restaurants.map((r) => (
          <option key={r._id || r.id} value={r._id || r.id}>
            {r.restaurantName || r.name}
          </option>
        ))}
      </select>

      {restaurantId && (
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-4">
            <h2 className="font-semibold text-slate-800">New deal</h2>
            <div className="flex gap-2">
              <button className={chip(form.kind === "flash")} onClick={() => setForm((f) => ({ ...f, kind: "flash" }))}>⚡ Flash deal</button>
              <button className={chip(form.kind === "bogo")} onClick={() => setForm((f) => ({ ...f, kind: "bogo" }))}>🎁 Buy 1 Get 1</button>
            </div>
            {form.kind === "flash" && (
              <div className="flex items-center gap-2">
                <button className={chip(form.percent)} onClick={() => setForm((f) => ({ ...f, percent: true }))}>% off</button>
                <button className={chip(!form.percent)} onClick={() => setForm((f) => ({ ...f, percent: false }))}>₹ off</button>
                <input
                  type="number"
                  min="1"
                  value={form.value}
                  onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                  className="w-28 px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
            )}
            <div>
              <p className="text-sm text-slate-600 mb-2">Runs for{form.kind === "bogo" ? " (optional)" : ""}</p>
              <div className="flex flex-wrap gap-2 items-center">
                {DURATIONS.map(([m, label]) => (
                  <button key={m} className={chip(!form.endAt && form.minutes === m)} onClick={() => setForm((f) => ({ ...f, minutes: m, endAt: "" }))}>
                    {label}
                  </button>
                ))}
                <input
                  type="datetime-local"
                  value={form.endAt}
                  onChange={(e) => setForm((f) => ({ ...f, endAt: e.target.value }))}
                  className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm"
                  title="Custom end time"
                />
              </div>
            </div>
            <input
              placeholder="Title (optional), e.g. Biryani rush hour"
              value={form.title}
              maxLength={60}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg"
            />
            <div>
              <p className="text-sm text-slate-600 mb-2">Dishes ({form.itemIds.length} selected)</p>
              <div className="max-h-64 overflow-y-auto border border-slate-200 rounded-lg divide-y">
                {foods.map((f) => {
                  const id = String(f.id || f._id)
                  return (
                    <label key={id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50">
                      <input type="checkbox" checked={form.itemIds.includes(id)} onChange={() => toggleItem(id)} />
                      <span className="flex-1">{f.name}</span>
                      <span className="text-slate-500">₹{Number(f.price) || 0}</span>
                    </label>
                  )
                })}
                {!foods.length && <p className="p-3 text-sm text-slate-500">No approved dishes.</p>}
              </div>
            </div>
            <button
              onClick={submit}
              disabled={saving}
              className="w-full py-2.5 rounded-lg bg-teal-600 text-white font-semibold disabled:opacity-60"
            >
              {saving ? "Saving…" : "Start deal"}
            </button>
          </div>

          <div className="space-y-3">
            <h2 className="font-semibold text-slate-800">Deals</h2>
            {!deals.length && <p className="text-sm text-slate-500">No deals for this restaurant yet.</p>}
            {deals.map((d) => (
              <div key={d.id} className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="flex items-center gap-2">
                  {d.kind === "flash" ? <Zap className="w-5 h-5 text-rose-600" /> : <Gift className="w-5 h-5 text-teal-600" />}
                  <span className="font-semibold flex-1">{d.title ? `${d.title} · ${d.label}` : d.label}</span>
                  <span className={`text-xs px-2 py-1 rounded-full tabular-nums ${d.live ? "bg-rose-50 text-rose-600" : "bg-slate-100 text-slate-500"}`}>
                    {d.live ? (d.endAt ? left(d.endAt) : "Running") : d.status === "paused" ? "Paused" : "Ended"}
                  </span>
                </div>
                <p className="text-sm text-slate-600 mt-1">{(d.itemIds || []).map((id) => foodName.get(id) || "Dish").join(", ")}</p>
                {d.endAt && <p className="text-xs text-slate-400">Ends {new Date(d.endAt).toLocaleString("en-IN")}</p>}
                <div className="flex justify-end gap-3 mt-2 text-sm">
                  {d.live && (
                    <button className="flex items-center gap-1 text-slate-700" onClick={() => act(() => api.status(d.id, "inactive"))}>
                      <Square className="w-4 h-4" /> Stop
                    </button>
                  )}
                  <button className="flex items-center gap-1 text-red-600" onClick={() => act(() => api.remove(d.id))}>
                    <Trash2 className="w-4 h-4" /> Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
