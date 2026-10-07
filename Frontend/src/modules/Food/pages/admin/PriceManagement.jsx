import { useEffect, useMemo, useRef, useState } from "react"
import { adminAPI } from "@food/api"
import { Loader2, Plus, Trash2, Pencil, X, Search, Eye } from "lucide-react"

/**
 * Global price management.
 *
 * A rule raises or lowers what customers see and pay by a percentage of the
 * restaurant's own price. The restaurant's price is never changed: their menu,
 * their orders and their payout all stay on the price they set. The gap is
 * Minto's (or Minto's cost, for a decrease).
 *
 * One dish follows one rule -- the most specific: dish > category >
 * restaurant > zone > all. A 0% dish rule takes a dish out of a wider rule.
 */

const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
const errText = (e, fallback) => e?.response?.data?.message || e?.message || fallback
const dataOf = (res) => res?.data?.data ?? res?.data ?? {}
const idOf = (x) => String(x?.id || x?._id || "")

const SCOPES = [
  { value: "all", label: "All dishes" },
  { value: "zone", label: "A zone / city" },
  { value: "restaurant", label: "Selected restaurants" },
  { value: "category", label: "Selected categories" },
  { value: "item", label: "Selected dishes" },
]
const ROUNDINGS = [
  { value: "nearest_1", label: "Nearest ₹1" },
  { value: "none", label: "Exact (paise)" },
  { value: "end_9", label: "Up to a price ending in 9" },
]

const toLocalInput = (value) => {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fmtDate = (v) =>
  new Date(v).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })

const emptyForm = {
  id: null,
  name: "",
  scope: "all",
  zoneId: "",
  restaurants: [], // [{id, name}]
  categories: [],
  items: [],
  direction: "increase",
  percent: "",
  rounding: "nearest_1",
  applyToAddons: false,
  scheduled: false,
  startsAt: "",
  endsAt: "",
}

const input =
  "w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"

/** Searchable multi-select of {id, name, sub?}. `search(q)` returns options. */
function MultiPicker({ label, selected, onChange, search, placeholder }) {
  const [q, setQ] = useState("")
  const [options, setOptions] = useState([])
  const [loading, setLoading] = useState(false)
  const timer = useRef(null)

  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setLoading(true)
      try {
        setOptions(await search(q))
      } catch {
        setOptions([])
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => clearTimeout(timer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const chosen = new Set(selected.map((s) => s.id))
  const toggle = (opt) =>
    onChange(chosen.has(opt.id) ? selected.filter((s) => s.id !== opt.id) : [...selected, opt])

  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      {selected.length ? (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selected.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-xs">
              {s.name}
              {s.sub ? <span className="text-blue-400">· {s.sub}</span> : null}
              <button type="button" onClick={() => toggle(s)} className="hover:text-blue-900">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-2.5" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className={`${input} pl-8`} />
      </div>
      <div className="mt-1 max-h-48 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
        {loading ? (
          <div className="px-3 py-2 text-xs text-slate-500">Searching…</div>
        ) : options.length === 0 ? (
          <div className="px-3 py-2 text-xs text-slate-500">Nothing found</div>
        ) : (
          options.map((opt) => (
            <label key={opt.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 cursor-pointer">
              <input type="checkbox" checked={chosen.has(opt.id)} onChange={() => toggle(opt)} />
              <span className="text-slate-800">{opt.name}</span>
              {opt.sub ? <span className="text-xs text-slate-400 ml-auto">{opt.sub}</span> : null}
            </label>
          ))
        )}
      </div>
    </div>
  )
}

export default function PriceManagement() {
  const [rules, setRules] = useState([])
  const [zones, setZones] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [form, setForm] = useState(null) // null = drawer closed
  const [formError, setFormError] = useState("")
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [restaurantsCache, setRestaurantsCache] = useState(null)
  const [categoriesCache, setCategoriesCache] = useState(null)
  const [checkRestaurant, setCheckRestaurant] = useState("")
  const [effective, setEffective] = useState(null)
  const [effectiveLoading, setEffectiveLoading] = useState(false)

  const load = async () => {
    setError("")
    try {
      setLoading(true)
      const data = dataOf(await adminAPI.getPriceRules())
      setRules(Array.isArray(data.rules) ? data.rules : [])
    } catch (e) {
      setError(errText(e, "Could not load price rules."))
    } finally {
      setLoading(false)
    }
  }

  const loadRestaurants = async () => {
    if (restaurantsCache) return restaurantsCache
    const data = dataOf(await adminAPI.getRestaurants({ limit: 1000 }))
    const list = (Array.isArray(data.restaurants) ? data.restaurants : Array.isArray(data) ? data : []).map((r) => ({
      id: idOf(r),
      name: r.restaurantName || r.name || "Restaurant",
      sub: r.zone?.name || r.zoneName || r.city || "",
    }))
    setRestaurantsCache(list)
    return list
  }

  const loadCategories = async () => {
    if (categoriesCache) return categoriesCache
    const data = dataOf(await adminAPI.getCategories({ limit: 1000 }))
    const list = (Array.isArray(data.categories) ? data.categories : Array.isArray(data) ? data : []).map((c) => ({
      id: idOf(c),
      name: c.name || "Category",
    }))
    setCategoriesCache(list)
    return list
  }

  useEffect(() => {
    load()
    adminAPI
      .getZones()
      .then((res) => {
        const data = dataOf(res)
        setZones(Array.isArray(data.zones) ? data.zones : Array.isArray(data) ? data : [])
      })
      .catch(() => setZones([]))
    loadRestaurants().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filterLocal = (list, q) => {
    const needle = q.trim().toLowerCase()
    const out = needle ? list.filter((x) => x.name.toLowerCase().includes(needle)) : list
    return out.slice(0, 100)
  }
  const searchRestaurants = async (q) => filterLocal(await loadRestaurants(), q)
  const searchCategories = async (q) => filterLocal(await loadCategories(), q)
  const searchDishes = async (q) => {
    const data = dataOf(await adminAPI.getFoods({ search: q || undefined, limit: 50, approvalStatus: "approved" }))
    return (Array.isArray(data.foods) ? data.foods : []).map((f) => ({
      id: idOf(f),
      name: f.name,
      sub: f.restaurantName || f.restaurant?.restaurantName || "",
    }))
  }

  const zoneName = (id) => zones.find((z) => idOf(z) === id)?.name || ""

  // ---- form -----------------------------------------------------------------

  const openNew = () => {
    setForm({ ...emptyForm })
    setPreview(null)
    setFormError("")
  }

  const openEdit = async (rule) => {
    setFormError("")
    setPreview(null)
    try {
      setBusy(rule.id)
      const r = dataOf(await adminAPI.getPriceRule(rule.id))
      setForm({
        id: r.id,
        name: r.name,
        scope: r.scope,
        zoneId: r.zoneId || "",
        restaurants: r.restaurants || [],
        categories: r.categories || [],
        items: (r.items || []).map((i) => ({ id: i.id, name: i.name, sub: i.restaurantName })),
        direction: r.percent < 0 ? "decrease" : "increase",
        percent: String(Math.abs(r.percent)),
        rounding: r.rounding,
        applyToAddons: r.applyToAddons,
        scheduled: Boolean(r.startsAt || r.endsAt),
        startsAt: toLocalInput(r.startsAt),
        endsAt: toLocalInput(r.endsAt),
        isActive: r.isActive,
      })
    } catch (e) {
      setError(errText(e, "Could not open the rule."))
    } finally {
      setBusy("")
    }
  }

  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }))
    setPreview(null)
  }

  const body = () => {
    const pct = Number(form.percent)
    return {
      id: form.id || undefined,
      name: form.name.trim(),
      scope: form.scope,
      zoneId: form.zoneId || null,
      restaurantIds: form.restaurants.map((r) => r.id),
      categoryIds: form.categories.map((c) => c.id),
      itemIds: form.items.map((i) => i.id),
      percent: form.direction === "decrease" ? -pct : pct,
      rounding: form.rounding,
      applyToAddons: form.applyToAddons,
      startsAt: form.scheduled && form.startsAt ? new Date(form.startsAt).toISOString() : null,
      endsAt: form.scheduled && form.endsAt ? new Date(form.endsAt).toISOString() : null,
      isActive: form.isActive === undefined ? true : form.isActive,
    }
  }

  const localCheck = () => {
    if (!form.name.trim()) return "Give the rule a name."
    const pct = Number(form.percent)
    if (form.percent === "" || !Number.isFinite(pct) || pct < 0) return "Enter a percentage."
    if (form.direction === "increase" && pct > 100) return "An increase can be at most 100%."
    if (form.direction === "decrease" && pct > 50) return "A decrease can be at most 50%."
    if (form.scope === "zone" && !form.zoneId) return "Choose the zone."
    if (form.scope === "restaurant" && !form.restaurants.length) return "Choose at least one restaurant."
    if (form.scope === "category" && !form.categories.length) return "Choose at least one category."
    if (form.scope === "item" && !form.items.length) return "Choose at least one dish."
    if (form.scheduled && form.startsAt && form.endsAt && form.endsAt <= form.startsAt) return "The end must be after the start."
    return ""
  }

  const runPreview = async () => {
    const problem = localCheck()
    if (problem) return setFormError(problem)
    setFormError("")
    try {
      setPreviewing(true)
      setPreview(dataOf(await adminAPI.previewPriceRule(body(), { limit: 50 })))
    } catch (e) {
      setFormError(errText(e, "Could not preview the rule."))
    } finally {
      setPreviewing(false)
    }
  }

  const save = async () => {
    const problem = localCheck()
    if (problem) return setFormError(problem)
    setFormError("")
    try {
      setBusy("save")
      // Always show the admin what will change before it goes live.
      const p = preview || dataOf(await adminAPI.previewPriceRule(body(), { limit: 50 }))
      setPreview(p)
      const changing = p.dishes ? p.total : 0
      const b = body()
      const sign = b.percent > 0 ? `+${b.percent}` : `${b.percent}`
      const msg =
        `This rule (${sign}%) covers ${changing} dish${changing === 1 ? "" : "es"}` +
        `${b.isActive && !b.startsAt ? " and changes their app price immediately" : ""}.\n\n` +
        "Restaurants will still see and be paid on their own price.\n\nSave it?"
      if (!window.confirm(msg)) return
      const payload = { ...b }
      delete payload.id
      if (form.id) await adminAPI.updatePriceRule(form.id, payload)
      else await adminAPI.createPriceRule(payload)
      setForm(null)
      setPreview(null)
      await load()
      if (checkRestaurant) loadEffective(checkRestaurant)
    } catch (e) {
      setFormError(errText(e, "Could not save the rule."))
    } finally {
      setBusy("")
    }
  }

  const toggle = async (rule) => {
    setError("")
    try {
      setBusy(rule.id)
      await adminAPI.togglePriceRule(rule.id, !rule.isActive)
      await load()
      if (checkRestaurant) loadEffective(checkRestaurant)
    } catch (e) {
      setError(errText(e, "Could not change the rule."))
    } finally {
      setBusy("")
    }
  }

  const remove = async (rule) => {
    if (!window.confirm(`Delete "${rule.name}"? Those dishes go back to the restaurant's price (or another rule).`)) return
    setError("")
    try {
      setBusy(rule.id)
      await adminAPI.deletePriceRule(rule.id)
      await load()
      if (checkRestaurant) loadEffective(checkRestaurant)
    } catch (e) {
      setError(errText(e, "Could not delete the rule."))
    } finally {
      setBusy("")
    }
  }

  const loadEffective = async (rid) => {
    setCheckRestaurant(rid)
    setEffective(null)
    if (!rid) return
    try {
      setEffectiveLoading(true)
      setEffective(dataOf(await adminAPI.getEffectivePrices(rid)))
    } catch (e) {
      setError(errText(e, "Could not load that restaurant's prices."))
    } finally {
      setEffectiveLoading(false)
    }
  }

  const appliesTo = (r) => {
    const zone = r.zoneName || zoneName(r.zoneId)
    const where = zone ? ` in ${zone}` : ""
    switch (r.scope) {
      case "all":
        return zone ? `All dishes in ${zone}` : "All dishes"
      case "zone":
        return `All dishes in ${zone || "zone"}`
      case "restaurant":
        return `${r.restaurantIds.length} restaurant${r.restaurantIds.length === 1 ? "" : "s"}${where}`
      case "category":
        return `${r.categoryIds.length} categor${r.categoryIds.length === 1 ? "y" : "ies"}${where}`
      case "item":
        return `${r.itemIds.length} dish${r.itemIds.length === 1 ? "" : "es"}${where}`
      default:
        return r.scope
    }
  }

  const status = (r) => {
    if (!r.isActive) return { label: "Off", tone: "bg-slate-100 text-slate-600" }
    if (r.isLive) return { label: "Live", tone: "bg-emerald-100 text-emerald-700" }
    return { label: "Scheduled", tone: "bg-amber-100 text-amber-700" }
  }

  const restaurantOptions = useMemo(() => restaurantsCache || [], [restaurantsCache])

  return (
    <div className="p-3 bg-slate-50 min-h-screen">
      <div className="w-full mx-auto max-w-6xl space-y-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5 flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-[240px]">
            <h1 className="text-xl font-bold text-slate-900">Price Management</h1>
            <p className="text-sm text-slate-500 mt-1">
              Raise or lower the price customers see and pay by a percentage of the restaurant&rsquo;s own price.
              Restaurants keep seeing — and are paid on — the price they set. Each dish follows its most specific
              rule: dish &gt; category &gt; restaurant &gt; zone &gt; all.
            </p>
          </div>
          <button
            type="button"
            onClick={openNew}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> New price rule
          </button>
        </div>

        {error ? <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-4 py-3 text-sm">{error}</div> : null}

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="text-base font-semibold text-slate-900 mb-3">Rules</h2>
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : rules.length === 0 ? (
            <p className="text-sm text-slate-500">No price rules. Customers pay exactly the restaurants&rsquo; prices.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                    <th className="py-2 pr-3">Name</th>
                    <th className="py-2 pr-3">Applies to</th>
                    <th className="py-2 pr-3">Change</th>
                    <th className="py-2 pr-3">Rounding</th>
                    <th className="py-2 pr-3">Add-ons</th>
                    <th className="py-2 pr-3">Schedule</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => {
                    const s = status(r)
                    return (
                      <tr key={r.id} className="border-b border-slate-100 last:border-0">
                        <td className="py-2 pr-3 font-medium text-slate-900">{r.name}</td>
                        <td className="py-2 pr-3 text-slate-600">{appliesTo(r)}</td>
                        <td className={`py-2 pr-3 font-semibold ${r.percent > 0 ? "text-emerald-700" : r.percent < 0 ? "text-rose-700" : "text-slate-600"}`}>
                          {r.percent > 0 ? `+${r.percent}%` : `${r.percent}%`}
                        </td>
                        <td className="py-2 pr-3 text-slate-600">{ROUNDINGS.find((x) => x.value === r.rounding)?.label}</td>
                        <td className="py-2 pr-3 text-slate-600">{r.applyToAddons ? "Yes" : "No"}</td>
                        <td className="py-2 pr-3 text-xs text-slate-500">
                          {r.startsAt || r.endsAt
                            ? `${r.startsAt ? fmtDate(r.startsAt) : "now"} → ${r.endsAt ? fmtDate(r.endsAt) : "no end"}`
                            : "Always"}
                        </td>
                        <td className="py-2 pr-3">
                          <button
                            type="button"
                            onClick={() => toggle(r)}
                            disabled={busy === r.id}
                            className={`px-2 py-0.5 rounded-full text-xs font-medium ${s.tone}`}
                            title={r.isActive ? "Switch off" : "Switch on"}
                          >
                            {busy === r.id ? "…" : s.label}
                          </button>
                        </td>
                        <td className="py-2 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => openEdit(r)}
                            className="p-1.5 rounded-md border border-slate-200 text-slate-500 hover:text-blue-700 hover:bg-blue-50 mr-1"
                            title="Edit"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => remove(r)}
                            disabled={busy === r.id}
                            className="p-1.5 rounded-md border border-slate-200 text-slate-500 hover:text-red-600 hover:bg-red-50"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="text-base font-semibold text-slate-900">Check a restaurant</h2>
          <p className="text-xs text-slate-500 mb-3">Restaurant price, app price and the rule each dish follows right now.</p>
          <select value={checkRestaurant} onChange={(e) => loadEffective(e.target.value)} className={`${input} max-w-md`}>
            <option value="">Choose a restaurant…</option>
            {restaurantOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.sub ? ` — ${r.sub}` : ""}
              </option>
            ))}
          </select>
          {effectiveLoading ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : effective ? (
            <PriceTable dishes={effective.dishes} mode="effective" />
          ) : null}
        </div>
      </div>

      {form ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => !busy && setForm(null)}>
          <div className="w-full max-w-2xl h-full bg-white overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">{form.id ? "Edit price rule" : "New price rule"}</h2>
              <button type="button" onClick={() => setForm(null)} className="p-1 rounded hover:bg-slate-100">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
              <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Bhiwandi festive +10%" className={input} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Apply to</label>
                <select value={form.scope} onChange={(e) => set({ scope: e.target.value })} className={input}>
                  {SCOPES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Zone {form.scope === "zone" ? "" : "(optional — limits the rule to one zone)"}
                </label>
                <select value={form.zoneId} onChange={(e) => set({ zoneId: e.target.value })} className={input}>
                  <option value="">{form.scope === "zone" ? "Choose a zone…" : "Every zone"}</option>
                  {zones.map((z) => (
                    <option key={idOf(z)} value={idOf(z)}>{z.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {form.scope === "restaurant" ? (
              <MultiPicker label="Restaurants" selected={form.restaurants} onChange={(v) => set({ restaurants: v })} search={searchRestaurants} placeholder="Search restaurants" />
            ) : null}
            {form.scope === "category" ? (
              <MultiPicker label="Categories" selected={form.categories} onChange={(v) => set({ categories: v })} search={searchCategories} placeholder="Search categories" />
            ) : null}
            {form.scope === "item" ? (
              <>
                <MultiPicker label="Dishes" selected={form.items} onChange={(v) => set({ items: v })} search={searchDishes} placeholder="Search dishes by name" />
                <p className="text-xs text-slate-500 -mt-2">Tip: a 0% dish rule keeps a dish at the restaurant&rsquo;s price even when a wider rule covers it.</p>
              </>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Change</label>
                <div className="flex rounded-lg border border-slate-300 overflow-hidden text-sm">
                  {["increase", "decrease"].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => set({ direction: d })}
                      className={`flex-1 py-2 ${form.direction === d ? (d === "increase" ? "bg-emerald-600 text-white" : "bg-rose-600 text-white") : "bg-white text-slate-700"}`}
                    >
                      {d === "increase" ? "Increase" : "Decrease"}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">By (%)</label>
                <input
                  type="number"
                  min="0"
                  max={form.direction === "increase" ? 100 : 50}
                  step="0.5"
                  value={form.percent}
                  onChange={(e) => set({ percent: e.target.value })}
                  placeholder="10"
                  className={input}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Rounding</label>
                <select value={form.rounding} onChange={(e) => set({ rounding: e.target.value })} className={input}>
                  {ROUNDINGS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.applyToAddons} onChange={(e) => set({ applyToAddons: e.target.checked })} />
              Also apply to add-ons
              <span className="text-xs text-slate-400">(only for All / Zone / Restaurant rules)</span>
            </label>

            <div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={form.scheduled} onChange={(e) => set({ scheduled: e.target.checked })} />
                Only during a set time (e.g. a festival)
              </label>
              {form.scheduled ? (
                <div className="grid gap-3 sm:grid-cols-2 mt-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Starts</label>
                    <input type="datetime-local" value={form.startsAt} onChange={(e) => set({ startsAt: e.target.value })} className={input} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Ends</label>
                    <input type="datetime-local" value={form.endsAt} onChange={(e) => set({ endsAt: e.target.value })} className={input} />
                  </div>
                </div>
              ) : null}
            </div>

            {formError ? <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2 text-sm">{formError}</div> : null}

            <div className="flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                onClick={runPreview}
                disabled={previewing}
                className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium inline-flex items-center gap-2"
              >
                {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />} Preview prices
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy === "save"}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium inline-flex items-center gap-2 disabled:opacity-60"
              >
                {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {form.id ? "Save changes" : "Create rule"}
              </button>
            </div>

            {preview ? (
              <div className="border-t border-slate-200 pt-4">
                <p className="text-sm text-slate-700 mb-2">
                  This rule covers <b>{preview.total}</b> dish{preview.total === 1 ? "" : "es"}
                  {preview.total > preview.dishes.length ? ` (showing first ${preview.dishes.length})` : ""}.
                </p>
                <PriceTable dishes={preview.dishes} mode="preview" />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Restaurant | Dish | Size | Restaurant ₹ | App ₹ | note */
function PriceTable({ dishes = [], mode }) {
  if (!dishes.length) return <p className="text-sm text-slate-500 mt-3">No dishes.</p>
  return (
    <div className="overflow-x-auto mt-3 max-h-[60vh] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white">
          <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
            {mode === "preview" ? <th className="py-2 pr-3">Restaurant</th> : null}
            <th className="py-2 pr-3">Dish</th>
            <th className="py-2 pr-3 text-right">Restaurant price</th>
            {mode === "preview" ? <th className="py-2 pr-3 text-right">App now</th> : null}
            <th className="py-2 pr-3 text-right">{mode === "preview" ? "App after" : "App price"}</th>
            <th className="py-2">{mode === "preview" ? "" : "Rule"}</th>
          </tr>
        </thead>
        <tbody>
          {dishes.flatMap((d) =>
            d.sizes.map((s, i) => {
              const changed = s.app !== s.base
              return (
                <tr key={`${d.id}-${i}`} className="border-b border-slate-100">
                  {mode === "preview" ? <td className="py-1.5 pr-3 text-slate-500">{i === 0 ? d.restaurantName : ""}</td> : null}
                  <td className="py-1.5 pr-3 text-slate-800">
                    {i === 0 ? d.name : ""}
                    {s.name ? <span className="text-xs text-slate-400"> {i === 0 ? "· " : ""}{s.name}</span> : null}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-slate-600">{money(s.base)}</td>
                  {mode === "preview" ? <td className="py-1.5 pr-3 text-right text-slate-500">{money(s.current)}</td> : null}
                  <td className={`py-1.5 pr-3 text-right font-semibold ${changed ? (s.app > s.base ? "text-emerald-700" : "text-rose-700") : "text-slate-700"}`}>
                    {money(s.app)}
                  </td>
                  <td className="py-1.5 text-xs text-slate-500">
                    {i !== 0
                      ? ""
                      : mode === "preview"
                        ? d.keepsRule
                          ? `Keeps "${d.keepsRule.name}" (${d.keepsRule.percent > 0 ? "+" : ""}${d.keepsRule.percent}%)`
                          : ""
                        : d.rule
                          ? `${d.rule.name} (${d.rule.percent > 0 ? "+" : ""}${d.rule.percent}%)`
                          : "—"}
                  </td>
                </tr>
              )
            }),
          )}
        </tbody>
      </table>
    </div>
  )
}
