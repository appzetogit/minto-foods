import { useCallback, useEffect, useState } from "react"
import { Loader2, RotateCcw, Search } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

/**
 * Refund tracking: every refund movement, from every path -- customer and
 * restaurant cancellations, orders that expired, and admin refunds -- with
 * where the money went, who bears it and whether it went through.
 *
 * Replaces "New Refund Requests", which called an API that never existed.
 */

const rupees = (n) => `₹${(Math.round(Number(n || 0) * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`

const STATUS_STYLE = {
  processed: "bg-emerald-100 text-emerald-700",
  pending: "bg-amber-100 text-amber-700",
  failed: "bg-red-100 text-red-700",
}

const SOURCE_LABEL = { online: "Online", wallet: "Wallet", cash: "Cash (COD)" }

const when = (value) => {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true })
}

const errText = (e, fallback) => e?.response?.data?.message || e?.message || fallback

export default function RefundTracking() {
  const [rows, setRows] = useState([])
  const [summary, setSummary] = useState(null)
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 })
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ status: "", chargedTo: "", from: "", to: "", search: "" })
  const [q, setQ] = useState("")
  const [page, setPage] = useState(1)

  // Search waits for typing to stop.
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.search === q.trim() ? f : { ...f, search: q.trim() }))
      setPage(1)
    }, 350)
    return () => clearTimeout(t)
  }, [q])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = { page, limit: 25 }
      for (const [k, v] of Object.entries(filters)) if (v) params[k] = v
      const res = await adminAPI.getOrderRefunds(params)
      const data = res?.data?.data || {}
      setRows(Array.isArray(data.refunds) ? data.refunds : [])
      setSummary(data.summary || null)
      setPagination(data.pagination || { page: 1, totalPages: 1, total: 0 })
    } catch (e) {
      toast.error(errText(e, "Could not load refunds"))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [filters, page])

  useEffect(() => {
    load()
  }, [load])

  const setFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }

  const tile = (label, value, sub, tone) => (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-80">{label}</p>
      <p className="mt-1 text-xl font-bold">{value}</p>
      {sub ? <p className="text-xs opacity-80">{sub}</p> : null}
    </div>
  )

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <RotateCcw className="w-5 h-5 text-slate-600" />
          <h1 className="text-2xl font-bold text-slate-900">Refunds</h1>
        </div>
        <p className="text-sm text-slate-600">
          Every refund, from cancellations and from the Refund button on an order. To refund an order, open it in
          Orders and use Refund.
        </p>

        {summary ? (
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {tile("Refunded", rupees(summary.processed.amount), `${summary.processed.count} refunds`, "border-emerald-200 bg-emerald-50 text-emerald-800")}
            {tile("In progress", rupees(summary.pending.amount), `${summary.pending.count} refunds`, "border-amber-200 bg-amber-50 text-amber-800")}
            {tile("Failed", rupees(summary.failed.amount), `${summary.failed.count} refunds`, "border-red-200 bg-red-50 text-red-800")}
            {tile("Borne by restaurants", rupees(summary.chargedToRestaurant), "taken off payouts", "border-slate-200 bg-white text-slate-800")}
            {tile("Borne by company", rupees(summary.chargedToPlatform), "Minto's cost", "border-slate-200 bg-white text-slate-800")}
          </div>
        ) : null}

        <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap gap-3 items-end">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Order ID, restaurant, customer name or phone"
              className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-slate-300"
            />
          </div>
          <label className="text-xs text-slate-600">
            Status
            <select value={filters.status} onChange={(e) => setFilter("status", e.target.value)} className="block mt-1 px-2 py-2 text-sm rounded-lg border border-slate-300">
              <option value="">All</option>
              <option value="processed">Refunded</option>
              <option value="pending">In progress</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label className="text-xs text-slate-600">
            Borne by
            <select value={filters.chargedTo} onChange={(e) => setFilter("chargedTo", e.target.value)} className="block mt-1 px-2 py-2 text-sm rounded-lg border border-slate-300">
              <option value="">Anyone</option>
              <option value="restaurant">Restaurant</option>
              <option value="platform">Company</option>
            </select>
          </label>
          <label className="text-xs text-slate-600">
            From
            <input type="date" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} className="block mt-1 px-2 py-2 text-sm rounded-lg border border-slate-300" />
          </label>
          <label className="text-xs text-slate-600">
            To
            <input type="date" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} className="block mt-1 px-2 py-2 text-sm rounded-lg border border-slate-300" />
          </label>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm p-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading refunds…
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-slate-500 p-6">No refunds match these filters.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Order</th>
                  <th className="px-3 py-2">Restaurant</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">From → To</th>
                  <th className="px-3 py-2">Borne by</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600">{when(r.createdAt)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="font-medium text-slate-900">#{r.orderDisplayId}</span>
                      <span className="block text-xs text-slate-500">of {rupees(r.orderTotal)}</span>
                    </td>
                    <td className="px-3 py-2 text-slate-700">{r.restaurantName || "—"}</td>
                    <td className="px-3 py-2 text-slate-700">
                      {r.customerName || "—"}
                      {r.customerPhone ? <span className="block text-xs text-slate-500">{r.customerPhone}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-900 whitespace-nowrap">{rupees(r.amount)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600">
                      {SOURCE_LABEL[r.source] || r.source} → {r.refundTo === "wallet" ? "Wallet" : "Original method"}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{r.chargedTo === "restaurant" ? "Restaurant" : "Company"}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLE[r.status] || ""}`}>
                        {r.status === "processed" ? "Refunded" : r.status === "pending" ? "In progress" : "Failed"}
                      </span>
                      {r.status === "processed" && r.processedAt ? (
                        <span className="block text-xs text-slate-500 mt-0.5">{when(r.processedAt)}</span>
                      ) : null}
                      {r.status === "failed" && r.failureReason ? (
                        <span className="block text-xs text-red-600 mt-0.5 max-w-[220px]">{r.failureReason}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-slate-600 max-w-[260px]">{r.reason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {pagination.totalPages > 1 ? (
          <div className="flex items-center justify-between text-sm text-slate-600">
            <span>
              Page {pagination.page} of {pagination.totalPages} · {pagination.total} refunds
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1.5 rounded-lg border border-slate-300 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= pagination.totalPages || loading}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 rounded-lg border border-slate-300 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
