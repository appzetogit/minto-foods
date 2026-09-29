import { useEffect, useMemo, useState } from "react"
import { Loader2, Search, X } from "lucide-react"
import { adminAPI } from "@food/api"

/**
 * Pick a restaurant's cuisines from the Cuisines master list.
 *
 * Add Restaurant used a list of seven names written into the page (two of
 * which, Burgers and Pizza, are not in the master list at all) and Edit
 * Restaurant used a free-text box, so neither matched what an admin keeps
 * under Cuisines. Both now read the same active list.
 *
 * A restaurant already tagged with a name that is not in the list keeps it,
 * shown so it can be removed, rather than silently dropped on save.
 *
 * @param {{ value: string[], onChange: (next: string[]) => void, max?: number }} props
 */
export default function CuisinePicker({ value = [], onChange, max = 3 }) {
  const [master, setMaster] = useState([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")

  useEffect(() => {
    let alive = true
    adminAPI
      .getCuisines()
      .then((res) => {
        const rows = res?.data?.data?.cuisines || res?.data?.cuisines || []
        if (alive) setMaster(Array.isArray(rows) ? rows.map((c) => c.name).filter(Boolean) : [])
      })
      .catch(() => alive && setMaster([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const selected = Array.isArray(value) ? value : []
  const key = (s) => String(s || "").trim().toLowerCase()
  const isSelected = (name) => selected.some((s) => key(s) === key(name))
  const notInMaster = selected.filter((s) => !master.some((m) => key(m) === key(s)))

  const shown = useMemo(() => {
    const q = key(query)
    return q ? master.filter((m) => key(m).includes(q)) : master
  }, [master, query])

  const toggle = (name) => {
    if (isSelected(name)) {
      onChange(selected.filter((s) => key(s) !== key(name)))
      return
    }
    if (selected.length >= max) return
    onChange([...selected, name])
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {selected.length}/{max} selected
          {selected.length >= max ? " — remove one to pick another" : ""}
        </p>
        {master.length > 8 ? (
          <label className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a cuisine"
              className="w-32 bg-transparent text-xs outline-none"
            />
          </label>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading cuisines…
        </div>
      ) : master.length === 0 ? (
        <p className="text-xs text-red-600">
          No cuisines found. Add them under Restaurant Management → Cuisines first.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {shown.map((name) => {
            const active = isSelected(name)
            const blocked = !active && selected.length >= max
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                disabled={blocked}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? "bg-slate-900 text-white"
                    : blocked
                      ? "cursor-not-allowed bg-slate-100 text-slate-400"
                      : "bg-slate-100 text-slate-800 hover:bg-slate-200"
                }`}
              >
                {name}
              </button>
            )
          })}
        </div>
      )}

      {notInMaster.length ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-amber-700">
          <span>Not in the Cuisines list:</span>
          {notInMaster.map((name) => (
            <span key={name} className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1">
              {name}
              <button
                type="button"
                onClick={() => onChange(selected.filter((s) => key(s) !== key(name)))}
                className="text-amber-800 hover:text-amber-950"
                aria-label={`Remove ${name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
