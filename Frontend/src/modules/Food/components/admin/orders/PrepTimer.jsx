import { useEffect, useState } from "react"
import { Timer } from "lucide-react"

const clock = (ms) => {
  const s = Math.floor(Math.abs(ms) / 1000)
  const h = Math.floor(s / 3600)
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0")
  const sec = String(s % 60).padStart(2, "0")
  return h ? `${h}:${m}:${sec}` : `${m}:${sec}`
}

/** Re-renders every second while mounted. */
const useNow = () => {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

/**
 * Live prep countdown for an accepted order not yet marked ready -- the same
 * clock the restaurant sees. Past due it turns into how late it is, so the
 * team knows to call the restaurant.
 */
export function PrepCountdown({ timing }) {
  const now = useNow()
  if (!timing?.dueAt || timing.readyAt) return null
  const left = timing.dueAt.getTime() - now
  if (left >= 0) {
    return (
      <div className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-600 tabular-nums">
        <Timer className="h-3.5 w-3.5" /> Prep: {clock(left)} left
      </div>
    )
  }
  return (
    <div className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-0.5 text-xs font-bold text-white tabular-nums">
      <Timer className="h-3.5 w-3.5" /> Prep time over by {clock(left)} — not marked ready
    </div>
  )
}

const time = (d) => (d ? d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "—")
const late = (m) => (m === null ? "" : m > 0 ? `${m} min late` : m < 0 ? `${-m} min early` : "on time")

/** Order view: the prep time given against what happened. */
export function KitchenTiming({ timing }) {
  if (!timing?.quoted || !timing.acceptedAt) return null
  const rows = [
    ["Prep time given", `${timing.quoted} min`],
    ["Accepted at", time(timing.acceptedAt)],
    ["Prep due at", time(timing.dueAt)],
    [
      "Marked ready",
      timing.readyAt
        ? `${time(timing.readyAt)} · took ${timing.tookMinutes} min · ${late(timing.readyLateBy)}`
        : "Not yet",
      timing.readyLateBy > 0,
    ],
    [
      "Handed to rider",
      timing.pickedUpAt
        ? `${time(timing.pickedUpAt)} · ${late(timing.handoverAfterDue)} vs prep due${
            timing.handoverAfterReady !== null ? ` · ${timing.handoverAfterReady} min after ready` : ""
          }`
        : "Not yet",
      timing.handoverAfterDue > 0,
    ],
  ]
  return (
    <div className="border-t border-slate-200 pt-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
        <Timer className="h-4 w-4" /> Kitchen Timing
      </h3>
      <PrepCountdown timing={timing} />
      <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-[10rem_1fr]">
        {rows.map(([k, v, bad]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className={bad ? "font-semibold text-red-600" : "text-slate-900"}>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
