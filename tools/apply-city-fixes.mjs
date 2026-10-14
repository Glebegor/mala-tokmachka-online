import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ukraineJsonPath = join(__dirname, '../mods/base/maps/ukraine.json');
const citiesGeojsonPath = join(__dirname, '../mods/base/maps/ukraine.cities.geojson');

const ukraineMap = JSON.parse(readFileSync(ukraineJsonPath, 'utf8'));
const citiesGeoJSON = JSON.parse(readFileSync(citiesGeojsonPath, 'utf8'));

// 1. Move Starodub in ukraine.json
const starodubCp = ukraineMap.capturePoints.find(c => c.id === 'starodub');
if (starodubCp) {
  console.log('Old Starodub pos:', starodubCp.pos);
  starodubCp.pos = [32.7607, 52.5876];
  console.log('New Starodub pos:', starodubCp.pos);
  writeFileSync(ukraineJsonPath, JSON.stringify(ukraineMap, null, 2));
}

// 2. Simplification
function simplifyPoints(points, tolerance) {
  if (points.length <= 4) return points;
  let maxDist = 0;
  let index = 0;
  const a = points[0];
  const b = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const dist = perpDist(p, a, b);
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }

  if (maxDist > tolerance) {
    const left = simplifyPoints(points.slice(0, index + 1), tolerance);
    const right = simplifyPoints(points.slice(index), tolerance);
    return [...left.slice(0, -1), ...right];
  } else {
    return [a, b];
  }
}

function perpDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplifyRing(ring, tolerance = 0.001) {
  if (ring.length <= 8) return ring;
  const isClosed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const openRing = isClosed ? ring.slice(0, -1) : ring;
  const simp = simplifyPoints(openRing, tolerance);
  return [...simp, simp[0]];
}

async function fetchPoly(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=geojson&polygon_geojson=1`;
  console.log(`Fetching Nominatim: ${query}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'MalaTokmachkaGame/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const poly = data.features?.find(f => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon');
  if (!poly) throw new Error(`No polygon found for ${query}`);

  if (poly.geometry.type === 'Polygon') {
    return poly.geometry.coordinates[0];
  } else {
    let best = poly.geometry.coordinates[0];
    let maxL = best[0]?.length || 0;
    for (const p of poly.geometry.coordinates) {
      if ((p[0]?.length || 0) > maxL) {
        maxL = p[0].length;
        best = p;
      }
    }
    return best[0];
  }
}

async function main() {
  // Fetch Alekseevka
  const alekseevkaRaw = await fetchPoly('город Алексеевка, Белгородская область');
  const alekseevkaRing = simplifyRing(alekseevkaRaw, 0.0008);
  console.log(`Alekseevka ring points: ${alekseevkaRing.length}`);
  await new Promise(r => setTimeout(r, 1000));

  // Fetch Starodub
  const starodubRaw = await fetchPoly('Стародуб, Брянская область');
  const starodubRing = simplifyRing(starodubRaw, 0.0008);
  console.log(`Starodub ring points: ${starodubRing.length}`);
  await new Promise(r => setTimeout(r, 1000));

  // Build Sudzha urban area
  const sudzhaQueries = [
    'городское поселение город Суджа',
    'Заолешенка, Курская область',
    'Гончаровка, Курская область',
    'Замостье, Курская область',
  ];
  const allSudzhaPts = [];
  for (const q of sudzhaQueries) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=geojson&polygon_geojson=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'MalaTokmachkaGame/1.0' } });
    const data = await res.json();
    const f = data.features?.[0];
    if (f?.geometry) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const p of polys) {
        for (const pt of p[0]) allSudzhaPts.push(pt);
      }
    }
    await new Promise(r => setTimeout(r, 800));
  }

  const cLon = 35.27, cLat = 51.195;
  const kmPerLat = 111.32;
  const kmPerLon = 111.32 * Math.cos(cLat * Math.PI / 180);
  const nRays = 48;
  const rayRing = [];
  for (let i = 0; i < nRays; i++) {
    const angle = (i / nRays) * 2 * Math.PI;
    const window = (2 * Math.PI) / nRays * 0.8;
    let maxDist = 0;
    let bestPt = null;

    for (const [x, y] of allSudzhaPts) {
      const dx = (x - cLon) * kmPerLon;
      const dy = (y - cLat) * kmPerLat;
      const a = (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI);
      let diff = Math.abs(a - angle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff <= window) {
        const d = Math.hypot(dx, dy);
        if (d > maxDist) {
          maxDist = d;
          bestPt = [x, y];
        }
      }
    }
    if (bestPt) rayRing.push(bestPt);
  }

  const cleanSudzha = [];
  for (let i = 0; i < rayRing.length; i++) {
    const p = rayRing[i];
    const prev = cleanSudzha[cleanSudzha.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-4) {
      cleanSudzha.push(p);
    }
  }
  cleanSudzha.push(cleanSudzha[0]);
  const sudzhaRing = simplifyRing(cleanSudzha, 0.0008);
  console.log(`Sudzha ring points: ${sudzhaRing.length}`);

  const replacements = {
    alekseevka: alekseevkaRing,
    starodub: starodubRing,
    sudzha: sudzhaRing,
  };

  let updatedCount = 0;
  for (const f of citiesGeoJSON.features) {
    const id = f.properties.cityId;
    if (replacements[id]) {
      const ring = replacements[id];
      if (f.properties.type === 'city-boundary-fill') {
        f.geometry = { type: 'Polygon', coordinates: [ring] };
        updatedCount++;
      } else if (f.properties.type === 'city-boundary-line') {
        f.geometry = { type: 'LineString', coordinates: ring };
        updatedCount++;
      }
    }
  }

  writeFileSync(citiesGeojsonPath, JSON.stringify(citiesGeoJSON));
  console.log(`Updated ${updatedCount} features in ${citiesGeojsonPath}`);
}

main().catch(console.error);
