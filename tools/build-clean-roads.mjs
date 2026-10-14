import { readFileSync, writeFileSync } from 'node:fs';

const ukrPath = 'C:/Users/AKIRA/.gemini/antigravity/scratch/ukr_extracted_lines.json';
const ruPath = 'C:/Users/AKIRA/.gemini/antigravity/scratch/ru_expanded_lines.json';
const mapPath = 'mods/base/maps/ukraine.json';
const outFile = 'mods/base/maps/ukraine.roads.json';

console.log('Loading datasets...');
const ukr = JSON.parse(readFileSync(ukrPath, 'utf8'));
const ru = JSON.parse(readFileSync(ruPath, 'utf8'));
const mapData = JSON.parse(readFileSync(mapPath, 'utf8'));
const cities = mapData.capturePoints.map((c) => c.pos);

console.log(`Loaded ${ukr.length} Ukraine lines, ${ru.length} Russia lines, ${cities.length} cities.`);

function distKm(p1, p2) {
  const dx = (p2[0] - p1[0]) * 71.5;
  const dy = (p2[1] - p1[1]) * 111.3;
  return Math.hypot(dx, dy);
}

function lineLenKm(pts) {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) len += distKm(pts[i], pts[i + 1]);
  return len;
}

function isInsideAnyCity(p, radiusKm = 4.0) {
  for (const c of cities) {
    if (distKm(p, c) < radiusKm) return true;
  }
  return false;
}

// Allowed major arterial classes (no links, no residential clutter)
const arterialSet = new Set(['motorway', 'trunk', 'primary', 'secondary']);

// 1. Filtering:
// - Keep all arterial highways (motorway, trunk, primary, secondary)
// - For tertiary: keep ONLY rural connector roads (length > 2.5 km and not inside city centers)
// - Drop all _link roads and unclassified roads to eliminate cloverleaf clutter and neighborhood tangles
console.log('Filtering roads to clean arterial network...');

function cleanFilter(lines) {
  return lines.filter((l) => {
    if (!l.pts || l.pts.length < 2) return false;
    const fc = l.fclass;
    if (arterialSet.has(fc)) return true;
    if (fc === 'tertiary') {
      const len = lineLenKm(l.pts);
      if (len < 2.5) return false;
      // If road is inside a city center, drop it to avoid urban clutter
      if (isInsideAnyCity(l.pts[0], 3.5) || isInsideAnyCity(l.pts[l.pts.length - 1], 3.5)) return false;
      return true;
    }
    return false;
  });
}

const ukrFiltered = cleanFilter(ukr);
const ruFiltered = cleanFilter(ru);
console.log(`Retained ${ukrFiltered.length} Ukraine arterial lines, ${ruFiltered.length} Russia arterial lines.`);

const raw = [...ukrFiltered, ...ruFiltered];
for (const l of raw) {
  l.major = (l.fclass === 'motorway' || l.fclass === 'trunk' || l.fclass === 'primary' || l.fclass === 'secondary') ? 1 : 0;
}

// 2. Chaining continuous road segments (avoiding 180° hairpin U-turn reversals)
console.log('Pass 1: Chaining continuous road segments...');
function chainLines(lines, snapMeters = 80) {
  const factor = 111320 / snapMeters;
  const ptKey = (p) => `${Math.round(p[0] * factor)},${Math.round(p[1] * factor)}`;
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
    let major = lines[i].major;
    const pts = [...lines[i].pts];

    const canConnect = (otherIdx) => {
      if (used[otherIdx]) return false;
      const other = lines[otherIdx];
      if (major === 1 && other.major === 1) return true;
      if (major === 0 && other.major === 0) return true;
      return false;
    };

    // Grow forward
    let growing = true;
    while (growing) {
      growing = false;
      const n = pts.length;
      const tailKey = ptKey(pts[n - 1]);
      const cand = endpoints.get(tailKey) || [];
      const viable = cand.filter((c) => canConnect(c.idx));

      if (viable.length >= 1) {
        const curDirX = pts[n - 1][0] - pts[n - 2][0];
        const curDirY = pts[n - 1][1] - pts[n - 2][1];
        const curLen = Math.hypot(curDirX, curDirY) || 1e-9;

        let bestC = null;
        let bestDot = -Infinity;

        for (const c of viable) {
          const other = lines[c.idx].pts;
          const otherDirX = c.atStart ? (other[1][0] - other[0][0]) : (other[other.length - 2][0] - other[other.length - 1][0]);
          const otherDirY = c.atStart ? (other[1][1] - other[0][1]) : (other[other.length - 2][1] - other[other.length - 1][1]);
          const otherLen = Math.hypot(otherDirX, otherDirY) || 1e-9;
          const dot = (curDirX * otherDirX + curDirY * otherDirY) / (curLen * otherLen);

          // Avoid acute U-turns into opposite carriageways
          if (dot > -0.6 && dot > bestDot) {
            bestDot = dot;
            bestC = c;
          }
        }

        if (bestC) {
          used[bestC.idx] = 1;
          const other = lines[bestC.idx].pts;
          if (bestC.atStart) {
            for (let k = 1; k < other.length; k++) pts.push(other[k]);
          } else {
            for (let k = other.length - 2; k >= 0; k--) pts.push(other[k]);
          }
          growing = true;
        }
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
        const curDirX = pts[0][0] - pts[1][0];
        const curDirY = pts[0][1] - pts[1][1];
        const curLen = Math.hypot(curDirX, curDirY) || 1e-9;

        let bestC = null;
        let bestDot = -Infinity;

        for (const c of viable) {
          const other = lines[c.idx].pts;
          const otherDirX = !c.atStart ? (other[other.length - 2][0] - other[other.length - 1][0]) : (other[1][0] - other[0][0]);
          const otherDirY = !c.atStart ? (other[other.length - 2][1] - other[other.length - 1][1]) : (other[1][1] - other[0][1]);
          const otherLen = Math.hypot(otherDirX, otherDirY) || 1e-9;
          const dot = (curDirX * otherDirX + curDirY * otherDirY) / (curLen * otherLen);

          if (dot > -0.6 && dot > bestDot) {
            bestDot = dot;
            bestC = c;
          }
        }

        if (bestC) {
          used[bestC.idx] = 1;
          const other = lines[bestC.idx].pts;
          if (!bestC.atStart) {
            for (let k = other.length - 2; k >= 0; k--) pts.unshift(other[k]);
          } else {
            for (let k = 1; k < other.length; k++) pts.unshift(other[k]);
          }
          growing = true;
        }
      }
    }

    merged.push({ major, pts });
  }

  return merged;
}

const chained1 = chainLines(raw, 80);
console.log(`Chained Pass 1: ${chained1.length} lines.`);

// 3. Artificial Gap Healing with strict Water & Bridge validation
console.log('Artificial Gap Healing: connecting open endpoints and bridging gaps...');

// Real bridges over Dnipro river:
// Any segment that crosses the Dnipro outside these bounds is strictly rejected!
function crossesDniproIllegally(p1, p2) {
  // Kremenchuk area: Dnipro is between lat 49.03 and 49.07, lng 33.35 and 33.55
  // Real Kryukivsky bridge is at lng 33.424, lat 49.053
  if (Math.min(p1[1], p2[1]) < 49.045 && Math.max(p1[1], p2[1]) > 49.065) {
    if (p1[0] > 33.38 && p1[0] < 33.55 && p2[0] > 33.38 && p2[0] < 33.55) {
      const avgLng = (p1[0] + p2[0]) * 0.5;
      // Real bridge is strictly at lng ~33.424. If east of 33.435 or west of 33.415, it's illegal!
      if (avgLng > 33.435 || avgLng < 33.415) return true;
    }
  }

  // Cherkasy area: Dnipro is around lat 49.43, lng 32.06
  if (Math.min(p1[1], p2[1]) < 49.40 && Math.max(p1[1], p2[1]) > 49.46) {
    if (p1[0] > 31.95 && p1[0] < 32.25) {
      const avgLng = (p1[0] + p2[0]) * 0.5;
      if (avgLng < 32.02 || avgLng > 32.10) return true;
    }
  }

  // Dnipro city / Zaporizhzhia / Kakhovka: reject long crossings (> 1.2 km) across wide water
  const d = distKm(p1, p2);
  if (d > 1.2) {
    // If endpoints are on opposite sides of Dnipro longitude in central/southern Ukraine
    if ((p1[0] < 34.8 && p2[0] > 35.2) || (p1[0] > 35.2 && p2[0] < 34.8)) return true;
    if ((p1[0] < 32.5 && p2[0] > 33.0) || (p1[0] > 33.0 && p2[0] < 32.5)) return true;
  }

  return false;
}

// 3a. Direct Major Endpoint-to-Endpoint Stitching
console.log('Stitching severed major highway endpoints...');
const majorEndpoints = [];
chained1.forEach((l, li) => {
  if (l.major === 1) {
    majorEndpoints.push({ li, end: 0, p: l.pts[0] });
    majorEndpoints.push({ li, end: l.pts.length - 1, p: l.pts[l.pts.length - 1] });
  }
});

const SNAP_MAJOR_EP = 0.004; // ~400m direct snap
const BRIDGE_MAJOR_EP = 0.015; // ~1.5 km maximum bridge gap (never 6km!)
const epConnectors = [];

const EP_CELL = 0.03;
const epGrid = new Map();
majorEndpoints.forEach((ep, epi) => {
  const k = `${Math.floor(ep.p[0] / EP_CELL)},${Math.floor(ep.p[1] / EP_CELL)}`;
  (epGrid.get(k) ?? epGrid.set(k, []).get(k)).push(epi);
});

majorEndpoints.forEach((ep1, i) => {
  let bestD2 = Infinity;
  let bestEpi = -1;
  const cx = Math.floor(ep1.p[0] / EP_CELL), cy = Math.floor(ep1.p[1] / EP_CELL);
  const span = Math.ceil(BRIDGE_MAJOR_EP / EP_CELL);

  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -span; dy <= span; dy++) {
      const bucket = epGrid.get(`${cx + dx},${cy + dy}`) || [];
      for (const epi of bucket) {
        if (epi <= i) continue;
        const ep2 = majorEndpoints[epi];
        if (ep2.li === ep1.li) continue;

        // Check distance
        const d2 = (ep1.p[0] - ep2.p[0]) ** 2 + (ep1.p[1] - ep2.p[1]) ** 2;
        if (d2 > 1e-9 && d2 < BRIDGE_MAJOR_EP * BRIDGE_MAJOR_EP && d2 < bestD2) {
          // Verify does not cross Dnipro illegally
          if (!crossesDniproIllegally(ep1.p, ep2.p)) {
            bestD2 = d2;
            bestEpi = epi;
          }
        }
      }
    }
  }

  if (bestEpi >= 0) {
    const ep2 = majorEndpoints[bestEpi];
    if (bestD2 < SNAP_MAJOR_EP * SNAP_MAJOR_EP) {
      const mid = [(ep1.p[0] + ep2.p[0]) * 0.5, (ep1.p[1] + ep2.p[1]) * 0.5];
      chained1[ep1.li].pts[ep1.end] = mid;
      chained1[ep2.li].pts[ep2.end] = mid;
    } else {
      epConnectors.push({ major: 1, pts: [ep1.p, ep2.p] });
    }
  }
});
console.log(`Stitched major endpoints, added ${epConnectors.length} highway bridges.`);

// 3b. Endpoint-to-Segment Gap Bridging (T-junctions, ramps)
console.log('Bridging road-to-segment junctions...');
const CELL = 0.03;
const grid = new Map();

chained1.forEach((l, li) => {
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

const SNAP_MAJOR = 0.015; // ~1.5 km
const SNAP_MINOR = 0.008; // ~800m
const DIRECT_SNAP = 0.0035; // ~350m
const segConnectors = [];
let bridgedCount = 0;

chained1.forEach((l, li) => {
  const maxGap = l.major === 1 ? SNAP_MAJOR : SNAP_MINOR;

  for (const end of [0, l.pts.length - 1]) {
    const e = l.pts[end];
    let bestDist2 = Infinity;
    let bestPoint = null;
    let bestTargetMajor = 0;

    const span = Math.ceil(maxGap / CELL);
    const cx = Math.floor(e[0] / CELL), cy = Math.floor(e[1] / CELL);

    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`) || [];
        for (const seg of bucket) {
          if (seg.li === li) continue;
          const targetLine = chained1[seg.li];
          const a = targetLine.pts[seg.si];
          const b = targetLine.pts[seg.si + 1];
          const vx = b[0] - a[0], vy = b[1] - a[1];
          const len2 = vx * vx + vy * vy;
          if (len2 === 0) continue;
          const t = Math.max(0, Math.min(1, ((e[0] - a[0]) * vx + (e[1] - a[1]) * vy) / len2));
          const px = a[0] + t * vx, py = a[1] + t * vy;
          const d2 = (e[0] - px) ** 2 + (e[1] - py) ** 2;

          if (d2 > 1e-9 && d2 < maxGap * maxGap && d2 < bestDist2) {
            const candPt = [Math.round(px * 100000) / 100000, Math.round(py * 100000) / 100000];
            if (!crossesDniproIllegally(e, candPt)) {
              bestDist2 = d2;
              bestPoint = candPt;
              bestTargetMajor = targetLine.major;
            }
          }
        }
      }
    }

    if (bestPoint) {
      const connMajor = (l.major === 1 || bestTargetMajor === 1) ? 1 : 0;
      if (bestDist2 < DIRECT_SNAP * DIRECT_SNAP) {
        l.pts[end] = bestPoint;
      } else {
        segConnectors.push({ major: connMajor, pts: [e, bestPoint] });
      }
      bridgedCount++;
    }
  }
});

console.log(`Bridged ${bridgedCount} gaps, added ${segConnectors.length} segment connectors.`);

// Known real bridges (e.g. Antonivsky / Kherson bypass)
const fixedConnectors = [
  { major: 1, pts: [[32.72006, 46.67277], [32.7203, 46.66961]] },
  { major: 1, pts: [[32.72287, 46.63682], [32.72301, 46.63465]] }
];

// 4. Pass 2 Chaining
console.log('Pass 2: Re-chaining with connectors into unified continuous highways...');
const allConnected = [...chained1, ...epConnectors, ...segConnectors, ...fixedConnectors];
const chained2 = chainLines(allConnected, 100);
console.log(`Pass 2 chained to ${chained2.length} unified lines.`);

// 5. Douglas-Peucker curve simplification with EUCLIDEAN FALLBACK FOR LOOPS
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
    const len = Math.hypot(dx, dy);

    for (let i = start + 1; i < end; i++) {
      const d = len < 1e-6
        ? Math.hypot(pts[i][0] - x1, pts[i][1] - y1)
        : Math.abs((pts[i][0] - x1) * dy - (pts[i][1] - y1) * dx) / len;

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

const simplifiedLines = chained2.map((l) => ({
  major: l.major,
  pts: simplify(l.pts, 0.00008) // ~8m accuracy
}));

// 6. Prune dead ends and illegal river cuts
console.log('Final validation and cleanup...');
const ptBucket = (p) => `${Math.round(p[0] * 300)},${Math.round(p[1] * 300)}`;

let currentLines = simplifiedLines.filter((l) => {
  if (!l.pts || l.pts.length < 2) return false;
  // Discard zero-length collapsed lines
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of l.pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  if ((maxX - minX) < 0.0003 && (maxY - minY) < 0.0003) return false;

  // Double check no segment of this line crosses Dnipro illegally
  for (let i = 0; i < l.pts.length - 1; i++) {
    if (crossesDniproIllegally(l.pts[i], l.pts[i + 1])) {
      console.log('Filtered illegal river crossing segment:', l.pts[i], '->', l.pts[i + 1]);
      return false;
    }
  }

  return true;
});

// Prune minor dead-end spurs
for (let iter = 0; iter < 2; iter++) {
  const degree = new Map();
  for (const l of currentLines) {
    for (const p of [l.pts[0], l.pts[l.pts.length - 1]]) {
      const k = ptBucket(p);
      degree.set(k, (degree.get(k) || 0) + 1);
    }
  }

  currentLines = currentLines.filter((l) => {
    if (l.major === 1) return true;
    const d0 = degree.get(ptBucket(l.pts[0])) || 0;
    const d1 = degree.get(ptBucket(l.pts[l.pts.length - 1])) || 0;
    if (d0 <= 1 && d1 <= 1) return false;
    if ((d0 <= 1 || d1 <= 1) && lineLenKm(l.pts) < 2.5) return false;
    return true;
  });
}

const cleanLines = currentLines;
const totalVertices = cleanLines.reduce((a, l) => a + l.pts.length, 0);
console.log(`Final output: ${cleanLines.length} lines, ${totalVertices} vertices.`);

const packed = cleanLines.map((l) => [l.major, ...l.pts.flat()]);
const json = JSON.stringify(packed);
writeFileSync(outFile, json);
console.log(`Saved ${(json.length / 1024 / 1024).toFixed(2)} MB to ${outFile}.`);
