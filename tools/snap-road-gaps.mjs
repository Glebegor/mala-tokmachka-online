import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const roadsPath = join(__dirname, '../mods/base/maps/ukraine.roads.json');
const roads = JSON.parse(readFileSync(roadsPath, 'utf8'));

// 1. Explicit fix for Kyiv Brovary junction (road 46)
const r46 = roads[46];
const pts46 = [];
for (let i = 1; i < r46.length; i += 2) pts46.push([r46[i], r46[i+1]]);
const p0 = [pts46[0][0], pts46[0][1]];
// Check if p0 is around [30.79416, 50.52816]
if (Math.abs(p0[0] - 30.79416) < 0.001 && Math.abs(p0[1] - 50.52816) < 0.001) {
  // Find index around 242
  let idx242 = pts46.findIndex((p, idx) => idx > 200 && Math.abs(p[0] - 30.79291) < 0.001 && Math.abs(p[1] - 50.52654) < 0.001);
  if (idx242 >= 0) {
    pts46.splice(idx242 + 1, 0, [p0[0], p0[1]]);
  }
  // Find index around 239
  let idx239 = pts46.findIndex((p, idx) => idx > 200 && Math.abs(p[0] - 30.79539) < 0.001 && Math.abs(p[1] - 50.52973) < 0.001);
  if (idx239 >= 0) {
    pts46.splice(idx239 + 1, 0, [p0[0], p0[1]]);
  }
  const flat46 = [r46[0]];
  for (const [x, y] of pts46) flat46.push(x, y);
  roads[46] = flat46;
  console.log('Applied Kyiv Brovary intersection fix to road 46!');
}

// 2. Unpack all polylines
const polylines = roads.map((r, idx) => {
  const major = r[0];
  const pts = [];
  for (let i = 1; i < r.length; i += 2) pts.push([r[i], r[i+1]]);
  return { idx, major, pts };
});

const CELL = 0.05;
const segGrid = new Map();

for (const pl of polylines) {
  for (let k = 0; k < pl.pts.length - 1; k++) {
    const a = pl.pts[k], b = pl.pts[k+1];
    const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
    const minY = Math.min(a[1], b[1]), maxY = Math.max(a[1], b[1]);
    const cX1 = Math.floor(minX / CELL), cX2 = Math.floor(maxX / CELL);
    const cY1 = Math.floor(minY / CELL), cY2 = Math.floor(maxY / CELL);
    for (let cx = cX1; cx <= cX2; cx++) {
      for (let cy = cY1; cy <= cY2; cy++) {
        const key = `${cx},${cy}`;
        let bucket = segGrid.get(key);
        if (!bucket) {
          bucket = [];
          segGrid.set(key, bucket);
        }
        bucket.push({ plIdx: pl.idx, k, a, b });
      }
    }
  }
}

const endpointMap = new Map();
function epKey(x, y) {
  return `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`;
}

for (const pl of polylines) {
  for (const isStart of [true, false]) {
    const pt = isStart ? pl.pts[0] : pl.pts[pl.pts.length - 1];
    const k = epKey(pt[0], pt[1]);
    endpointMap.set(k, (endpointMap.get(k) || 0) + 1);
  }
}

const deadEnds = [];
for (const pl of polylines) {
  for (const isStart of [true, false]) {
    const pt = isStart ? pl.pts[0] : pl.pts[pl.pts.length - 1];
    if (endpointMap.get(epKey(pt[0], pt[1])) === 1) {
      deadEnds.push({ pl, isStart, pt });
    }
  }
}
console.log('Total dead ends:', deadEnds.length);

function distToSeg(p, a, b) {
  const midLat = (p[1] + a[1] + b[1]) / 3;
  const kmPerLat = 111.32;
  const kmPerLng = 111.32 * Math.cos(midLat * Math.PI / 180);
  const px = p[0] * kmPerLng, py = p[1] * kmPerLat;
  const ax = a[0] * kmPerLng, ay = a[1] * kmPerLat;
  const bx = b[0] * kmPerLng, by = b[1] * kmPerLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { distM: Math.hypot(px - ax, py - ay) * 1000, proj: a, t: 0 };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const projX = ax + t * dx, projY = ay + t * dy;
  return {
    distM: Math.hypot(px - projX, py - projY) * 1000,
    proj: [projX / kmPerLng, projY / kmPerLat],
    t
  };
}

let snappedCount = 0;
const insertionsByRoad = new Map();

for (const de of deadEnds) {
  const p = de.pt;
  const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
  let bestDist = 220; // snap gaps up to 220 meters!
  let bestSeg = null;

  for (let x = cx - 1; x <= cx + 1; x++) {
    for (let y = cy - 1; y <= cy + 1; y++) {
      const bucket = segGrid.get(`${x},${y}`);
      if (!bucket) continue;
      for (const item of bucket) {
        // If same road, only check if distant segment (> 5 segments away)
        if (item.plIdx === de.pl.idx) {
          const segCount = de.pl.pts.length;
          if (de.isStart && item.k < 5) continue;
          if (!de.isStart && item.k > segCount - 6) continue;
        }

        const res = distToSeg(p, item.a, item.b);
        if (res.distM < bestDist) {
          bestDist = res.distM;
          bestSeg = { item, proj: res.proj, t: res.t };
        }
      }
    }
  }

  if (bestSeg) {
    snappedCount++;
    const proj = [Math.round(bestSeg.proj[0] * 1e5) / 1e5, Math.round(bestSeg.proj[1] * 1e5) / 1e5];
    if (de.isStart) {
      de.pl.pts[0] = proj;
    } else {
      de.pl.pts[de.pl.pts.length - 1] = proj;
    }

    if (!insertionsByRoad.has(bestSeg.item.plIdx)) {
      insertionsByRoad.set(bestSeg.item.plIdx, []);
    }
    insertionsByRoad.get(bestSeg.item.plIdx).push({ k: bestSeg.item.k, proj });
  }
}

console.log(`Snapped ${snappedCount} dead ends across the road network (up to 220m)!`);

let totalInsertedPoints = 0;
for (const [plIdx, items] of insertionsByRoad.entries()) {
  const pl = polylines[plIdx];
  items.sort((a, b) => b.k - a.k);
  for (const { k, proj } of items) {
    const p1 = pl.pts[k], p2 = pl.pts[k + 1];
    if (p1 && (Math.hypot(p1[0] - proj[0], p1[1] - proj[1]) < 1e-4)) continue;
    if (p2 && (Math.hypot(p2[0] - proj[0], p2[1] - proj[1]) < 1e-4)) continue;
    pl.pts.splice(k + 1, 0, proj);
    totalInsertedPoints++;
  }
}
console.log(`Inserted ${totalInsertedPoints} connection vertices into target roads.`);

const newRoads = polylines.map(pl => {
  const flat = [pl.major];
  for (const [x, y] of pl.pts) {
    flat.push(x, y);
  }
  return flat;
});

writeFileSync(roadsPath, JSON.stringify(newRoads));
console.log(`Successfully saved repaired road network to ${roadsPath}`);
