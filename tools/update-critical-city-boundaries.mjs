import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const geojsonPath = join(__dirname, '../mods/base/maps/ukraine.cities.geojson');
const roadsPath = join(__dirname, '../mods/base/maps/ukraine.roads.json');

const citiesGeoJSON = JSON.parse(readFileSync(geojsonPath, 'utf8'));
const roads = JSON.parse(readFileSync(roadsPath, 'utf8'));

// Douglas-Peucker simplification
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

// 1. Build Moscow MKAD polygon
function buildMoscowPolygon() {
  const moscowFeat = citiesGeoJSON.features.find(x => x.properties.cityId === 'moscow' && x.properties.type === 'city-boundary-fill');
  const origRing = moscowFeat.geometry.coordinates[0];

  // North/East/West arc: index 431 to 860
  const northArc = origRing.slice(431, 861);

  // South-west MKAD roads from ukraine.roads.json:
  function getPts(ri) {
    const r = roads[ri];
    const pts = [];
    for (let i = 1; i < r.length; i += 2) pts.push([r[i], r[i+1]]);
    return pts;
  }

  const p9909 = getPts(9909).filter(([x, y]) => x >= 37.36 && x <= 37.54 && y <= 55.64);
  const r9889 = getPts(9889).filter(([x, y]) => x >= 37.539 && x <= 37.555);

  const southConnector = [
    [37.5550, 55.5538],
    [37.5680, 55.5550],
    [37.5800, 55.5562],
    [37.5895, 55.5577],
    [37.5985, 55.5620],
    [37.6036, 55.5646]
  ];

  const westConnector = [
    [37.3720, 55.6500],
    [37.3650, 55.6400],
    [37.3600, 55.6320]
  ];

  const southArc = [
    ...westConnector,
    ...p9909,
    ...r9889,
    ...southConnector
  ];

  const full = simplifyRing([...northArc, ...southArc, northArc[0]], 0.001);
  return full;
}

// 2. Fetch real municipal boundary from Nominatim
async function fetchCityBoundary(query) {
  const url = `https://nominatim.openstreetmap.org/search?${query}&format=geojson&polygon_geojson=1`;
  console.log(`Fetching: ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'MalaTokmachkaGame/1.0 (tactical boundary search)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const poly = data.features?.find(f => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon');
  if (!poly) throw new Error(`No polygon found for ${query}`);

  if (poly.geometry.type === 'Polygon') {
    return simplifyRing(poly.geometry.coordinates[0]);
  } else {
    // MultiPolygon: pick largest polygon
    let best = poly.geometry.coordinates[0];
    let maxL = best[0]?.length || 0;
    for (const p of poly.geometry.coordinates) {
      if ((p[0]?.length || 0) > maxL) {
        maxL = p[0].length;
        best = p;
      }
    }
    return simplifyRing(best[0]);
  }
}

async function main() {
  console.log('Building corrected city boundaries...');

  // 1. Moscow
  console.log('Constructing Moscow MKAD boundary...');
  const moscowRing = buildMoscowPolygon();
  console.log(`Moscow ring points: ${moscowRing.length}`);

  // 2. Ternopil
  console.log('Fetching Ternopil municipal boundary...');
  const ternopilRing = await fetchCityBoundary('city=Ternopil&country=Ukraine');
  console.log(`Ternopil ring points: ${ternopilRing.length}`);
  await new Promise(r => setTimeout(r, 1000));

  // 3. Khmelnytskyi
  console.log('Fetching Khmelnytskyi municipal boundary...');
  const khmelnytskyiRing = await fetchCityBoundary('city=Khmelnytskyi&country=Ukraine');
  console.log(`Khmelnytskyi ring points: ${khmelnytskyiRing.length}`);
  await new Promise(r => setTimeout(r, 1000));

  // 4. Donetsk
  console.log('Fetching Donetsk municipal boundary...');
  const donetskRing = await fetchCityBoundary('city=Donetsk&country=Ukraine');
  console.log(`Donetsk ring points: ${donetskRing.length}`);
  await new Promise(r => setTimeout(r, 1000));

  // 5. Saint Petersburg
  console.log('Fetching Saint Petersburg municipal boundary...');
  const spbRing = await fetchCityBoundary('city=Saint Petersburg&country=Russia');
  console.log(`Saint Petersburg ring points: ${spbRing.length}`);

  const replacements = {
    moscow: moscowRing,
    ternopil: ternopilRing,
    khmelnytskyi: khmelnytskyiRing,
    donetsk: donetskRing,
    saint_petersburg: spbRing,
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

  writeFileSync(geojsonPath, JSON.stringify(citiesGeoJSON));
  console.log(`Updated ${updatedCount} features in ${geojsonPath}`);
}

main().catch(console.error);
