import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Loader2, Save } from "lucide-react"
import { adminAPI } from "@food/api"

/**
 * Dispatch Settings: how orders get a rider.
 *
 * Automatic: offered to nearby online riders, first to accept wins.
 * Manual: nothing is offered; an admin assigns each order from Assign Rider.
 * A platform-wide default (super admin) and a per-zone override.
 */

const errText = (e, f) => e?.response?.data?.message || e?.message || f
const dataOf = (res) => res?.data?.data ?? res?.data ?? {}

const MANUAL_WARNING = (where) =>
  `New orders ${where} won't be offered to riders. Someone must assign each order from Order Management → Assign Rider, or it won't be delivered.\n\nContinue?`

export default function DispatchSettings() {
  const [data, setData] = useState(null)
  const [form, setForm] = useState({ dispatchMode: "auto", manualAcceptWindowSeconds: 120, manualQueueAlertMinutes: 5 })
  const [saving, setSaving] = useState("")

  const load = async () => {
    try {
      const d = dataOf(await adminAPI.getDispatchSettings())
      setData(d)
      setForm({
        dispatchMode: d.dispatchMode || "auto",
        manualAcceptWindowSeconds: d.manualAcceptWindowSeconds || 120,
        manualQueueAlertMinutes: d.manualQueueAlertMinutes || 5,
      })
    } catch (e) {
      toast.error(errText(e, "Could not load dispatch settings"))
    }
  }
  useEffect(() => {
    load()
  }, [])

  const saveGlobal = async () => {
    if (form.dispatchMode === "manual" && data?.dispatchMode !== "manual" && !window.confirm(MANUAL_WARNING("in every zone that follows the default"))) return
    try {
      setSaving("global")
      setData(dataOf(await adminAPI.updateDispatchSettings({
        dispatchMode: form.dispatchMode,
        manualAcceptWindowSeconds: Number(form.manualAcceptWindowSeconds),
        manualQueueAlertMinutes: Number(form.manualQueueAlertMinutes),
      })))
      toast.success("Dispatch settings saved")
    } catch (e) {
      toast.error(errText(e, "Could not save"))
    } finally {
      setSaving("")
    }
  }

  const setZone = async (zone, value) => {
    const mode = value === "default" ? null : value
    const effective = mode || data?.dispatchMode
    if (effective === "manual" && zone.effectiveMode !== "manual" && !window.confirm(MANUAL_WARNING(`in ${zone.name}`))) return
    try {
      setSaving(zone.id)
      await adminAPI.updateZoneDispatchMode(zone.id, mode)
      toast.success(`${zone.name}: ${effective === "manual" ? "manual" : "automatic"} assignment`)
      await load()
    } catch (e) {
      toast.error(errText(e, "Could not change the zone"))
    } finally {
      setSaving("")
    }
  }

  if (!data) {
    return (
      <div className="flex h-[320px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="p-3 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h1 className="text-xl font-bold text-slate-900">Dispatch Settings</h1>
          <p className="text-sm text-slate-500 mt-1">
            <b>Automatic</b>: orders are offered to nearby online riders and the first to accept gets it.{" "}
            <b>Manual</b>: nothing is offered — an admin assigns each order from{" "}
            <Link to="/admin/food/dispatch/assign" className="text-blue-600 underline">Assign Rider</Link>.
          </p>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">Platform default</h2>
          <div className="flex flex-wrap gap-2">
            {["auto", "manual"].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setForm((f) => ({ ...f, dispatchMode: m }))}
                className={`px-4 py-2 rounded-lg text-sm border ${form.dispatchMode === m ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-700 border-slate-300"}`}
              >
                {m === "auto" ? "Automatic" : "Manual"}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-slate-700">
              Rider must accept an admin assignment within (seconds)
              <input
                type="number"
                min="30"
                max="900"
                value={form.manualAcceptWindowSeconds}
                onChange={(e) => setForm((f) => ({ ...f, manualAcceptWindowSeconds: e.target.value }))}
                className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
              />
            </label>
            <label className="text-sm text-slate-700">
              Remind admins when an order waits longer than (minutes)
              <input
                type="number"
                min="1"
                max="120"
                value={form.manualQueueAlertMinutes}
                onChange={(e) => setForm((f) => ({ ...f, manualQueueAlertMinutes: e.target.value }))}
                className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
              />
            </label>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={saveGlobal}
              disabled={saving === "global"}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium inline-flex items-center gap-2 disabled:opacity-60"
            >
              {saving === "global" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
            </button>
          </div>
          <p className="text-xs text-slate-400">Only the super admin can change the platform default. City admins can set their own zones below.</p>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="text-base font-semibold text-slate-900 mb-3">Per zone</h2>
          {data.zones?.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3">Zone</th>
                  <th className="py-2 pr-3">City</th>
                  <th className="py-2 pr-3">Mode</th>
                  <th className="py-2">Now</th>
                </tr>
              </thead>
              <tbody>
                {data.zones.map((z) => (
                  <tr key={z.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-3 font-medium text-slate-900">{z.name}</td>
                    <td className="py-2 pr-3 text-slate-600">{z.city || "—"}</td>
                    <td className="py-2 pr-3">
                      <select
                        value={z.dispatchMode || "default"}
                        disabled={saving === z.id}
                        onChange={(e) => setZone(z, e.target.value)}
                        className="px-2 py-1.5 text-sm rounded-lg border border-slate-300 bg-white"
                      >
                        <option value="default">Platform default</option>
                        <option value="auto">Automatic</option>
                        <option value="manual">Manual</option>
                      </select>
                    </td>
                    <td className="py-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${z.effectiveMode === "manual" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                        {z.effectiveMode === "manual" ? "Manual" : "Automatic"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-slate-500">No zones.</p>
          )}
        </div>
      </div>
    </div>
  )
}
