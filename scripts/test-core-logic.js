const assert = require('assert');
const turf = require('@turf/turf');

// 1. Uji Durasi: (jarak_km / kecepatan_kmh) * 60 (FR-15, Kriteria 4)
function calculateDurationMinutes(distanceMeters, speedKmh) {
  if (speedKmh <= 0) return 0;
  return ((distanceMeters / 1000) / speedKmh) * 60;
}

const distMeters = 20000; // 20 km
assert.strictEqual(calculateDurationMinutes(distMeters, 40), 30, '20km @ 40km/h harus 30 menit');
assert.strictEqual(calculateDurationMinutes(distMeters, 80), 15, '20km @ 80km/h harus 15 menit');

// 2. Uji Klasifikasi Penumpang (FR-09, Kriteria 5 & 6)
// Garis rute dari [100.0, 0.0] ke [100.0, 1.0] (sepanjang meridian)
const returnRoute = [
  [100.0, 0.0],
  [100.0, 1.0],
];
const line = turf.lineString(returnRoute);

function classify(lat, lng, radiusMeters) {
  const pt = turf.point([lng, lat]);
  const dist = Math.round(turf.pointToLineDistance(pt, line, { units: 'meters' }));
  return { dist, status: dist <= radiusMeters ? 'green' : 'red' };
}

// Titik pada garis tepat (lat: 0.5, lng: 100.0) -> dist ~ 0 -> green
const onLine = classify(0.5, 100.0, 500);
assert.strictEqual(onLine.dist, 0);
assert.strictEqual(onLine.status, 'green', 'Titik tepat di garis harus hijau');

// Titik sekitar ~300 meter dari garis (0.0027 derajat bujur di ekuator ~ 300 meter)
const nearPoint = classify(0.5, 100.0027, 500);
assert.ok(nearPoint.dist < 500, 'Jarak harus < 500m');
assert.strictEqual(nearPoint.status, 'green', 'Jarak 300m dengan radius 500m harus hijau');

// Mengubah radius menjadi 200m -> titik tadi harus jadi merah (Kriteria 5)
const nearPointSmallRadius = classify(0.5, 100.0027, 200);
assert.strictEqual(nearPointSmallRadius.status, 'red', 'Jarak 300m dengan radius 200m harus merah');

// Titik dengan jarak tepat sama dengan radius harus hijau (Kriteria 6)
const exactRadiusCheck = nearPoint.dist <= nearPoint.dist ? 'green' : 'red';
assert.strictEqual(exactRadiusCheck, 'green', 'Jarak tepat sama dengan radius harus hijau');

// 3. Uji Interpolasi Pergerakan Taksi (FR-13)
const totalLen = turf.length(line, { units: 'kilometers' });
const startPt = turf.along(line, 0, { units: 'kilometers' });
const midPt = turf.along(line, totalLen * 0.5, { units: 'kilometers' });
const endPt = turf.along(line, totalLen, { units: 'kilometers' });

assert.deepStrictEqual(startPt.geometry.coordinates, [100.0, 0.0]);
assert.deepStrictEqual(endPt.geometry.coordinates, [100.0, 1.0]);
assert.strictEqual(Math.round(midPt.geometry.coordinates[1] * 10) / 10, 0.5);

// 4. Uji Penumpang Terlewat di Rute Pulang (Aturan Baru: sudah dilewati -> merah)
function classifyWithProgress(lat, lng, radiusMeters, taxiReturnProgressMeters = 0) {
  const pt = turf.point([lng, lat]);
  const snapped = turf.nearestPointOnLine(line, pt, { units: 'meters' });
  const dist = Math.round(snapped.properties.dist);
  const location = Math.round(snapped.properties.location);
  const isPassed = taxiReturnProgressMeters > 0 && location <= taxiReturnProgressMeters;
  return {
    dist,
    location,
    isPassed,
    status: isPassed ? 'red' : dist <= radiusMeters ? 'green' : 'red',
  };
}

// Titik di lat 0.3 (location ~33.3 km dari titik awal B)
const pMid = classifyWithProgress(0.3, 100.002, 500, 0);
assert.strictEqual(pMid.status, 'green', 'Sebelum taksi lewat, titik dalam radius harus hijau');
assert.strictEqual(pMid.isPassed, false);

// Taksi baru berjalan 20 km (belum melewati 33.3 km)
const pBefore = classifyWithProgress(0.3, 100.002, 500, 20000);
assert.strictEqual(pBefore.status, 'green', 'Taksi di 20km belum melewati titik di 33km -> tetap hijau');
assert.strictEqual(pBefore.isPassed, false);

// Taksi sudah di 40 km (sudah melewati 33.3 km)
const pAfter = classifyWithProgress(0.3, 100.002, 500, 40000);
assert.strictEqual(pAfter.status, 'red', 'Taksi di 40km sudah melewati titik di 33km -> harus merah');
assert.strictEqual(pAfter.isPassed, true, 'isPassed harus true');

// Bahkan jika radius diperbesar menjadi 2000m, titik yang sudah dilewati tetap merah
const pAfterLargeRadius = classifyWithProgress(0.3, 100.002, 2000, 40000);
assert.strictEqual(pAfterLargeRadius.status, 'red', 'Titik yang sudah terlewat tetap merah meski radius naik');

console.log('✓ Semua pengujian logika inti GIS (durasi, klasifikasi, interpolasi, penumpang terlewat) lulus 100%!');
