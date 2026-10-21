import { useState, useEffect } from "react"
import { Save, Loader2, DollarSign, Plus, Trash2, Edit, Check, X } from "lucide-react"
import { Button } from "@food/components/ui/button"
import { adminAPI } from "@food/api"
import { toast } from "sonner"
import { FEE_FIELDS, checkFee, validateFeeSettings } from "./feeValidation"
const debugLog = (...args) => {}
const debugWarn = (...args) => {}
const debugError = (...args) => {}


// Fee Settings Component - Range-based delivery fee configuration
/**
 * The distance ladder must start at 0 km and have no gaps: a distance no range
 * covered was quietly priced as the longest range. The server checks the same.
 */
const ladderProblem = (ranges = []) => {
  const sorted = [...ranges].sort((a, b) => Number(a.min) - Number(b.min))
  if (!sorted.length) return null
  if (Number(sorted[0].min) > 0.001) return `The first range must start at 0 km (it starts at ${sorted[0].min} km)`
  for (let i = 1; i < sorted.length; i += 1) {
    if (Math.abs(Number(sorted[i].min) - Number(sorted[i - 1].max)) > 0.001) {
      return `Ranges must not have gaps: nothing covers ${sorted[i - 1].max} km to ${sorted[i].min} km`
    }
  }
  return null
}

// The same arithmetic as the server (order-pricing.service.js): each range
// charges its fee plus the per-km rate past the range start, and pays the
// rider base pay plus per-km past the range start. A distance past the last
// range uses the last range.
const rangeFor = (ranges, km) => {
  const sorted = [...ranges].sort((a, b) => Number(a.min) - Number(b.min))
  const hit = sorted.find((r, i) =>
    km >= Number(r.min) && (i === sorted.length - 1 ? km <= Number(r.max) : km < Number(r.max)))
  return hit || sorted[sorted.length - 1]
}
const customerFeeAt = (ranges, km) => {
  const r = rangeFor(ranges, km)
  return Number(r.fee || 0) + Number(r.feePerKm || 0) * Math.max(0, km - Number(r.min || 0))
}
const riderPayAt = (ranges, km, floor) => {
  const r = rangeFor(ranges, km)
  const pay = Number(r.deliveryBoyBasePay || 0) + Number(r.deliveryBoyPerKm || 0) * Math.max(0, km - Number(r.min || 0))
  return Math.max(Number(floor) || 0, Math.round(pay))
}

/** What each distance costs the customer, pays the rider, and leaves the platform. */
function FeePreview({ ranges, riderFloor }) {
  if (!ranges.length) return null
  const last = Math.max(...ranges.map((r) => Number(r.max) || 0))
  const points = [...new Set([
    ...Array.from({ length: Math.min(Math.ceil(last), 20) }, (_, i) => i + 1),
    ...ranges.map((r) => Number(r.max)),
    ...ranges.map((r) => Math.max(0, Number(r.max) - 0.1)),
  ])].filter((km) => km > 0 && km <= last).sort((a, b) => a - b)

  let previousFee = -Infinity
  const rows = points.map((km) => {
    const fee = Math.round(customerFeeAt(ranges, km) * 100) / 100
    const pay = riderPayAt(ranges, km, riderFloor)
    const drop = fee < previousFee - 0.009
    previousFee = fee
    return { km, fee, pay, margin: Math.round((fee - pay) * 100) / 100, drop }
  })
  const losses = rows.filter((r) => r.margin < 0).length
  const drops = rows.filter((r) => r.drop).length

  return (
    <div className="mb-4 rounded-lg border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
        <h4 className="text-sm font-semibold text-slate-800">Preview: what each distance costs</h4>
        <p className="text-xs text-slate-500 mt-0.5">
          Delivery fee only (before GST, surge and Quick delivery). Rider pay includes the minimum pay per trip.
        </p>
        {(losses > 0 || drops > 0) && (
          <p className="mt-2 text-xs font-semibold text-red-600">
            {losses > 0 ? `Rider is paid more than the customer pays at ${losses} distance${losses > 1 ? "s" : ""}. ` : ""}
            {drops > 0 ? "The customer fee goes down as the distance goes up somewhere below: start the next range at the price the previous one ends on." : ""}
          </p>
        )}
      </div>
      <div className="max-h-72 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="bg-white sticky top-0">
            <tr className="text-left text-xs text-slate-500">
              <th className="px-4 py-2 font-medium">Distance</th>
              <th className="px-4 py-2 font-medium text-right">Customer pays</th>
              <th className="px-4 py-2 font-medium text-right">Rider gets</th>
              <th className="px-4 py-2 font-medium text-right">Platform keeps</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.km} className={r.margin < 0 || r.drop ? "bg-red-50" : ""}>
                <td className="px-4 py-1.5 text-slate-700">{Number(r.km.toFixed(2))} km</td>
                <td className={`px-4 py-1.5 text-right ${r.drop ? "text-red-600 font-semibold" : "text-slate-800"}`}>₹{r.fee.toFixed(2)}</td>
                <td className="px-4 py-1.5 text-right text-slate-800">₹{r.pay}</td>
                <td className={`px-4 py-1.5 text-right font-semibold ${r.margin < 0 ? "text-red-600" : "text-green-700"}`}>
                  {r.margin < 0 ? "−" : ""}₹{Math.abs(r.margin).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function FeeSettings() {
  const [feeSettings, setFeeSettings] = useState({
    deliveryFee: "",
    deliveryFeeRanges: [],
    platformFee: "",
    quickDeliveryFee: "",
    riderMinPayPerTrip: "",
    gstRate: "",
    deliveryFeeGstRate: "",
    deliveryDistanceMode: "",
    roadDistanceCapFactor: "",
  })
  // Which scope is being edited. "" is the global default that applies to any
  // zone without fees of its own.
  const [selectedZoneId, setSelectedZoneId] = useState("")
  const [zones, setZones] = useState([])
  // Whether the selected zone has fees of its own, as opposed to inheriting
  // the global ones. The two look identical on screen otherwise.
  const [scopeConfigured, setScopeConfigured] = useState(false)
  const [loadingFeeSettings, setLoadingFeeSettings] = useState(false)
  const [savingFeeSettings, setSavingFeeSettings] = useState(false)
  // Which boxes are out of bounds, keyed by field. Shown under the box rather
  // than as a toast, so the admin can see which one to fix.
  const [feeErrors, setFeeErrors] = useState({})
  const [editingRangeIndex, setEditingRangeIndex] = useState(null)
  const [newRange, setNewRange] = useState({ 
    min: '', 
    max: '', 
    fee: '0', 
    feePerKm: '0',
    deliveryBoyPerKm: '0', 
    deliveryBoyBasePay: '0' 
  })

  // Fetch fee settings
  const fetchFeeSettings = async (zoneId = selectedZoneId) => {
    try {
      setLoadingFeeSettings(true)
      const response = await adminAPI.getFeeSettings(zoneId ? { zoneId } : {})
      if (response.data.success && response.data.data.feeSettings) {
        setScopeConfigured(true)
        setFeeSettings({
          deliveryFee: response.data.data.feeSettings.deliveryFee ?? "",
          deliveryFeeRanges: response.data.data.feeSettings.deliveryFeeRanges || [],
          platformFee: response.data.data.feeSettings.platformFee ?? "",
          quickDeliveryFee: response.data.data.feeSettings.quickDeliveryFee ?? "",
          riderMinPayPerTrip: response.data.data.feeSettings.riderMinPayPerTrip ?? "",
          gstRate: response.data.data.feeSettings.gstRate ?? "",
          deliveryFeeGstRate: response.data.data.feeSettings.deliveryFeeGstRate ?? "",
          deliveryDistanceMode: response.data.data.feeSettings.deliveryDistanceMode ?? "",
          roadDistanceCapFactor: response.data.data.feeSettings.roadDistanceCapFactor ?? "",
        })
      } else if (response.data.success && response.data.data.feeSettings === null) {
        setScopeConfigured(false)
        // Not configured yet - keep empty fields (no defaults).
        setFeeSettings({
          deliveryFee: "",
          deliveryFeeRanges: [],
          platformFee: "",
          quickDeliveryFee: "",
          riderMinPayPerTrip: "",
          gstRate: "",
          deliveryFeeGstRate: "",
          deliveryDistanceMode: "",
          roadDistanceCapFactor: "",
        })
      }
    } catch (error) {
      debugError('Error fetching fee settings:', error)
      toast.error('Failed to load fee settings')
    } finally {
      setLoadingFeeSettings(false)
    }
  }

  // Fetch fee settings on mount
  useEffect(() => {
    const loadZones = async () => {
      try {
        const response = await adminAPI.getZones({ isActive: true })
        const payload = response?.data?.data ?? response?.data ?? {}
        const rows = payload.zones || payload.items || payload.data || (Array.isArray(payload) ? payload : [])
        setZones(Array.isArray(rows) ? rows : [])
      } catch (error) {
        // Without the list the screen still edits the global default.
        setZones([])
      }
    }
    loadZones()
  }, [])

  // Reloads whenever the scope changes, so the form always shows the fees for
  // the zone named above it rather than whichever was loaded first.
  useEffect(() => {
    fetchFeeSettings(selectedZoneId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedZoneId])

  // Unified save function
  const zoneLabelFor = (id) => {
    const zone = zones.find((z) => String(z.id || z._id) === String(id))
    return zone?.name || zone?.zoneName || "this zone"
  }

  const saveSettings = async (settingsToSave) => {
    // The inputs carry min/max, but those only drive the spinner arrows --
    // typing past them is allowed and nothing was checking the result.
    const problems = validateFeeSettings(settingsToSave)
    setFeeErrors(problems)
    const first = Object.values(problems)[0]
    if (first) {
      toast.error(first)
      return false
    }

    try {
      setSavingFeeSettings(true)
      const payload = {
        deliveryFee: settingsToSave.deliveryFee === "" ? undefined : Number(settingsToSave.deliveryFee),
        deliveryFeeRanges: settingsToSave.deliveryFeeRanges.map(r => ({
          ...r,
          feePerKm: r.feePerKm === "" || r.feePerKm === undefined ? 0 : Number(r.feePerKm),
          deliveryBoyPerKm: r.deliveryBoyPerKm === "" ? 0 : Number(r.deliveryBoyPerKm),
          deliveryBoyBasePay: r.deliveryBoyBasePay === "" ? 0 : Number(r.deliveryBoyBasePay),
        })),
        platformFee: settingsToSave.platformFee === "" ? undefined : Number(settingsToSave.platformFee),
        quickDeliveryFee: settingsToSave.quickDeliveryFee === "" ? undefined : Number(settingsToSave.quickDeliveryFee),
        riderMinPayPerTrip:
          settingsToSave.riderMinPayPerTrip === "" ? null : Number(settingsToSave.riderMinPayPerTrip),
        gstRate: settingsToSave.gstRate === "" ? undefined : Number(settingsToSave.gstRate),
        deliveryFeeGstRate: settingsToSave.deliveryFeeGstRate === "" ? undefined : Number(settingsToSave.deliveryFeeGstRate),
        // The distance choice was removed from this page; saving clears any
        // old value. The fee is always on road distance capped at 1.5x.
        deliveryDistanceMode: null,
        roadDistanceCapFactor: null,
        isActive: true,
        // Without this a zone edit would land on the global row and change
        // the fees for every zone that inherits it.
        zoneId: selectedZoneId || null,
      }
      
      debugLog('[DEBUG] Saving Fee Settings Payload:', payload)
      
      const response = await adminAPI.createOrUpdateFeeSettings(payload)

      if (response.data.success) {
        toast.success(
          selectedZoneId
            ? `Fees saved for ${zoneLabelFor(selectedZoneId)}`
            : 'Global fees saved',
        )
        setScopeConfigured(true)
        const saved = response?.data?.data?.feeSettings
        if (saved) {
          setFeeSettings({
            deliveryFee: saved.deliveryFee ?? "",
            deliveryFeeRanges: saved.deliveryFeeRanges ?? [],
            platformFee: saved.platformFee ?? "",
            quickDeliveryFee: saved.quickDeliveryFee ?? "",
            riderMinPayPerTrip: saved.riderMinPayPerTrip ?? "",
            gstRate: saved.gstRate ?? "",
            deliveryFeeGstRate: saved.deliveryFeeGstRate ?? "",
            deliveryDistanceMode: saved.deliveryDistanceMode ?? "",
            roadDistanceCapFactor: saved.roadDistanceCapFactor ?? "",
          })
        }
        return true
      } else {
        toast.error(response.data.message || 'Failed to save settings')
        return false
      }
    } catch (error) {
      debugError('Error saving fee settings:', error)
      toast.error(error.response?.data?.message || 'Failed to save settings')
      return false
    } finally {
      setSavingFeeSettings(false)
    }
  }

  const setFee = (key, value) => {
    setFeeSettings((prev) => ({ ...prev, [key]: value }))
    const field = FEE_FIELDS.find((f) => f.key === key)
    // Cleared as soon as the value becomes acceptable, rather than making the
    // admin press Save again to find out whether they fixed it.
    setFeeErrors((prev) => ({ ...prev, [key]: (field && checkFee(value, field)) || undefined }))
  }

  // A number input treats "e" as an exponent, which is how 102020202020e233
  // got typed into a GST box. Nothing in a fee is ever written that way.
  const blockExponent = (e) => {
    if (e.key === "e" || e.key === "E" || e.key === "+") e.preventDefault()
  }

  const feeInputClass = (key) =>
    `w-full px-4 py-2 border rounded-lg outline-none transition-all ${
      feeErrors[key]
        ? "border-red-400 focus:ring-2 focus:ring-red-500 focus:border-red-500"
        : "border-slate-300 focus:ring-2 focus:ring-green-500 focus:border-green-500"
    }`

  // Save fee settings (main button)
  const handleSaveFeeSettings = async () => {
    await saveSettings(feeSettings)
  }

  // Add or update delivery fee range
  const handleAddRange = async () => {
    // Robust validation: check if values are present and not just empty strings
    const minRaw = String(newRange.min).trim()
    const maxRaw = String(newRange.max).trim()
    const feeRaw = String(newRange.fee).trim()

    if (minRaw === '' || maxRaw === '' || feeRaw === '') {
      toast.error('Please fill all fields (Min, Max, Fee)')
      return
    }

    const min = Number(minRaw)
    const max = Number(maxRaw)
    const fee = Number(feeRaw)
    const userPerKm = Number(newRange.feePerKm || 0)
    const dbPerKm = Number(newRange.deliveryBoyPerKm || 0)
    const dbBasePay = Number(newRange.deliveryBoyBasePay || 0)

    if (isNaN(min) || isNaN(max) || isNaN(fee) || isNaN(userPerKm) || isNaN(dbPerKm) || isNaN(dbBasePay)) {
      toast.error('Please enter valid numbers')
      return
    }

    if (min < 0 || max < 0 || fee < 0 || userPerKm < 0 || dbPerKm < 0 || dbBasePay < 0) {
      toast.error('All values must be positive numbers')
      return
    }

    if (min >= max) {
      toast.error('Min distance must be less than Max distance')
      return
    }

    // Check for overlapping ranges (excluding the current one being edited)
    const otherRanges = editingRangeIndex !== null
      ? feeSettings.deliveryFeeRanges.filter((_, i) => i !== editingRangeIndex)
      : feeSettings.deliveryFeeRanges

    for (const range of otherRanges) {
      if (
        (min >= range.min && min < range.max) ||
        (max > range.min && max <= range.max) ||
        (min <= range.min && max >= range.max)
      ) {
        toast.error('This range overlaps with an existing range')
        return
      }
    }

    const updatedRanges = [...feeSettings.deliveryFeeRanges, { 
      min, 
      max, 
      fee, 
      feePerKm: userPerKm,
      deliveryBoyPerKm: dbPerKm, 
      deliveryBoyBasePay: dbBasePay 
    }]
    updatedRanges.sort((a, b) => a.min - b.min)

    const updatedSettings = {
      ...feeSettings,
      deliveryFeeRanges: updatedRanges
    }

    const ladderError = ladderProblem(updatedRanges)
    if (ladderError) {
      toast.error(ladderError)
      return
    }

    setFeeSettings(updatedSettings)
    
    // Save to DB immediately
    await saveSettings(updatedSettings)

    // Reset state
    setNewRange({ min: '', max: '', fee: '0', feePerKm: '0', deliveryBoyPerKm: '0', deliveryBoyBasePay: '0' })
  }

  // Delete delivery fee range
  const handleDeleteRange = async (index) => {
    const newRanges = feeSettings.deliveryFeeRanges.filter((_, i) => i !== index)
    const ladderError = ladderProblem(newRanges)
    if (ladderError) {
      toast.error(`Can't delete this range: ${ladderError}. Edit the next range to start where this one starts instead.`)
      return
    }
    const updatedSettings = {
      ...feeSettings,
      deliveryFeeRanges: newRanges
    }
    setFeeSettings(updatedSettings)
    await saveSettings(updatedSettings)
  }

  // Edit delivery fee range
  const handleEditRange = (index) => {
    const range = feeSettings.deliveryFeeRanges[index]
    setNewRange({ 
      min: range.min, 
      max: range.max, 
      fee: range.fee || '0',
      feePerKm: range.feePerKm ?? '0',
      deliveryBoyPerKm: range.deliveryBoyPerKm ?? '0',
      deliveryBoyBasePay: range.deliveryBoyBasePay ?? '0'
    })
    setEditingRangeIndex(index)
  }

  // Save edited range
  const handleSaveEditRange = async () => {
    if (newRange.min === '' || newRange.max === '' || newRange.fee === '') {
      toast.error('Please fill all fields')
      return
    }

    const min = Number(newRange.min)
    const max = Number(newRange.max)
    const fee = Number(newRange.fee)
    const userPerKm = Number(newRange.feePerKm || 0)
    const dbPerKm = Number(newRange.deliveryBoyPerKm || 0)
    const dbBasePay = Number(newRange.deliveryBoyBasePay || 0)

    if (min < 0 || max < 0 || fee < 0 || userPerKm < 0 || dbPerKm < 0 || dbBasePay < 0) {
      toast.error('All values must be positive numbers')
      return
    }

    if (min >= max) {
      toast.error('Min value must be less than Max value')
      return
    }

    const ranges = [...feeSettings.deliveryFeeRanges]
    // Remove the range being edited
    ranges.splice(editingRangeIndex, 1)

    // Check for overlapping ranges
    for (const range of ranges) {
      if ((min >= range.min && min < range.max) || (max > range.min && max <= range.max) || (min <= range.min && max >= range.max)) {
        toast.error('This range overlaps with an existing range')
        return
      }
    }

    // Add updated range
    ranges.push({ 
      min, 
      max, 
      fee, 
      feePerKm: userPerKm,
      deliveryBoyPerKm: dbPerKm, 
      deliveryBoyBasePay: dbBasePay 
    })
    ranges.sort((a, b) => a.min - b.min)

    const updatedSettings = {
      ...feeSettings,
      deliveryFeeRanges: ranges
    }

    const ladderError = ladderProblem(ranges)
    if (ladderError) {
      toast.error(ladderError)
      return
    }

    setFeeSettings(updatedSettings)
    await saveSettings(updatedSettings)

    setNewRange({ min: '', max: '', fee: '0', feePerKm: '0', deliveryBoyPerKm: '0', deliveryBoyBasePay: '0' })
    setEditingRangeIndex(null)
  }

  // Cancel edit
  const handleCancelEdit = () => {
    setNewRange({ min: '', max: '', fee: '0', feePerKm: '0', deliveryBoyPerKm: '0', deliveryBoyBasePay: '0' })
    setEditingRangeIndex(null)
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      {/* Header Section */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center">
            <DollarSign className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Delivery & Platform Fee</h1>
        </div>
        <p className="text-sm text-slate-600">
          Configure delivery fee, platform fee, and GST settings for orders
        </p>

        <div className="mt-5 pt-5 border-t border-slate-200">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
            Applies to
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={selectedZoneId}
              onChange={(e) => setSelectedZoneId(e.target.value)}
              disabled={loadingFeeSettings || savingFeeSettings}
              className="text-sm rounded-lg border border-slate-300 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-60 min-w-[220px]"
            >
              <option value="">All zones (default)</option>
              {zones.map((zone) => (
                <option key={zone.id || zone._id} value={zone.id || zone._id}>
                  {zone.name || zone.zoneName}
                </option>
              ))}
            </select>
            {selectedZoneId && (
              <span
                className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
                  scopeConfigured
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-slate-100 text-slate-600 border-slate-200"
                }`}
              >
                {scopeConfigured ? "Overrides the default" : "Inherits the default"}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-2">
            {selectedZoneId
              ? scopeConfigured
                ? "Orders in this zone are priced with the fees below instead of the default."
                : "This zone has no fees of its own yet and is priced with the default. Saving here creates an override for it."
              : "These fees apply to every zone that does not have fees of its own."}
          </p>
        </div>
      </div>

      {/* Fee Settings Panel */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Fee Configuration</h2>
              <p className="text-sm text-slate-500 mt-1">
                Set the fees and charges that will be applied to all orders
              </p>
            </div>
            <Button
              onClick={handleSaveFeeSettings}
              disabled={savingFeeSettings || loadingFeeSettings}
              className="bg-green-600 hover:bg-green-700 text-white flex items-center gap-2"
            >
              {savingFeeSettings ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  Save Settings
                </>
              )}
            </Button>
          </div>

          {loadingFeeSettings ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-green-600" />
            </div>
          ) : (
            <>
              {/* Delivery Fee Ranges Section */}
              <div className="mb-8">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">Delivery Fee by Distance Range</h3>
                    <p className="text-sm text-slate-500 mt-1">
                      Set different delivery fees based on distance ranges (in km)
                    </p>
                  </div>
                </div>

                {/* Ranges Table */}
                {feeSettings.deliveryFeeRanges.length > 0 && (
                  <div className="mb-4 overflow-x-auto">
                    <table className="w-full border border-slate-200 rounded-lg">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700 border-b border-slate-200">Min Distance (km)</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700 border-b border-slate-200">Max Distance (km)</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700 border-b border-slate-200">User Delivery Fee (₹)</th>
                          <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700 border-b border-slate-200">User ₹/km</th>
                          <th title="Added to the rider base pay for every km past this range's start, the same way the customer per-km works. Not charged to the customer." className="px-4 py-3 text-left text-sm font-semibold text-slate-700 border-b border-slate-200">Rider ₹/km after range start</th>
                          <th title="What the rider earns for a trip at the start of this range. Per-km pay is added on top. Not charged to the customer." className="px-4 py-3 text-left text-sm font-semibold text-slate-700 border-b border-slate-200">Rider Base Pay (₹)</th>
                          <th className="px-4 py-3 text-center text-sm font-semibold text-slate-700 border-b border-slate-200">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {feeSettings.deliveryFeeRanges
                          .map((range, originalIndex) => ({ range, originalIndex }))
                          .sort((a, b) => a.range.min - b.range.min)
                          .map(({ range, originalIndex }) => {
                            const isEditing = editingRangeIndex === originalIndex;
                            return (
                              <tr key={originalIndex} className={`${isEditing ? 'bg-blue-50' : 'hover:bg-slate-50'} transition-colors`}>
                                  <td className="px-4 py-3 text-sm text-slate-900 border-b border-slate-100">
                                  {isEditing ? (
                                    <div className="flex items-center gap-1">
                                      <input
                                        type="number"
                                        value={newRange.min}
                                        onChange={(e) => setNewRange({ ...newRange, min: e.target.value })}
                                        className="w-24 px-2 py-1 border border-blue-300 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                                      />
                                      <span className="text-slate-400">km</span>
                                    </div>
                                  ) : (
                                    <>{range.min} km</>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-sm text-slate-900 border-b border-slate-100">
                                  {isEditing ? (
                                    <div className="flex items-center gap-1">
                                      <input
                                        type="number"
                                        value={newRange.max}
                                        onChange={(e) => setNewRange({ ...newRange, max: e.target.value })}
                                        className="w-24 px-2 py-1 border border-blue-300 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                                      />
                                      <span className="text-slate-400">km</span>
                                    </div>
                                  ) : (
                                    <>{range.max} km</>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-sm font-medium text-green-600 border-b border-slate-100">
                                  {isEditing ? (
                                    <div className="flex items-center gap-1">
                                      <span className="text-slate-400">₹</span>
                                      <input
                                        type="number"
                                        value={newRange.fee}
                                        onChange={(e) => setNewRange({ ...newRange, fee: e.target.value })}
                                        className="w-20 px-2 py-1 border border-blue-300 rounded focus:ring-2 focus:ring-blue-500 outline-none text-green-600 font-medium"
                                      />
                                    </div>
                                  ) : (
                                    <>₹{range.fee}</>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-sm font-medium text-green-600 border-b border-slate-100">
                                  {isEditing ? (
                                    <div className="flex items-center gap-1">
                                      <span className="text-slate-400">₹</span>
                                      <input
                                        type="number"
                                        min="0"
                                        step="0.5"
                                        value={newRange.feePerKm}
                                        onChange={(e) => setNewRange({ ...newRange, feePerKm: e.target.value })}
                                        className="w-20 px-2 py-1 border border-blue-300 rounded focus:ring-2 focus:ring-blue-500 outline-none text-green-600 font-medium"
                                      />
                                    </div>
                                  ) : (
                                    <>{Number(range.feePerKm) > 0 ? `₹${range.feePerKm}/km` : '-'}</>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-sm text-slate-900 border-b border-slate-100">
                                  {isEditing ? (
                                    <div className="flex items-center gap-1">
                                      <span className="text-slate-400">₹</span>
                                      <input
                                        type="number"
                                        value={newRange.deliveryBoyPerKm}
                                        disabled={Number(newRange.deliveryBoyBasePay) > 0}
                                        onChange={(e) => setNewRange({ ...newRange, deliveryBoyPerKm: e.target.value, deliveryBoyBasePay: '0' })}
                                        className="w-20 px-2 py-1 border border-blue-300 rounded focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-100 disabled:cursor-not-allowed"
                                        placeholder="0"
                                      />
                                    </div>
                                  ) : (
                                    <>{range.deliveryBoyPerKm !== undefined && range.deliveryBoyPerKm !== null ? `₹${range.deliveryBoyPerKm}` : '-'}</>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-sm text-slate-900 border-b border-slate-100">
                                  {isEditing ? (
                                    <div className="flex items-center gap-1">
                                      <span className="text-slate-400">₹</span>
                                      <input
                                        type="number"
                                        value={newRange.deliveryBoyBasePay}
                                        disabled={Number(newRange.deliveryBoyPerKm) > 0}
                                        onChange={(e) => setNewRange({ ...newRange, deliveryBoyBasePay: e.target.value, deliveryBoyPerKm: '0' })}
                                        className="w-20 px-2 py-1 border border-blue-300 rounded focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-100 disabled:cursor-not-allowed"
                                        placeholder="0"
                                      />
                                    </div>
                                  ) : (
                                    <>{range.deliveryBoyBasePay !== undefined && range.deliveryBoyBasePay !== null ? `₹${range.deliveryBoyBasePay}` : '-'}</>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-center border-b border-slate-100">
                                  <div className="flex items-center justify-center gap-2">
                                    {isEditing ? (
                                      <>
                                        <button
                                          onClick={handleSaveEditRange}
                                          className="p-1.5 text-green-600 hover:bg-green-100 rounded transition-colors"
                                          title="Save"
                                        >
                                          <Check className="w-4 h-4" />
                                        </button>
                                        <button
                                          onClick={handleCancelEdit}
                                          className="p-1.5 text-red-600 hover:bg-red-100 rounded transition-colors"
                                          title="Cancel"
                                        >
                                          <X className="w-4 h-4" />
                                        </button>
                                      </>
                                    ) : (
                                      <>
                                        <button
                                          onClick={() => handleEditRange(originalIndex)}
                                          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition-colors"
                                          title="Edit"
                                        >
                                          <Edit className="w-4 h-4" />
                                        </button>
                                        <button
                                          onClick={() => handleDeleteRange(originalIndex)}
                                          className="p-1.5 text-red-600 hover:bg-red-50 rounded transition-colors"
                                          title="Delete"
                                        >
                                          <Trash2 className="w-4 h-4" />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                )}

                <FeePreview ranges={feeSettings.deliveryFeeRanges} riderFloor={feeSettings.riderMinPayPerTrip} />

                {/* Add/Edit Range Form */}
                <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                    <div className="flex items-center gap-2 mb-3">
                      {editingRangeIndex !== null ? (
                        <Edit className="w-4 h-4 text-blue-600" />
                      ) : (
                        <Plus className="w-4 h-4 text-green-600" />
                      )}
                    <h4 className="text-sm font-semibold text-slate-700">
                      {editingRangeIndex !== null ? 'Edit Range' : 'Add New Range'}
                    </h4>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Min Distance (km)</label>
                      <input
                        type="number"
                        value={newRange.min}
                        onChange={(e) => setNewRange({ ...newRange, min: e.target.value })}
                        min="0"
                        step="0.1"
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none transition-all"
                        placeholder="0"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Max Distance (km)</label>
                      <input
                        type="number"
                        value={newRange.max}
                        onChange={(e) => setNewRange({ ...newRange, max: e.target.value })}
                        min="0"
                        step="0.1"
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none transition-all"
                        placeholder="5"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">User Delivery Fee (₹)</label>
                      <input
                        type="number"
                        value={newRange.fee}
                        onChange={(e) => setNewRange({ ...newRange, fee: e.target.value })}
                        min="0"
                        step="1"
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none transition-all"
                        placeholder="0"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">User ₹/km</label>
                      <input
                        type="number"
                        value={newRange.feePerKm}
                        onChange={(e) => setNewRange({ ...newRange, feePerKm: e.target.value })}
                        min="0"
                        step="0.5"
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none transition-all"
                        placeholder="0"
                      />
                      <p className="mt-1 text-xs text-slate-500">Charged on the distance past this band start. 0 means a flat fee.</p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Rider ₹/km after range start</label>
                      <input
                        type="number"
                        value={newRange.deliveryBoyPerKm}
                        disabled={Number(newRange.deliveryBoyBasePay) > 0}
                        onChange={(e) => setNewRange({ ...newRange, deliveryBoyPerKm: e.target.value, deliveryBoyBasePay: '0' })}
                        min="0"
                        step="1"
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none transition-all disabled:bg-slate-100 disabled:cursor-not-allowed"
                        placeholder="0"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Rider Base Pay (₹)</label>
                      <input
                        type="number"
                        value={newRange.deliveryBoyBasePay}
                        disabled={Number(newRange.deliveryBoyPerKm) > 0}
                        onChange={(e) => setNewRange({ ...newRange, deliveryBoyBasePay: e.target.value, deliveryBoyPerKm: '0' })}
                        min="0"
                        step="1"
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none transition-all disabled:bg-slate-100 disabled:cursor-not-allowed"
                        placeholder="0"
                      />
                    </div>
                    <div className="flex items-end gap-2">
                      <Button
                        onClick={editingRangeIndex !== null ? handleSaveEditRange : handleAddRange}
                        className={`${editingRangeIndex !== null ? 'bg-blue-600 hover:bg-blue-700' : 'bg-green-600 hover:bg-green-700'} text-white text-sm flex-1 flex items-center justify-center gap-2`}
                      >
                        {editingRangeIndex !== null ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                        {editingRangeIndex !== null ? 'Update' : 'Add Range'}
                      </Button>
                      {editingRangeIndex !== null && (
                        <Button
                          variant="outline"
                          onClick={handleCancelEdit}
                          className="border-slate-300 text-slate-600 hover:bg-slate-100"
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-slate-500 mt-2 italic">
                    Example: Orders within 0 to 3 km will have ₹20 delivery fee.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 border-t border-slate-200 pt-6 mt-6">

                {/* Platform Fee */}
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-slate-700">
                    Platform Fee (₹)
                  </label>
                  <input
                    type="number"
                    value={feeSettings.platformFee}
                    onChange={(e) => setFee("platformFee", e.target.value)}
                    onKeyDown={blockExponent}
                    min="0"
                    step="1"
                    className={feeInputClass("platformFee")}
                    placeholder="5"
                  />
                  <p className="text-xs text-slate-500">
                    Platform service fee per order
                  </p>
                  {feeErrors.platformFee ? (
                    <p className="text-xs font-medium text-red-600">{feeErrors.platformFee}</p>
                  ) : null}
                </div>

                {/* Quick Delivery Fee */}
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-slate-700">
                    Quick Delivery Extra (₹)
                  </label>
                  <input
                    type="number"
                    value={feeSettings.quickDeliveryFee}
                    onChange={(e) => setFee("quickDeliveryFee", e.target.value)}
                    onKeyDown={blockExponent}
                    min="0"
                    step="1"
                    className={feeInputClass("quickDeliveryFee")}
                    placeholder="15"
                  />
                  <p className="text-xs text-slate-500">
                    Extra amount charged when the customer picks Quick delivery at checkout. It is added to the order total and shown in the bill as "Quick Mode"; the rider pay does not change.
                  </p>
                  {feeErrors.quickDeliveryFee ? (
                    <p className="text-xs font-medium text-red-600">{feeErrors.quickDeliveryFee}</p>
                  ) : null}
                </div>

                {/* Minimum rider pay */}
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-slate-700">
                    Minimum Rider Pay per Trip (₹)
                  </label>
                  <input
                    type="number"
                    value={feeSettings.riderMinPayPerTrip}
                    onChange={(e) => setFee("riderMinPayPerTrip", e.target.value)}
                    onKeyDown={blockExponent}
                    min="0"
                    step="1"
                    className={feeInputClass("riderMinPayPerTrip")}
                    placeholder="Leave blank for no minimum"
                  />
                  <p className="text-xs text-slate-500">
                    The least a rider earns for one delivery, whatever the distance rows work out
                    to. A short trip paid per km earns very little without this.
                  </p>
                  {feeErrors.riderMinPayPerTrip ? (
                    <p className="text-xs font-medium text-red-600">{feeErrors.riderMinPayPerTrip}</p>
                  ) : null}
                </div>

                {/* GST Rate */}
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-slate-700">
                    GST Rate (%)
                  </label>
                  <input
                    type="number"
                    value={feeSettings.gstRate}
                    onChange={(e) => setFee("gstRate", e.target.value)}
                    onKeyDown={blockExponent}
                    min="0"
                    max="100"
                    step="0.1"
                    className={feeInputClass("gstRate")}
                    placeholder="5"
                  />
                  <p className="text-xs text-slate-500">
                    GST percentage applied on order subtotal
                  </p>
                  {feeErrors.gstRate ? (
                    <p className="text-xs font-medium text-red-600">{feeErrors.gstRate}</p>
                  ) : null}
                </div>

                {/* Delivery Fee GST Rate */}
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-slate-700">
                    Delivery Fee GST Rate (%)
                  </label>
                  <input
                    type="number"
                    value={feeSettings.deliveryFeeGstRate}
                    onChange={(e) => setFee("deliveryFeeGstRate", e.target.value)}
                    onKeyDown={blockExponent}
                    min="0"
                    max="100"
                    step="0.1"
                    className={feeInputClass("deliveryFeeGstRate")}
                    placeholder="0"
                  />
                  <p className="text-xs text-slate-500">
                    GST percentage applied on the delivery fee. Leave blank or 0 to not charge it.
                  </p>
                  {feeErrors.deliveryFeeGstRate ? (
                    <p className="text-xs font-medium text-red-600">{feeErrors.deliveryFeeGstRate}</p>
                  ) : null}
                </div>
              </div>
          </>
          )}
        </div>
      </div>
    </div>
  )
}
