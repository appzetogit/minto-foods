import { useEffect, useState } from "react"
import { AlertTriangle, Banknote, Loader2, RefreshCw, Save } from "lucide-react"
import { Button } from "@food/components/ui/button"
import { Input } from "@food/components/ui/input"
import { Label } from "@food/components/ui/label"
import { adminAPI } from "@food/api"
import { toast } from "sonner"

const debugError = (..._args) => {}

const FOLLOW = "follow"
const ON = "on"
const OFF = "off"

const MODES = [
  { value: FOLLOW, label: "Follow platform" },
  { value: ON, label: "On" },
  { value: OFF, label: "Off" },
]

const modeOf = (codEnabled) => {
  if (codEnabled === true) return ON
  if (codEnabled === false) return OFF
  return FOLLOW
}

/**
 * "Follow platform" is null, never false. A zone that has never been configured
 * is not a zone that has been switched off, and false would pin it off even
 * after the platform switch comes back on.
 */
const codEnabledOf = (mode) => {
  if (mode === ON) return true
  if (mode === OFF) return false
  return null
}

const zoneIdOf = (zone) => String(zone?.id || zone?._id || "")

const REASON_TEXT = {
  "platform-off": "the platform switch is off",
  "zone-off": "this zone is switched off",
  "new-customer": "they are below this zone's minimum",
}

/**
 * The server runs the same rule checkout runs, so what is shown here cannot
 * drift from what a customer actually gets at the payment step.
 */
const effectiveRows = (effective) => {
  if (effective && typeof effective === "object") {
    return [
      { label: "New customers", decision: effective.newCustomer },
      { label: "Returning customers", decision: effective.returningCustomer },
    ]
  }
  return [{ label: "Cash on delivery", decision: { allowed: effective === true, reason: "" } }]
}

function PlatformSwitch({ enabled, disabled, onToggle }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={onToggle}
      className={`inline-flex items-center w-12 h-6 rounded-full border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
        enabled ? "bg-blue-600 border-blue-600 justify-end" : "bg-slate-200 border-slate-300 justify-start"
      }`}
    >
      <span className="h-5 w-5 rounded-full bg-white shadow-sm" />
    </button>
  )
}

export default function CodPayments() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [savingPlatform, setSavingPlatform] = useState(false)
  const [savingZoneId, setSavingZoneId] = useState("")
  const [platformEnabled, setPlatformEnabled] = useState(true)
  const [zones, setZones] = useState([])
  // Edits live apart from the server rows so that reloading one zone after its
  // own save does not throw away what is half-typed in another.
  const [drafts, setDrafts] = useState({})

  const fetchSettings = async ({ showSpinner = true, resetDrafts = false } = {}) => {
    try {
      if (showSpinner) setLoading(true)
      const res = await adminAPI.getCodSettings()
      const data = res?.data?.data || res?.data
      setPlatformEnabled(data?.platformCodEnabled !== false)
      setZones(Array.isArray(data?.zones) ? data.zones : [])
      if (resetDrafts) setDrafts({})
      setError("")
    } catch (e) {
      debugError("Error fetching COD settings:", e)
      const message = e?.response?.data?.message || "Failed to load COD settings"
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchSettings()
  }, [])

  const draftFor = (zone) => {
    const id = zoneIdOf(zone)
    return (
      drafts[id] || {
        mode: modeOf(zone?.codEnabled),
        minDeliveredOrders: String(Number(zone?.codMinDeliveredOrders) || 0),
      }
    )
  }

  const patchDraft = (zone, patch) => {
    const id = zoneIdOf(zone)
    const current = draftFor(zone)
    setDrafts((prev) => ({ ...prev, [id]: { ...current, ...patch } }))
  }

  const isDirty = (zone) => {
    const draft = draftFor(zone)
    return (
      draft.mode !== modeOf(zone?.codEnabled) ||
      (Number(draft.minDeliveredOrders) || 0) !== (Number(zone?.codMinDeliveredOrders) || 0)
    )
  }

  const handlePlatformToggle = async () => {
    const next = !platformEnabled
    try {
      setSavingPlatform(true)
      await adminAPI.updateCodSettings({ codEnabled: next })
      toast.success(next ? "Cash on delivery switched on" : "Cash on delivery switched off everywhere")
      // Every zone's effective answer changes with this switch, so take the
      // recomputed list rather than flipping a flag locally.
      await fetchSettings({ showSpinner: false })
    } catch (e) {
      debugError("Error updating platform COD setting:", e)
      toast.error(e?.response?.data?.message || "Failed to update the platform COD switch")
    } finally {
      setSavingPlatform(false)
    }
  }

  const handleZoneSave = async (zone) => {
    const id = zoneIdOf(zone)
    if (!id) return
    const draft = draftFor(zone)
    const minDeliveredOrders = Number(draft.minDeliveredOrders || 0)
    if (!Number.isInteger(minDeliveredOrders) || minDeliveredOrders < 0) {
      toast.error("Minimum delivered orders must be a whole number of 0 or more")
      return
    }

    try {
      setSavingZoneId(id)
      await adminAPI.updateZoneCod(id, {
        codEnabled: codEnabledOf(draft.mode),
        codMinDeliveredOrders: minDeliveredOrders,
      })
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      toast.success(`Saved COD settings for ${zone?.name || "this zone"}`)
      await fetchSettings({ showSpinner: false })
    } catch (e) {
      debugError("Error updating zone COD settings:", e)
      toast.error(e?.response?.data?.message || "Failed to save this zone's COD settings")
    } finally {
      setSavingZoneId("")
    }
  }

  if (loading) {
    return (
      <div className="p-4 lg:p-6 bg-slate-50 min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center">
            <Banknote className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">COD &amp; User Payments</h1>
        </div>
        <p className="text-sm text-slate-600">
          Decide where customers may pay cash on delivery, and how many delivered orders they need
          before it is offered to them.
        </p>
      </div>

      {error ? (
        <div className="bg-white rounded-xl shadow-sm border border-red-200 p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-slate-900">{error}</p>
              <p className="text-xs text-slate-500 mt-1">
                Nothing has been changed. Try loading the settings again.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => fetchSettings({ resetDrafts: true })}
              >
                <RefreshCw className="w-4 h-4" />
                Retry
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Platform switch */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Cash on delivery (whole platform)</h2>
                <p className="text-xs text-slate-500 mt-1">
                  {platformEnabled
                    ? "Cash on delivery is available, subject to each zone's own setting below."
                    : "Cash on delivery is switched off. No customer can pay cash anywhere."}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {savingPlatform ? <Loader2 className="w-4 h-4 animate-spin text-slate-400" /> : null}
                <span className="text-xs font-semibold text-slate-700">
                  {platformEnabled ? "On" : "Off"}
                </span>
                <PlatformSwitch
                  enabled={platformEnabled}
                  disabled={savingPlatform}
                  onToggle={handlePlatformToggle}
                />
              </div>
            </div>

            <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <p className="text-xs text-slate-700">
                When this switch is off, cash on delivery is off in every zone, whatever an
                individual zone says. Zone settings only apply while it is on.
              </p>
            </div>
          </div>

          {/* Per-zone settings */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Zones</h2>
                <p className="text-xs text-slate-500 mt-1">
                  Each zone is saved on its own row.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fetchSettings({ resetDrafts: true })}
              >
                <RefreshCw className="w-4 h-4" />
                Refresh
              </Button>
            </div>

            {zones.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <p className="text-sm font-semibold text-slate-900">No zones yet</p>
                <p className="text-xs text-slate-500 mt-1">
                  Create a delivery zone under Zone Setup, then set its cash on delivery rules here.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {zones.map((zone) => {
                  const id = zoneIdOf(zone)
                  const draft = draftFor(zone)
                  const saving = savingZoneId === id
                  const dirty = isDirty(zone)

                  return (
                    <div key={id} className="px-6 py-5">
                      <div className="flex flex-col xl:flex-row xl:items-end gap-4">
                        <div className="xl:w-56">
                          <p className="text-sm font-semibold text-slate-900">
                            {zone?.name || "Unnamed zone"}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">{zone?.city || "No city set"}</p>
                        </div>

                        <div className="xl:w-72">
                          <Label className="text-xs font-semibold text-slate-700">Cash on delivery</Label>
                          <div className="mt-1.5 inline-flex rounded-lg border border-slate-300 overflow-hidden">
                            {MODES.map((mode) => (
                              <button
                                key={mode.value}
                                type="button"
                                disabled={saving}
                                onClick={() => patchDraft(zone, { mode: mode.value })}
                                className={`px-3 py-2 text-xs font-semibold transition-colors border-r border-slate-300 last:border-r-0 disabled:opacity-50 disabled:cursor-not-allowed ${
                                  draft.mode === mode.value
                                    ? "bg-blue-600 text-white"
                                    : "bg-white text-slate-700 hover:bg-slate-50"
                                }`}
                              >
                                {mode.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="xl:w-64">
                          <Label className="text-xs font-semibold text-slate-700">
                            Minimum delivered orders
                          </Label>
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            disabled={saving}
                            value={draft.minDeliveredOrders}
                            onChange={(e) =>
                              patchDraft(zone, {
                                minDeliveredOrders: e.target.value.replace(/\D/g, ""),
                              })
                            }
                            className="mt-1.5"
                          />
                          <p className="mt-1 text-xs text-slate-500">
                            0 lets everyone pay cash. 1 keeps cash off for a customer&apos;s first
                            order and turns it on once they have had one delivered.
                          </p>
                        </div>

                        <div className="flex-1">
                          <p className="text-xs font-semibold text-slate-700">What this means now</p>
                          <div className="mt-1.5 space-y-1">
                            {effectiveRows(zone?.effective).map((row) => (
                              <p key={row.label} className="text-xs text-slate-600">
                                <span className="text-slate-500">{row.label}:</span>{" "}
                                <span
                                  className={
                                    row.decision?.allowed
                                      ? "font-semibold text-emerald-600"
                                      : "font-semibold text-red-600"
                                  }
                                >
                                  {row.decision?.allowed ? "can pay cash" : "cannot pay cash"}
                                </span>
                                {!row.decision?.allowed && REASON_TEXT[row.decision?.reason]
                                  ? ` — ${REASON_TEXT[row.decision.reason]}`
                                  : ""}
                              </p>
                            ))}
                          </div>
                          {dirty ? (
                            <p className="mt-1.5 text-xs text-amber-600">
                              Unsaved changes — this still shows the saved settings.
                            </p>
                          ) : null}
                        </div>

                        <div className="xl:self-center">
                          <Button
                            type="button"
                            size="sm"
                            disabled={saving || !dirty}
                            onClick={() => handleZoneSave(zone)}
                          >
                            {saving ? (
                              <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Saving
                              </>
                            ) : (
                              <>
                                <Save className="w-4 h-4" />
                                Save
                              </>
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
