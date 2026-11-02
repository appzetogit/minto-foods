import { getGoogleMapsApiKey } from "./googleMapsApiKey"

/**
 * Address search through the Places API (New).
 *
 * google.maps.places.Autocomplete, AutocompleteService and PlacesService call
 * the legacy Places API, which Google does not enable on current projects:
 * typing into a search box popped up "This page can't load Google Maps
 * correctly" over the whole map. These stand in for those three with the same
 * calls and the same result shapes, so a page only changes what it constructs.
 */

const BASE = "https://places.googleapis.com/v1"
const DETAIL_FIELDS = "id,displayName,formattedAddress,addressComponents,location"

const okStatus = () => window.google?.maps?.places?.PlacesServiceStatus?.OK ?? "OK"
const failStatus = () => window.google?.maps?.places?.PlacesServiceStatus?.UNKNOWN_ERROR ?? "UNKNOWN_ERROR"

const newSession = () =>
  typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `s${Date.now()}${Math.random().toString(16).slice(2)}`

// Google bills suggestions and the place picked from them as one session.
let session = newSession()

async function suggest(input, signal) {
  const key = await getGoogleMapsApiKey()
  const res = await fetch(`${BASE}/places:autocomplete`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
    body: JSON.stringify({ input, includedRegionCodes: ["in"], sessionToken: session }),
  })
  if (!res.ok) throw new Error(`Place search failed (${res.status})`)
  const data = await res.json()
  return (data.suggestions || [])
    .map((s) => s.placePrediction)
    .filter(Boolean)
    .map((p) => ({
      place_id: p.placeId,
      description: p.text?.text || "",
      structured_formatting: {
        main_text: p.structuredFormat?.mainText?.text || p.text?.text || "",
        secondary_text: p.structuredFormat?.secondaryText?.text || "",
      },
      types: p.types || [],
    }))
}

async function details(placeId) {
  const key = await getGoogleMapsApiKey()
  const res = await fetch(`${BASE}/places/${encodeURIComponent(placeId)}?sessionToken=${session}`, {
    headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": DETAIL_FIELDS },
  })
  session = newSession()
  if (!res.ok) throw new Error(`Place lookup failed (${res.status})`)
  const p = await res.json()
  const lat = Number(p.location?.latitude)
  const lng = Number(p.location?.longitude)
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng)
  const LatLng = window.google?.maps?.LatLng
  return {
    place_id: p.id || placeId,
    name: p.displayName?.text || "",
    formatted_address: p.formattedAddress || "",
    address_components: (p.addressComponents || []).map((c) => ({
      long_name: c.longText || "",
      short_name: c.shortText || "",
      types: c.types || [],
    })),
    geometry: hasPoint
      ? { location: LatLng ? new LatLng(lat, lng) : { lat: () => lat, lng: () => lng } }
      : undefined,
  }
}

/** Stands in for google.maps.places.AutocompleteService. */
export class PlaceSuggestions {
  getPlacePredictions(request, callback) {
    const run = suggest(String(request?.input || "").trim()).then((predictions) => {
      callback?.(predictions, predictions.length ? okStatus() : window.google?.maps?.places?.PlacesServiceStatus?.ZERO_RESULTS ?? "ZERO_RESULTS")
      return { predictions }
    })
    return run.catch((err) => {
      callback?.([], failStatus())
      if (!callback) throw err
      return { predictions: [] }
    })
  }
}

/** Stands in for google.maps.places.PlacesService. */
export class PlaceDetails {
  getDetails(request, callback) {
    details(request?.placeId)
      .then((place) => callback?.(place, okStatus()))
      .catch(() => callback?.(null, failStatus()))
  }
}

const byInput = new WeakMap()

/** Stands in for google.maps.places.Autocomplete: a suggestion list under an input. */
export class PlaceAutocomplete {
  constructor(input) {
    byInput.get(input)?.destroy()
    byInput.set(input, this)
    this.input = input
    this.listeners = []
    this.place = null
    this.items = []
    this.active = -1
    this.seq = 0

    const box = document.createElement("div")
    box.setAttribute("role", "listbox")
    Object.assign(box.style, {
      position: "fixed",
      zIndex: "1000",
      display: "none",
      background: "#fff",
      border: "1px solid #e2e8f0",
      borderRadius: "8px",
      boxShadow: "0 10px 25px rgba(15,23,42,.15)",
      maxHeight: "260px",
      overflowY: "auto",
    })
    document.body.appendChild(box)
    this.box = box

    this.onInput = () => {
      clearTimeout(this.timer)
      const q = input.value.trim()
      if (q.length < 2) return this.hide()
      this.timer = setTimeout(() => this.search(q), 250)
    }
    this.onKey = (e) => {
      if (this.box.style.display === "none") return
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        const n = this.items.length
        this.active = (this.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n
        this.render()
      } else if (e.key === "Enter") {
        // Enter picks a suggestion rather than submitting the form around it.
        e.preventDefault()
        this.pick(this.items[this.active >= 0 ? this.active : 0])
      } else if (e.key === "Escape") {
        this.hide()
      }
    }
    this.onBlur = () => setTimeout(() => this.hide(), 150)
    this.onMove = () => this.position()
    input.addEventListener("input", this.onInput)
    input.addEventListener("keydown", this.onKey)
    input.addEventListener("blur", this.onBlur)
    window.addEventListener("scroll", this.onMove, true)
    window.addEventListener("resize", this.onMove)
  }

  async search(q) {
    const seq = ++this.seq
    try {
      const items = await suggest(q)
      if (seq !== this.seq || !this.input.isConnected) return
      this.items = items.slice(0, 6)
      this.active = -1
      if (this.items.length) this.render()
      else this.hide()
    } catch {
      this.hide()
    }
  }

  render() {
    const box = this.box
    box.textContent = ""
    this.items.forEach((item, i) => {
      const row = document.createElement("div")
      row.setAttribute("role", "option")
      Object.assign(row.style, {
        padding: "8px 12px",
        cursor: "pointer",
        fontSize: "13px",
        lineHeight: "1.3",
        color: "#0f172a",
        background: i === this.active ? "#f1f5f9" : "#fff",
        borderBottom: "1px solid #f1f5f9",
      })
      const main = document.createElement("div")
      main.style.fontWeight = "600"
      main.textContent = item.structured_formatting.main_text
      const sub = document.createElement("div")
      sub.style.color = "#64748b"
      sub.style.fontSize = "12px"
      sub.textContent = item.structured_formatting.secondary_text
      row.append(main, sub)
      // mousedown, so it lands before the input's blur closes the list.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault()
        this.pick(item)
      })
      box.appendChild(row)
    })
    box.style.display = "block"
    this.position()
  }

  position() {
    if (this.box.style.display === "none") return
    if (!this.input.isConnected) return this.hide()
    const r = this.input.getBoundingClientRect()
    Object.assign(this.box.style, { left: `${r.left}px`, top: `${r.bottom + 4}px`, width: `${r.width}px` })
  }

  hide() {
    this.box.style.display = "none"
  }

  async pick(item) {
    if (!item) return
    this.hide()
    this.input.value = item.description
    try {
      this.place = await details(item.place_id)
    } catch {
      return
    }
    this.input.value = this.place.formatted_address || item.description
    this.listeners.forEach((fn) => fn())
  }

  addListener(event, fn) {
    if (event !== "place_changed") return { remove() {} }
    this.listeners.push(fn)
    return { remove: () => { this.listeners = this.listeners.filter((f) => f !== fn) } }
  }

  getPlace() {
    return this.place || {}
  }

  destroy() {
    clearTimeout(this.timer)
    this.input.removeEventListener("input", this.onInput)
    this.input.removeEventListener("keydown", this.onKey)
    this.input.removeEventListener("blur", this.onBlur)
    window.removeEventListener("scroll", this.onMove, true)
    window.removeEventListener("resize", this.onMove)
    this.box.remove()
    byInput.delete(this.input)
  }
}
