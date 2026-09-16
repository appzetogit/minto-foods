import { useState, useEffect, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import useRestaurantBackNavigation from "@food/hooks/useRestaurantBackNavigation"
import {
  ArrowLeft,
  Wand2,
  Percent,
  IndianRupee,
  Loader2,
  Tag,
  Users,
  Clock,
  Lock,
} from "lucide-react"
import { restaurantAPI } from "@food/api"
import { toast } from "sonner"

const DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
]
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const AUDIENCES = [
  { value: "all", label: "Everyone", hint: "Any customer can use it" },
  { value: "new_here", label: "New to your restaurant", hint: "Customers who have never ordered from you" },
  { value: "first_time", label: "First order on the app", hint: "Customers placing their very first order" },
]

const EMPTY = {
  couponCode: "",
  discountType: "percentage",
  discountValue: "",
  maxDiscount: "",
  minOrderValue: "",
  audience: "all",
  usageLimit: "",
  perUserLimit: "1",
  startDate: "",
  endDate: "",
  activeDays: [],
  allDay: true,
  activeFromTime: "12:00",
  activeToTime: "15:00",
}

// India-time calendar date for an ISO timestamp, as <input type="date"> wants it.
const toIstDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : ""

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })

const rupees = (n) => {
  const v = Number(n) || 0
  return `₹${Number.isInteger(v) ? v : v.toFixed(2)}`
}

const describeDays = (days) => {
  const list = [...new Set(days)].sort((a, b) => a - b)
  if (!list.length || list.length === 7) return ""
  const contiguous = list.length >= 3 && list.every((d, i) => i === 0 || d === list[i - 1] + 1)
  return contiguous
    ? `${DAY_NAMES[list[0]]}-${DAY_NAMES[list[list.length - 1]]}`
    : list.map((d) => DAY_NAMES[d]).join(", ")
}

const FieldLabel = ({ children, required, hint }) => (
  <div className="mb-1.5">
    <label className="block text-sm font-semibold text-gray-700">
      {children} {required && <span className="text-red-500">*</span>}
    </label>
    {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
  </div>
)

const ErrorMsg = ({ error }) => (error ? <p className="text-xs text-red-500 mt-1">{error}</p> : null)

const Section = ({ title, icon: Icon, children }) => (
  <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
    <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide flex items-center gap-2">
      {Icon && <Icon className="w-4 h-4 text-gray-500" />}
      {title}
    </h2>
    {children}
  </div>
)

const themeButton = {
  background: "linear-gradient(135deg, rgba(var(--module-theme-rgb,37,99,235),0.9), var(--module-theme-color,#2563EB))",
  boxShadow: "0 10px 22px rgba(var(--module-theme-rgb,37,99,235),0.28)",
}
const themeSelected = {
  backgroundColor: "rgba(var(--module-theme-rgb,37,99,235),0.10)",
  borderColor: "var(--module-theme-color,#2563EB)",
  color: "var(--module-theme-color,#2563EB)",
}

export default function AddCouponPage(props) {
  const { mode = "create", couponId } = props || {}
  const isEditMode = mode === "edit" && Boolean(couponId)

  const navigate = useNavigate()
  const goBack = useRestaurantBackNavigation()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isLoading, setIsLoading] = useState(isEditMode)
  const [codeLocked, setCodeLocked] = useState(false)
  const [usedCount, setUsedCount] = useState(0)
  const [formData, setFormData] = useState(EMPTY)
  const [errors, setErrors] = useState({})

  useEffect(() => {
    if (!isEditMode) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await restaurantAPI.getMyOffer(couponId)
        const o = res.data?.data?.doc
        if (!o || cancelled) return
        const hasWindow = Boolean(o.activeFromTime && o.activeToTime)
        setFormData({
          couponCode: o.couponCode || "",
          discountType: o.discountType === "percentage" ? "percentage" : "flat_price",
          discountValue: o.discountValue != null ? String(Number(o.discountValue)) : "",
          maxDiscount: o.maxDiscount != null ? String(Number(o.maxDiscount)) : "",
          minOrderValue: o.minOrderValue != null ? String(Number(o.minOrderValue)) : "",
          audience: o.newToRestaurantOnly
            ? "new_here"
            : o.customerScope === "first_time" || o.isFirstOrderOnly
              ? "first_time"
              : "all",
          usageLimit: o.usageLimit ? String(o.usageLimit) : "",
          perUserLimit: o.perUserLimit ? String(o.perUserLimit) : "",
          startDate: toIstDate(o.startDate),
          endDate: toIstDate(o.endDate),
          activeDays: Array.isArray(o.activeDays) ? o.activeDays : [],
          allDay: !hasWindow,
          activeFromTime: o.activeFromTime || "12:00",
          activeToTime: o.activeToTime || "15:00",
        })
        setCodeLocked(o.canChangeCode === false)
        setUsedCount(Number(o.usedCount) || 0)
      } catch (error) {
        toast.error(error.response?.data?.message || "Could not load this coupon")
        navigate("/food/restaurant/coupon")
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [isEditMode, couponId, navigate])

  const set = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: null }))
  }

  const toggleDay = (day) => {
    const has = formData.activeDays.includes(day)
    set("activeDays", has ? formData.activeDays.filter((d) => d !== day) : [...formData.activeDays, day])
  }

  const generateCode = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    let code = ""
    for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length))
    set("couponCode", code)
  }

  const isPercent = formData.discountType === "percentage"

  // The same wording the customer sees, so the restaurant knows what it is offering.
  const preview = useMemo(() => {
    const value = Number(formData.discountValue) || 0
    const headline = !value
      ? "Your offer"
      : isPercent
        ? `${value}% OFF${Number(formData.maxDiscount) > 0 ? ` up to ${rupees(formData.maxDiscount)}` : ""}`
        : `${rupees(value)} OFF`
    const conditions = []
    if (Number(formData.minOrderValue) > 0) conditions.push(`on orders above ${rupees(formData.minOrderValue)}`)
    const days = describeDays(formData.activeDays)
    if (days) conditions.push(days)
    if (!formData.allDay) conditions.push(`${formData.activeFromTime}-${formData.activeToTime}`)
    if (formData.audience === "new_here") conditions.push("new customers only")
    if (formData.audience === "first_time") conditions.push("first order only")
    const perUser = Number(formData.perUserLimit) || 0
    if (perUser === 1) conditions.push("once per customer")
    else if (perUser > 1) conditions.push(`${perUser} times per customer`)
    return { headline, conditions }
  }, [formData, isPercent])

  const validate = () => {
    const e = {}
    const value = Number(formData.discountValue)
    const min = Number(formData.minOrderValue) || 0
    const code = formData.couponCode.trim()

    if (!code) e.couponCode = "Coupon code is required"
    else if (!/^[A-Z0-9]{3,20}$/i.test(code)) e.couponCode = "3-20 letters or numbers, no spaces or symbols"

    if (!formData.discountValue || isNaN(value) || value <= 0) e.discountValue = "Enter a valid discount"
    else if (isPercent && value > 100) e.discountValue = "Percentage cannot exceed 100"

    if (isPercent && !(Number(formData.maxDiscount) > 0)) e.maxDiscount = "Set the most a customer can save"
    if (!isPercent && value > 0 && min <= value) {
      e.minOrderValue = `Must be more than the ${rupees(value)} discount, or small orders become free`
    }

    const total = Number(formData.usageLimit) || 0
    const perUser = Number(formData.perUserLimit) || 0
    if (formData.usageLimit && (!Number.isInteger(Number(formData.usageLimit)) || total < 1)) e.usageLimit = "Whole number, 1 or more"
    if (formData.perUserLimit && (!Number.isInteger(Number(formData.perUserLimit)) || perUser < 1)) e.perUserLimit = "Whole number, 1 or more"
    if (total && perUser && perUser > total) e.perUserLimit = "Cannot exceed total redemptions"
    if (isEditMode && total && total < usedCount) e.usageLimit = `Already used ${usedCount} times`

    if (!formData.endDate) e.endDate = "End date is required"
    if (!isEditMode && formData.startDate && formData.startDate < todayIst()) e.startDate = "Start date cannot be in the past"
    if (formData.endDate && formData.endDate < todayIst()) e.endDate = "End date cannot be in the past"
    if (formData.startDate && formData.endDate && formData.startDate > formData.endDate) e.endDate = "End date must be after start date"

    if (!formData.allDay) {
      if (!formData.activeFromTime || !formData.activeToTime) e.hours = "Set both times"
      else if (formData.activeFromTime === formData.activeToTime) e.hours = "Start and end cannot be the same"
    }

    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) {
      toast.error("Please fix the highlighted fields")
      return
    }
    setIsSubmitting(true)
    try {
      const payload = {
        couponCode: formData.couponCode.trim().toUpperCase(),
        discountType: formData.discountType,
        discountValue: Number(formData.discountValue),
        minOrderValue: Number(formData.minOrderValue) || 0,
        maxDiscount: isPercent ? Number(formData.maxDiscount) : undefined,
        usageLimit: formData.usageLimit ? Number(formData.usageLimit) : 0,
        perUserLimit: formData.perUserLimit ? Number(formData.perUserLimit) : 0,
        startDate: formData.startDate || undefined,
        endDate: formData.endDate,
        customerScope: formData.audience === "first_time" ? "first_time" : "all",
        newToRestaurantOnly: formData.audience === "new_here",
        activeDays: formData.activeDays,
        activeFromTime: formData.allDay ? "" : formData.activeFromTime,
        activeToTime: formData.allDay ? "" : formData.activeToTime,
      }
      if (isEditMode) {
        await restaurantAPI.updateMyOffer(couponId, payload)
        toast.success("Coupon updated")
      } else {
        await restaurantAPI.createMyOffer(payload)
        toast.success("Coupon created and live for customers")
      }
      navigate("/food/restaurant/coupon")
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || "Failed to save coupon")
    } finally {
      setIsSubmitting(false)
    }
  }

  const inputCls = (field) =>
    `w-full px-4 py-3 bg-gray-50 border rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 transition-colors ${
      errors[field]
        ? "border-red-300 focus:ring-red-300"
        : "border-gray-200 focus:ring-gray-400 focus:border-gray-500"
    }`

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="bg-white border-b border-gray-200 px-4 py-3 sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <button onClick={goBack} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors" aria-label="Go back">
            <ArrowLeft className="w-6 h-6 text-gray-900" />
          </button>
          <div className="flex-1">
            <h1 className="text-base font-bold text-gray-900">{isEditMode ? "Edit Coupon" : "Create Coupon"}</h1>
            <p className="text-xs text-gray-500">Funded by your restaurant</p>
          </div>
        </div>
      </div>

      <div className="px-4 py-4 pb-8 space-y-3 max-w-lg mx-auto">
        {/* Live preview */}
        <div className="rounded-lg border-2 border-dashed p-4 bg-white" style={{ borderColor: "var(--module-theme-color,#2563EB)" }}>
          <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400 mb-1">Customers will see</p>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={themeSelected}>
              <Tag className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-lg font-extrabold text-gray-900 leading-tight">{preview.headline}</p>
              <p className="text-xs text-gray-600 mt-0.5">
                Use code <span className="font-mono font-bold tracking-wider">{formData.couponCode || "CODE"}</span>
              </p>
              {preview.conditions.length > 0 && (
                <p className="text-xs text-gray-500 mt-1">{preview.conditions.join(" · ")}</p>
              )}
            </div>
          </div>
        </div>

        <Section title="Discount" icon={Percent}>
          <div>
            <FieldLabel required hint={codeLocked ? "Customers have used this code, so it cannot change" : undefined}>
              Coupon code
            </FieldLabel>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  value={formData.couponCode}
                  onChange={(e) => set("couponCode", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  placeholder="e.g. LUNCH50"
                  maxLength={20}
                  disabled={codeLocked}
                  className={`${inputCls("couponCode")} font-mono tracking-widest disabled:opacity-60`}
                />
                {codeLocked && <Lock className="w-4 h-4 text-gray-400 absolute right-3 top-1/2 -translate-y-1/2" />}
              </div>
              {!codeLocked && (
                <button
                  type="button"
                  onClick={generateCode}
                  className="px-3 py-3 bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg transition-colors text-gray-700 shrink-0"
                  title="Generate a code"
                  aria-label="Generate a code"
                >
                  <Wand2 className="w-4 h-4" />
                </button>
              )}
            </div>
            <ErrorMsg error={errors.couponCode} />
          </div>

          <div>
            <FieldLabel required>Type</FieldLabel>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: "percentage", label: "Percentage", icon: Percent },
                { value: "flat_price", label: "Flat amount", icon: IndianRupee },
              ].map((opt) => {
                const selected = formData.discountType === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => set("discountType", opt.value)}
                    className={`flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-semibold transition-colors ${
                      selected ? "" : "border-gray-200 text-gray-700 bg-gray-50 hover:bg-gray-100"
                    }`}
                    style={selected ? themeSelected : undefined}
                  >
                    <opt.icon className="w-4 h-4" /> {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel required>{isPercent ? "Discount %" : "Discount ₹"}</FieldLabel>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                value={formData.discountValue}
                onChange={(e) => set("discountValue", e.target.value)}
                placeholder={isPercent ? "e.g. 50" : "e.g. 75"}
                className={inputCls("discountValue")}
              />
              <ErrorMsg error={errors.discountValue} />
            </div>
            {isPercent && (
              <div>
                <FieldLabel required>Max discount ₹</FieldLabel>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  value={formData.maxDiscount}
                  onChange={(e) => set("maxDiscount", e.target.value)}
                  placeholder="e.g. 100"
                  className={inputCls("maxDiscount")}
                />
                <ErrorMsg error={errors.maxDiscount} />
              </div>
            )}
          </div>

          <div>
            <FieldLabel
              required={!isPercent}
              hint={!isPercent ? "Must be more than the discount" : "Leave empty for no minimum"}
            >
              Minimum order ₹
            </FieldLabel>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              value={formData.minOrderValue}
              onChange={(e) => set("minOrderValue", e.target.value)}
              placeholder="e.g. 199"
              className={inputCls("minOrderValue")}
            />
            <ErrorMsg error={errors.minOrderValue} />
          </div>
        </Section>

        <Section title="Who can use it" icon={Users}>
          <div className="space-y-2">
            {AUDIENCES.map((a) => {
              const selected = formData.audience === a.value
              return (
                <button
                  key={a.value}
                  type="button"
                  onClick={() => set("audience", a.value)}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                    selected ? "" : "border-gray-200 bg-gray-50 hover:bg-gray-100"
                  }`}
                  style={selected ? { ...themeSelected, color: undefined } : undefined}
                >
                  <p className="text-sm font-semibold text-gray-900">{a.label}</p>
                  <p className="text-xs text-gray-500">{a.hint}</p>
                </button>
              )
            })}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel hint="Per customer">Max redemptions</FieldLabel>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                value={formData.perUserLimit}
                onChange={(e) => set("perUserLimit", e.target.value)}
                placeholder="Unlimited"
                className={inputCls("perUserLimit")}
              />
              <ErrorMsg error={errors.perUserLimit} />
            </div>
            <div>
              <FieldLabel hint="Across all customers">Total redemptions</FieldLabel>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                value={formData.usageLimit}
                onChange={(e) => set("usageLimit", e.target.value)}
                placeholder="Unlimited"
                className={inputCls("usageLimit")}
              />
              <ErrorMsg error={errors.usageLimit} />
            </div>
          </div>
        </Section>

        <Section title="When it works" icon={Clock}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel hint="Empty = starts now">Start date</FieldLabel>
              <input
                type="date"
                value={formData.startDate}
                onChange={(e) => set("startDate", e.target.value)}
                min={isEditMode ? undefined : todayIst()}
                className={`${inputCls("startDate")} appearance-none`}
                style={{ colorScheme: "light" }}
              />
              <ErrorMsg error={errors.startDate} />
            </div>
            <div>
              <FieldLabel required hint="Last day it works">End date</FieldLabel>
              <input
                type="date"
                value={formData.endDate}
                onChange={(e) => set("endDate", e.target.value)}
                min={formData.startDate || todayIst()}
                className={`${inputCls("endDate")} appearance-none`}
                style={{ colorScheme: "light" }}
              />
              <ErrorMsg error={errors.endDate} />
            </div>
          </div>

          <div>
            <FieldLabel hint={formData.activeDays.length ? undefined : "No days selected = every day"}>Days</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((d) => {
                const selected = formData.activeDays.includes(d.value)
                return (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => toggleDay(d.value)}
                    aria-pressed={selected}
                    className={`w-12 py-2 rounded-lg border text-xs font-semibold transition-colors ${
                      selected ? "" : "border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"
                    }`}
                    style={selected ? themeSelected : undefined}
                  >
                    {d.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <FieldLabel>Hours</FieldLabel>
            <div className="grid grid-cols-2 gap-2 mb-3">
              {[
                { value: true, label: "All day" },
                { value: false, label: "Specific hours" },
              ].map((opt) => {
                const selected = formData.allDay === opt.value
                return (
                  <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => set("allDay", opt.value)}
                    className={`py-2.5 rounded-lg border text-sm font-semibold transition-colors ${
                      selected ? "" : "border-gray-200 text-gray-700 bg-gray-50 hover:bg-gray-100"
                    }`}
                    style={selected ? themeSelected : undefined}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
            {!formData.allDay && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="time"
                    value={formData.activeFromTime}
                    onChange={(e) => set("activeFromTime", e.target.value)}
                    className={inputCls("hours")}
                    style={{ colorScheme: "light" }}
                    aria-label="From"
                  />
                  <input
                    type="time"
                    value={formData.activeToTime}
                    onChange={(e) => set("activeToTime", e.target.value)}
                    className={inputCls("hours")}
                    style={{ colorScheme: "light" }}
                    aria-label="To"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1.5">
                  India time. An end before the start runs overnight, e.g. 22:00 to 02:00.
                </p>
                <ErrorMsg error={errors.hours} />
              </>
            )}
          </div>
        </Section>

        <button
          onClick={handleSubmit}
          disabled={isSubmitting}
          className="w-full flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed text-white font-bold py-3.5 rounded-lg transition-colors text-sm"
          style={themeButton}
        >
          {isSubmitting ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
          ) : isEditMode ? "Save changes" : "Create coupon"}
        </button>
      </div>
    </div>
  )
}
