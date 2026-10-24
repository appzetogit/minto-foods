import { config } from '../../../../config/env.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Fetches driving route metrics from the Google Routes API.
 * Call sparingly (e.g. once per order) — billed per request.
 * @param {Object} origin - { lat, lng }
 * @param {Object} destination - { lat, lng }
 * @returns {Promise<{ polyline: string, distanceMeters: number|null, durationSeconds: number|null, distanceKm: number|null }>}
 */
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
    // Routes API, not the legacy Directions API: the production key's project
    // has the legacy Maps APIs switched off (REQUEST_DENIED "legacy API").
    // Its polyline already follows the road at full detail.
    const latLng = (p) => ({ location: { latLng: { latitude: Number(p.lat), longitude: Number(p.lng) } } });
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: latLng(origin),
        destination: latLng(destination),
        travelMode: 'DRIVE',
        polylineQuality: 'HIGH_QUALITY',
      }),
    });
    clearTimeout(timeout);
    const data = await res.json();

    const route = data.routes?.[0];
    if (res.ok && route) {
      const distanceMeters = Number(route.distanceMeters) || 0;
      // "946s"
      const durationSeconds = parseInt(String(route.duration || '0'), 10) || 0;
      return {
        polyline: route.polyline?.encodedPolyline || '',
        distanceMeters: distanceMeters > 0 ? distanceMeters : null,
        durationSeconds: durationSeconds > 0 ? durationSeconds : null,
        distanceKm:
          distanceMeters > 0 ? Number((distanceMeters / 1000).toFixed(2)) : null,
      };
    }

    logger.warn(
      `Google Routes API returned ${res.status}. Message: ${data.error?.message || 'No routes found'}`,
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
