import { config } from '../../../../config/env.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Fetches driving route metrics from the Google Routes API.
 * Call sparingly (e.g. once per order) — billed per request.
 * @param {Object} origin - { lat, lng }
 * @param {Object} destination - { lat, lng }
 * @returns {Promise<{ polyline: string, distanceMeters: number|null, durationSeconds: number|null, distanceKm: number|null }>}
 */

/* ── Encoded-polyline codec (Google's algorithm) ──────────────────────────────
   Kept inline rather than adding a dependency; it is ~30 lines and stable.      */

/** Decode an encoded polyline into [[lat, lng], ...]. */
export function decodePolyline(encoded) {
  const str = String(encoded || '');
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

const encodeSigned = (value) => {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
};

/** Encode [[lat, lng], ...] back into an encoded polyline. */
export function encodePolyline(points) {
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  for (const [lat, lng] of points) {
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    out += encodeSigned(iLat - lastLat) + encodeSigned(iLng - lastLng);
    lastLat = iLat;
    lastLng = iLng;
  }
  return out;
}

/**
 * Stitch every step's polyline into one full-detail route.
 * Consecutive steps share an endpoint, so the duplicate is dropped at each join.
 * Returns '' when there are no usable steps, so the caller can fall back.
 */
export function buildDetailedPolyline(legs = []) {
  const points = [];
  for (const leg of legs) {
    for (const step of leg?.steps || []) {
      const encoded = step?.polyline?.points;
      if (!encoded) continue;
      const decoded = decodePolyline(encoded);
      if (decoded.length === 0) continue;
      const last = points[points.length - 1];
      const start = last && last[0] === decoded[0][0] && last[1] === decoded[0][1] ? 1 : 0;
      for (let i = start; i < decoded.length; i += 1) points.push(decoded[i]);
    }
  }
  return points.length >= 2 ? encodePolyline(points) : '';
}

export async function fetchDrivingRoute(origin, destination) {
  const empty = {
    polyline: '',
    distanceMeters: null,
    durationSeconds: null,
    distanceKm: null,
  };

  const apiKey = config.googleMapsApiKey;
  if (!apiKey) {
    logger.warn('Google Maps API key missing. Driving route fetch skipped.');
    return empty;
  }

  if (
    !origin ||
    !destination ||
    !Number.isFinite(Number(origin.lat)) ||
    !Number.isFinite(Number(origin.lng)) ||
    !Number.isFinite(Number(destination.lat)) ||
    !Number.isFinite(Number(destination.lng))
  ) {
    return empty;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const waypoint = ({ lat, lng }) => ({
      location: { latLng: { latitude: Number(lat), longitude: Number(lng) } },
    });

    // The Routes API. The older Directions API is a legacy product Google does
    // not enable on current projects: it answered REQUEST_DENIED, and every
    // delivery fee silently fell back to straight-line distance.
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: waypoint(origin),
        destination: waypoint(destination),
        travelMode: 'DRIVE',
        // Road-following detail: the simplified line visibly cuts corners on a
        // street-level tracking map.
        polylineQuality: 'HIGH_QUALITY',
      }),
    });
    clearTimeout(timeout);
    const data = await res.json();

    const route = data.routes?.[0];
    if (res.ok && route) {
      const distanceMeters = Number(route.distanceMeters) || 0;
      // A protobuf duration: "654s".
      const durationSeconds = Number.parseInt(route.duration, 10) || 0;

      return {
        polyline: route.polyline?.encodedPolyline || '',
        distanceMeters: distanceMeters > 0 ? distanceMeters : null,
        durationSeconds: durationSeconds > 0 ? durationSeconds : null,
        distanceKm:
          distanceMeters > 0 ? Number((distanceMeters / 1000).toFixed(2)) : null,
      };
    }

    logger.warn(
      `Google Routes API returned status: ${res.status}. Message: ${data.error?.message || 'No routes found'}`,
    );
  } catch (err) {
    logger.error(`Error fetching driving route from Google: ${err.message}`);
  }

  return empty;
}

/**
 * Fetches an encoded polyline from the Google Routes API.
 * This should be called ONLY ONCE per order assignment to save costs.
 * @param {Object} origin - { lat, lng }
 * @param {Object} destination - { lat, lng }
 * @returns {Promise<string>} - Encoded polyline points
 */
export async function fetchPolyline(origin, destination) {
  const { polyline } = await fetchDrivingRoute(origin, destination);
  return polyline;
}
