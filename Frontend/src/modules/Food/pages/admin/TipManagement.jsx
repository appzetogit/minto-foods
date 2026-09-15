import { useEffect, useState } from "react"
import { adminAPI } from "@food/api"
import { Loader2, Plus, X } from "lucide-react"

/**
 * Tips for delivery riders: the amounts a customer may choose, and what riders
 * were actually given.
 *
 * The amounts live here and nowhere else -- the apps ask for them, so changing
 * what customers are offered never waits on an app release.
 */

const money = (n) => `\u20b9${Number(n || 0).toLocaleString("en-IN")}`

export default function TipManagement() {
  const [settings, setSettings] = useState({ tipsEnabled: true, tipPresets: [], tipMaxAmount: null })
  const [report, setReport] = useState(null)
  const [newPreset, setNewPreset] = useState("")
  const [maxAmount, setMaxAmount] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const load = async () => {
    setError("")
    try {
      setLoading(true)
      const [s, r] = await Promise.all([adminAPI.getTipSettings(), adminAPI.getTipReport(30)])
      const sd = s?.data?.data ?? s?.data ?? {}
      setSettings({
        tipsEnabled: sd.tipsEnabled !== false,
        tipPresets: Array.isArray(sd.tipPresets) ? sd.tipPresets : [],
        tipMaxAmount: sd.tipMaxAmount ?? null,
      })
      setMaxAmount(sd.tipMaxAmount == null ? "" : String(sd.tipMaxAmount))
      setReport(r?.data?.data ?? r?.data ?? null)
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not load tips.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const save = async (patch) => {
    setError("")
    setNotice("")
    try {
      setSaving(true)
      const res = await adminAPI.updateTipSettings({
        tipsEnabled: settings.tipsEnabled,
        tipPresets: settings.tipPresets,
        tipMaxAmount: maxAmount === "" ? null : Number(maxAmount),
        ...patch,
      })
      const data = res?.data?.data ?? res?.data ?? {}
      setSettings({
        tipsEnabled: data.tipsEnabled !== false,
        tipPresets: Array.isArray(data.tipPresets) ? data.tipPresets : [],
        tipMaxAmount: data.tipMaxAmount ?? null,
      })
      // The server saves and warns rather than refusing, so show what it said.
      if (data.warning) setNotice(data.warning)
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not save the tip settings.")
      await load()
    } finally {
      setSaving(false)
    }
  }

  const addPreset = () => {
    const amount = Math.round(Number(newPreset))
    if (!Number.isFinite(amount) || amount <= 0) return setError("A tip amount must be a whole number above 0.")
    if (settings.tipPresets.includes(amount)) return setError("That amount is already offered.")
    const next = [...settings.tipPresets, amount].sort((a, b) => a - b)
    setSettings((s) => ({ ...s, tipPresets: next }))
    setNewPreset("")
    save({ tipPresets: next })
  }

  const removePreset = (amount) => {
    const next = settings.tipPresets.filter((p) => p !== amount)
    setSettings((s) => ({ ...s, tipPresets: next }))
    save({ tipPresets: next })
  }

  return (
    <div className="p-3 bg-slate-50 min-h-screen">
      <div className="w-full mx-auto max-w-5xl space-y-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h1 className="text-xl font-bold text-slate-900">Tip Management</h1>
          <p className="text-sm text-slate-500 mt-1">
            The tip amounts customers are offered at checkout, and what riders have been tipped.
            A tip is paid to the rider on top of their delivery earning.
          </p>
        </div>

        {error ? <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-4 py-3 text-sm">{error}</div> : null}
        {notice ? <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm">{notice}</div> : null}

        {loading ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 flex items-center gap-2 text-slate-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading&hellip;
          </div>
        ) : (
          <>
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Tipping</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Off hides tipping in the apps entirely. Existing tips are unaffected.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    const next = !settings.tipsEnabled
                    setSettings((s) => ({ ...s, tipsEnabled: next }))
                    save({ tipsEnabled: next })
                  }}
                  className={`px-4 py-2 rounded-lg text-sm font-medium ${
                    settings.tipsEnabled ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-700"
                  }`}
                >
                  {settings.tipsEnabled ? "On" : "Off"}
                </button>
              </div>

              <label className="block text-xs font-medium text-slate-600 mb-1">Amounts offered</label>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                {settings.tipPresets.length === 0 ? (
                  <span className="text-sm text-slate-500">No amounts yet — customers will see no tip options.</span>
                ) : (
                  settings.tipPresets.map((amount) => (
                    <span key={amount} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-slate-100 text-sm font-medium text-slate-800">
                      {money(amount)}
                      <button type="button" onClick={() => removePreset(amount)} disabled={saving} className="text-slate-400 hover:text-red-600">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ))
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  value={newPreset}
                  onChange={(e) => setNewPreset(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addPreset() }}
                  placeholder="Add an amount"
                  className="w-40 px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
                <button type="button" onClick={addPreset} disabled={saving} className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium inline-flex items-center gap-1">
                  <Plus className="w-4 h-4" /> Add
                </button>
              </div>

              <div className="mt-4 max-w-xs">
                <label className="block text-xs font-medium text-slate-600 mb-1">Maximum custom tip</label>
                <input
                  type="number"
                  min="1"
                  value={maxAmount}
                  onChange={(e) => setMaxAmount(e.target.value)}
                  onBlur={() => save({})}
                  placeholder="No limit"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
                <p className="mt-1 text-xs text-slate-500">Blank means a customer may tip any amount.</p>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <h2 className="text-base font-semibold text-slate-900 mb-1">Tips received</h2>
              <p className="text-xs text-slate-500 mb-4">Last {report?.days ?? 30} days.</p>

              <div className="grid grid-cols-2 gap-3 mb-4 max-w-sm">
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                  <div className="text-xs text-slate-500">Total tipped</div>
                  <div className="text-lg font-semibold text-slate-900">{money(report?.totalTipped)}</div>
                </div>
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                  <div className="text-xs text-slate-500">Orders with a tip</div>
                  <div className="text-lg font-semibold text-slate-900">{report?.tippedOrders ?? 0}</div>
                </div>
              </div>

              {!report?.riders?.length ? (
                <p className="text-sm text-slate-500">
                  No tips yet. Customers can tip once the apps ship the tip option at checkout.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold text-slate-700">Rider</th>
                        <th className="px-3 py-2 text-left font-semibold text-slate-700">Phone</th>
                        <th className="px-3 py-2 text-right font-semibold text-slate-700">Orders</th>
                        <th className="px-3 py-2 text-right font-semibold text-slate-700">Tips</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.riders.map((r) => (
                        <tr key={r.riderId || "unassigned"} className="border-b border-slate-100">
                          <td className="px-3 py-2 text-slate-900">{r.name}</td>
                          <td className="px-3 py-2 text-slate-500">{r.phone || "—"}</td>
                          <td className="px-3 py-2 text-right text-slate-700">{r.orders}</td>
                          <td className="px-3 py-2 text-right font-medium text-slate-900">{money(r.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
