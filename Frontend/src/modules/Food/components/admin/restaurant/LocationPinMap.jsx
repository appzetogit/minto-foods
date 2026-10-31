import { useEffect, useRef, useState } from "react"
import { Loader } from "@googlemaps/js-api-loader"
import { getGoogleMapsApiKey } from "@food/utils/googleMapsApiKey"

/**
 * Pick a restaurant's exact location by dropping a pin.
 *
 * Search alone often lands on the area's centre rather than the shop, and
 * delivery fees, reach and rider dispatch all measure from this point. Drag
 * the pin, or click the map, and the address fields are filled from the spot
 * (reverse geocoding) -- the admin can still edit them after.
 *
 * Props: latitude, longitude (current point, may be empty), onChange({ latitude,
 * longitude, formattedAddress, area, city, state, pincode }).
 */

const INDIA = { lat: 20.5937, lng: 78.9629 }

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && v !== "" && v !== null ? n : null
}

/** The address parts a geocoder result carries, by type. */
const partsOf = (result) => {
  const find = (...types) =>
    result?.address_components?.find((c) => types.some((t) => c.types.includes(t)))?.long_name || ""
  return {
    formattedAddress: result?.formatted_address || "",
    area: find("sublocality_level_1", "sublocality", "neighborhood", "locality"),
    city: find("locality", "administrative_area_level_3", "administrative_area_level_2"),
    state: find("administrative_area_level_1"),
    pincode: find("postal_code"),
  }
}

let mapsPromise = null
const loadMaps = async () => {
  if (window.google?.maps) return window.google
  if (!mapsPromise) {
    mapsPromise = (async () => {
      const apiKey = await getGoogleMapsApiKey()
      if (!apiKey) throw new Error("Google Maps key is not set")
      return new Loader({ apiKey, version: "weekly", libraries: ["places", "geometry"] }).load()
    })().catch((e) => {
      mapsPromise = null
      throw e
    })
  }
  return mapsPromise
}

export default function LocationPinMap({ latitude, longitude, onChange, height = 300 }) {
  const boxRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const geocoderRef = useRef(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [error, setError] = useState("")
  const [ready, setReady] = useState(false)

  const lat = num(latitude)
  const lng = num(longitude)

  // Build the map once.
  useEffect(() => {
    let cancelled = false
    loadMaps()
      .then((google) => {
        if (cancelled || !boxRef.current) return
        const start = lat !== null && lng !== null ? { lat, lng } : INDIA
        const map = new google.maps.Map(boxRef.current, {
          center: start,
          zoom: lat !== null ? 17 : 5,
          mapTypeControl: true,
          streetViewControl: false,
          fullscreenControl: true,
        })
        const marker = new google.maps.Marker({ position: start, map, draggable: true, visible: lat !== null })
        geocoderRef.current = new google.maps.Geocoder()

        const place = (position) => {
          const p = { lat: position.lat(), lng: position.lng() }
          marker.setPosition(p)
          marker.setVisible(true)
          const base = { latitude: Number(p.lat.toFixed(6)), longitude: Number(p.lng.toFixed(6)) }
          onChangeRef.current?.(base)
          geocoderRef.current.geocode({ location: p }, (results, status) => {
            if (status === "OK" && results?.[0]) onChangeRef.current?.({ ...base, ...partsOf(results[0]) })
          })
        }
        marker.addListener("dragend", (e) => place(e.latLng))
        map.addListener("click", (e) => place(e.latLng))

        mapRef.current = map
        markerRef.current = marker
        setReady(true)
      })
      .catch((e) => !cancelled && setError(e?.message || "Could not load the map"))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow the point when it changes from outside (the search box).
  useEffect(() => {
    if (!ready || lat === null || lng === null) return
    const marker = markerRef.current
    const current = marker.getPosition()
    if (current && Math.abs(current.lat() - lat) < 1e-7 && Math.abs(current.lng() - lng) < 1e-7 && marker.getVisible()) return
    marker.setPosition({ lat, lng })
    marker.setVisible(true)
    mapRef.current.panTo({ lat, lng })
    if (mapRef.current.getZoom() < 15) mapRef.current.setZoom(17)
  }, [ready, lat, lng])

  if (error) {
    return <p className="text-xs text-red-600">Map unavailable: {error}. Use the search box instead.</p>
  }
  return (
    <div className="space-y-1">
      <div ref={boxRef} style={{ height }} className="w-full rounded-md border border-gray-200 bg-gray-100" />
      <p className="text-[11px] text-gray-500">
        Drag the pin (or click the map) to the restaurant's exact entrance.
        {lat !== null && lng !== null ? ` Pinned at ${lat.toFixed(5)}, ${lng.toFixed(5)}.` : ""}
      </p>
    </div>
  )
}
