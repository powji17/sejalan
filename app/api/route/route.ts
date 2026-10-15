import { NextRequest, NextResponse } from 'next/server';

/**
 * Route Handler proxy untuk routing engine (OSRM / OpenRouteService).
 * Memenuhi FR-05, FR-07, dan aspek keamanan API key.
 * 
 * ponytail: OSRM demo server used by default; upgrade to self-hosted OSRM or ORS with API key for production SLA.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const startParam = searchParams.get('start'); // format "lng,lat"
  const endParam = searchParams.get('end');     // format "lng,lat"

  if (!startParam || !endParam) {
    return NextResponse.json(
      { error: 'Parameter start dan end (format: lng,lat) wajib diisi.' },
      { status: 400 }
    );
  }

  const [startLngStr, startLatStr] = startParam.split(',');
  const [endLngStr, endLatStr] = endParam.split(',');

  const startLng = parseFloat(startLngStr);
  const startLat = parseFloat(startLatStr);
  const endLng = parseFloat(endLngStr);
  const endLat = parseFloat(endLatStr);

  if (
    isNaN(startLng) || isNaN(startLat) ||
    isNaN(endLng) || isNaN(endLat) ||
    Math.abs(startLat) > 90 || Math.abs(endLat) > 90 ||
    Math.abs(startLng) > 180 || Math.abs(endLng) > 180
  ) {
    return NextResponse.json(
      { error: 'Koordinat tidak valid (harus angka derajat latitude/longitude yang sah).' },
      { status: 400 }
    );
  }

  // Kasus Tepi: A dan B dipilih di titik yang sama atau sangat berdekatan
  const dLat = (startLat - endLat) * 111320;
  const dLng = (startLng - endLng) * (111320 * Math.cos((startLat * Math.PI) / 180));
  const roughDistMeters = Math.sqrt(dLat * dLat + dLng * dLng);

  if (roughDistMeters < 20) {
    return NextResponse.json(
      { error: 'Titik A dan Titik B terlalu berdekatan (kurang dari 20 meter). Silakan pilih titik yang lebih berjauhan.' },
      { status: 400 }
    );
  }

  // Cek apakah ada ORS_API_KEY di environment variable
  const orsApiKey = process.env.ORS_API_KEY;

  if (orsApiKey) {
    try {
      const orsUrl = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${orsApiKey}&start=${startLng},${startLat}&end=${endLng},${endLat}`;
      const res = await fetch(orsUrl, { headers: { Accept: 'application/json, application/geo+json' }, next: { revalidate: 3600 } });
      if (res.ok) {
        const data = await res.json();
        const feature = data.features?.[0];
        if (feature?.geometry?.coordinates) {
          const coords = feature.geometry.coordinates;
          const dist = feature.properties?.segments?.[0]?.distance || feature.properties?.summary?.distance || 0;
          const dur = feature.properties?.segments?.[0]?.duration || feature.properties?.summary?.duration || 0;
          return NextResponse.json({ coordinates: coords, distance: dist, duration: dur });
        }
      }
    } catch (orsErr) {
      console.warn('Gagal memanggil OpenRouteService, mencoba fallback OSRM:', orsErr);
    }
  }

  // Default: Panggil OSRM Demo Server
  try {
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);

    const osrmRes = await fetch(osrmUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SeJalan-WebGIS/1.0',
      },
    });
    clearTimeout(timeoutId);

    if (!osrmRes.ok) {
      return NextResponse.json(
        { error: `Server rute mengembalikan status ${osrmRes.status}. Coba beberapa saat lagi.` },
        { status: osrmRes.status }
      );
    }

    const osrmData = await osrmRes.json();

    if (osrmData.code !== 'Ok' || !osrmData.routes || osrmData.routes.length === 0) {
      return NextResponse.json(
        { error: 'Rute jalan tidak ditemukan. Pastikan kedua titik berada dekat dengan jaringan jalan raya.' },
        { status: 422 }
      );
    }

    const route = osrmData.routes[0];
    return NextResponse.json({
      coordinates: route.geometry.coordinates, // [[lng, lat], ...]
      distance: route.distance, // meter
      duration: route.duration, // detik
    });
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError';
    return NextResponse.json(
      {
        error: isTimeout
          ? 'Koneksi ke server routing time out (melebihi 9 detik). Silakan coba lagi.'
          : 'Layanan routing tidak merespons. Periksa koneksi internet Anda atau coba sesaat lagi.',
      },
      { status: 504 }
    );
  }
}
