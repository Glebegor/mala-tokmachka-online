import { readFileSync, writeFileSync } from 'node:fs';

const [src, bboxArg, out] = process.argv.slice(2);
const srcFile = src || 'C:/Users/AKIRA/.gemini/antigravity/scratch/ukr_roads.geojson';
const bbox = bboxArg ? bboxArg.split(',').map(Number) : [22.0, 43.8, 41.5, 53.2];
const outFile = out || 'mods/base/maps/ukraine.roads.json';

const [W, S, E, N] = bbox;
const inside = (c) => c[0] >= W && c[0] <= E && c[1] >= S && c[1] <= N;
const round = (v) => Math.round(v * 1000) / 1000;

console.log(`Loading ${srcFile}...`);
const data = JSON.parse(readFileSync(srcFile, 'utf8'));

console.log(`Extracting lines within bounds [${W}, ${S}, ${E}, ${N}]...`);
const raw = [];
for (const f of data.features) {
  if (!f.geometry) continue;
  const major = f.properties?.ntlclass === 'motorway' || f.properties?.ntlclass === 'trunk' ? 1 : 0;
  const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const part of parts) {
    let run = [];
    const flush = () => {
      if (run.length > 1) raw.push({ major, pts: run });
      run = [];
    };
    for (const c of part) {
      if (inside(c)) run.push([round(c[0]), round(c[1])]);
      else flush();
    }
    flush();
  }
}
console.log(`Extracted ${raw.length} segments.`);

// Chain contiguous segments of the same major type
function chainLines(lines) {
  const ptKey = (p) => `${p[0]},${p[1]}`;
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
    const pts = [...lines[i].pts];

    let growing = true;
    while (growing) {
      growing = false;
      const tailKey = ptKey(pts[pts.length - 1]);
      const candidates = endpoints.get(tailKey) || [];
      const viable = candidates.filter((c) => !used[c.idx] && lines[c.idx].major === major);
      if (viable.length === 1) {
        const next = viable[0];
        used[next.idx] = 1;
        const nextPts = lines[next.idx].pts;
        if (next.atStart) pts.push(...nextPts.slice(1));
        else pts.push(...[...nextPts].reverse().slice(1));
        growing = true;
      }
    }

    growing = true;
    while (growing) {
      growing = false;
      const headKey = ptKey(pts[0]);
      const candidates = endpoints.get(headKey) || [];
      const viable = candidates.filter((c) => !used[c.idx] && lines[c.idx].major === major);
      if (viable.length === 1) {
        const prev = viable[0];
        used[prev.idx] = 1;
        const prevPts = lines[prev.idx].pts;
        if (!prev.atStart) pts.unshift(...prevPts.slice(0, -1));
        else pts.unshift(...[...prevPts].reverse().slice(0, -1));
        growing = true;
      }
    }

    merged.push({ major, pts });
  }

  return merged;
}

const chained = chainLines(raw);
console.log(`Chained down to ${chained.length} lines.`);

// Build spatial grid for crossings and snapping
const CELL = 0.05;
const cellsOf = (a, b) => {
  const out = [];
  const minX = Math.floor(Math.min(a[0], b[0]) / CELL);
  const maxX = Math.floor(Math.max(a[0], b[0]) / CELL);
  const minY = Math.floor(Math.min(a[1], b[1]) / CELL);
  const maxY = Math.floor(Math.max(a[1], b[1]) / CELL);
  for (let x = minX; x <= maxX; x++)
    for (let y = minY; y <= maxY; y++) out.push(`${x},${y}`);
  return out;
};

const grid = new Map();
chained.forEach((l, li) => {
  for (let i = 0; i + 1 < l.pts.length; i++) {
    for (const c of cellsOf(l.pts[i], l.pts[i + 1])) {
      (grid.get(c) ?? grid.set(c, []).get(c)).push([li, i]);
    }
  }
});

const inserts = chained.map(() => []);
const addInsert = (li, seg, t, p) => t > 1e-6 && t < 1 - 1e-6 && inserts[li].push({ seg, t, p });
let crossings = 0, snapped = 0;

for (const [cellKey, bucket] of grid.entries()) {
  for (let m = 0; m < bucket.length; m++) {
    const [la, ia] = bucket[m];
    const p1 = chained[la].pts[ia], p2 = chained[la].pts[ia + 1];
    const minXa = Math.min(p1[0], p2[0]), maxXa = Math.max(p1[0], p2[0]);
    const minYa = Math.min(p1[1], p2[1]), maxYa = Math.max(p1[1], p2[1]);

    for (let n = m + 1; n < bucket.length; n++) {
      const [lb, ib] = bucket[n];
      if (la === lb) continue;
      const p3 = chained[lb].pts[ib], p4 = chained[lb].pts[ib + 1];
      const minXb = Math.min(p3[0], p4[0]), maxXb = Math.max(p3[0], p4[0]);
      const minYb = Math.min(p3[1], p4[1]), maxYb = Math.max(p3[1], p4[1]);

      // Bounding box test
      if (maxXa < minXb || maxXb < minXa || maxYa < minYb || maxYb < minYa) continue;

      // Ensure pair is evaluated in exactly one cell (the top-left cell of the bbox intersection)
      const interMinX = Math.max(minXa, minXb);
      const interMinY = Math.max(minYa, minYb);
      const anchorCell = `${Math.floor(interMinX / CELL)},${Math.floor(interMinY / CELL)}`;
      if (cellKey !== anchorCell) continue;

      const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
      if (Math.abs(d) < 1e-12) continue;
      const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
      const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const p = [round(p1[0] + (p2[0] - p1[0]) * t), round(p1[1] + (p2[1] - p1[1]) * t)];
      addInsert(la, ia, t, p);
      addInsert(lb, ib, u, p);
      crossings++;
    }
  }
}

// Dead ends that stop within ~1.5 km (SNAP = 0.02) of another road are joined
const SNAP = 0.02;
chained.forEach((l, li) => {
  for (const end of [0, l.pts.length - 1]) {
    const e = l.pts[end];
    let best = null;
    for (const c of cellsOf([e[0] - SNAP, e[1] - SNAP], [e[0] + SNAP, e[1] + SNAP])) {
      for (const [lb, ib] of grid.get(c) ?? []) {
        if (lb === li) continue;
        const a = chained[lb].pts[ib], b = chained[lb].pts[ib + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((e[0] - a[0]) * dx + (e[1] - a[1]) * dy) / (dx * dx + dy * dy || 1e-12)));
        const q = [a[0] + dx * t, a[1] + dy * t];
        const dist = Math.hypot(q[0] - e[0], q[1] - e[1]);
        if (dist < SNAP && (!best || dist < best.dist)) best = { dist, lb, ib, t, q: [round(q[0]), round(q[1])] };
      }
    }
    if (best && best.dist > 0) {
      l.pts[end] = best.q;
      addInsert(best.lb, best.ib, best.t, best.q);
      if (best.t <= 1e-6) l.pts[end] = chained[best.lb].pts[best.ib];
      if (best.t >= 1 - 1e-6) l.pts[end] = chained[best.lb].pts[best.ib + 1];
      snapped++;
    }
  }
});

chained.forEach((l, li) => {
  if (!inserts[li].length) return;
  const out = [];
  l.pts.forEach((p, i) => {
    out.push(p);
    inserts[li].filter((x) => x.seg === i).sort((a, b) => a.t - b.t).forEach((x) => out.push(x.p));
  });
  l.pts = out;
});
console.log(`${crossings} crossings noded, ${snapped} dead ends snapped.`);

// Junction preservation & Douglas-Peucker simplification
const uses = new Map();
for (const l of chained) {
  for (const k of new Set(l.pts.map((p) => p.join(',')))) uses.set(k, (uses.get(k) ?? 0) + 1);
}
const isJunction = (p) => (uses.get(p.join(',')) ?? 0) > 1;

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  pts.forEach((p, i) => isJunction(p) && (keep[i] = 1));
  const anchors = [...keep.keys()].filter((i) => keep[i]);
  const stack = anchors.slice(1).map((b, i) => [anchors[i], b]);
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > worst) (worst = d), (idx = i);
    }
    if (worst > tol) (keep[idx] = 1), stack.push([a, idx], [idx, b]);
  }
  return pts.filter((_, i) => keep[i]);
}

const lines = chained.map((l) => ({ major: l.major, pts: simplify(l.pts, 0.002) }));
const packed = lines.map((l) => [l.major, ...l.pts.flat()]);
writeFileSync(outFile, JSON.stringify(packed));
const totalPts = lines.reduce((a, l) => a + l.pts.length, 0);
console.log(`${lines.length} lines, ${totalPts} points written to ${outFile}.`);
