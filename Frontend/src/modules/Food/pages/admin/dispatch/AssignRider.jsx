import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import io from "socket.io-client"
import { toast } from "sonner"
import { Loader2, RefreshCw, X, MapPin, Bike, AlertTriangle, Search } from "lucide-react"
import { adminAPI } from "@food/api"
import { API_BASE_URL } from "@food/api/config"

/**
 * Assign Rider: the manual-dispatch queue.
 *
 * Orders in zones set to manual wait here; nothing is offered to riders until
 * an admin assigns one. The rider gets the usual accept popup; if they decline
 * or don't answer in time, the order comes back here with their name on it.
 * Live over the admin socket, with a 20s poll as a fallback.
 */

const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`
const errText = (e, f) => e?.response?.data?.message || e?.message || f
const dataOf = (res) => res?.data?.data ?? res?.data ?? {}

function useTick(ms = 1000) {
  const [, set] = useState(0)
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

const sinceText = (date) => {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

const countdown = (deadline) => {
  const s = Math.max(0, Math.round((new Date(deadline).getTime() - Date.now()) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export default function AssignRider() {
  const [queue, setQueue] = useState({ orders: [], alertMinutes: 5 })
  const [loading, setLoading] = useState(true)
  const [picking, setPicking] = useState(null) // order being assigned
  const [busy, setBusy] = useState("")
  const fetchRef = useRef(null)
  useTick(1000)

  const load = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true)
      setQueue(dataOf(await adminAPI.getDispatchQueue()))
    } catch (e) {
      if (!silent) toast.error(errText(e, "Could not load the queue"))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])
  fetchRef.current = load

  useEffect(() => {
    load()
    const poll = setInterval(() => {
      if (!document.hidden) fetchRef.current(true)
    }, 20000)
    return () => clearInterval(poll)
  }, [load])

  // Live: a new order needing a rider, a decline, an accept.
  useEffect(() => {
    const backendUrl = API_BASE_URL.replace(/\/api\/?$/, "")
    if (!backendUrl.startsWith("http")) return undefined
    const socket = io(backendUrl, {
      transports: ["websocket", "polling"],
      auth: (cb) => {
        let token = ""
        try {
          token = localStorage.getItem("admin_accessToken") || ""
        } catch (_) {}
        cb({ token })
      },
      reconnection: true,
    })
    const refresh = () => fetchRef.current(true)
    socket.on("order_needs_assignment", (p) => {
      if (p?.reason === "declined" || p?.reason === "timeout") toast.warning(p.message)
      else if (p?.reason === "new") toast.info(p.message || "New order needs a rider")
      refresh()
    })
    socket.on("order_assignment_update", refresh)
    socket.on("order_status_update", refresh)
    return () => socket.disconnect()
  }, [])

  const unassign = async (order) => {
    if (!window.confirm(`Cancel ${order.assignedTo?.name}'s assignment for #${order.displayId}?`)) return
    try {
      setBusy(order.id)
      await adminAPI.unassignRider(order.id)
      toast.success("Assignment cancelled")
      load(true)
    } catch (e) {
      toast.error(errText(e, "Could not cancel"))
    } finally {
      setBusy("")
    }
  }

  const orders = queue.orders || []

  return (
    <div className="p-3 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5 flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-[240px]">
            <h1 className="text-xl font-bold text-slate-900">Assign Rider</h1>
            <p className="text-sm text-slate-500 mt-1">
              Orders in manual-dispatch zones wait here. Pick a rider from the order&rsquo;s zone; they get the order
              and accept it in the app. Declined or unanswered orders come back here.
            </p>
          </div>
          <Link to="/admin/food/dispatch/settings" className="text-sm text-blue-600 underline">Dispatch settings</Link>
          <button type="button" onClick={() => load()} className="p-2 rounded-lg border border-slate-200" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500 text-sm py-10 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : orders.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-sm text-slate-500">
            No orders waiting for a rider.
            <div className="text-xs text-slate-400 mt-1">Only zones set to Manual in Dispatch Settings use this queue.</div>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {orders.map((o) => {
              const late = o.waitingMinutes >= (queue.alertMinutes || 5) && !o.assignedTo
              return (
                <div key={o.id} className={`bg-white rounded-xl border p-4 space-y-2 ${late ? "border-red-300 ring-1 ring-red-200" : "border-slate-200"}`}>
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <div className="font-semibold text-slate-900">#{o.displayId}</div>
                      <div className="text-sm text-slate-600">{o.restaurantName}{o.restaurantArea ? ` · ${o.restaurantArea}` : ""}</div>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${late ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                      waiting {sinceText(o.waitingSince)}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
                    <span className="capitalize">{o.orderStatus.replace(/_/g, " ")}</span>
                    <span>{o.zoneName}</span>
                    <span className="uppercase">{o.paymentMethod}</span>
                    <span>{money(o.total)}</span>
                    {o.isForSomeoneElse ? <span className="text-violet-600">For someone else</span> : null}
                  </div>
                  <div className="text-xs text-slate-600 flex gap-1 items-start">
                    <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {o.dropArea || "—"}
                  </div>
                  <div className="text-xs text-slate-500 truncate">{o.items.join(", ")}</div>
                  {o.declinedBy?.length ? (
                    <div className="text-xs text-rose-600">
                      Declined / no answer: {o.declinedBy.map((d) => `${d.name}${d.action === "timeout" ? " (no answer)" : ""}`).join(", ")}
                    </div>
                  ) : null}

                  {o.assignedTo ? (
                    <div className="flex items-center gap-2 bg-blue-50 rounded-lg px-3 py-2 text-sm">
                      <Bike className="w-4 h-4 text-blue-600" />
                      <span className="flex-1">
                        Waiting for <b>{o.assignedTo.name}</b> to accept · {countdown(o.assignedTo.deadlineAt)}
                      </span>
                      <button type="button" onClick={() => setPicking(o)} className="text-xs text-blue-700 underline">Re-assign</button>
                      <button type="button" disabled={busy === o.id} onClick={() => unassign(o)} className="text-xs text-slate-600 underline">Cancel</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPicking(o)}
                      className="w-full py-2 rounded-lg bg-blue-600 text-white text-sm font-medium"
                    >
                      Assign rider
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {picking ? (
        <RiderPicker
          order={picking}
          onClose={() => setPicking(null)}
          onAssigned={() => {
            setPicking(null)
            load(true)
          }}
        />
      ) : null}
    </div>
  )
}

/** Riders for one order's zone: in-zone first, free first, nearest first. */
export function RiderPicker({ order, onClose, onAssigned }) {
  const [riders, setRiders] = useState([])
  const [loading, setLoading] = useState(true)
  const [showOffline, setShowOffline] = useState(false)
  const [q, setQ] = useState("")
  const [search, setSearch] = useState("")
  const [saving, setSaving] = useState("")
  // The server caps the online list and pages the offline one.
  const [onlineCapped, setOnlineCapped] = useState(0)
  const [offline, setOffline] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  // Search runs on the server, so riders past the first page can be found.
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 350)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    let alive = true
    setLoading(true)
    adminAPI
      .getEligibleRiders(order.id, showOffline, { search })
      .then((res) => {
        if (!alive) return
        const d = dataOf(res)
        setRiders(d.riders || [])
        setOnlineCapped(d.onlineCapped ? d.onlineCap : 0)
        setOffline(d.offline || null)
      })
      .catch((e) => alive && toast.error(errText(e, "Could not load riders")))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [order.id, showOffline, search])

  const loadMoreOffline = async () => {
    if (!offline?.hasMore) return
    try {
      setLoadingMore(true)
      const d = dataOf(await adminAPI.getEligibleRiders(order.id, true, { search, offlinePage: offline.page + 1 }))
      const seen = new Set(riders.map((r) => r.id))
      // The online riders come back again on every page; keep only the new offline ones.
      setRiders([...riders, ...(d.riders || []).filter((r) => !r.online && !seen.has(r.id))])
      setOffline(d.offline || null)
    } catch (e) {
      toast.error(errText(e, "Could not load more riders"))
    } finally {
      setLoadingMore(false)
    }
  }

  const assign = async (r) => {
    let body = { deliveryPartnerId: r.id }
    if (r.needsOverride) {
      const reason = window.prompt(`${r.name} is outside the zone right now. Why assign them anyway?`)
      if (!reason || !reason.trim()) return
      body = { ...body, force: true, reason: reason.trim() }
    }
    try {
      setSaving(r.id)
      const res = await adminAPI.assignRider(order.id, body)
      toast.success(res?.data?.message || `Assigned to ${r.name}`)
      onAssigned?.()
    } catch (e) {
      toast.error(errText(e, "Could not assign"))
    } finally {
      setSaving("")
    }
  }

  const needle = q.trim().toLowerCase()
  const shown = needle ? riders.filter((r) => `${r.name} ${r.phone}`.toLowerCase().includes(needle)) : riders

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-white overflow-y-auto p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Assign rider · #{order.displayId || order.id}</h2>
            <p className="text-xs text-slate-500">{order.restaurantName}{order.zoneName ? ` · ${order.zoneName}` : ""}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex gap-2 items-center">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name or phone"
              className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-slate-300"
            />
          </div>
          <label className="text-xs text-slate-600 flex items-center gap-1 whitespace-nowrap">
            <input type="checkbox" checked={showOffline} onChange={(e) => setShowOffline(e.target.checked)} /> Show offline
          </label>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500 text-sm py-6">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading riders…
          </div>
        ) : shown.length === 0 ? (
          <p className="text-sm text-slate-500 py-6">No riders found for this zone{showOffline ? "" : " who are online"}.</p>
        ) : (
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
            {shown.map((r) => (
              <div key={r.id} className={`p-3 flex items-center gap-3 ${r.assignable ? "" : "opacity-60"}`}>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-900 flex items-center gap-2">
                    {r.name}
                    <span className={`w-2 h-2 rounded-full ${r.online ? "bg-emerald-500" : "bg-slate-300"}`} />
                    {!r.insideZone ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">outside zone</span> : null}
                    {r.declinedThisOrder ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">declined this</span> : null}
                  </div>
                  <div className="text-xs text-slate-500 flex flex-wrap gap-x-3">
                    <span>{r.phone}</span>
                    {r.distanceKm != null ? <span>{r.distanceKm} km to restaurant</span> : null}
                    <span>{r.deliveredToday} today</span>
                    <span>cash {money(r.cashInHand)}</span>
                    {r.lastLocationAt ? <span>seen {sinceText(r.lastLocationAt)} ago</span> : null}
                  </div>
                  {!r.assignable ? (
                    <div className="text-xs text-rose-600 flex items-center gap-1 mt-0.5">
                      <AlertTriangle className="w-3 h-3" /> {r.notAssignableReason}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={!r.assignable || r.currentlyAssigned || saving === r.id}
                  onClick={() => assign(r)}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium disabled:bg-slate-300"
                >
                  {saving === r.id ? "…" : r.currentlyAssigned ? "Assigned" : "Assign"}
                </button>
              </div>
            ))}
          </div>
        )}
        {!loading && onlineCapped ? (
          <p className="text-xs text-slate-500">Showing the {onlineCapped} nearest online riders. Search by name or phone to find others.</p>
        ) : null}
        {!loading && offline?.hasMore ? (
          <button
            type="button"
            onClick={loadMoreOffline}
            disabled={loadingMore}
            className="w-full py-2 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Load more offline riders"}
          </button>
        ) : null}
      </div>
    </div>
  )
}
