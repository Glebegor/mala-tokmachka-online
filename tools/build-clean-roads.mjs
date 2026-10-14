import { readFileSync, writeFileSync } from 'node:fs';

const ukrPath = 'C:/Users/AKIRA/.gemini/antigravity/scratch/ukr_extracted_lines.json';
const ruPath = 'C:/Users/AKIRA/.gemini/antigravity/scratch/ru_expanded_lines.json';
const outFile = 'mods/base/maps/ukraine.roads.json';

console.log('Loading extracted road datasets...');
const ukr = JSON.parse(readFileSync(ukrPath, 'utf8'));
const ru = JSON.parse(readFileSync(ruPath, 'utf8'));
console.log(`Loaded ${ukr.length} Ukraine lines, ${ru.length} Russia lines.`);

// Ukraine: keep all classified highways, plus connecting unclassified (length > ~1.2km)
const ukrFiltered = ukr.filter((l) => {
  if (!l.pts || l.pts.length < 2) return false;
  if (l.fclass !== 'unclassified') return true;
  let len = 0;
  for (let i = 0; i < l.pts.length - 1; i++) {
    len += Math.hypot(l.pts[i + 1][0] - l.pts[i][0], l.pts[i + 1][1] - l.pts[i][1]);
  }
  return len > 0.012; // > ~1.2 km
});

const ruFiltered = ru.filter((l) => l.pts && l.pts.length >= 2);
console.log(`Retained ${ukrFiltered.length} Ukraine lines, ${ruFiltered.length} Russia lines.`);

const raw = [...ukrFiltered, ...ruFiltered];

// Set major: 1 for motorway, trunk, and primary (plus links)
const majorSet = new Set(['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link', 'primary_link']);
for (const l of raw) {
  l.major = majorSet.has(l.fclass) ? 1 : 0;
}

// 1. Chaining continuous road segments
console.log('Chaining continuous road segments...');
function chainLines(lines) {
  const ptKey = (p) => `${Math.round(p[0] * 2000)},${Math.round(p[1] * 2000)}`; // ~50m snap
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
      if (viable.length >= 1) {
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
      if (viable.length >= 1) {
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
console.log(`Chained down to ${chained.length} lines.`);

// 2. Spatial Indexing for gap healing
console.log('Building spatial index for gap healing...');
const CELL = 0.05; // ~5 km
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

// 3. Gap Healing: bridge broken roads across Ukraine & Russia
console.log('Bridging gaps on highways and connectors...');
const SNAP_MAJOR = 0.04; // ~4.0 km for major highways
const SNAP_MINOR = 0.02; // ~2.0 km for minor roads
const connectors = [];
let bridgedCount = 0;

chained.forEach((l, li) => {
  const isMajor = l.major === 1;
  const maxGap = isMajor ? SNAP_MAJOR : SNAP_MINOR;

  for (const end of [0, l.pts.length - 1]) {
    const e = l.pts[end];
    let bestDist2 = Infinity;
    let bestPoint = null;

    const span = Math.ceil(maxGap / CELL);
    const cx = Math.floor(e[0] / CELL), cy = Math.floor(e[1] / CELL);
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
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
          if (d2 > 1e-9 && d2 < maxGap * maxGap && d2 < bestDist2) {
            bestDist2 = d2;
            bestPoint = [Math.round(px * 100000) / 100000, Math.round(py * 100000) / 100000];
          }
        }
      }
    }

    if (bestPoint) {
      if (bestDist2 < 0.0025 * 0.0025) {
        // Snap endpoint directly if within 250m
        l.pts[end] = bestPoint;
      } else {
        // Add connector segment
        connectors.push({ major: l.major, pts: [e, bestPoint] });
      }
      bridgedCount++;
    }
  }
});

console.log(`Bridged ${bridgedCount} gaps, added ${connectors.length} connectors.`);

// Bridges across Dnipro
connectors.push(
  { major: 1, pts: [[32.72006, 46.67277], [32.7203, 46.66961]] },
  { major: 1, pts: [[32.72287, 46.63682], [32.72301, 46.63465]] }
);

const allLines = [...chained, ...connectors];

// 4. Douglas-Peucker curve simplification
console.log('Simplifying curves...');
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
  pts: simplify(l.pts, 0.00012)
}));

// 5. Prune disconnected stubs (lines where both endpoints connect to nothing within 400m)
console.log('Pruning floating disconnected stubs...');
const ptBucket = (p) => `${Math.round(p[0] * 250)},${Math.round(p[1] * 250)}`;
const degree = new Map();
for (const l of simplifiedLines) {
  for (const p of [l.pts[0], l.pts[l.pts.length - 1]]) {
    const k = ptBucket(p);
    degree.set(k, (degree.get(k) || 0) + 1);
  }
}

const cleanLines = simplifiedLines.filter((l) => {
  if (l.pts.length < 2) return false;
  // Always keep major roads
  if (l.major === 1) return true;
  const d0 = degree.get(ptBucket(l.pts[0])) || 0;
  const d1 = degree.get(ptBucket(l.pts[l.pts.length - 1])) || 0;
  // If isolated at both ends (no connection within ~400m), drop it
  if (d0 <= 1 && d1 <= 1) return false;
  return true;
});

const totalVertices = cleanLines.reduce((a, l) => a + l.pts.length, 0);
console.log(`Final output: ${cleanLines.length} lines, ${totalVertices} vertices.`);

const packed = cleanLines.map((l) => [l.major, ...l.pts.flat()]);
const json = JSON.stringify(packed);
writeFileSync(outFile, json);
console.log(`Saved ${(json.length / 1024 / 1024).toFixed(2)} MB to ${outFile}.`);
