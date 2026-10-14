// tools/build-real-osm-city-boundaries.mjs
// Fetches real OpenStreetMap municipal/settlement boundary polygons via bounded Nominatim queries.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ukraineMap = JSON.parse(readFileSync(join(__dirname, '../mods/base/maps/ukraine.json'), 'utf8'));
const cacheDir = join(__dirname, 'cache-boundaries');
if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

// Douglas-Peucker polyline simplification
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

function simplifyRing(ring, tolerance = 0.0012) {
  if (ring.length <= 8) return ring;
  const isClosed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const openRing = isClosed ? ring.slice(0, -1) : ring;
  const simp = simplifyPoints(openRing, tolerance);
  return [...simp, simp[0]];
}

async function fetchOsmBoundary(cp) {
  const cacheFile = join(cacheDir, `${cp.id}.json`);
  if (existsSync(cacheFile)) {
    try {
      return JSON.parse(readFileSync(cacheFile, 'utf8'));
    } catch {
      // re-fetch
    }
  }

  const [lng, lat] = cp.pos;
  const delta = cp.value >= 4 ? 0.35 : cp.value === 3 ? 0.22 : 0.15;
  const box = `${lng - delta},${lat + delta},${lng + delta},${lat - delta}`;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cp.name)}&viewbox=${box}&bounded=1&format=geojson&polygon_geojson=1`;

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'MalaTokmachkaGame/1.0 (tactical boundary search)' } });
    if (!res.ok) {
      console.warn(`HTTP ${res.status} for ${cp.name}`);
      return null;
    }
    const data = await res.json();
    const poly = data.features?.find(f => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon');
    if (poly) {
      writeFileSync(cacheFile, JSON.stringify(poly));
      return poly;
    }
  } catch (err) {
    console.warn(`Error fetching ${cp.name}:`, err.message);
  }
  return null;
}

// Fallback organic boundary if OSM boundary is missing
function fallbackBoundary(cp) {
  const [cLng, cLat] = cp.pos;
  const val = cp.value ?? 2;
  const kmPerLat = 111.32;
  const kmPerLng = 111.32 * Math.cos((cLat * Math.PI) / 180);
  const toCoords = (dxKm, dyKm) => [
    Math.round((cLng + dxKm / kmPerLng) * 1e5) / 1e5,
    Math.round((cLat + dyKm / kmPerLat) * 1e5) / 1e5,
  ];
  const rKm = val === 5 ? 3.8 : val === 4 ? 2.8 : val === 3 ? 1.8 : val === 2 ? 1.1 : 0.75;
  const n = 14;
  const ring = [];
  let seed = 0;
  for (let i = 0; i < cp.id.length; i++) seed = (seed * 31 + cp.id.charCodeAt(i)) & 0xffffffff;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    const varFrac = 0.78 + ((seed >>> 16) / 65536) * 0.44;
    ring.push(toCoords(Math.cos(a) * rKm * varFrac, Math.sin(a) * rKm * varFrac));
  }
  ring.push(ring[0]);
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { display_name: cp.name },
  };
}

async function main() {
  const capturePoints = ukraineMap.capturePoints;
  console.log(`Starting real OSM boundary generation for ${capturePoints.length} cities...`);

  const features = [];
  let fetchedCount = 0;
  let cachedCount = 0;
  let fallbackCount = 0;

  for (let i = 0; i < capturePoints.length; i++) {
    const cp = capturePoints[i];
    const cacheFile = join(cacheDir, `${cp.id}.json`);
    const isCached = existsSync(cacheFile);

    const osmFeat = await fetchOsmBoundary(cp);
    let geom = null;

    if (osmFeat?.geometry) {
      if (isCached) cachedCount++; else fetchedCount++;
      const gType = osmFeat.geometry.type;
      if (gType === 'Polygon') {
        const outer = simplifyRing(osmFeat.geometry.coordinates[0]);
        geom = { type: 'Polygon', coordinates: [outer] };
      } else if (gType === 'MultiPolygon') {
        // Pick largest polygon in MultiPolygon
        let bestPoly = osmFeat.geometry.coordinates[0];
        let maxLen = bestPoly[0]?.length ?? 0;
        for (const poly of osmFeat.geometry.coordinates) {
          if ((poly[0]?.length ?? 0) > maxLen) {
            maxLen = poly[0].length;
            bestPoly = poly;
          }
        }
        const outer = simplifyRing(bestPoly[0]);
        geom = { type: 'Polygon', coordinates: [outer] };
      }
    }

    if (!geom) {
      fallbackCount++;
      const fb = fallbackBoundary(cp);
      geom = fb.geometry;
    }

    // Boundary polygon fill
    features.push({
      type: 'Feature',
      properties: {
        type: 'city-boundary-fill',
        cityId: cp.id,
        cityName: cp.name,
        val: cp.value ?? 2,
      },
      geometry: geom,
    });

    // Boundary line outline
    features.push({
      type: 'Feature',
      properties: {
        type: 'city-boundary-line',
        cityId: cp.id,
        val: cp.value ?? 2,
      },
      geometry: {
        type: 'LineString',
        coordinates: geom.coordinates[0],
      },
    });

    if ((i + 1) % 10 === 0 || i === capturePoints.length - 1) {
      console.log(`Progress: ${i + 1}/${capturePoints.length} (fetched: ${fetchedCount}, cached: ${cachedCount}, fallback: ${fallbackCount})`);
      // Save intermediate progress
      const intermediate = { type: 'FeatureCollection', features };
      writeFileSync(join(__dirname, '../mods/base/maps/ukraine.cities.geojson'), JSON.stringify(intermediate));
    }

    if (!isCached) {
      await new Promise(r => setTimeout(r, 800)); // Respect Nominatim rate limit
    }
  }

  const finalGeoJSON = { type: 'FeatureCollection', features };
  const outPath = join(__dirname, '../mods/base/maps/ukraine.cities.geojson');
  writeFileSync(outPath, JSON.stringify(finalGeoJSON));
  console.log(`Finished! Saved ${features.length} features to ${outPath}`);
}

main().catch(console.error);
