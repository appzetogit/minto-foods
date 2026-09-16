import { useState, useEffect, useMemo } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { useNavigate } from "react-router-dom"
import useRestaurantBackNavigation from "@food/hooks/useRestaurantBackNavigation"
import {
  ArrowLeft,
  Plus,
  Tag,
  Trash2,
  MoreVertical,
  Calendar,
  Copy,
  Pencil,
  Pause,
  Play,
  StopCircle,
} from "lucide-react"
import { restaurantAPI } from "@food/api"
import { toast } from "sonner"

// What each lifecycle state from the server looks like, and whether it is
// still running (shown under "Running") or finished (under "Past").
const STATES = {
  live: { label: "LIVE", running: true, themed: true },
  scheduled: { label: "SCHEDULED", running: true, className: "bg-blue-50 text-blue-700" },
  paused: { label: "PAUSED", running: true, className: "bg-amber-50 text-amber-700" },
  exhausted: { label: "LIMIT REACHED", running: false, className: "bg-gray-100 text-gray-600" },
  expired: { label: "EXPIRED", running: false, className: "bg-gray-100 text-gray-600" },
  ended: { label: "ENDED", running: false, className: "bg-gray-100 text-gray-600" },
}

const rupees = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`

const themeButton = {
  background: "linear-gradient(135deg, rgba(var(--module-theme-rgb,37,99,235),0.9), var(--module-theme-color,#2563EB))",
  boxShadow: "0 8px 18px rgba(var(--module-theme-rgb,37,99,235),0.26)",
}

export default function CouponListPage() {
  const navigate = useNavigate()
  const goBack = useRestaurantBackNavigation()
  const [openMenuId, setOpenMenuId] = useState(null)
  const [coupons, setCoupons] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [tab, setTab] = useState("running")
  const [busyId, setBusyId] = useState(null)

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (openMenuId && !event.target.closest(`[data-menu-id="${openMenuId}"]`)) setOpenMenuId(null)
    }
    if (openMenuId) document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [openMenuId])

  const fetchCoupons = async () => {
    try {
      const res = await restaurantAPI.listMyOffers()
      setCoupons(res.data?.data?.offers || [])
    } catch {
      toast.error("Failed to fetch coupons")
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => { fetchCoupons() }, [])

  const { running, past } = useMemo(() => ({
    running: coupons.filter((c) => STATES[c.state]?.running),
    past: coupons.filter((c) => !STATES[c.state]?.running),
  }), [coupons])
  const shown = tab === "running" ? running : past

  const act = async (coupon, fn, success) => {
    setOpenMenuId(null)
    setBusyId(coupon.id)
    try {
      await fn()
      toast.success(success)
      await fetchCoupons()
    } catch (error) {
      toast.error(error.response?.data?.message || "Something went wrong")
    } finally {
      setBusyId(null)
    }
  }

  const setStatus = (coupon, status, success) =>
    act(coupon, () => restaurantAPI.updateMyOfferStatus(coupon.id, status), success)

  const handleEnd = (coupon) => {
    if (!window.confirm(`End ${coupon.couponCode}? Customers will no longer be able to use it. Its results are kept.`)) return
    setStatus(coupon, "inactive", "Coupon ended")
  }

  const handleDelete = (coupon) => {
    if (!window.confirm(`Delete ${coupon.couponCode}? This cannot be undone.`)) return
    act(coupon, () => restaurantAPI.deleteMyOffer(coupon.id), "Coupon deleted")
  }

  const handleCopyCode = (code) => {
    navigator.clipboard?.writeText(code)
    toast.success("Code copied")
  }

  const menuItem = (onClick, Icon, label, danger = false) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
        danger ? "text-red-600 hover:bg-red-50" : "text-gray-700 hover:bg-gray-50"
      }`}
    >
      <Icon className="w-4 h-4" /> {label}
    </button>
  )

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="bg-white border-b border-gray-200 px-4 py-3 sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <button onClick={goBack} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors" aria-label="Go back">
            <ArrowLeft className="w-6 h-6 text-gray-900" />
          </button>
          <div className="flex-1">
            <h1 className="text-base font-bold text-gray-900">Offers & Coupons</h1>
            <p className="text-xs text-gray-500">Discounts funded by your restaurant</p>
          </div>
          <button
            onClick={() => navigate("/food/restaurant/coupon/new")}
            className="flex items-center gap-1.5 text-white text-sm font-semibold px-3 py-2 rounded-lg transition-colors"
            style={themeButton}
          >
            <Plus className="w-4 h-4" />
            Add New
          </button>
        </div>

        {coupons.length > 0 && (
          <div className="flex gap-2 mt-3">
            {[
              { value: "running", label: `Running (${running.length})` },
              { value: "past", label: `Past (${past.length})` },
            ].map((t) => (
              <button
                key={t.value}
                onClick={() => setTab(t.value)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                  tab === t.value ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="px-4 py-4 pb-24 space-y-3 max-w-2xl mx-auto">
        {isLoading ? (
          <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-4 border-gray-900 border-t-transparent rounded-full animate-spin" />
              <p className="text-gray-600 text-sm">Loading coupons...</p>
            </div>
          </div>
        ) : shown.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
            <div className="flex flex-col items-center gap-4 px-6">
              <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center">
                <Tag className="w-8 h-8 text-gray-400" />
              </div>
              <div>
                <p className="text-gray-900 font-semibold text-sm">
                  {coupons.length === 0 ? "No coupons yet" : tab === "running" ? "No running coupons" : "No past coupons"}
                </p>
                <p className="text-gray-500 text-xs mt-1">
                  {coupons.length === 0
                    ? "Offers like \"50% off up to ₹100\" bring in new customers and bigger orders"
                    : tab === "running" ? "Create one to start bringing in orders" : "Ended and expired coupons appear here"}
                </p>
              </div>
              {tab === "running" && (
                <button
                  onClick={() => navigate("/food/restaurant/coupon/new")}
                  className="flex items-center gap-2 text-white text-sm font-semibold px-4 py-2.5 rounded-lg"
                  style={themeButton}
                >
                  <Plus className="w-4 h-4" />
                  Create Coupon
                </button>
              )}
            </div>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {shown.map((coupon, index) => {
              const meta = STATES[coupon.state] || STATES.ended
              const results = coupon.results || {}
              const canPause = coupon.state === "live" || coupon.state === "scheduled"
              const canResume = coupon.state === "paused"
              const canEnd = meta.running
              return (
                <motion.div
                  key={coupon.id}
                  layout
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: busyId === coupon.id ? 0.6 : 1, y: 0 }}
                  exit={{ opacity: 0, y: -16 }}
                  transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.2) }}
                  className="bg-white border border-gray-200 rounded-lg"
                >
                  <div
                    className="h-1 rounded-t-lg"
                    style={{ backgroundColor: coupon.state === "live" ? "var(--module-theme-color, #2563EB)" : "#d1d5db" }}
                  />
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <span
                        className={`px-2.5 py-1 rounded text-[11px] font-bold tracking-wide ${meta.className || ""}`}
                        style={meta.themed ? {
                          backgroundColor: "rgba(var(--module-theme-rgb,37,99,235),0.10)",
                          color: "var(--module-theme-color,#2563EB)",
                        } : undefined}
                      >
                        {meta.label}
                      </span>
                      <div className="relative" data-menu-id={coupon.id}>
                        <button
                          onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === coupon.id ? null : coupon.id) }}
                          className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                          data-menu-id={coupon.id}
                          aria-label={`Actions for ${coupon.couponCode}`}
                          disabled={busyId === coupon.id}
                        >
                          <MoreVertical className="w-4 h-4 text-gray-500" />
                        </button>
                        <AnimatePresence>
                          {openMenuId === coupon.id && (
                            <motion.div
                              initial={{ opacity: 0, scale: 0.95, y: -8 }}
                              animate={{ opacity: 1, scale: 1, y: 0 }}
                              exit={{ opacity: 0, scale: 0.95, y: -8 }}
                              transition={{ duration: 0.15 }}
                              className="absolute right-0 top-full mt-1 bg-white rounded-xl shadow-2xl border border-gray-200 py-2 z-50 min-w-[170px]"
                              data-menu-id={coupon.id}
                            >
                              {menuItem(() => navigate(`/food/restaurant/coupon/${coupon.id}/edit`), Pencil, "Edit")}
                              {canPause && menuItem(() => setStatus(coupon, "paused", "Coupon paused"), Pause, "Pause")}
                              {canResume && menuItem(() => setStatus(coupon, "active", "Coupon resumed"), Play, "Resume")}
                              {canEnd && menuItem(() => handleEnd(coupon), StopCircle, "End offer", true)}
                              {coupon.canDelete && menuItem(() => handleDelete(coupon), Trash2, "Delete", true)}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>

                    <p className="text-xl font-extrabold text-gray-900 leading-tight">{coupon.headline}</p>
                    {coupon.conditions?.length > 0 && (
                      <p className="text-xs text-gray-500 mt-1">{coupon.conditions.join(" · ")}</p>
                    )}

                    <div className="flex items-center gap-2 mt-3">
                      <span className="px-2.5 py-1 border border-dashed border-gray-300 rounded font-mono text-sm font-bold tracking-widest text-gray-900">
                        {coupon.couponCode}
                      </span>
                      <button
                        onClick={() => handleCopyCode(coupon.couponCode)}
                        className="p-1.5 hover:bg-gray-100 rounded transition-colors"
                        aria-label="Copy code"
                      >
                        <Copy className="w-4 h-4" style={{ color: "var(--module-theme-color, #2563EB)" }} />
                      </button>
                    </div>

                    <div className="border-t border-dashed border-gray-200 my-3" />

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Redeemed</p>
                        <p className="text-sm font-bold text-gray-900">
                          {Number(coupon.usedCount) || 0}
                          <span className="text-gray-400 font-medium">{coupon.usageLimit ? ` / ${coupon.usageLimit}` : ""}</span>
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Customers</p>
                        <p className="text-sm font-bold text-gray-900">{results.customers || 0}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Sales</p>
                        <p className="text-sm font-bold text-gray-900">{rupees(results.sales)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Discount given</p>
                        <p className="text-sm font-bold text-gray-900">{rupees(results.discountGiven)}</p>
                      </div>
                    </div>

                    {(coupon.startDate || coupon.endDate) && (
                      <div className="flex items-center gap-1.5 mt-3">
                        <Calendar className="w-3.5 h-3.5 text-gray-400" />
                        <p className="text-xs text-gray-500">
                          {coupon.startDate
                            ? new Date(coupon.startDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })
                            : "Now"}
                          {" → "}
                          {coupon.endDate
                            ? new Date(coupon.endDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
                            : "No end date"}
                        </p>
                      </div>
                    )}
                  </div>
                </motion.div>
              )
            })}
          </AnimatePresence>
        )}
      </div>

      <motion.button
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 200, damping: 15 }}
        whileTap={{ scale: 0.9 }}
        onClick={() => navigate("/food/restaurant/coupon/new")}
        className="fixed bottom-6 right-4 w-14 h-14 bg-gray-900 hover:bg-gray-800 text-white rounded-full shadow-lg flex items-center justify-center z-40 transition-colors md:hidden"
        aria-label="Create coupon"
      >
        <Plus className="w-6 h-6" />
      </motion.button>
    </div>
  )
}
