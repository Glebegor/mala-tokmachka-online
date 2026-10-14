import { readFileSync, writeFileSync } from 'node:fs';

const ukrPath = 'C:/Users/AKIRA/.gemini/antigravity/scratch/ukr_extracted_lines.json';
const ruPath = 'C:/Users/AKIRA/.gemini/antigravity/scratch/ru_extracted_lines.json';
const outFile = 'mods/base/maps/ukraine.roads.json';

console.log('Loading extracted road datasets...');
const ukr = JSON.parse(readFileSync(ukrPath, 'utf8'));
const ru = JSON.parse(readFileSync(ruPath, 'utf8'));
console.log(`Loaded ${ukr.length} Ukraine lines, ${ru.length} Russia lines.`);

const allowedClasses = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'
]);

const raw = [...ukr, ...ru].filter((l) => allowedClasses.has(l.fclass) && l.pts && l.pts.length > 1);
console.log(`Total candidate road features: ${raw.length}`);

// 1. Chain continuous segments of the exact same road class
console.log('Chaining continuous segments of the same road class...');
function chainLines(lines) {
  const ptKey = (p) => `${Math.round(p[0] * 100000)},${Math.round(p[1] * 100000)}`;
  const endpoints = new Map();

  lines.forEach((l, idx) => {
    const k0 = ptKey(l.pts[0]);
    const k1 = ptKey(l.pts[l.pts.length - 1]);
    (endpoints.get(k0) ?? endpoints.set(k0, []).get(k0)).push({ idx, atStart: true });
    (endpoints.get(k1) ?? endpoints.set(k1, []).get(k1)).push({ idx, atStart: false });
  });

  const merged = [];
  const used = new Uint8Array(lines.length);

  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const fclass = lines[i].fclass;
    const major = lines[i].major;
    const pts = [...lines[i].pts];

    // Grow forward
    let growing = true;
    while (growing) {
      growing = false;
      const tailKey = ptKey(pts[pts.length - 1]);
      const cand = endpoints.get(tailKey) || [];
      const viable = cand.filter((c) => !used[c.idx] && lines[c.idx].fclass === fclass);
      if (viable.length === 1) {
        const c = viable[0];
        used[c.idx] = 1;
        const other = lines[c.idx].pts;
        if (c.atStart) {
          for (let k = 1; k < other.length; k++) pts.push(other[k]);
        } else {
          for (let k = other.length - 2; k >= 0; k--) pts.push(other[k]);
        }
        growing = true;
      }
    }

    // Grow backward
    growing = true;
    while (growing) {
      growing = false;
      const headKey = ptKey(pts[0]);
      const cand = endpoints.get(headKey) || [];
      const viable = cand.filter((c) => !used[c.idx] && lines[c.idx].fclass === fclass);
      if (viable.length === 1) {
        const c = viable[0];
        used[c.idx] = 1;
        const other = lines[c.idx].pts;
        if (!c.atStart) {
          for (let k = other.length - 2; k >= 0; k--) pts.unshift(other[k]);
        } else {
          for (let k = 1; k < other.length; k++) pts.unshift(other[k]);
        }
        growing = true;
      }
    }

    merged.push({ major, pts, fclass });
  }

  return merged;
}

const chained = chainLines(raw);
console.log(`Chained down to ${chained.length} continuous lines.`);

// 2. Spatial snapping of endpoints that end within 300m (~0.003 deg) of another road
// This seamlessly connects cross-border links (UA-RU) and joins intersections
console.log('Snapping endpoints within 300m...');
const CELL = 0.05;
const grid = new Map();

chained.forEach((l, li) => {
  for (let i = 0; i < l.pts.length - 1; i++) {
    const [x1, y1] = l.pts[i], [x2, y2] = l.pts[i + 1];
    const minX = Math.floor(Math.min(x1, x2) / CELL), maxX = Math.floor(Math.max(x1, x2) / CELL);
    const minY = Math.floor(Math.min(y1, y2) / CELL), maxY = Math.floor(Math.max(y1, y2) / CELL);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const k = `${x},${y}`;
        (grid.get(k) ?? grid.set(k, []).get(k)).push({ li, si: i });
      }
    }
  }
});

const SNAP = 0.003; // ~300 meters
let snappedCount = 0;

chained.forEach((l, li) => {
  for (const end of [0, l.pts.length - 1]) {
    const e = l.pts[end];
    let bestDist2 = Infinity;
    let bestPoint = null;
    let targetLi = -1;
    let targetSi = -1;

    const cx = Math.floor(e[0] / CELL), cy = Math.floor(e[1] / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`) || [];
        for (const seg of bucket) {
          if (seg.li === li) continue;
          const a = chained[seg.li].pts[seg.si];
          const b = chained[seg.li].pts[seg.si + 1];
          const vx = b[0] - a[0], vy = b[1] - a[1];
          const len2 = vx * vx + vy * vy;
          if (len2 === 0) continue;
          const t = Math.max(0, Math.min(1, ((e[0] - a[0]) * vx + (e[1] - a[1]) * vy) / len2));
          const px = a[0] + t * vx, py = a[1] + t * vy;
          const d2 = (e[0] - px) ** 2 + (e[1] - py) ** 2;
          if (d2 > 1e-10 && d2 < SNAP * SNAP && d2 < bestDist2) {
            bestDist2 = d2;
            bestPoint = [Math.round(px * 100000) / 100000, Math.round(py * 100000) / 100000];
            targetLi = seg.li;
            targetSi = seg.si;
          }
        }
      }
    }

    if (bestPoint) {
      l.pts[end] = bestPoint;
      chained[targetLi].pts.splice(targetSi + 1, 0, bestPoint);
      snappedCount++;
    }
  }
});
console.log(`Snapped ${snappedCount} junctions within 300m.`);

// 3. Douglas-Peucker simplification (tol 0.00015 deg ~ 15m)
// Keeps every single turn and curve accurate to the OSM basemap, while stripping redundant straight-line points
console.log('Simplifying curves (0.00015 deg ~ 15m)...');
function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;

  function recurse(start, end) {
    let maxD = 0, maxIdx = -1;
    const [x1, y1] = pts[start], [x2, y2] = pts[end];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-12;
    for (let i = start + 1; i < end; i++) {
      const d = Math.abs((pts[i][0] - x1) * dy - (pts[i][1] - y1) * dx) / len;
      if (d > maxD) { maxD = d; maxIdx = i; }
    }
    if (maxD > tol && maxIdx > 0) {
      keep[maxIdx] = 1;
      recurse(start, maxIdx);
      recurse(maxIdx, end);
    }
  }
  recurse(0, pts.length - 1);
  return pts.filter((_, i) => keep[i]);
}

const lines = chained.map((l) => ({
  major: l.major,
  pts: simplify(l.pts, 0.00015)
}));

// Filter micro-segments (< 50m)
const minDeg = 0.0005;
const validLines = lines.filter((l) => {
  if (l.pts.length < 2) return false;
  let d = 0;
  for (let i = 0; i < l.pts.length - 1; i++) {
    d += Math.hypot(l.pts[i + 1][0] - l.pts[i][0], l.pts[i + 1][1] - l.pts[i][1]);
    if (d >= minDeg) return true;
  }
  return false;
});

const totalVertices = validLines.reduce((a, l) => a + l.pts.length, 0);
console.log(`Final output: ${validLines.length} lines, ${totalVertices} vertices.`);

const packed = validLines.map((l) => [l.major, ...l.pts.flat()]);
const json = JSON.stringify(packed);
writeFileSync(outFile, json);
console.log(`Saved ${(json.length / 1024 / 1024).toFixed(2)} MB to ${outFile}.`);
