import { useEffect, useState } from "react"
import { Save, Upload, FileText } from "lucide-react"
import { toast } from "sonner"
import { adminAPI, uploadAPI } from "@food/api"

/**
 * Everything about a restaurant beyond its name, owner and hours: licences,
 * tax and identity documents, where its money is paid, and how far it
 * delivers. The details editor above it only covered the basics, so an admin
 * could see a wrong FSSAI number or bank account but not correct it.
 *
 * Saves on its own, sending only what changed. Document images are uploaded
 * first and their new link is sent; untouched documents are not resent.
 */

const DOCS = [
  { key: "fssaiImage", label: "FSSAI certificate" },
  { key: "panImage", label: "PAN card" },
  { key: "aadhaarImage", label: "Aadhaar card" },
  { key: "gstImage", label: "GST certificate" },
  { key: "upiQrImage", label: "UPI QR code" },
]

const TEXT_FIELDS = [
  "fssaiNumber", "fssaiExpiry",
  "panNumber", "nameOnPan", "aadhaarNumber",
  "gstRegistered", "gstNumber", "gstLegalName", "gstAddress",
  "accountHolderName", "accountNumber", "ifscCode", "accountType", "upiId",
  "deliveryRadiusKm", "freeDeliveryAbove",
]

const urlOf = (v) => (typeof v === "string" ? v : v?.url || "")

const toDateInput = (value) => {
  if (!value) return ""
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10)
}

const fromRestaurant = (r = {}) => ({
  fssaiNumber: r.fssaiNumber || "",
  fssaiExpiry: toDateInput(r.fssaiExpiry),
  panNumber: r.panNumber || "",
  nameOnPan: r.nameOnPan || "",
  aadhaarNumber: r.aadhaarNumber || "",
  gstRegistered: r.gstRegistered === true,
  gstNumber: r.gstNumber || "",
  gstLegalName: r.gstLegalName || "",
  gstAddress: r.gstAddress || "",
  accountHolderName: r.accountHolderName || "",
  accountNumber: r.accountNumber || "",
  ifscCode: r.ifscCode || "",
  accountType: r.accountType || "",
  upiId: r.upiId || "",
  deliveryRadiusKm: r.deliveryRadiusKm == null ? "" : String(r.deliveryRadiusKm),
  freeDeliveryAbove: r.freeDeliveryAbove == null ? "" : String(r.freeDeliveryAbove),
})

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  )
}

const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"

export default function RestaurantBusinessEditor({ restaurant, onSaved }) {
  const restaurantId = restaurant?._id || restaurant?.id
  const [form, setForm] = useState(() => fromRestaurant(restaurant))
  const [original, setOriginal] = useState(() => fromRestaurant(restaurant))
  // New document files chosen but not yet uploaded, and their previews.
  const [files, setFiles] = useState({})
  const [previews, setPreviews] = useState({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const next = fromRestaurant(restaurant)
    setForm(next)
    setOriginal(next)
    setFiles({})
    setPreviews({})
  }, [restaurantId]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))

  const pickFile = (key, file) => {
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      toast.error("That file is over 5 MB")
      return
    }
    setFiles((f) => ({ ...f, [key]: file }))
    setPreviews((p) => ({ ...p, [key]: URL.createObjectURL(file) }))
  }

  const validate = () => {
    const ifsc = form.ifscCode.trim().toUpperCase()
    if (ifsc && !IFSC.test(ifsc)) return "IFSC looks wrong. It is 11 characters, like SBIN0001234."
    const pan = form.panNumber.trim().toUpperCase()
    if (pan && !PAN.test(pan)) return "PAN looks wrong. It is 10 characters, like ABCDE1234F."
    const gst = form.gstNumber.trim().toUpperCase()
    if (form.gstRegistered && gst && !GSTIN.test(gst)) return "GSTIN looks wrong. It is 15 characters."
    const aadhaar = form.aadhaarNumber.replace(/\s/g, "")
    if (aadhaar && !/^\d{12}$/.test(aadhaar)) return "Aadhaar number must be 12 digits."
    const acct = form.accountNumber.replace(/\s/g, "")
    if (acct && !/^\d{9,18}$/.test(acct)) return "Account number must be 9 to 18 digits."
    if (form.deliveryRadiusKm !== "" && !(Number(form.deliveryRadiusKm) > 0)) {
      return "Delivery radius must be more than 0 km, or blank to follow the platform."
    }
    if (form.freeDeliveryAbove !== "" && !(Number(form.freeDeliveryAbove) >= 0)) {
      return "Free delivery amount must be 0 or more, or blank for none."
    }
    return null
  }

  const save = async () => {
    const problem = validate()
    if (problem) {
      toast.error(problem)
      return
    }
    setSaving(true)
    try {
      const payload = {}
      for (const key of TEXT_FIELDS) {
        if (form[key] === original[key]) continue
        let value = form[key]
        if (["ifscCode", "panNumber", "gstNumber"].includes(key)) value = String(value).trim().toUpperCase()
        else if (["aadhaarNumber", "accountNumber"].includes(key)) value = String(value).replace(/\s/g, "")
        else if (key === "fssaiExpiry") value = value || null
        else if (key === "deliveryRadiusKm" || key === "freeDeliveryAbove") value = value === "" ? null : Number(value)
        else if (typeof value === "string") value = value.trim()
        payload[key] = value
      }

      for (const [key, file] of Object.entries(files)) {
        const res = await uploadAPI.uploadMedia(file, { folder: "minto/restaurant/documents" })
        const media = res?.data?.data?.file || res?.data?.data || res?.data?.file
        if (!media?.url) throw new Error(`Could not upload the ${key}`)
        payload[key] = media.url
      }

      if (Object.keys(payload).length === 0) {
        toast.info("Nothing has changed")
        return
      }

      const response = await adminAPI.updateRestaurant(restaurantId, payload)
      const updated = response?.data?.data?.restaurant
      toast.success("Business details saved")
      const next = fromRestaurant(updated || { ...restaurant, ...payload })
      setForm(next)
      setOriginal(next)
      setFiles({})
      onSaved?.(updated)
    } catch (error) {
      toast.error(error?.response?.data?.message || error?.message || "Could not save the business details")
    } finally {
      setSaving(false)
    }
  }

  const docPreview = (key) => previews[key] || urlOf(restaurant?.[key])

  return (
    <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-base font-semibold text-slate-900">Business &amp; documents</h4>
          <p className="text-xs text-slate-500">Licences, tax details, payout account and delivery limits.</p>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Save className="h-4 w-4" /> {saving ? "Saving..." : "Save business details"}
        </button>
      </div>

      <section className="space-y-3">
        <p className="text-sm font-semibold text-slate-800">FSSAI</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="FSSAI licence number">
            <input className={inputClass} value={form.fssaiNumber} onChange={(e) => set("fssaiNumber", e.target.value)} />
          </Field>
          <Field label="Licence expiry">
            <input type="date" className={inputClass} value={form.fssaiExpiry} onChange={(e) => set("fssaiExpiry", e.target.value)} />
          </Field>
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-sm font-semibold text-slate-800">PAN, Aadhaar and GST</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="PAN number">
            <input className={`${inputClass} uppercase`} value={form.panNumber} onChange={(e) => set("panNumber", e.target.value)} />
          </Field>
          <Field label="Name on PAN">
            <input className={inputClass} value={form.nameOnPan} onChange={(e) => set("nameOnPan", e.target.value)} />
          </Field>
          <Field label="Aadhaar number">
            <input className={inputClass} inputMode="numeric" value={form.aadhaarNumber} onChange={(e) => set("aadhaarNumber", e.target.value)} />
          </Field>
          <Field label="GST registered">
            <select
              className={inputClass}
              value={form.gstRegistered ? "yes" : "no"}
              onChange={(e) => set("gstRegistered", e.target.value === "yes")}
            >
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </Field>
          {form.gstRegistered && (
            <>
              <Field label="GSTIN">
                <input className={`${inputClass} uppercase`} value={form.gstNumber} onChange={(e) => set("gstNumber", e.target.value)} />
              </Field>
              <Field label="GST legal name">
                <input className={inputClass} value={form.gstLegalName} onChange={(e) => set("gstLegalName", e.target.value)} />
              </Field>
              <div className="md:col-span-2">
                <Field label="GST registered address">
                  <input className={inputClass} value={form.gstAddress} onChange={(e) => set("gstAddress", e.target.value)} />
                </Field>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-sm font-semibold text-slate-800">Payout account</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Account holder name">
            <input className={inputClass} value={form.accountHolderName} onChange={(e) => set("accountHolderName", e.target.value)} />
          </Field>
          <Field label="Account number">
            <input className={inputClass} inputMode="numeric" value={form.accountNumber} onChange={(e) => set("accountNumber", e.target.value)} />
          </Field>
          <Field label="IFSC code">
            <input className={`${inputClass} uppercase`} value={form.ifscCode} onChange={(e) => set("ifscCode", e.target.value)} />
          </Field>
          <Field label="Account type">
            <select className={inputClass} value={form.accountType} onChange={(e) => set("accountType", e.target.value)}>
              <option value="">Not set</option>
              <option value="savings">Savings</option>
              <option value="current">Current</option>
            </select>
          </Field>
          <Field label="UPI ID (optional)">
            <input className={inputClass} value={form.upiId} onChange={(e) => set("upiId", e.target.value)} placeholder="name@bank" />
          </Field>
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-sm font-semibold text-slate-800">Delivery</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Delivery radius (km)" hint="Blank follows the platform setting in Business Setup.">
            <input type="number" min="0" step="0.1" className={inputClass} value={form.deliveryRadiusKm} onChange={(e) => set("deliveryRadiusKm", e.target.value)} />
          </Field>
          <Field label="Free delivery above (Rs)" hint="Blank means delivery is always charged.">
            <input type="number" min="0" step="1" className={inputClass} value={form.freeDeliveryAbove} onChange={(e) => set("freeDeliveryAbove", e.target.value)} />
          </Field>
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-sm font-semibold text-slate-800">Documents</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {DOCS.map(({ key, label }) => {
            const src = docPreview(key)
            return (
              <div key={key} className="rounded-lg border border-slate-200 p-2">
                <p className="mb-1 truncate text-[11px] font-semibold text-slate-700">{label}</p>
                <a
                  href={src || undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-20 items-center justify-center overflow-hidden rounded bg-slate-50"
                >
                  {src ? (
                    <img src={src} alt={label} className="h-full w-full object-cover" />
                  ) : (
                    <FileText className="h-6 w-6 text-slate-300" />
                  )}
                </a>
                <label className="mt-2 flex cursor-pointer items-center justify-center gap-1 rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50">
                  <Upload className="h-3 w-3" /> {src ? "Replace" : "Upload"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => pickFile(key, e.target.files?.[0])}
                  />
                </label>
                {files[key] && <p className="mt-1 truncate text-[10px] text-blue-600">New: {files[key].name}</p>}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
