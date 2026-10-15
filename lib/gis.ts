import * as turf from '@turf/turf';

export interface PointCoord {
  lat: number;
  lng: number;
}

export interface RouteData {
  coordinates: [number, number][]; // [lng, lat] format from GeoJSON
  distanceMeters: number;
}

export type PassengerStatus = 'gray' | 'green' | 'red';

export interface Passenger {
  id: string;
  lat: number;
  lng: number;
  status: PassengerStatus;
  distanceToReturnMeters?: number;
  routeLocationMeters?: number; // Jarak proyeksi dari awal rute pulang (titik B)
  isPassed?: boolean;           // True jika sudah dilewati oleh taksi pada rute pulang
}

/**
 * ponytail: pointToLineDistance treats Earth as a sphere; fine for urban taxi radii (<50km).
 * Upgrade to geodesic / ellipsoid projection if sub-meter continental accuracy is needed.
 */
export function classifyPassenger(
  passenger: { lat: number; lng: number },
  returnRouteCoords: [number, number][] | null,
  radiusMeters: number,
  taxiReturnProgressMeters: number = 0
): {
  status: PassengerStatus;
  distanceMeters?: number;
  routeLocationMeters?: number;
  isPassed?: boolean;
} {
  if (!returnRouteCoords || returnRouteCoords.length < 2) {
    return { status: 'gray' };
  }

  const pt = turf.point([passenger.lng, passenger.lat]);
  const line = turf.lineString(returnRouteCoords);
  const snapped = turf.nearestPointOnLine(line, pt, { units: 'meters' });
  const roundedDist = Math.round(snapped.properties.dist ?? 0);
  const routeLocation = Math.round(snapped.properties.location ?? 0);

  // Titik dianggap sudah dilewati jika taksi berada pada rute pulang dan jarak tempuhnya >= posisi proyeksi titik
  const isPassed = taxiReturnProgressMeters > 0 && routeLocation <= taxiReturnProgressMeters;

  // FR-09 & Aturan Terlewat:
  // Jika sudah dilewati taksi pada rute pulang, tidak bisa memesan lagi -> MERAH
  // Jika belum dilewati: hijau jika jarak <= radius, merah jika > radius
  const status: PassengerStatus = isPassed
    ? 'red'
    : roundedDist <= radiusMeters
    ? 'green'
    : 'red';

  return {
    status,
    distanceMeters: roundedDist,
    routeLocationMeters: routeLocation,
    isPassed,
  };
}

/**
 * ponytail: simplified buffer returns GeoJSON polygon. Upgrade to multi-resolution simplify for 100km+ routes.
 */
export function createReturnBuffer(
  returnRouteCoords: [number, number][],
  radiusMeters: number
): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null {
  if (!returnRouteCoords || returnRouteCoords.length < 2 || radiusMeters <= 0) {
    return null;
  }

  try {
    const line = turf.lineString(returnRouteCoords);
    const buffered = turf.buffer(line, radiusMeters / 1000, { units: 'kilometers' });
    return buffered as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
  } catch (err) {
    console.error('Gagal membuat buffer polygon:', err);
    return null;
  }
}

/**
 * Durasi perjalanan sesuai FR-15: durasi = (jarak_km / kecepatan_kmh) * 60 menit.
 */
export function calculateDurationMinutes(distanceMeters: number, speedKmh: number): number {
  if (speedKmh <= 0) return 0;
  const distanceKm = distanceMeters / 1000;
  return (distanceKm / speedKmh) * 60;
}

/**
 * Interpolasi posisi dan sudut hadap (bearing) taksi di sepanjang polyline rute.
 */
export function interpolateRoutePosition(
  coordinates: [number, number][],
  fraction: number
): { lat: number; lng: number; bearing: number } {
  const clampedFraction = Math.max(0, Math.min(1, fraction));
  const line = turf.lineString(coordinates);
  const totalLength = turf.length(line, { units: 'kilometers' });

  if (totalLength <= 0) {
    const [lng, lat] = coordinates[0];
    return { lat, lng, bearing: 0 };
  }

  const targetDist = totalLength * clampedFraction;
  const currPoint = turf.along(line, targetDist, { units: 'kilometers' });
  const [currLng, currLat] = currPoint.geometry.coordinates;

  // Cari titik sedikit di depannya untuk menghitung bearing/arah kendaraan
  const lookAheadDist = Math.min(totalLength, targetDist + 0.05); // 50 meter ke depan
  const nextPoint = turf.along(line, lookAheadDist, { units: 'kilometers' });
  const [nextLng, nextLat] = nextPoint.geometry.coordinates;

  let bearing = 0;
  if (currLng !== nextLng || currLat !== nextLat) {
    bearing = turf.bearing(currPoint, nextPoint);
  }

  return {
    lat: currLat,
    lng: currLng,
    bearing: (bearing + 360) % 360,
  };
}
