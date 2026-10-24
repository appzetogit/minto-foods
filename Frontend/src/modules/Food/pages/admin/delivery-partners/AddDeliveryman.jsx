import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

const EMPTY = {
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
  aadharNumber: "",
  panNumber: "",
  approved: true,
}

const inputClass =
  "w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"

/**
 * Add a delivery partner from the admin panel. They sign in to the rider app
 * with an OTP to this phone number; there is no password.
 */
export default function AddDeliveryman() {
  const navigate = useNavigate()
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)

  const set = (key) => (e) =>
    setForm((prev) => ({ ...prev, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return toast.error("Name is required")
    if (!/^[6-9]\d{9}$/.test(form.phone.replace(/\D/g, "").slice(-10))) {
      return toast.error("Enter a valid 10 digit mobile number")
    }
    try {
      setSaving(true)
      const { approved, ...rest } = form
      await adminAPI.createDeliveryPartner({ ...rest, status: approved ? "approved" : "pending" })
      toast.success(`${form.name.trim()} added. They can log in to the rider app with OTP on ${form.phone}.`)
      setForm(EMPTY)
      navigate("/admin/food/delivery-partners")
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not add the delivery partner")
    } finally {
      setSaving(false)
    }
  }

  const field = (label, key, props = {}) => (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
      <input value={form[key]} onChange={set(key)} className={inputClass} {...props} />
    </div>
  )

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-4xl mx-auto bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <h1 className="text-2xl font-bold text-slate-900">Add Deliveryman</h1>
        <p className="text-sm text-slate-500 mt-1 mb-6">
          The rider logs in to the delivery app with an OTP sent to this mobile number.
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {field("Full name *", "name", { placeholder: "e.g. Ravi Kumar" })}
            {field("Mobile number *", "phone", { placeholder: "10 digit number", inputMode: "numeric", maxLength: 13 })}
            {field("Email", "email", { type: "email", placeholder: "optional" })}
            {field("City", "city")}
            {field("State", "state")}
            {field("Address", "address")}
          </div>

          <div>
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Vehicle</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Type</label>
                <select value={form.vehicleType} onChange={set("vehicleType")} className={inputClass}>
                  <option value="bike">Bike</option>
                  <option value="scooter">Scooter</option>
                  <option value="bicycle">Bicycle</option>
                  <option value="ev">Electric</option>
                </select>
              </div>
              {field("Model", "vehicleName", { placeholder: "e.g. Splendor" })}
              {field("Number", "vehicleNumber", { placeholder: "e.g. MH04AB1234" })}
            </div>
          </div>

          <div>
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Documents (optional)</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {field("Driving licence no.", "drivingLicenseNumber")}
              {field("Aadhaar no.", "aadharNumber", { inputMode: "numeric" })}
              {field("PAN no.", "panNumber")}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={form.approved} onChange={set("approved")} className="h-4 w-4" />
            Approve now, so they can take orders right away
          </label>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setForm(EMPTY)}
              className="px-5 py-2.5 text-sm font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
            >
              Reset
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2.5 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {saving ? "Adding…" : "Add Deliveryman"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
