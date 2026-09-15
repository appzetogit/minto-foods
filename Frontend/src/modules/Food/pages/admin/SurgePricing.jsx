import { useEffect, useState } from "react"
import { adminAPI } from "@food/api"
import { Loader2, Plus, Trash2 } from "lucide-react"

/**
 * Surge: a flat amount added to the delivery fee while a rule is running.
 *
 * Flat rather than a multiplier so a customer can be told "delivery is Rs 15
 * more in the rain" -- a multiplier means a different surcharge on every order.
 */

const money = (n) => `\u20b9${Number(n || 0).toLocaleString("en-IN")}`

/** A datetime-local value from an ISO string, in the browser's own zone. */
const toLocalInput = (value) => {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const emptyForm = { label: "", surgeFee: "", zoneId: "", scheduled: false, startAt: "", endAt: "" }

export default function SurgePricing() {
  const [rules, setRules] = useState([])
  const [zones, setZones] = useState([])
  const [form, setForm] = useState(emptyForm)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")

  const load = async () => {
    setError("")
    try {
      setLoading(true)
      const res = await adminAPI.getSurgeRules()
      const data = res?.data?.data ?? res?.data ?? {}
      setRules(Array.isArray(data.rules) ? data.rules : [])
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not load the surge rules.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    adminAPI
      .getZones()
      .then((res) => {
        const data = res?.data?.data ?? res?.data ?? {}
        setZones(Array.isArray(data.zones) ? data.zones : Array.isArray(data) ? data : [])
      })
      .catch(() => setZones([]))
  }, [])

  const create = async () => {
    setError("")
    const fee = Number(form.surgeFee)
    if (!Number.isFinite(fee) || fee <= 0) return setError("The surge amount must be more than 0.")
    if (form.scheduled && (!form.startAt || !form.endAt)) return setError("A scheduled surge needs both a start and an end.")
    if (form.scheduled && form.endAt <= form.startAt) return setError("The end time must be after the start time.")

    try {
      setBusy("create")
      await adminAPI.createSurgeRule({
        label: form.label,
        surgeFee: fee,
        zoneId: form.zoneId || null,
        // Immediate means no window at all: on from now until switched off.
        startAt: form.scheduled ? new Date(form.startAt).toISOString() : null,
        endAt: form.scheduled ? new Date(form.endAt).toISOString() : null,
        isActive: true,
      })
      setForm(emptyForm)
      await load()
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not create the surge rule.")
    } finally {
      setBusy("")
    }
  }

  const toggle = async (rule) => {
    setError("")
    try {
      setBusy(rule.id)
      await adminAPI.updateSurgeRule(rule.id, { isActive: !rule.isActive })
      await load()
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not change the rule.")
    } finally {
      setBusy("")
    }
  }

  const remove = async (rule) => {
    if (!window.confirm(`Delete this surge rule${rule.label ? ` ("${rule.label}")` : ""}?`)) return
    setError("")
    try {
      setBusy(rule.id)
      await adminAPI.deleteSurgeRule(rule.id)
      await load()
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not delete the rule.")
    } finally {
      setBusy("")
    }
  }

  const state = (rule) => {
    if (!rule.isActive) return { label: "Off", tone: "bg-slate-100 text-slate-600" }
    if (rule.isRunningNow) return { label: "Charging now", tone: "bg-rose-100 text-rose-700" }
    return { label: "Scheduled", tone: "bg-amber-100 text-amber-700" }
  }

  const runningNow = rules.filter((r) => r.isRunningNow)

  return (
    <div className="p-3 bg-slate-50 min-h-screen">
      <div className="w-full mx-auto max-w-5xl space-y-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h1 className="text-xl font-bold text-slate-900">Surge Pricing</h1>
          <p className="text-sm text-slate-500 mt-1">
            Adds a flat amount to the delivery fee — now, or during a set window. The rider&rsquo;s pay
            is unchanged, and an order with free delivery stays free.
          </p>
        </div>

        {runningNow.length ? (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg px-4 py-3 text-sm">
            Customers are being charged {money(Math.max(...runningNow.map((r) => r.surgeFee)))} extra for delivery right now.
          </div>
        ) : null}

        {error ? <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-4 py-3 text-sm">{error}</div> : null}

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="text-base font-semibold text-slate-900 mb-3">Add a surge</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Reason</label>
              <input
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="Heavy rain"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <p className="mt-1 text-xs text-slate-500">For your records. Customers never see it.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Extra delivery charge (&#8377;)</label>
              <input
                type="number"
                min="1"
                value={form.surgeFee}
                onChange={(e) => setForm((f) => ({ ...f, surgeFee: e.target.value }))}
                placeholder="15"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Zone</label>
              <select
                value={form.zoneId}
                onChange={(e) => setForm((f) => ({ ...f, zoneId: e.target.value }))}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                <option value="">Every zone</option>
                {zones.map((z) => (
                  <option key={z.id || z._id} value={z.id || z._id}>{z.name}{z.city ? ` — ${z.city}` : ""}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">When</label>
              <select
                value={form.scheduled ? "scheduled" : "now"}
                onChange={(e) => setForm((f) => ({ ...f, scheduled: e.target.value === "scheduled" }))}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                <option value="now">Immediately, until I switch it off</option>
                <option value="scheduled">On a schedule</option>
              </select>
            </div>

            {form.scheduled ? (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Starts</label>
                  <input
                    type="datetime-local"
                    value={form.startAt}
                    onChange={(e) => setForm((f) => ({ ...f, startAt: e.target.value }))}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Ends</label>
                  <input
                    type="datetime-local"
                    value={form.endAt}
                    onChange={(e) => setForm((f) => ({ ...f, endAt: e.target.value }))}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
                  />
                </div>
              </>
            ) : null}

            <div className="sm:col-span-2 flex justify-end">
              <button
                type="button"
                onClick={create}
                disabled={busy === "create"}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium inline-flex items-center gap-2 disabled:opacity-60"
              >
                {busy === "create" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Add surge
              </button>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="text-base font-semibold text-slate-900 mb-3">Rules</h2>
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading&hellip;
            </div>
          ) : rules.length === 0 ? (
            <p className="text-sm text-slate-500">No surge rules. Delivery is charged at the normal fee.</p>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => {
                const s = state(rule)
                return (
                  <div key={rule.id} className="flex flex-wrap items-center gap-3 border border-slate-200 rounded-lg p-3">
                    <span className="font-semibold text-slate-900">+{money(rule.surgeFee)}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${s.tone}`}>{s.label}</span>
                    <span className="text-sm text-slate-600">{rule.label || "No reason given"}</span>
                    <span className="text-xs text-slate-400">
                      {rule.zoneName ? `${rule.zoneName} only` : "Every zone"}
                      {" · "}
                      {rule.startAt
                        ? `${new Date(rule.startAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} to ${new Date(rule.endAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                        : "no schedule"}
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggle(rule)}
                        disabled={busy === rule.id}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium ${rule.isActive ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-700"}`}
                      >
                        {busy === rule.id ? "…" : rule.isActive ? "On" : "Off"}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(rule)}
                        disabled={busy === rule.id}
                        className="p-1.5 rounded-md border border-slate-200 text-slate-500 hover:text-red-600 hover:bg-red-50"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
