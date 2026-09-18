import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Plus } from "lucide-react"
import { adminAPI } from "@food/api"

const keyOf = (name) => String(name || "").trim().replace(/\s+/g, " ").toLowerCase()

/**
 * Picks the city a zone belongs to.
 *
 * Suggests the cities that already exist as you type, and matches what you
 * typed to one however it is capitalised. A new city is only made when you
 * choose "Add … as a new city", so a typo cannot quietly start a second
 * Indore.
 *
 * value: { cityId, name, createCity }
 */
export default function CityPicker({ value, onChange, disabled = false }) {
  const [cities, setCities] = useState([])
  const [open, setOpen] = useState(false)
  const [loadError, setLoadError] = useState("")
  const boxRef = useRef(null)

  useEffect(() => {
    let alive = true
    adminAPI
      .getCities({ limit: 500 })
      .then((res) => alive && setCities(res?.data?.data?.cities || []))
      .catch(() => alive && setLoadError("Could not load cities"))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const close = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [])

  // An edit form loads the zone's city by name before the list arrives; tie it
  // to its id once the list is here.
  useEffect(() => {
    if (value?.cityId || !value?.name || !cities.length) return
    const match = cities.find((c) => keyOf(c.name) === keyOf(value.name))
    if (match) onChange({ cityId: match.id, name: match.name, createCity: false })
  }, [cities]) // eslint-disable-line react-hooks/exhaustive-deps

  const typed = value?.name || ""
  const suggestions = useMemo(() => {
    const k = keyOf(typed)
    return k ? cities.filter((c) => keyOf(c.name).includes(k)) : cities
  }, [cities, typed])
  const exact = cities.find((c) => keyOf(c.name) === keyOf(typed))

  const pick = (city) => {
    onChange({ cityId: city.id, name: city.name, createCity: false })
    setOpen(false)
  }

  const type = (name) => {
    const match = cities.find((c) => keyOf(c.name) === keyOf(name))
    onChange(match ? { cityId: match.id, name, createCity: false } : { cityId: "", name, createCity: false })
    setOpen(true)
  }

  return (
    <div className="relative" ref={boxRef}>
      <input
        type="text"
        value={typed}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => type(e.target.value)}
        placeholder="Start typing a city"
        className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        required
      />

      {open && !disabled && (
        <div className="absolute z-30 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {suggestions.map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => pick(c)}
              className="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              <span>
                {c.name}
                <span className="ml-2 text-xs text-slate-400">
                  {c.zoneCount} zone{c.zoneCount === 1 ? "" : "s"}
                </span>
              </span>
              {value?.cityId === c.id && <Check className="h-4 w-4 text-blue-600" />}
            </button>
          ))}
          {typed.trim() && !exact && (
            <button
              type="button"
              onClick={() => {
                onChange({ cityId: "", name: typed.trim().replace(/\s+/g, " "), createCity: true })
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 border-t border-slate-100 px-4 py-2 text-left text-sm font-medium text-blue-700 hover:bg-blue-50"
            >
              <Plus className="h-4 w-4" /> Add &ldquo;{typed.trim()}&rdquo; as a new city
            </button>
          )}
          {!suggestions.length && !typed.trim() && (
            <p className="px-4 py-2 text-sm text-slate-400">{loadError || "No cities yet. Type one to add it."}</p>
          )}
        </div>
      )}

      <p className="mt-1 text-xs text-slate-500">
        {value?.createCity
          ? `${typed.trim()} will be added as a new city when you save.`
          : value?.cityId
            ? "A city can have several zones. Sub-admins are given cities and see all their zones."
            : typed.trim()
              ? "Pick a city from the list, or add it as a new one."
              : "Pick the city this zone is in."}
      </p>
    </div>
  )
}
