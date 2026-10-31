import { useEffect, useMemo, useRef, useState } from "react"
import { Bike, Clock, Loader2, MapPin, Navigation, RefreshCw, Search, Wifi, WifiOff } from "lucide-react"
import { Loader } from "@googlemaps/js-api-loader"
import { adminAPI } from "@food/api"
import { subscribeAllDeliveryLocations } from "@food/realtimeTracking"
import { getGoogleMapsApiKey } from "@food/utils/googleMapsApiKey"

const debugError = () => {}

const DEFAULT_CENTER = { lat: 20.5937, lng: 78.9629 }
const ACTIVE_ORDERS_REFRESH_MS = 30000

// What a rider is doing, worked out from their online flag and current order.
const RIDER_STATUS = {
  vacant: { label: "Vacant", color: "#16a34a", badge: "bg-emerald-100 text-emerald-700" },
  awaiting: { label: "Order offered", color: "#d97706", badge: "bg-amber-100 text-amber-700" },
  to_pickup: { label: "Going to pickup", color: "#2563eb", badge: "bg-blue-100 text-blue-700" },
  to_drop: { label: "Delivering", color: "#7c3aed", badge: "bg-violet-100 text-violet-700" },
  offline: { label: "Offline", color: "#64748b", badge: "bg-slate-100 text-slate-600" },
}

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "on_order", label: "On order" },
  { key: "vacant", label: "Vacant" },
  { key: "offline", label: "Offline" },
]

const getRiderStatus = (isOnline, activeOrder) => {
  if (activeOrder) {
    if (!activeOrder.accepted) return "awaiting"
    return activeOrder.stage === "to_drop" ? "to_drop" : "to_pickup"
  }
  return isOnline ? "vacant" : "offline"
}

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch])

const describeDestination = (activeOrder) => {
  if (!activeOrder) return ""
  const { destination, stage } = activeOrder
  const place = [destination?.name, destination?.area].filter(Boolean).join(" · ")
  return `${stage === "to_drop" ? "Drop" : "Pickup"}: ${place || "location not set"}`
}

const hasCoordinates = (point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng)

// Marker labels sit on the map tiles, so give them a solid pill to stay readable.
const MARKER_LABEL_CSS = `
  .rider-map-label {
    background: #0f172a;
    color: #ffffff !important;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 11px !important;
    font-weight: 700;
    white-space: nowrap;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.35);
  }
`

const toFiniteNumber = (value) => {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue : null
}

const getDeliveryId = (deliveryman) =>
  String(deliveryman?._id || deliveryman?.id || deliveryman?.deliveryId || deliveryman?.fullData?._id || "")

const getDeliveryName = (deliveryman) =>
  deliveryman?.name ||
  deliveryman?.fullName ||
  deliveryman?.fullData?.name ||
  deliveryman?.fullData?.fullName ||
  "Delivery Partner"

const getDeliveryPhone = (deliveryman) =>
  deliveryman?.phone || deliveryman?.mobile || deliveryman?.fullData?.phone || "N/A"

const isDeliveryOnlineFromDb = (deliveryman) => {
  const status = String(deliveryman?.availabilityStatus || deliveryman?.fullData?.availabilityStatus || "").toLowerCase()
  if (status === "online") return true
  if (status === "offline") return false
  return deliveryman?.isOnline === true || deliveryman?.fullData?.isOnline === true
}

const formatLastSeen = (timestamp) => {
  if (!timestamp) return "No live update yet"
  const date = new Date(Number(timestamp))
  if (Number.isNaN(date.getTime())) return "No live update yet"
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

const getLocationFromPayload = (payload) => {
  const location = payload?.location || payload || {}
  const lat = toFiniteNumber(location.lat ?? location.latitude)
  const lng = toFiniteNumber(location.lng ?? location.longitude)
  const timestamp = toFiniteNumber(location.timestamp ?? location.last_updated ?? location.lastUpdate)
  const status = String(location.status || "").toLowerCase()

  return {
    lat,
    lng,
    heading: toFiniteNumber(location.heading ?? location.bearing) || 0,
    speed: toFiniteNumber(location.speed) || 0,
    accuracy: toFiniteNumber(location.accuracy),
    timestamp,
    isOnline:
      Boolean(location.isOnline) ||
      status === "online" ||
      status === "busy",
  }
}

const getDbLocationFromDeliveryman = (deliveryman) => {
  const source = deliveryman?.lastLocation || deliveryman?.fullData?.lastLocation || {}
  const coordinates = Array.isArray(source?.coordinates)
    ? source.coordinates
    : Array.isArray(deliveryman?.lastLocation?.coordinates)
      ? deliveryman.lastLocation.coordinates
      : []
  const lat = toFiniteNumber(
    source?.lat ??
    source?.latitude ??
    deliveryman?.lastLat ??
    deliveryman?.fullData?.lastLat ??
    coordinates[1],
  )
  const lng = toFiniteNumber(
    source?.lng ??
    source?.longitude ??
    deliveryman?.lastLng ??
    deliveryman?.fullData?.lastLng ??
    coordinates[0],
  )
  const timestamp =
    toFiniteNumber(source?.timestamp) ||
    toFiniteNumber(new Date(deliveryman?.lastLocationAt || deliveryman?.fullData?.lastLocationAt || "").getTime())

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return {
    lat,
    lng,
    latitude: lat,
    longitude: lng,
    heading: toFiniteNumber(source?.heading ?? source?.bearing) || 0,
    speed: toFiniteNumber(source?.speed) || 0,
    accuracy: toFiniteNumber(source?.accuracy),
    timestamp,
    isOnline: true,
  }
}

const getFreshestLocation = (liveLocation, dbLocation) => {
  const hasLiveCoordinates = Number.isFinite(liveLocation?.lat) && Number.isFinite(liveLocation?.lng)
  const hasDbCoordinates = Number.isFinite(dbLocation?.lat) && Number.isFinite(dbLocation?.lng)
  if (!hasLiveCoordinates) return hasDbCoordinates ? dbLocation : null
  if (!hasDbCoordinates) return liveLocation

  const liveTimestamp = toFiniteNumber(liveLocation?.timestamp) || 0
  const dbTimestamp = toFiniteNumber(dbLocation?.timestamp) || 0
  return dbTimestamp >= liveTimestamp - 5000 ? dbLocation : liveLocation
}

export default function DeliveryLiveTracking() {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef(new Map())
  // Per busy rider: the arrow to where they are heading and a pin at that place.
  const routesRef = useRef(new Map())
  const infoWindowRef = useRef(null)
  const geocoderRef = useRef(null)

  const [deliverymen, setDeliverymen] = useState([])
  const [activeOrdersByRider, setActiveOrdersByRider] = useState({})
  const [locationsById, setLocationsById] = useState({})
  const [selectedDeliveryId, setSelectedDeliveryId] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [loading, setLoading] = useState(true)
  const [mapLoading, setMapLoading] = useState(true)
  const [mapError, setMapError] = useState("")
  const [listError, setListError] = useState("")
  const [selectedAddress, setSelectedAddress] = useState("")

  const fetchDeliverymen = async () => {
    try {
      setLoading(true)
      setListError("")
      const response = await adminAPI.getDeliveryPartners({
        page: 1,
        limit: 1000,
        status: "approved",
        isActive: true,
      })
      const rows = response?.data?.data?.deliveryPartners || []
      setDeliverymen(Array.isArray(rows) ? rows : [])
    } catch (error) {
      debugError("Failed to load delivery partners:", error)
      setListError(error?.response?.data?.message || "Failed to load delivery partners.")
      setDeliverymen([])
    } finally {
      setLoading(false)
    }
  }

  const fetchActiveOrders = async () => {
    try {
      const response = await adminAPI.getRiderActiveOrders()
      const orders = response?.data?.data?.orders || []
      // A rider normally holds one order; if more, show the one closest to done.
      const byRider = {}
      orders.forEach((order) => {
        const current = byRider[order.riderId]
        if (!current || (order.stage === "to_drop" && current.stage !== "to_drop")) {
          byRider[order.riderId] = order
        }
      })
      setActiveOrdersByRider(byRider)
    } catch (error) {
      debugError("Failed to load rider active orders:", error)
    }
  }

  const refreshAll = () => {
    fetchDeliverymen()
    fetchActiveOrders()
  }

  useEffect(() => {
    refreshAll()
    const timer = setInterval(fetchActiveOrders, ACTIVE_ORDERS_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeAllDeliveryLocations(
      (deliveryNode) => {
        const nextLocations = Object.entries(deliveryNode || {}).reduce((acc, [deliveryId, payload]) => {
          acc[String(deliveryId)] = getLocationFromPayload(payload)
          return acc
        }, {})
        setLocationsById(nextLocations)
      },
      (error) => {
        debugError("Delivery location listener failed:", error)
      },
    )

    return () => {
      if (typeof unsubscribe === "function") unsubscribe()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadMap = async () => {
      try {
        setMapLoading(true)
        setMapError("")

        let apiKey = ""
        try {
          apiKey = await getGoogleMapsApiKey()
        } catch (error) {
          debugError("Failed to read Google Maps API key:", error)
        }

        if (!apiKey && !window.google?.maps) {
          setMapError("Google Maps API key not found. Please set VITE_GOOGLE_MAPS_API_KEY.")
          return
        }

        if (cancelled || !mapContainerRef.current) return

        const google = window.google?.maps
          ? window.google
          : await new Loader({
              apiKey,
              version: "weekly",
              libraries: ["places"],
            }).load()

        if (cancelled || !mapContainerRef.current) return

        mapRef.current = new google.maps.Map(mapContainerRef.current, {
          center: DEFAULT_CENTER,
          zoom: 5,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          gestureHandling: "greedy",
          clickableIcons: false,
        })
        infoWindowRef.current = new google.maps.InfoWindow()
        geocoderRef.current = new google.maps.Geocoder()
        setTimeout(() => {
          if (mapRef.current) google.maps.event.trigger(mapRef.current, "resize")
        }, 100)
      } catch (error) {
        debugError("Failed to load Google Maps:", error)
        setMapError("Failed to load Google Maps. Please verify the API key, billing, and domain restrictions.")
      } finally {
        if (!cancelled) setMapLoading(false)
      }
    }

    loadMap()

    return () => {
      cancelled = true
      markersRef.current.forEach((marker) => marker.setMap(null))
      markersRef.current.clear()
      routesRef.current.forEach(({ line, pin }) => {
        line.setMap(null)
        pin.setMap(null)
      })
      routesRef.current.clear()
      if (mapRef.current) {
        mapRef.current = null
      }
    }
  }, [])

  const deliveryRows = useMemo(() => {
    return deliverymen.map((deliveryman) => {
      const deliveryId = getDeliveryId(deliveryman)
      const liveLocation = locationsById[deliveryId]
      const dbLocation = getDbLocationFromDeliveryman(deliveryman)
      const freshestLocation = getFreshestLocation(liveLocation, dbLocation)
      const hasCoordinates = Number.isFinite(freshestLocation?.lat) && Number.isFinite(freshestLocation?.lng)
      const activeOrder = activeOrdersByRider[deliveryId] || null
      // A rider holding an order is working even if the online flag lagged.
      const isOnline = isDeliveryOnlineFromDb(deliveryman) || Boolean(activeOrder)

      return {
        id: deliveryId,
        name: getDeliveryName(deliveryman),
        phone: getDeliveryPhone(deliveryman),
        zone: deliveryman?.zone?.name || deliveryman?.zoneName || deliveryman?.serviceZone || "N/A",
        isOnline,
        activeOrder,
        status: getRiderStatus(isOnline, activeOrder),
        location: isOnline && hasCoordinates ? freshestLocation : null,
        lastSeen: freshestLocation?.timestamp || deliveryman?.lastLocationAt || null,
      }
    }).filter((deliveryman) => deliveryman.id)
  }, [deliverymen, locationsById, activeOrdersByRider])

  const filteredDeliveryRows = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase()
    return deliveryRows.filter((deliveryman) => {
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "on_order" && Boolean(deliveryman.activeOrder)) ||
        (statusFilter === "vacant" && deliveryman.status === "vacant") ||
        (statusFilter === "offline" && !deliveryman.isOnline)
      const matchesSearch =
        !normalizedSearch ||
        deliveryman.name.toLowerCase().includes(normalizedSearch) ||
        deliveryman.phone.toLowerCase().includes(normalizedSearch)
      return matchesStatus && matchesSearch
    })
  }, [deliveryRows, searchQuery, statusFilter])

  const selectedDeliveryman = useMemo(
    () => deliveryRows.find((deliveryman) => deliveryman.id === selectedDeliveryId) || null,
    [deliveryRows, selectedDeliveryId],
  )

  const onOrderCount = deliveryRows.filter((deliveryman) => deliveryman.activeOrder).length
  const vacantCount = deliveryRows.filter((deliveryman) => deliveryman.status === "vacant").length
  const offlineCount = deliveryRows.filter((deliveryman) => !deliveryman.isOnline).length

  useEffect(() => {
    const google = window.google
    const map = mapRef.current
    if (!google?.maps || !map || mapLoading) return

    const onlineRows = deliveryRows.filter((deliveryman) => deliveryman.isOnline && deliveryman.location)
    const activeIds = new Set(onlineRows.map((deliveryman) => deliveryman.id))

    markersRef.current.forEach((marker, deliveryId) => {
      if (!activeIds.has(deliveryId)) {
        marker.setMap(null)
        markersRef.current.delete(deliveryId)
      }
    })

    onlineRows.forEach((deliveryman) => {
      const position = {
        lat: deliveryman.location.lat,
        lng: deliveryman.location.lng,
      }

      const statusMeta = RIDER_STATUS[deliveryman.status] || RIDER_STATUS.vacant
      const icon = {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: statusMeta.color,
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 3,
        scale: 9,
        // In path units (× scale): puts the name pill just under the dot.
        labelOrigin: new google.maps.Point(0, 3.2),
      }
      const label = {
        text: deliveryman.name,
        color: "#ffffff",
        fontWeight: "700",
        className: "rider-map-label",
      }

      let marker = markersRef.current.get(deliveryman.id)
      if (!marker) {
        marker = new google.maps.Marker({ map, position, zIndex: 10 })
        marker.addListener("click", () => {
          setSelectedDeliveryId(deliveryman.id)
        })
        markersRef.current.set(deliveryman.id, marker)
      }

      marker.setPosition(position)
      marker.setTitle(`${deliveryman.name} · ${statusMeta.label}`)
      marker.setIcon(icon)
      marker.setLabel(label)

      const { activeOrder } = deliveryman
      marker.deliveryInfoContent = `
        <div style="min-width:210px;padding:4px;">
          <div style="font-weight:700;color:#0f172a;margin-bottom:4px;">${escapeHtml(deliveryman.name)}</div>
          <div style="font-size:12px;color:#475569;margin-bottom:4px;">${escapeHtml(deliveryman.phone)}</div>
          <div style="font-size:12px;color:${statusMeta.color};font-weight:700;">${statusMeta.label}</div>
          ${activeOrder ? `
            <div style="font-size:12px;color:#0f172a;margin-top:6px;">Order ${escapeHtml(activeOrder.orderNumber)}</div>
            <div style="font-size:12px;color:#475569;margin-top:2px;">${escapeHtml(describeDestination(activeOrder))}</div>
          ` : ""}
        </div>
      `
    })

    // Arrow from each busy rider to the restaurant (before pickup) or the
    // customer (after pickup), with a pin at that place.
    const routedRows = onlineRows.filter((deliveryman) => hasCoordinates(deliveryman.activeOrder?.destination))
    const routedIds = new Set(routedRows.map((deliveryman) => deliveryman.id))
    routesRef.current.forEach(({ line, pin }, deliveryId) => {
      if (!routedIds.has(deliveryId)) {
        line.setMap(null)
        pin.setMap(null)
        routesRef.current.delete(deliveryId)
      }
    })

    routedRows.forEach((deliveryman) => {
      const { activeOrder } = deliveryman
      const statusMeta = RIDER_STATUS[deliveryman.status] || RIDER_STATUS.vacant
      const from = { lat: deliveryman.location.lat, lng: deliveryman.location.lng }
      const to = { lat: activeOrder.destination.lat, lng: activeOrder.destination.lng }

      let route = routesRef.current.get(deliveryman.id)
      if (!route) {
        route = {
          line: new google.maps.Polyline({ map, geodesic: true, strokeOpacity: 0, zIndex: 5 }),
          pin: new google.maps.Marker({ map, zIndex: 8 }),
        }
        route.pin.addListener("click", () => setSelectedDeliveryId(deliveryman.id))
        routesRef.current.set(deliveryman.id, route)
      }

      // Dashed line drawn with repeated dash symbols, then an arrowhead at the end.
      route.line.setOptions({
        path: [from, to],
        icons: [
          {
            icon: { path: "M 0,-1 0,1", strokeColor: statusMeta.color, strokeOpacity: 0.9, strokeWeight: 3, scale: 3 },
            offset: "0",
            repeat: "14px",
          },
          {
            icon: {
              path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
              fillColor: statusMeta.color,
              fillOpacity: 1,
              strokeColor: statusMeta.color,
              strokeWeight: 1,
              scale: 4,
            },
            offset: "100%",
          },
        ],
      })

      route.pin.setPosition(to)
      route.pin.setTitle(`${deliveryman.name} → ${describeDestination(activeOrder)}`)
      route.pin.setIcon({
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: "#ffffff",
        fillOpacity: 1,
        strokeColor: statusMeta.color,
        strokeWeight: 3,
        scale: 8,
      })
      route.pin.setLabel({
        text: activeOrder.stage === "to_drop" ? "C" : "R",
        color: statusMeta.color,
        fontWeight: "700",
        fontSize: "11px",
      })
    })

  }, [deliveryRows, mapLoading])

  // Camera moves only when the selection changes, so the 30-second order
  // refresh and live location pings don't keep yanking the map back.
  const autoFittedRef = useRef(false)
  const hasAnyLocation = deliveryRows.some((deliveryman) => deliveryman.location)
  useEffect(() => {
    const google = window.google
    const map = mapRef.current
    if (!google?.maps || !map || mapLoading) return

    if (selectedDeliveryman?.isOnline && selectedDeliveryman.location) {
      const destination = selectedDeliveryman.activeOrder?.destination
      if (hasCoordinates(destination)) {
        const bounds = new google.maps.LatLngBounds()
        bounds.extend({ lat: selectedDeliveryman.location.lat, lng: selectedDeliveryman.location.lng })
        bounds.extend({ lat: destination.lat, lng: destination.lng })
        map.fitBounds(bounds, { top: 60, right: 60, bottom: 60, left: 60 })
      } else {
        map.panTo({ lat: selectedDeliveryman.location.lat, lng: selectedDeliveryman.location.lng })
        map.setZoom(Math.max(map.getZoom() || 14, 14))
      }
      return
    }

    if (autoFittedRef.current) return
    const bounds = new google.maps.LatLngBounds()
    let points = 0
    deliveryRows.forEach((deliveryman) => {
      if (!deliveryman.location) return
      bounds.extend({ lat: deliveryman.location.lat, lng: deliveryman.location.lng })
      points += 1
      const destination = deliveryman.activeOrder?.destination
      if (hasCoordinates(destination)) bounds.extend({ lat: destination.lat, lng: destination.lng })
    })
    if (points > 0) {
      map.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 })
      autoFittedRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeliveryId, mapLoading, hasAnyLocation])

  useEffect(() => {
    const map = mapRef.current
    const infoWindow = infoWindowRef.current
    const marker = markersRef.current.get(selectedDeliveryId)

    if (!map || !infoWindow || !selectedDeliveryman?.isOnline || !selectedDeliveryman.location || !marker) {
      return
    }

    infoWindow.setContent(marker.deliveryInfoContent || selectedDeliveryman.name)
    infoWindow.open(map, marker)
  }, [selectedDeliveryId, selectedDeliveryman])

  useEffect(() => {
    let cancelled = false
    setSelectedAddress("")

    if (!selectedDeliveryman?.isOnline || !selectedDeliveryman.location || !geocoderRef.current) return

    const loadAddress = async () => {
      const lat = selectedDeliveryman.location.lat.toFixed(6)
      const lng = selectedDeliveryman.location.lng.toFixed(6)
      try {
        const results = await geocoderRef.current.geocode({
          location: {
            lat: Number(lat),
            lng: Number(lng),
          },
        })
        if (!cancelled) {
          setSelectedAddress(results?.results?.[0]?.formatted_address || `${lat}, ${lng}`)
        }
      } catch (error) {
        debugError("Google reverse geocode failed:", error)
        if (!cancelled) setSelectedAddress(`${lat}, ${lng}`)
      }
    }

    loadAddress()

    return () => {
      cancelled = true
    }
  }, [selectedDeliveryman])

  return (
    <div className="min-h-screen bg-slate-50 p-3 lg:p-4">
      <style>{MARKER_LABEL_CSS}</style>
      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white">
              <Bike className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900">Delivery Live Tracking</h1>
              <p className="text-sm text-slate-600">See who is vacant, who is on an order, and where each rider is heading.</p>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={refreshAll}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh List
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[380px_1fr] lg:items-stretch">
        <section className="flex min-h-[540px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:h-[calc(100vh-214px)]">
          <div className="border-b border-slate-100 p-3">
            <div className="grid grid-cols-4 gap-2">
              <div className="rounded-xl bg-slate-50 p-2.5">
                <p className="text-xs text-slate-500">All</p>
                <p className="text-lg font-bold text-slate-900">{deliveryRows.length}</p>
              </div>
              <div className="rounded-xl bg-blue-50 p-2.5">
                <p className="text-xs text-blue-700">On order</p>
                <p className="text-lg font-bold text-blue-700">{onOrderCount}</p>
              </div>
              <div className="rounded-xl bg-emerald-50 p-2.5">
                <p className="text-xs text-emerald-700">Vacant</p>
                <p className="text-lg font-bold text-emerald-700">{vacantCount}</p>
              </div>
              <div className="rounded-xl bg-slate-100 p-2.5">
                <p className="text-xs text-slate-600">Offline</p>
                <p className="text-lg font-bold text-slate-700">{offlineCount}</p>
              </div>
            </div>

            <div className="mt-3 flex gap-2">
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  onClick={() => setStatusFilter(filter.key)}
                  className={`flex-1 rounded-lg px-2 py-2 text-sm font-semibold transition ${
                    statusFilter === filter.key
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>

            <div className="relative mt-3">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search delivery partner..."
                className="w-full rounded-lg border border-slate-200 py-2.5 pl-10 pr-3 text-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {loading && (
              <div className="flex h-40 items-center justify-center text-sm text-slate-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading delivery partners...
              </div>
            )}

            {!loading && listError && (
              <div className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">{listError}</div>
            )}

            {!loading && !listError && filteredDeliveryRows.length === 0 && (
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-6 text-center text-sm text-slate-500">
                No delivery partners found for this filter.
              </div>
            )}

            {!loading && !listError && filteredDeliveryRows.map((deliveryman) => (
              <button
                key={deliveryman.id}
                type="button"
                onClick={() => setSelectedDeliveryId(deliveryman.id)}
                className={`mb-2.5 w-full rounded-xl border p-3 text-left transition ${
                  selectedDeliveryId === deliveryman.id
                    ? "border-emerald-500 bg-emerald-50 shadow-sm"
                    : "border-slate-100 bg-white hover:border-slate-300 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-slate-900">{deliveryman.name}</h3>
                    <p className="mt-1 text-sm text-slate-500">{deliveryman.phone}</p>
                  </div>
                  <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${
                    RIDER_STATUS[deliveryman.status].badge
                  }`}>
                    {deliveryman.isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                    {RIDER_STATUS[deliveryman.status].label}
                  </span>
                </div>
                {deliveryman.activeOrder && (
                  <div className="mt-2 rounded-lg bg-slate-50 px-2.5 py-2 text-xs">
                    <p className="font-semibold text-slate-800">Order {deliveryman.activeOrder.orderNumber}</p>
                    <p className="mt-0.5 flex items-start gap-1 text-slate-600">
                      <Navigation className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{describeDestination(deliveryman.activeOrder)}</span>
                    </p>
                  </div>
                )}
                <div className="mt-3 flex items-center gap-1 text-xs text-slate-500">
                  <Clock className="h-3.5 w-3.5" />
                  {formatLastSeen(deliveryman.lastSeen)}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="flex min-h-[540px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:h-[calc(100vh-214px)]">
          <div className="border-b border-slate-100 p-3">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Online Delivery Map</h2>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                  {["vacant", "awaiting", "to_pickup", "to_drop"].map((key) => (
                    <span key={key} className="inline-flex items-center gap-1">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: RIDER_STATUS[key].color }} />
                      {RIDER_STATUS[key].label}
                    </span>
                  ))}
                  <span>Arrow → R restaurant / C customer</span>
                </div>
              </div>
              {selectedDeliveryman && (
                <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm">
                  <p className="font-semibold text-slate-900">{selectedDeliveryman.name}</p>
                  <p className="text-slate-500">
                    {selectedDeliveryman.activeOrder
                      ? `${RIDER_STATUS[selectedDeliveryman.status].label} · Order ${selectedDeliveryman.activeOrder.orderNumber}`
                      : selectedDeliveryman.isOnline ? "Vacant" : "Selected partner is offline"}
                  </p>
                  {selectedDeliveryman.activeOrder && (
                    <p className="text-xs text-slate-500">{describeDestination(selectedDeliveryman.activeOrder)}</p>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,4fr)_112px] gap-3 p-3">
            <div className="relative min-h-0 overflow-hidden rounded-xl border border-slate-100 bg-slate-100">
              <div ref={mapContainerRef} className="h-full w-full" />

              {(mapLoading || mapError) && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-100">
                  <div className="p-6 text-center">
                    {mapLoading ? (
                      <>
                        <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-emerald-600" />
                        <p className="text-sm text-slate-600">Loading Google Map...</p>
                      </>
                    ) : (
                      <>
                        <MapPin className="mx-auto mb-3 h-10 w-10 text-slate-400" />
                        <p className="text-sm font-semibold text-slate-700">{mapError}</p>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            <aside className="min-h-0 overflow-hidden rounded-xl border border-slate-100 bg-slate-50 p-2">
              {selectedDeliveryman?.isOnline && selectedDeliveryman.location ? (
                <div className="grid h-full min-h-0 gap-2 md:grid-cols-2">
                  <div className="min-h-0 overflow-hidden rounded-xl bg-white p-3 shadow-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Written Location</p>
                    <p className="mt-1 max-h-[58px] overflow-y-auto pr-1 text-sm font-semibold leading-snug text-slate-900">
                      {selectedAddress || "Finding address..."}
                    </p>
                  </div>
                  <div className="min-h-0 overflow-hidden rounded-xl bg-white p-3 shadow-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Last Updated</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{formatLastSeen(selectedDeliveryman.lastSeen)}</p>
                    <p className="mt-1 truncate text-xs text-slate-500" title={`${selectedDeliveryman.name} · ${selectedDeliveryman.location.lat.toFixed(5)}, ${selectedDeliveryman.location.lng.toFixed(5)}`}>
                      {selectedDeliveryman.name} · {selectedDeliveryman.location.lat.toFixed(5)}, {selectedDeliveryman.location.lng.toFixed(5)}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center rounded-xl bg-white p-5 text-center text-sm text-slate-500 shadow-sm">
                  Select an online delivery partner to view written location and last update.
                </div>
              )}
            </aside>
          </div>
        </section>
      </div>
    </div>
  )
}
