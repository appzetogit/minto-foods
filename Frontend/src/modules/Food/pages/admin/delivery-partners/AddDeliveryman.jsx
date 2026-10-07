import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Loader2, Upload, CheckCircle2, AlertTriangle } from "lucide-react"
import { adminAPI } from "@food/api"

/**
 * Add Deliveryman.
 *
 * Creates a real, approved rider -- the same details the rider app's sign-up
 * collects. The rider then logs in to the delivery app with OTP on this phone.
 * When rider self sign-up is switched off (Feature Settings), this page is the
 * only way to add riders.
 *
 * (This page used to be a mock: its submit waited a second and saved nothing.)
 */

const VEHICLES = [
  { value: "bike", label: "Bike" },
  { value: "scooter", label: "Scooter" },
  { value: "electric", label: "Electric bike / scooter" },
  { value: "bicycle", label: "Bicycle" },
]

const PHOTOS = [
  { key: "profilePhoto", label: "Profile photo" },
  { key: "aadharPhoto", label: "Aadhaar card" },
  { key: "panPhoto", label: "PAN card" },
  { key: "drivingLicensePhoto", label: "Driving licence" },
]

const empty = {
  name: "",
  phone: "",
  email: "",
  city: "",
  state: "",
  address: "",
  vehicleType: "bike",
  vehicleName: "",
  vehicleNumber: "",
  drivingLicenseNumber: "",
  panNumber: "",
  aadharNumber: "",
  bankAccountHolderName: "",
  bankAccountNumber: "",
  bankIfscCode: "",
  bankName: "",
  upiId: "",
}

const input =
  "w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"

function Field({ label, error, hint, children, required }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">
        {label}
        {required ? <span className="text-red-500"> *</span> : null}
      </label>
      {children}
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </div>
  )
}

export default function AddDeliveryman() {
  const [form, setForm] = useState(empty)
  const [files, setFiles] = useState({})
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState("")
  const [saving, setSaving] = useState(false)
  const [added, setAdded] = useState(null)
  const [cities, setCities] = useState([])
  const [signupOpen, setSignupOpen] = useState(true)

  useEffect(() => {
    adminAPI
      .getCities({ limit: 500 })
      .then((res) => {
        const data = res?.data?.data ?? res?.data ?? {}
        setCities(Array.isArray(data.cities) ? data.cities : Array.isArray(data) ? data : [])
      })
      .catch(() => setCities([]))
    adminAPI
      .getOnboardingStatus()
      .then((res) => setSignupOpen(res?.data?.data?.delivery !== false))
      .catch(() => {})
  }, [])

  const set = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (errors[key]) setErrors((e) => ({ ...e, [key]: "" }))
  }

  const validate = () => {
    const e = {}
    const phone = form.phone.replace(/\D/g, "").slice(-10)
    if (!form.name.trim()) e.name = "Name is required"
    if (!/^[6-9]\d{9}$/.test(phone)) e.phone = "Enter a valid 10-digit mobile number"
    if (!form.city.trim()) e.city = "City is required"
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "Invalid email"
    if (form.panNumber && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(form.panNumber.toUpperCase())) e.panNumber = "Invalid PAN (e.g. ABCDE1234F)"
    if (form.aadharNumber && !/^\d{12}$/.test(form.aadharNumber)) e.aadharNumber = "Aadhaar must be 12 digits"
    if (form.drivingLicenseNumber && !/^[A-Z]{2}[0-9A-Z]{8,16}$/.test(form.drivingLicenseNumber.replace(/[\s-]/g, "").toUpperCase()))
      e.drivingLicenseNumber = "Invalid licence number (e.g. MH0420190012345)"
    if (form.bankAccountNumber && !/^\d{9,18}$/.test(form.bankAccountNumber)) e.bankAccountNumber = "9 to 18 digits"
    if (form.bankIfscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(form.bankIfscCode.toUpperCase())) e.bankIfscCode = "Invalid IFSC (e.g. SBIN0001234)"
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const submit = async (ev) => {
    ev.preventDefault()
    setServerError("")
    if (!validate()) return
    const fd = new FormData()
    for (const [k, v] of Object.entries(form)) {
      const value = String(v ?? "").trim()
      if (value) fd.append(k, k === "phone" ? value.replace(/\D/g, "").slice(-10) : value)
    }
    for (const [k, file] of Object.entries(files)) if (file) fd.append(k, file)
    try {
      setSaving(true)
      const res = await adminAPI.createDeliveryPartner(fd)
      setAdded(res?.data?.data || { name: form.name, phone: form.phone })
      setForm(empty)
      setFiles({})
    } catch (e) {
      setServerError(e?.response?.data?.message || e?.message || "Could not add the rider.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h1 className="text-2xl font-bold text-slate-900">Add Deliveryman</h1>
          <p className="text-sm text-slate-500 mt-1">
            The rider is approved immediately and logs in to the delivery app with an OTP on this phone number.
          </p>
        </div>

        {!signupOpen ? (
          <div className="flex gap-2 items-start bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            Rider self sign-up is switched off, so this page is the only way to add new riders.
          </div>
        ) : null}

        {added ? (
          <div className="flex gap-2 items-start bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-4 py-3 text-sm">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <b>{added.name}</b> added. They can log in with OTP on {added.phone}.{" "}
              <Link to="/admin/food/delivery-partners" className="underline">View riders</Link>
            </div>
          </div>
        ) : null}

        {serverError ? (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-4 py-3 text-sm">{serverError}</div>
        ) : null}

        <form onSubmit={submit} className="space-y-4">
          <section className="bg-white rounded-xl border border-slate-200 p-5">
            <h2 className="text-base font-semibold text-slate-900 mb-3">Personal details</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Full name" required error={errors.name}>
                <input className={input} value={form.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label="Mobile number" required error={errors.phone} hint="Used for OTP login">
                <div className="flex">
                  <span className="px-3 py-2 text-sm rounded-l-lg border border-r-0 border-slate-300 bg-slate-50 text-slate-500">+91</span>
                  <input
                    className={`${input} rounded-l-none`}
                    inputMode="numeric"
                    maxLength={10}
                    value={form.phone}
                    onChange={(e) => set("phone", e.target.value.replace(/\D/g, "").slice(0, 10))}
                  />
                </div>
              </Field>
              <Field label="Email" error={errors.email}>
                <input className={input} type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
              </Field>
              <Field label="City" required error={errors.city} hint="Decides which city admins can see this rider">
                {cities.length ? (
                  <select className={input} value={form.city} onChange={(e) => set("city", e.target.value)}>
                    <option value="">Choose a city…</option>
                    {cities.map((c) => (
                      <option key={c.id || c._id || c.name} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                ) : (
                  <input className={input} value={form.city} onChange={(e) => set("city", e.target.value)} />
                )}
              </Field>
              <Field label="State">
                <input className={input} value={form.state} onChange={(e) => set("state", e.target.value)} />
              </Field>
              <Field label="Address">
                <input className={input} value={form.address} onChange={(e) => set("address", e.target.value)} />
              </Field>
            </div>
          </section>

          <section className="bg-white rounded-xl border border-slate-200 p-5">
            <h2 className="text-base font-semibold text-slate-900 mb-3">Vehicle</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Type">
                <select className={input} value={form.vehicleType} onChange={(e) => set("vehicleType", e.target.value)}>
                  {VEHICLES.map((v) => (
                    <option key={v.value} value={v.value}>{v.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Model">
                <input className={input} placeholder="Honda Activa" value={form.vehicleName} onChange={(e) => set("vehicleName", e.target.value)} />
              </Field>
              <Field label="Registration number" hint="Must not belong to another rider">
                <input className={input} placeholder="MH04AB1234" value={form.vehicleNumber} onChange={(e) => set("vehicleNumber", e.target.value.toUpperCase())} />
              </Field>
            </div>
          </section>

          <section className="bg-white rounded-xl border border-slate-200 p-5">
            <h2 className="text-base font-semibold text-slate-900 mb-3">Documents</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Driving licence no." error={errors.drivingLicenseNumber}>
                <input className={input} value={form.drivingLicenseNumber} onChange={(e) => set("drivingLicenseNumber", e.target.value.toUpperCase())} />
              </Field>
              <Field label="PAN" error={errors.panNumber}>
                <input className={input} maxLength={10} value={form.panNumber} onChange={(e) => set("panNumber", e.target.value.toUpperCase())} />
              </Field>
              <Field label="Aadhaar" error={errors.aadharNumber}>
                <input className={input} inputMode="numeric" maxLength={12} value={form.aadharNumber} onChange={(e) => set("aadharNumber", e.target.value.replace(/\D/g, ""))} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-4 mt-4">
              {PHOTOS.map((p) => (
                <label key={p.key} className="border-2 border-dashed border-slate-300 rounded-lg p-3 text-center cursor-pointer hover:border-blue-400">
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => setFiles((f) => ({ ...f, [p.key]: e.target.files?.[0] || null }))}
                  />
                  {files[p.key] ? (
                    <img src={URL.createObjectURL(files[p.key])} alt={p.label} className="h-20 mx-auto object-contain rounded" />
                  ) : (
                    <Upload className="w-6 h-6 mx-auto text-slate-400" />
                  )}
                  <span className="block text-xs text-slate-600 mt-1">{p.label}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="bg-white rounded-xl border border-slate-200 p-5">
            <h2 className="text-base font-semibold text-slate-900 mb-1">Bank details</h2>
            <p className="text-xs text-slate-500 mb-3">Optional — the rider can also add these in the app.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Account holder name">
                <input className={input} value={form.bankAccountHolderName} onChange={(e) => set("bankAccountHolderName", e.target.value)} />
              </Field>
              <Field label="Account number" error={errors.bankAccountNumber}>
                <input className={input} inputMode="numeric" value={form.bankAccountNumber} onChange={(e) => set("bankAccountNumber", e.target.value.replace(/\D/g, ""))} />
              </Field>
              <Field label="IFSC" error={errors.bankIfscCode}>
                <input className={input} maxLength={11} value={form.bankIfscCode} onChange={(e) => set("bankIfscCode", e.target.value.toUpperCase())} />
              </Field>
              <Field label="Bank name">
                <input className={input} value={form.bankName} onChange={(e) => set("bankName", e.target.value)} />
              </Field>
              <Field label="UPI id">
                <input className={input} placeholder="name@upi" value={form.upiId} onChange={(e) => set("upiId", e.target.value)} />
              </Field>
            </div>
          </section>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setForm(empty); setFiles({}); setErrors({}); setServerError("") }}
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm"
            >
              Reset
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium inline-flex items-center gap-2 disabled:opacity-60"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Add rider
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
