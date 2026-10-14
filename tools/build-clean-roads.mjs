import { readFileSync, writeFileSync } from 'node:fs';

const ukrPath = 'C:/Users/AKIRA/.gemini/antigravity/scratch/ukr_extracted_lines.json';
const ruPath = 'C:/Users/AKIRA/.gemini/antigravity/scratch/ru_expanded_lines.json';
const outFile = 'mods/base/maps/ukraine.roads.json';

console.log('Loading extracted road datasets...');
const ukr = JSON.parse(readFileSync(ukrPath, 'utf8'));
const ru = JSON.parse(readFileSync(ruPath, 'utf8'));
console.log(`Loaded ${ukr.length} Ukraine lines, ${ru.length} Russia lines.`);

// Exclude 'unclassified' to eliminate village grid clutter, dead-end tracks, and alleys
const allowedClasses = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'
]);

const raw = [...ukr, ...ru].filter((l) => allowedClasses.has(l.fclass) && l.pts && l.pts.length > 1);
console.log(`Total candidate road features (without unclassified): ${raw.length}`);

// Set major: 1 for motorway, trunk, AND primary (plus links).
const majorSet = new Set(['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link', 'primary_link']);
for (const l of raw) {
  l.major = majorSet.has(l.fclass) ? 1 : 0;
}

// 1. Chain continuous segments of the same hierarchy
console.log('Chaining continuous road segments...');
function chainLines(lines) {
  const ptKey = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
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
    const major = lines[i].major;
    const fclass = lines[i].fclass;
    const pts = [...lines[i].pts];

    const canConnect = (otherIdx) => {
      if (used[otherIdx]) return false;
      const other = lines[otherIdx];
      if (major === 1) return other.major === 1;
      return other.fclass === fclass;
    };

    // Grow forward
    let growing = true;
    while (growing) {
      growing = false;
      const tailKey = ptKey(pts[pts.length - 1]);
      const cand = endpoints.get(tailKey) || [];
      const viable = cand.filter((c) => canConnect(c.idx));
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
      const viable = cand.filter((c) => canConnect(c.idx));
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

    merged.push({ major, pts });
  }

  return merged;
}

const chained = chainLines(raw);
console.log(`Chained down to ${chained.length} continuous lines.`);

// 2. Spatial snapping and bridging
console.log('Snapping endpoints and bridging main road gaps...');
const CELL = 0.05;
const grid = new Map();
const majorGrid = new Map();

chained.forEach((l, li) => {
  for (let i = 0; i < l.pts.length - 1; i++) {
    const [x1, y1] = l.pts[i], [x2, y2] = l.pts[i + 1];
    const minX = Math.floor(Math.min(x1, x2) / CELL), maxX = Math.floor(Math.max(x1, x2) / CELL);
    const minY = Math.floor(Math.min(y1, y2) / CELL), maxY = Math.floor(Math.max(y1, y2) / CELL);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const k = `${x},${y}`;
        (grid.get(k) ?? grid.set(k, []).get(k)).push({ li, si: i });
        if (l.major === 1) {
          (majorGrid.get(k) ?? majorGrid.set(k, []).get(k)).push({ li, si: i });
        }
      }
    }
  }
});

const SNAP_STD = 0.008; // ~800 meters
const SNAP_MAJOR = 0.02; // ~2 km for major highways
let snappedCount = 0;
const connectors = [];

chained.forEach((l, li) => {
  const isMajor = l.major === 1;
  const snapDist = isMajor ? SNAP_MAJOR : SNAP_STD;
  const activeGrid = isMajor ? majorGrid : grid;

  for (const end of [0, l.pts.length - 1]) {
    const e = l.pts[end];
    let bestDist2 = Infinity;
    let bestPoint = null;
    let targetLi = -1;
    let targetSi = -1;

    const span = Math.ceil(snapDist / CELL);
    const cx = Math.floor(e[0] / CELL), cy = Math.floor(e[1] / CELL);
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        const bucket = activeGrid.get(`${cx + dx},${cy + dy}`) || [];
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
          if (d2 > 1e-10 && d2 < snapDist * snapDist && d2 < bestDist2) {
            bestDist2 = d2;
            bestPoint = [Math.round(px * 100000) / 100000, Math.round(py * 100000) / 100000];
            targetLi = seg.li;
            targetSi = seg.si;
          }
        }
      }
    }

    if (bestPoint) {
      if (bestDist2 < 0.001 * 0.001) {
        l.pts[end] = bestPoint;
        chained[targetLi].pts.splice(targetSi + 1, 0, bestPoint);
      } else {
        connectors.push({ major: l.major, pts: [e, bestPoint] });
        chained[targetLi].pts.splice(targetSi + 1, 0, bestPoint);
      }
      snappedCount++;
    }
  }
});

console.log(`Snapped/bridged ${snappedCount} junctions (added ${connectors.length} connectors).`);
const allLines = [...chained, ...connectors];

// Bridges across Dnipro
allLines.push(
  { major: 1, pts: [[32.72006, 46.67277], [32.7203, 46.66961]] },
  { major: 1, pts: [[32.72287, 46.63682], [32.72301, 46.63465]] }
);

// 3. Douglas-Peucker simplification
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

const simplifiedLines = allLines.map((l) => ({
  major: l.major,
  pts: simplify(l.pts, 0.00015)
}));

// 4. Strict graph connectivity with ~100m vertex equivalence
console.log('Analyzing road network graph connectivity...');
const vKey = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
const vMap = new Map();
let nextVId = 0;
const getVId = (p) => {
  const k = vKey(p);
  let id = vMap.get(k);
  if (id === undefined) {
    id = nextVId++;
    vMap.set(k, id);
  }
  return id;
};

const adj = [];
for (const l of simplifiedLines) {
  for (let i = 0; i < l.pts.length - 1; i++) {
    const u = getVId(l.pts[i]);
    const v = getVId(l.pts[i + 1]);
    while (adj.length <= Math.max(u, v)) adj.push([]);
    if (u !== v) {
      adj[u].push(v);
      adj[v].push(u);
    }
  }
}

// Connected components
const comp = new Int32Array(adj.length).fill(-1);
const compSizes = [];
for (let i = 0; i < adj.length; i++) {
  if (comp[i] >= 0) continue;
  const cId = compSizes.length;
  let size = 0;
  const stack = [i];
  comp[i] = cId;
  while (stack.length) {
    const curr = stack.pop();
    size++;
    for (const nxt of adj[curr]) {
      if (comp[nxt] < 0) {
        comp[nxt] = cId;
        stack.push(nxt);
      }
    }
  }
  compSizes.push(size);
}

const sortedComps = compSizes.map((s, id) => ({ id, size: s })).sort((a, b) => b.size - a.size);
console.log('Top 5 component sizes:', sortedComps.slice(0, 5));

// Keep components that have >= 200 vertices (removes all isolated stubs and small disconnected artifacts)
const validCompIds = new Set(sortedComps.filter((c) => c.size >= 200).map((c) => c.id));
console.log(`Retaining ${validCompIds.size} major connected components (>= 200 vertices each).`);

const connectedLines = simplifiedLines.filter((l) => {
  if (l.pts.length < 2) return false;
  return l.pts.some((p) => validCompIds.has(comp[getVId(p)]));
});

// Drop lines that are completely isolated single segments without any junction
const degMap = new Map();
for (const l of connectedLines) {
  for (const p of [l.pts[0], l.pts[l.pts.length - 1]]) {
    const id = getVId(p);
    degMap.set(id, (degMap.get(id) || 0) + 1);
  }
}

// A line whose BOTH ends have degree 1 and doesn't connect to any other road is a detached stub!
const finalLines = connectedLines.filter((l) => {
  if (l.pts.length < 2) return false;
  const d0 = degMap.get(getVId(l.pts[0])) || 0;
  const d1 = degMap.get(getVId(l.pts[l.pts.length - 1])) || 0;
  // If both ends touch nothing else and it's short, drop it
  if (d0 <= 1 && d1 <= 1 && l.pts.length <= 4) {
    let len = 0;
    for (let i = 0; i < l.pts.length - 1; i++) {
      len += Math.hypot(l.pts[i + 1][0] - l.pts[i][0], l.pts[i + 1][1] - l.pts[i][1]);
    }
    if (len < 0.01) return false; // < 1 km detached stub
  }
  return true;
});

const totalVertices = finalLines.reduce((a, l) => a + l.pts.length, 0);
console.log(`Final output: ${finalLines.length} lines, ${totalVertices} vertices.`);

const packed = finalLines.map((l) => [l.major, ...l.pts.flat()]);
const json = JSON.stringify(packed);
writeFileSync(outFile, json);
console.log(`Saved ${(json.length / 1024 / 1024).toFixed(2)} MB to ${outFile}.`);
