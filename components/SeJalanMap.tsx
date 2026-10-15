'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import {
  classifyPassenger,
  createReturnBuffer,
  calculateDurationMinutes,
  interpolateRoutePosition,
  Passenger,
  PassengerStatus,
  PointCoord,
} from '../lib/gis';

// Preset Koordinat Demo (Pontianak: Bandara Supadio & RSUD Dr. Soedarso)
const PRESET_SCENARIO = {
  pointA: { lat: -0.1507, lng: 109.4036 }, // Bandara Supadio (Mangkal)
  pointB: { lat: -0.0543, lng: 109.3512 }, // RSUD Dr. Soedarso (Tujuan Antar)
  passengers: [
    { lat: -0.0585, lng: 109.3520 }, // Sangat dekat rute (~150m) -> Hijau
    { lat: -0.0632, lng: 109.3475 }, // Jarak sedang (~350m) -> Hijau @ 500m
    { lat: -0.0820, lng: 109.3780 }, // Jarak ~780m -> Merah @ 500m, Hijau @ 1000m
    { lat: -0.0180, lng: 109.3450 }, // Jauh (~4.2 km) -> Merah
  ],
};

// Durasi animasi demo di layar (detik)
const DEMO_ANIM_DURATION_SEC = 16;

export default function SeJalanMap() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);

  // Layer groups Leaflet
  const layersRef = useRef<{
    markers: L.LayerGroup | null;
    routes: L.LayerGroup | null;
    buffer: L.LayerGroup | null;
    passengers: L.LayerGroup | null;
    taxi: L.LayerGroup | null;
  }>({
    markers: null,
    routes: null,
    buffer: null,
    passengers: null,
    taxi: null,
  });

  const taxiMarkerRef = useRef<L.Marker | null>(null);
  const animFrameIdRef = useRef<number | null>(null);
  const elapsedMsRef = useRef<number>(0);
  const animDurationRef = useRef<{ go: number; ret: number }>({ go: 0, ret: 0 });
  // Jarak yang sudah ditempuh taksi di rute pulang (meter)
  const taxiReturnDistRef = useRef<number>(0);

  // State Aplikasi
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [activeMode, setActiveMode] = useState<'setA' | 'setB' | 'addPassenger' | 'neutral'>('setA');
  const [pointA, setPointA] = useState<PointCoord | null>(null);
  const [pointB, setPointB] = useState<PointCoord | null>(null);

  const [routeGo, setRouteGo] = useState<{
    coordinates: [number, number][];
    distanceMeters: number;
    durationSeconds: number;
  } | null>(null);

  const [routeReturn, setRouteReturn] = useState<{
    coordinates: [number, number][];
    distanceMeters: number;
    durationSeconds: number;
  } | null>(null);

  const [passengers, setPassengers] = useState<Passenger[]>([]);
  const [radius, setRadius] = useState<number>(500);
  const [radiusInput, setRadiusInput] = useState<string>('500');
  const [speed, setSpeed] = useState<number>(40);
  const [speedInput, setSpeedInput] = useState<string>('40');
  const [showBuffer, setShowBuffer] = useState<boolean>(true);
  const [showLegend, setShowLegend] = useState<boolean>(true);

  // Status Taksi & Animasi
  const [taxiPhase, setTaxiPhase] = useState<'idle' | 'phase1' | 'phase2' | 'phase3'>('idle');
  const [taxiProgress, setTaxiProgress] = useState<number>(0);
  const [isLoadingRoute, setIsLoadingRoute] = useState<boolean>(false);
  const [alert, setAlert] = useState<{ type: 'error' | 'warning' | 'info'; message: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);

  // Ref untuk akses langsung state di dalam event listener / animasi
  const stateRef = useRef({
    activeMode,
    pointA,
    pointB,
    routeGo,
    routeReturn,
    radius,
    speed,
    passengers,
  });

  useEffect(() => {
    stateRef.current = {
      activeMode,
      pointA,
      pointB,
      routeGo,
      routeReturn,
      radius,
      speed,
      passengers,
    };
  }, [activeMode, pointA, pointB, routeGo, routeReturn, radius, speed, passengers]);

  // Inisialisasi Peta Leaflet
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [-0.07, 109.37],
      zoom: 12,
      zoomControl: false,
    });

    // Basemap OpenStreetMap
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap kontributor | SeJalan',
    }).addTo(map);

    // Zoom control di pojok kanan atas
    L.control.zoom({ position: 'topright' }).addTo(map);

    // Layer groups
    const bufferGroup = L.layerGroup().addTo(map);
    const routesGroup = L.layerGroup().addTo(map);
    const passengersGroup = L.layerGroup().addTo(map);
    const markersGroup = L.layerGroup().addTo(map);
    const taxiGroup = L.layerGroup().addTo(map);

    layersRef.current = {
      markers: markersGroup,
      routes: routesGroup,
      buffer: bufferGroup,
      passengers: passengersGroup,
      taxi: taxiGroup,
    };

    mapInstanceRef.current = map;

    // Event Klik Peta
    map.on('click', (e: L.LeafletMouseEvent) => {
      const mode = stateRef.current.activeMode;
      // Mode netral: abaikan klik peta (tidak menaruh atau mengubah titik apapun)
      if (mode === 'neutral') return;

      const clickedLat = e.latlng.lat;
      const clickedLng = e.latlng.lng;

      if (mode === 'setA') {
        setPointA({ lat: clickedLat, lng: clickedLng });
        // Jika B belum ada, otomatis beralih ke mode setB agar alur mulus
        if (!stateRef.current.pointB) {
          setActiveMode('setB');
        }
      } else if (mode === 'setB') {
        setPointB({ lat: clickedLat, lng: clickedLng });
        if (stateRef.current.pointA) {
          setActiveMode('addPassenger');
        }
      } else if (mode === 'addPassenger') {
        const newPassengerId = `p-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const classification = classifyPassenger(
          { lat: clickedLat, lng: clickedLng },
          stateRef.current.routeReturn?.coordinates || null,
          stateRef.current.radius,
          taxiReturnDistRef.current
        );

        const newP: Passenger = {
          id: newPassengerId,
          lat: clickedLat,
          lng: clickedLng,
          status: classification.status,
          distanceToReturnMeters: classification.distanceMeters,
          routeLocationMeters: classification.routeLocationMeters,
          isPassed: classification.isPassed,
        };

        setPassengers((prev) => [...prev, newP]);
      }
    });

    return () => {
      if (animFrameIdRef.current) cancelAnimationFrame(animFrameIdRef.current);
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Update Kursor Peta berdasarkan Mode Aktif (Crosshair saat input aktif, Grab saat netral)
  useEffect(() => {
    if (!mapContainerRef.current) return;
    if (activeMode === 'neutral') {
      mapContainerRef.current.style.cursor = '';
      if (mapInstanceRef.current) {
        mapInstanceRef.current.getContainer().classList.remove('leaflet-crosshair-mode');
      }
    } else {
      mapContainerRef.current.style.cursor = 'crosshair';
      if (mapInstanceRef.current) {
        mapInstanceRef.current.getContainer().classList.add('leaflet-crosshair-mode');
      }
    }
  }, [activeMode]);

  // Hapus Penumpang Tunggal (FR-04)
  const handleRemovePassenger = useCallback((id: string) => {
    setPassengers((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // Render Marker Titik A & B
  useEffect(() => {
    const markersGroup = layersRef.current.markers;
    if (!markersGroup) return;

    markersGroup.clearLayers();

    if (pointA) {
      const iconA = L.divIcon({
        className: 'custom-pin-wrap',
        html: `
          <div class="custom-pin-a" title="Titik A (Tempat Mangkal)">
            <div class="custom-pin-content" style="font-weight:800; font-size:13px;">A</div>
          </div>
        `,
        iconSize: [34, 34],
        iconAnchor: [17, 34],
      });
      L.marker([pointA.lat, pointA.lng], { icon: iconA })
        .bindTooltip('<b>Titik A (Mangkal)</b><br>Tujuan akhir rute pulang', { direction: 'top' })
        .addTo(markersGroup);
    }

    if (pointB) {
      const iconB = L.divIcon({
        className: 'custom-pin-wrap',
        html: `
          <div class="custom-pin-b" title="Titik B (Tujuan Antar Pertama)">
            <div class="custom-pin-content">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                <line x1="4" y1="22" x2="4" y2="15"/>
              </svg>
            </div>
          </div>
        `,
        iconSize: [34, 34],
        iconAnchor: [17, 34],
      });
      L.marker([pointB.lat, pointB.lng], { icon: iconB })
        .bindTooltip('<b>Titik B (Tujuan Antar)</b><br>Awal mula rute pulang taksi', { direction: 'top' })
        .addTo(markersGroup);
    }
  }, [pointA, pointB]);

  // Permintaan Rute (OSRM proxy via Route Handler) saat A & B siap
  const fetchRoutes = useCallback(async (start: PointCoord, end: PointCoord) => {
    setIsLoadingRoute(true);
    setAlert(null);

    // Hentikan animasi berjalan
    if (animFrameIdRef.current) {
      cancelAnimationFrame(animFrameIdRef.current);
      animFrameIdRef.current = null;
    }
    setTaxiPhase('idle');
    setTaxiProgress(0);

    try {
      // 1. Rute Pergi: A ke B
      const goUrl = `/api/route?start=${start.lng},${start.lat}&end=${end.lng},${end.lat}`;
      const goRes = await fetch(goUrl);
      const goData = await goRes.json();

      if (!goRes.ok) {
        throw new Error(goData.error || 'Gagal menghitung rute pergi (A ke B).');
      }

      // 2. Rute Pulang: B ke A
      const retUrl = `/api/route?start=${end.lng},${end.lat}&end=${start.lng},${start.lat}`;
      const retRes = await fetch(retUrl);
      const retData = await retRes.json();

      if (!retRes.ok) {
        throw new Error(retData.error || 'Gagal menghitung rute pulang (B ke A).');
      }

      const newRouteGo = {
        coordinates: goData.coordinates as [number, number][],
        distanceMeters: goData.distance as number,
        durationSeconds: goData.duration as number,
      };

      const newRouteReturn = {
        coordinates: retData.coordinates as [number, number][],
        distanceMeters: retData.distance as number,
        durationSeconds: retData.duration as number,
      };

      setRouteGo(newRouteGo);
      setRouteReturn(newRouteReturn);

      // Fit peta untuk mencakup seluruh rute
      if (mapInstanceRef.current && newRouteGo.coordinates.length > 0) {
        const bounds = L.latLngBounds(
          newRouteGo.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])
        );
        mapInstanceRef.current.fitBounds(bounds, { padding: [60, 60] });
      }

      // Re-klasifikasi semua calon penumpang yang sudah ada (FR-11, FR-12)
      setPassengers((prev) =>
        prev.map((p) => {
          const res = classifyPassenger(
            { lat: p.lat, lng: p.lng },
            newRouteReturn.coordinates,
            stateRef.current.radius,
            0
          );
          return {
            ...p,
            status: res.status,
            distanceToReturnMeters: res.distanceMeters,
            routeLocationMeters: res.routeLocationMeters,
            isPassed: res.isPassed,
          };
        })
      );
    } catch (err: any) {
      console.error('Error saat membuat rute:', err);
      setAlert({
        type: 'error',
        message: err.message || 'Layanan routing gagal merespons. Silakan coba kembali.',
      });
      setRouteGo(null);
      setRouteReturn(null);
    } finally {
      setIsLoadingRoute(false);
    }
  }, []);

  // Picu pembuatan rute otomatis jika A atau B berubah
  useEffect(() => {
    if (pointA && pointB) {
      fetchRoutes(pointA, pointB);
    }
  }, [pointA, pointB, fetchRoutes]);

  // Gambar Garis Rute (Pergi & Pulang dengan gaya berbeda per FR-06)
  useEffect(() => {
    const routesGroup = layersRef.current.routes;
    if (!routesGroup) return;

    routesGroup.clearLayers();

    // Rute Pergi: Garis putus-putus biru / abu-abu (FR-06)
    if (routeGo && routeGo.coordinates.length > 0) {
      const latLngs = routeGo.coordinates.map(([lng, lat]) => [lat, lng] as [number, number]);
      L.polyline(latLngs, {
        color: '#3b82f6',
        weight: 4,
        opacity: 0.85,
        dashArray: '8, 8',
      })
        .bindTooltip('<b>Rute Pergi (A &rarr; B)</b>', { sticky: true })
        .addTo(routesGroup);
    }

    // Rute Pulang: Garis tebal ungu (FR-06)
    if (routeReturn && routeReturn.coordinates.length > 0) {
      const latLngs = routeReturn.coordinates.map(([lng, lat]) => [lat, lng] as [number, number]);
      L.polyline(latLngs, {
        color: '#7c3aed',
        weight: 6,
        opacity: 0.95,
      })
        .bindTooltip('<b>Rute Pulang (B &rarr; A)</b><br>Acuan utama penjemputan', { sticky: true })
        .addTo(routesGroup);
    }
  }, [routeGo, routeReturn]);

  // Render Koridor Buffer Poligon (FR-10)
  useEffect(() => {
    const bufferGroup = layersRef.current.buffer;
    if (!bufferGroup) return;

    bufferGroup.clearLayers();

    if (showBuffer && routeReturn && routeReturn.coordinates.length > 0 && radius > 0) {
      const bufferGeoJson = createReturnBuffer(routeReturn.coordinates, radius);
      if (bufferGeoJson) {
        L.geoJSON(bufferGeoJson, {
          style: {
            color: '#059669',
            weight: 1.5,
            dashArray: '5, 5',
            fillColor: '#10b981',
            fillOpacity: 0.16,
          },
        })
          .bindTooltip(`<b>Koridor Buffer Pulang</b><br>Radius: ${radius} meter`, { sticky: true })
          .addTo(bufferGroup);
      }
    }
  }, [routeReturn, radius, showBuffer]);

  // Render & Perbarui Titik Calon Penumpang (FR-08, FR-09, FR-04)
  useEffect(() => {
    const passengersGroup = layersRef.current.passengers;
    if (!passengersGroup) return;

    passengersGroup.clearLayers();

    passengers.forEach((p, idx) => {
      // Simbol aksesibilitas: SVG Centang untuk hijau, Silang untuk merah, Info untuk abu-abu
      const symbolSvg =
        p.status === 'green'
          ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
          : p.status === 'red'
          ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
          : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

      const labelText =
        p.isPassed
          ? 'Tidak Bisa Memesan (Sudah Dilewati Taksi)'
          : p.status === 'green'
          ? 'Bisa Memesan (Terjangkau)'
          : p.status === 'red'
          ? 'Tidak Bisa Memesan (Di Luar Radius)'
          : 'Belum Dihitung (Menunggu Rute Pulang)';

      const markerHtml = `
        <div class="passenger-marker-icon ${p.status}" title="Penumpang #${idx + 1} (${p.status}${p.isPassed ? ' - Terlewat' : ''})">
          ${symbolSvg}
        </div>
      `;

      const pIcon = L.divIcon({
        className: 'custom-passenger-wrap',
        html: markerHtml,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const distText =
        p.distanceToReturnMeters !== undefined
          ? `${p.distanceToReturnMeters} meter`
          : 'Belum tersedia';

      const popupContent = document.createElement('div');
      popupContent.style.minWidth = '180px';
      popupContent.innerHTML = `
        <div style="font-weight:700; font-size:13px; margin-bottom:4px;">Calon Penumpang #${idx + 1}</div>
        <div style="font-size:11px; margin-bottom:2px; color:#475569;">
          Status: <b style="color:${p.status === 'green' ? '#047857' : p.status === 'red' ? '#b91c1c' : '#64748b'}">${labelText}</b>
        </div>
        <div style="font-size:11px; margin-bottom:8px; color:#475569;">
          Jarak ke Rute Pulang: <b>${distText}</b><br>
          Batas Radius: <b>${radius} meter</b>
        </div>
      `;

      const deleteBtn = document.createElement('button');
      deleteBtn.innerText = '🗑️ Hapus Titik Ini';
      deleteBtn.className = 'btn-danger';
      deleteBtn.style.padding = '4px 8px';
      deleteBtn.style.fontSize = '10px';
      deleteBtn.onclick = () => {
        handleRemovePassenger(p.id);
      };
      popupContent.appendChild(deleteBtn);

      L.marker([p.lat, p.lng], { icon: pIcon })
        .bindPopup(popupContent)
        .addTo(passengersGroup);
    });
  }, [passengers, radius, handleRemovePassenger]);

  // Perubahan Radius: Otomatis Re-Klasifikasi Semua Titik (FR-03, FR-08, FR-09)
  const handleRadiusChange = (newRadius: number) => {
    setRadius(newRadius);
    setRadiusInput(String(newRadius));

    if (newRadius > 50000) {
      setAlert({
        type: 'warning',
        message: 'Radius sangat besar (>50 km). Pembuatan visual buffer poligon dapat memakan waktu.',
      });
    } else {
      if (alert?.type === 'warning') setAlert(null);
    }

    // Re-klasifikasi seketika (titik yang sudah dilewati taksi tetap merah)
    if (routeReturn && routeReturn.coordinates.length > 0) {
      setPassengers((prev) =>
        prev.map((p) => {
          const res = classifyPassenger(
            { lat: p.lat, lng: p.lng },
            routeReturn.coordinates,
            newRadius,
            taxiReturnDistRef.current
          );
          return {
            ...p,
            status: res.status,
            distanceToReturnMeters: res.distanceMeters,
            routeLocationMeters: res.routeLocationMeters,
            isPassed: res.isPassed,
          };
        })
      );
    }
  };

  // Validasi Input Radius
  const handleRadiusInputChange = (val: string) => {
    setRadiusInput(val);
    const parsed = parseFloat(val);
    if (!isNaN(parsed) && parsed > 0) {
      handleRadiusChange(parsed);
    }
  };

  // Perubahan Kecepatan: Hitung ulang durasi & mulai animasi dari awal (FR-17)
  const handleSpeedChange = (newSpeed: number) => {
    setSpeed(newSpeed);
    setSpeedInput(String(newSpeed));
  };

  const handleSpeedInputChange = (val: string) => {
    setSpeedInput(val);
    const parsed = parseFloat(val);
    if (!isNaN(parsed) && parsed > 0) {
      handleSpeedChange(parsed);
    }
  };

  // Helper: posisikan taksi dan update state berdasarkan elapsed ms
  const applyAnimFrame = useCallback(
    (elapsed: number, goMs: number, retMs: number) => {
      if (!routeGo || !routeReturn || !taxiMarkerRef.current) return;
      const totalMs = goMs + retMs;

      if (elapsed < goMs) {
        // FASE 1: Menuju B (Rute Pergi)
        taxiReturnDistRef.current = 0;
        const fraction = elapsed / goMs;
        const pos = interpolateRoutePosition(routeGo.coordinates, fraction);
        taxiMarkerRef.current.setLatLng([pos.lat, pos.lng]);
        const elem = document.getElementById('taxi-marker-element');
        if (elem) elem.style.transform = `rotate(${pos.bearing}deg)`;
        setTaxiPhase('phase1');
        setTaxiProgress(fraction * 0.5);
      } else if (elapsed < totalMs) {
        // FASE 2: Kembali ke A (Rute Pulang)
        const fraction = (elapsed - goMs) / retMs;
        const currentReturnDist = fraction * routeReturn.distanceMeters;
        taxiReturnDistRef.current = currentReturnDist;

        const pos = interpolateRoutePosition(routeReturn.coordinates, fraction);
        taxiMarkerRef.current.setLatLng([pos.lat, pos.lng]);
        const elem = document.getElementById('taxi-marker-element');
        if (elem) elem.style.transform = `rotate(${pos.bearing}deg)`;
        setTaxiPhase('phase2');
        setTaxiProgress(0.5 + fraction * 0.5);

        // Periksa apakah ada titik calon penumpang yang baru saja dilewati taksi
        const curList = stateRef.current.passengers;
        let hasChange = false;
        const updatedList = curList.map((p) => {
          if (
            p.status === 'green' &&
            p.routeLocationMeters !== undefined &&
            p.routeLocationMeters <= currentReturnDist
          ) {
            hasChange = true;
            return { ...p, status: 'red' as PassengerStatus, isPassed: true };
          }
          return p;
        });

        if (hasChange) {
          setPassengers(updatedList);
        }
      } else {
        // FASE 3: Tiba di A (Selesai)
        taxiReturnDistRef.current = routeReturn.distanceMeters;
        const last = routeReturn.coordinates[routeReturn.coordinates.length - 1];
        taxiMarkerRef.current.setLatLng([last[1], last[0]]);
        setTaxiPhase('phase3');
        setTaxiProgress(1);
        setIsPlaying(false);

        // Pastikan semua titik calon penumpang yang tadinya hijau ditandai terlewat (merah)
        const curList = stateRef.current.passengers;
        let hasChange = false;
        const updatedList = curList.map((p) => {
          if (p.status === 'green') {
            hasChange = true;
            return { ...p, status: 'red' as PassengerStatus, isPassed: true };
          }
          return p;
        });

        if (hasChange) {
          setPassengers(updatedList);
        }
      }
    },
    [routeGo, routeReturn]
  );

  // Setup marker taksi & hitung durasi animasi saat rute berubah
  useEffect(() => {
    const taxiGroup = layersRef.current.taxi;
    if (!taxiGroup || !routeGo || !routeReturn) return;

    if (animFrameIdRef.current) {
      cancelAnimationFrame(animFrameIdRef.current);
      animFrameIdRef.current = null;
    }
    taxiGroup.clearLayers();

    const taxiIcon = L.divIcon({
      className: 'custom-taxi-wrap',
      html: `
        <div id="taxi-marker-element" class="taxi-marker-icon" title="Taksi SeJalan">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            <ellipse cx="18" cy="19" rx="12" ry="14" fill="rgba(0,0,0,0.22)"/>
            <rect x="6" y="8" width="2.5" height="5" rx="1.2" fill="#0f172a"/>
            <rect x="27.5" y="8" width="2.5" height="5" rx="1.2" fill="#0f172a"/>
            <rect x="6" y="23" width="2.5" height="5" rx="1.2" fill="#0f172a"/>
            <rect x="27.5" y="23" width="2.5" height="5" rx="1.2" fill="#0f172a"/>
            <rect x="8" y="5" width="20" height="26" rx="5" fill="#facc15" stroke="#1e293b" stroke-width="1.8"/>
            <path d="M11 11C11 9 13 8 18 8C23 8 25 9 25 11L24 14H12L11 11Z" fill="#1e293b"/>
            <path d="M12 24C12 26 14 27 18 27C22 27 24 26 24 24L23.5 22H12.5L12 24Z" fill="#1e293b"/>
            <rect x="13.5" y="16.5" width="9" height="3.5" rx="1" fill="#ffffff" stroke="#1e293b" stroke-width="0.8"/>
            <text x="18" y="19.1" font-size="2.4" font-weight="900" text-anchor="middle" fill="#1e293b" font-family="sans-serif">TAXI</text>
            <rect x="9.5" y="4.5" width="3" height="1.5" rx="0.75" fill="#ffffff"/>
            <rect x="23.5" y="4.5" width="3" height="1.5" rx="0.75" fill="#ffffff"/>
            <path d="M18 2L20.5 5.5H15.5L18 2Z" fill="#ef4444"/>
          </svg>
        </div>
      `,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });

    const [startLng, startLat] = routeGo.coordinates[0];
    const taxiMarker = L.marker([startLat, startLng], { icon: taxiIcon, zIndexOffset: 1000 }).addTo(taxiGroup);
    taxiMarkerRef.current = taxiMarker;

    const totalDistAll = routeGo.distanceMeters + routeReturn.distanceMeters;
    if (totalDistAll <= 0) return;

    const animMs = DEMO_ANIM_DURATION_SEC * 1000;
    const goMs = animMs * (routeGo.distanceMeters / totalDistAll);
    const retMs = animMs * (routeReturn.distanceMeters / totalDistAll);
    animDurationRef.current = { go: goMs, ret: retMs };

    // Reset progress ke awal, posisikan taksi di titik awal, siap menunggu Play
    elapsedMsRef.current = 0;
    setTaxiPhase('idle');
    setTaxiProgress(0);
    setIsPlaying(false);

    return () => {
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current);
        animFrameIdRef.current = null;
      }
    };
  }, [routeGo, routeReturn]);

  // Hitung ulang durasi animasi saat speed berubah (FR-17) tanpa reset posisi
  useEffect(() => {
    if (!routeGo || !routeReturn) return;
    const totalDistAll = routeGo.distanceMeters + routeReturn.distanceMeters;
    if (totalDistAll <= 0) return;
    const animMs = DEMO_ANIM_DURATION_SEC * 1000;
    animDurationRef.current = {
      go: animMs * (routeGo.distanceMeters / totalDistAll),
      ret: animMs * (routeReturn.distanceMeters / totalDistAll),
    };
  }, [speed, routeGo, routeReturn]);

  // Loop animasi: jalan saat isPlaying=true, berhenti saat false (pause)
  useEffect(() => {
    if (!isPlaying || !routeGo || !routeReturn) return;

    const { go: goMs, ret: retMs } = animDurationRef.current;
    const totalMs = goMs + retMs;
    if (totalMs <= 0) return;

    // Jika sudah selesai (phase3), restart dari awal
    if (elapsedMsRef.current >= totalMs) {
      elapsedMsRef.current = 0;
    }

    let prevTimestamp: number | null = null;

    const tick = (timestamp: number) => {
      if (prevTimestamp === null) prevTimestamp = timestamp;
      const delta = timestamp - prevTimestamp;
      prevTimestamp = timestamp;

      elapsedMsRef.current = Math.min(elapsedMsRef.current + delta, totalMs);
      applyAnimFrame(elapsedMsRef.current, goMs, retMs);

      if (elapsedMsRef.current < totalMs) {
        animFrameIdRef.current = requestAnimationFrame(tick);
      }
    };

    animFrameIdRef.current = requestAnimationFrame(tick);

    return () => {
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current);
        animFrameIdRef.current = null;
      }
    };
  }, [isPlaying, routeGo, routeReturn, applyAnimFrame]);

  // Tombol Reset Penuh (FR-18)
  const handleReset = () => {
    if (animFrameIdRef.current) {
      cancelAnimationFrame(animFrameIdRef.current);
      animFrameIdRef.current = null;
    }

    setPointA(null);
    setPointB(null);
    setRouteGo(null);
    setRouteReturn(null);
    setPassengers([]);
    setRadius(500);
    setRadiusInput('500');
    setSpeed(40);
    setSpeedInput('40');
    setShowBuffer(true);
    setTaxiPhase('idle');
    setTaxiProgress(0);
    setIsPlaying(false);
    elapsedMsRef.current = 0;
    taxiReturnDistRef.current = 0;
    setAlert(null);
    setActiveMode('setA');

    // Kosongkan semua layer
    Object.values(layersRef.current).forEach((grp) => grp?.clearLayers());

    // Kembalikan view peta ke default
    if (mapInstanceRef.current) {
      mapInstanceRef.current.setView([-0.07, 109.37], 12);
    }
  };

  // Muat Contoh Skenario Cepat (1-Klik untuk Evaluasi Langsung)
  const handleLoadScenario = () => {
    handleReset();
    setPointA(PRESET_SCENARIO.pointA);
    setPointB(PRESET_SCENARIO.pointB);

    // Siapkan penumpang demo
    const demoPassengers: Passenger[] = PRESET_SCENARIO.passengers.map((p, i) => ({
      id: `preset-${i}`,
      lat: p.lat,
      lng: p.lng,
      status: 'gray',
    }));
    setPassengers(demoPassengers);
    setActiveMode('addPassenger');
  };

  // Perhitungan Durasi berbasis Rumus PRD FR-15: (jarak_km / kecepatan_kmh) * 60
  const distGoKm = routeGo ? routeGo.distanceMeters / 1000 : 0;
  const durGoMin = routeGo ? calculateDurationMinutes(routeGo.distanceMeters, speed) : 0;

  const distReturnKm = routeReturn ? routeReturn.distanceMeters / 1000 : 0;
  const durReturnMin = routeReturn ? calculateDurationMinutes(routeReturn.distanceMeters, speed) : 0;

  const distTotalKm = distGoKm + distReturnKm;
  const durTotalMin = durGoMin + durReturnMin;

  // Statistik Penumpang (FR-20)
  const countGreen = passengers.filter((p) => p.status === 'green').length;
  const countRed = passengers.filter((p) => p.status === 'red').length;
  const countGray = passengers.filter((p) => p.status === 'gray').length;

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      {/* Tombol Toggle Drawer pada Mobile dengan Animasi Hamburger Morph */}
      <button
        className={`mobile-sidebar-toggle ${sidebarOpen ? 'open' : ''}`}
        onClick={() => setSidebarOpen((prev) => !prev)}
        aria-label="Toggle Panel Kontrol"
        aria-expanded={sidebarOpen}
      >
        <span className="hamburger-box">
          <span className="hamburger-line line-top"></span>
          <span className="hamburger-line line-mid"></span>
          <span className="hamburger-line line-bot"></span>
        </span>
      </button>

      {/* Floating Sidebar (Sisi Kiri) */}
      <aside className={`floating-sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
        {/* Header */}
        <div className="sidebar-header">
          <div className="brand-title">
            <div className="brand-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.5 2.8C2 11 2 11.5 2 12v4c0 .6.4 1 1 1h2" />
                <circle cx="7" cy="17" r="2" />
                <path d="M9 17h6" />
                <circle cx="17" cy="17" r="2" />
              </svg>
            </div>
            <div className="brand-text">
              <h1>SeJalan</h1>
              <p>Simulasi Penjemputan Sekali Jalan</p>
            </div>
          </div>
        </div>

        {/* Isi Sidebar */}
        <div className="sidebar-content">
          {/* Bagian Mode Input (FR-01, FR-02, FR-03) */}
          <div className="panel-section">
            <div className="section-label">Pilih Mode Input Peta</div>
            <div className="mode-grid">
              <button
                className={`mode-btn ${activeMode === 'setA' ? 'active' : ''}`}
                onClick={() => setActiveMode((prev) => (prev === 'setA' ? 'neutral' : 'setA'))}
                title={activeMode === 'setA' ? 'Klik untuk nonaktifkan (mode netral)' : 'Aktifkan mode Set Titik A'}
              >
                <span className="icon">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
                    <circle cx="12" cy="10" r="3"/>
                  </svg>
                </span>
                <span>Set Titik A</span>
              </button>
              <button
                className={`mode-btn ${activeMode === 'setB' ? 'active' : ''}`}
                onClick={() => setActiveMode((prev) => (prev === 'setB' ? 'neutral' : 'setB'))}
                title={activeMode === 'setB' ? 'Klik untuk nonaktifkan (mode netral)' : 'Aktifkan mode Set Titik B'}
              >
                <span className="icon">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                    <line x1="4" y1="22" x2="4" y2="15"/>
                  </svg>
                </span>
                <span>Set Titik B</span>
              </button>
              <button
                className={`mode-btn ${activeMode === 'addPassenger' ? 'active' : ''}`}
                onClick={() => setActiveMode((prev) => (prev === 'addPassenger' ? 'neutral' : 'addPassenger'))}
                title={activeMode === 'addPassenger' ? 'Klik untuk nonaktifkan (mode netral)' : 'Aktifkan mode Tambah Penumpang'}
              >
                <span className="icon">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="8.5" cy="7" r="4"/>
                    <line x1="20" y1="8" x2="20" y2="14"/>
                    <line x1="23" y1="11" x2="17" y2="11"/>
                  </svg>
                </span>
                <span>+ Penumpang</span>
              </button>
            </div>
            {activeMode !== 'neutral' && (
              <div className="mode-hint">
                {activeMode === 'setA' && 'Klik di peta untuk menetapkan Titik A (Tempat Mangkal).'}
                {activeMode === 'setB' && 'Klik di peta untuk menetapkan Titik B (Tujuan Antar Pertama).'}
                {activeMode === 'addPassenger' &&
                  'Klik di peta untuk menaruh titik calon penumpang di sepanjang jalur.'}
              </div>
            )}
          </div>

          {/* Bagian Parameter Simulasi: Radius & Kecepatan */}
          <div className="panel-section">
            <div className="section-label">Parameter Simulasi</div>

            {/* Input Radius (FR-08) */}
            <div>
              <div className="input-row">
                <div className="input-label-group">
                  <label htmlFor="radius-input">Radius Penjemputan</label>
                  <span>Maksimal jarak ke rute pulang</span>
                </div>
                <div className="number-input-wrap">
                  <input
                    id="radius-input"
                    type="number"
                    min="1"
                    step="50"
                    value={radiusInput}
                    onChange={(e) => handleRadiusInputChange(e.target.value)}
                  />
                  <span className="unit">m</span>
                </div>
              </div>
              <div className="chips-row">
                {[250, 500, 1000, 1500].map((r) => (
                  <button
                    key={r}
                    className={`chip-btn ${radius === r ? 'active' : ''}`}
                    onClick={() => handleRadiusChange(r)}
                  >
                    {r}m
                  </button>
                ))}
              </div>
            </div>

            {/* Input Kecepatan (FR-14) */}
            <div style={{ marginTop: '8px' }}>
              <div className="input-row">
                <div className="input-label-group">
                  <label htmlFor="speed-input">Kecepatan Taksi</label>
                  <span>Mempengaruhi durasi & animasi</span>
                </div>
                <div className="number-input-wrap">
                  <input
                    id="speed-input"
                    type="number"
                    min="1"
                    max="120"
                    step="5"
                    value={speedInput}
                    onChange={(e) => handleSpeedInputChange(e.target.value)}
                  />
                  <span className="unit">km/h</span>
                </div>
              </div>
              <div className="chips-row">
                {[30, 40, 60, 80].map((s) => (
                  <button
                    key={s}
                    className={`chip-btn ${speed === s ? 'active' : ''}`}
                    onClick={() => handleSpeedChange(s)}
                  >
                    {s} km/h
                  </button>
                ))}
              </div>
            </div>

            {/* Toggle Tampilkan Buffer (FR-10) */}
            <div className="toggle-row" style={{ marginTop: '4px' }}>
              <label htmlFor="buffer-toggle">Tampilkan Koridor Buffer</label>
              <label className="switch">
                <input
                  id="buffer-toggle"
                  type="checkbox"
                  checked={showBuffer}
                  onChange={(e) => setShowBuffer(e.target.checked)}
                />
                <span className="slider"></span>
              </label>
            </div>
          </div>

          {/* Status Taksi & Progress (FR-16) */}
          <div className="panel-section">
            <div className="section-label">Status Taksi & Simulasi</div>
            <div className="status-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                  Fase Perjalanan:
                </span>
                <span
                  className={`status-badge ${
                    taxiPhase === 'idle'
                      ? 'idle'
                      : taxiPhase === 'phase1'
                      ? 'phase1'
                      : taxiPhase === 'phase2'
                      ? 'phase2'
                      : 'phase3'
                  }`}
                >
                  {isLoadingRoute && 'Menghitung rute...'}
                  {!isLoadingRoute && taxiPhase === 'idle' && '⚪ Menunggu Simulasi'}
                  {!isLoadingRoute && taxiPhase === 'phase1' && '🟡 Fase 1: Menuju Titik B'}
                  {!isLoadingRoute && taxiPhase === 'phase2' && '🟣 Fase 2: Kembali ke Titik A'}
                  {!isLoadingRoute && taxiPhase === 'phase3' && '🟢 Fase 3: Tiba di Titik A'}
                </span>
              </div>
              <div className="status-bar-bg">
                <div
                  className="status-bar-fill"
                  style={{ width: `${Math.round(taxiProgress * 100)}%` }}
                ></div>
              </div>
              {/* Tombol Play / Pause */}
              <button
                className="btn-play-pause"
                disabled={!routeGo || !routeReturn || isLoadingRoute}
                onClick={() => {
                  if (taxiPhase === 'idle') {
                    // Mulai dari awal
                    elapsedMsRef.current = 0;
                    taxiReturnDistRef.current = 0;
                    setIsPlaying(true);
                  } else if (taxiPhase === 'phase3') {
                    // Sudah selesai, putar ulang dari awal: reset titik ke status semula
                    elapsedMsRef.current = 0;
                    taxiReturnDistRef.current = 0;
                    if (routeReturn) {
                      setPassengers((prev) =>
                        prev.map((p) => {
                          const res = classifyPassenger(
                            { lat: p.lat, lng: p.lng },
                            routeReturn.coordinates,
                            radius,
                            0
                          );
                          return {
                            ...p,
                            status: res.status,
                            distanceToReturnMeters: res.distanceMeters,
                            routeLocationMeters: res.routeLocationMeters,
                            isPassed: false,
                          };
                        })
                      );
                    }
                    setIsPlaying(true);
                  } else {
                    // Toggle play/pause
                    setIsPlaying((prev) => !prev);
                  }
                }}
              >
                {isPlaying ? (
                  <>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="4" width="4" height="16" rx="1.5" />
                      <rect x="14" y="4" width="4" height="16" rx="1.5" />
                    </svg>
                    <span>Jeda Simulasi</span>
                  </>
                ) : taxiPhase === 'phase3' ? (
                  <>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                    <span>Putar Ulang</span>
                  </>
                ) : (
                  <>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    <span>Mulai Simulasi</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Panel Info Jarak & Durasi (FR-15) */}
          <div className="panel-section">
            <div className="section-label">Estimasi Jarak & Durasi</div>
            <table className="info-table">
              <thead>
                <tr>
                  <th>Segmen</th>
                  <th>Jarak</th>
                  <th>Durasi</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Rute Pergi (A &rarr; B)</td>
                  <td>{distGoKm > 0 ? `${distGoKm.toFixed(2)} km` : '-'}</td>
                  <td>{durGoMin > 0 ? `${durGoMin.toFixed(1)} mnt` : '-'}</td>
                </tr>
                <tr>
                  <td>Rute Pulang (B &rarr; A)</td>
                  <td>{distReturnKm > 0 ? `${distReturnKm.toFixed(2)} km` : '-'}</td>
                  <td>{durReturnMin > 0 ? `${durReturnMin.toFixed(1)} mnt` : '-'}</td>
                </tr>
                <tr>
                  <td>Total Perjalanan</td>
                  <td>{distTotalKm > 0 ? `${distTotalKm.toFixed(2)} km` : '-'}</td>
                  <td>{durTotalMin > 0 ? `${durTotalMin.toFixed(1)} mnt` : '-'}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Ringkasan Penumpang (FR-20) */}
          <div className="panel-section">
            <div className="section-label">Status Calon Penumpang ({passengers.length})</div>
            <div className="passenger-stats">
              <div className="stat-pill green">
                <span className="num">{countGreen}</span>
                <span className="label">Bisa Memesan</span>
              </div>
              <div className="stat-pill red">
                <span className="num">{countRed}</span>
                <span className="label">Di Luar Radius</span>
              </div>
            </div>
            {countGray > 0 && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                ⚪ {countGray} titik belum dihitung (menunggu rute dibuat).
              </div>
            )}
          </div>

          {/* Tombol Aksi & Reset (FR-18) */}
          <div className="button-row">
            <button className="btn-primary" onClick={handleLoadScenario}>
              <span>Muat Contoh Skenario</span>
            </button>
            <button className="btn-secondary" onClick={handleReset}>
              <span>Reset Titik & Rute</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Floating Alert / Notifikasi (Top Right) */}
      {alert && (
        <div className={`floating-alert ${alert.type}`}>
          <span className="alert-icon">
            {alert.type === 'error' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            ) : alert.type === 'warning' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            )}
          </span>
          <span className="alert-text">{alert.message}</span>
          <button
            className="alert-close"
            onClick={() => setAlert(null)}
            aria-label="Tutup notifikasi"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      )}

      {/* Legenda Peta (Bottom Right - FR-19) */}
      {showLegend ? (
        <div className="map-legend">
          <div className="legend-header">
            <div className="legend-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/>
                <line x1="8" y1="2" x2="8" y2="18"/>
                <line x1="16" y1="6" x2="16" y2="22"/>
              </svg>
              <span>Legenda Peta</span>
            </div>
            <button
              className="legend-close-btn"
              onClick={() => setShowLegend(false)}
              title="Sembunyikan Legenda"
              aria-label="Tutup Legenda"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div className="legend-items">
            <div className="legend-item">
              <div className="legend-symbol">
                <div className="legend-circle green">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
              </div>
              <span>Bisa Memesan (&le; {radius}m)</span>
            </div>
            <div className="legend-item">
              <div className="legend-symbol">
                <div className="legend-circle red">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </div>
              </div>
              <span>Tidak Bisa Memesan (&gt;{radius}m / Terlewat)</span>
            </div>
            <div className="legend-item">
              <div className="legend-symbol">
                <div className="legend-circle gray">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                </div>
              </div>
              <span>Belum Dihitung (Tanpa Rute)</span>
            </div>
            <div className="legend-item">
              <div className="legend-symbol">
                <div className="legend-line route-go"></div>
              </div>
              <span>Rute Pergi (A &rarr; B)</span>
            </div>
            <div className="legend-item">
              <div className="legend-symbol">
                <div className="legend-line route-return"></div>
              </div>
              <span>Rute Pulang (B &rarr; A)</span>
            </div>
            {showBuffer && (
              <div className="legend-item">
                <div className="legend-symbol">
                  <div className="legend-buffer-box"></div>
                </div>
                <span>Koridor Buffer Penjemputan</span>
              </div>
            )}
            <div className="legend-item">
              <div className="legend-symbol">
                <div className="legend-pin-a">
                  <span style={{ fontSize: '9px', fontWeight: 800, color: 'white', transform: 'rotate(45deg)' }}>A</span>
                </div>
              </div>
              <span>Titik A (Tempat Mangkal)</span>
            </div>
            <div className="legend-item">
              <div className="legend-symbol">
                <div className="legend-pin-b">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                    <line x1="4" y1="22" x2="4" y2="15"/>
                  </svg>
                </div>
              </div>
              <span>Titik B (Tujuan Antar)</span>
            </div>
            <div className="legend-item">
              <div className="legend-symbol">
                <div className="legend-taxi-icon">
                  <svg width="18" height="18" viewBox="0 0 36 36" fill="none">
                    <rect x="8" y="5" width="20" height="26" rx="5" fill="#facc15" stroke="#1e293b" strokeWidth="1.8"/>
                    <path d="M11 11C11 9 13 8 18 8C23 8 25 9 25 11L24 14H12L11 11Z" fill="#1e293b"/>
                    <rect x="13.5" y="16.5" width="9" height="3.5" rx="1" fill="#ffffff" stroke="#1e293b" strokeWidth="0.8"/>
                    <rect x="9.5" y="4.5" width="3" height="1.5" rx="0.75" fill="#ffffff"/>
                    <rect x="23.5" y="4.5" width="3" height="1.5" rx="0.75" fill="#ffffff"/>
                  </svg>
                </div>
              </div>
              <span>Taksi (Simulasi Pergerakan)</span>
            </div>
          </div>
        </div>
      ) : (
        <button
          className="map-legend-toggle-pill"
          onClick={() => setShowLegend(true)}
          title="Tampilkan Legenda Peta"
          aria-label="Buka Legenda Peta"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/>
            <line x1="8" y1="2" x2="8" y2="18"/>
            <line x1="16" y1="6" x2="16" y2="22"/>
          </svg>
          <span>Legenda</span>
          <span className="legend-pill-dot"></span>
        </button>
      )}

      {/* Kontainer Peta Leaflet Penuh Layar */}
      <div id="map-container" ref={mapContainerRef} />
    </div>
  );
}
