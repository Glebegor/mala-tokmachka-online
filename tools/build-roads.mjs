// Extracts the road network for a map from Natural Earth's public-domain 1:10m roads.
// usage: node tools/build-roads.mjs <ne_10m_roads.geojson> <west,south,east,north> <out.json>
// source: https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_10m_roads.geojson
import { readFileSync, writeFileSync } from 'node:fs';

const [src, bboxArg, out] = process.argv.slice(2);
const [W, S, E, N] = bboxArg.split(',').map(Number);
const inside = (c) => c[0] >= W && c[0] <= E && c[1] >= S && c[1] <= N;
const round = (v) => Math.round(v * 1000) / 1000;

const data = JSON.parse(readFileSync(src, 'utf8'));
const raw = [];
for (const f of data.features) {
  if (!f.geometry || f.properties.type === 'Ferry Route') continue;
  const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const major = f.properties.type === 'Major Highway' || f.properties.type === 'Secondary Highway' ? 1 : 0;
  for (const part of parts) {
    // keep the runs of vertices that fall inside the bbox
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

// --- make the network routable: node crossings and snap dead ends onto the road they meet ---
const CELL = 0.1;
const cellsOf = (a, b) => {
  const out = [];
  for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++)
    for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) out.push(`${x},${y}`);
  return out;
};
const grid = new Map();
raw.forEach((l, li) => {
  for (let i = 0; i + 1 < l.pts.length; i++) for (const c of cellsOf(l.pts[i], l.pts[i + 1])) (grid.get(c) ?? grid.set(c, []).get(c)).push([li, i]);
});
const inserts = raw.map(() => []); // per line: { seg, t, p }
const addInsert = (li, seg, t, p) => t > 1e-6 && t < 1 - 1e-6 && inserts[li].push({ seg, t, p });
const seen = new Set();
let crossings = 0, snapped = 0;
for (const bucket of grid.values()) {
  for (let m = 0; m < bucket.length; m++) {
    for (let n = m + 1; n < bucket.length; n++) {
      const [la, ia] = bucket[m], [lb, ib] = bucket[n];
      if (la === lb) continue;
      const key = `${la}:${ia}|${lb}:${ib}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [p1, p2, p3, p4] = [raw[la].pts[ia], raw[la].pts[ia + 1], raw[lb].pts[ib], raw[lb].pts[ib + 1]];
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
// dead ends that stop within ~1.5 km of another road are joined to it
const SNAP = 0.02;
raw.forEach((l, li) => {
  for (const end of [0, l.pts.length - 1]) {
    const e = l.pts[end];
    let best = null;
    for (const c of cellsOf([e[0] - SNAP, e[1] - SNAP], [e[0] + SNAP, e[1] + SNAP])) {
      for (const [lb, ib] of grid.get(c) ?? []) {
        if (lb === li) continue;
        const a = raw[lb].pts[ib], b = raw[lb].pts[ib + 1];
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
      if (best.t <= 1e-6) l.pts[end] = raw[best.lb].pts[best.ib];
      if (best.t >= 1 - 1e-6) l.pts[end] = raw[best.lb].pts[best.ib + 1];
      snapped++;
    }
  }
});
raw.forEach((l, li) => {
  if (!inserts[li].length) return;
  const out = [];
  l.pts.forEach((p, i) => {
    out.push(p);
    inserts[li].filter((x) => x.seg === i).sort((a, b) => a.t - b.t).forEach((x) => out.push(x.p));
  });
  l.pts = out;
});
console.log(`${crossings} crossings noded, ${snapped} dead ends snapped`);

// vertices used by more than one line are junctions and must survive simplification
const uses = new Map();
for (const l of raw) for (const k of new Set(l.pts.map((p) => p.join(',')))) uses.set(k, (uses.get(k) ?? 0) + 1);
const isJunction = (p) => uses.get(p.join(',')) > 1;
const lines = raw.map((l) => ({ major: l.major, pts: simplify(l.pts, 0.004) }));

/** Douglas-Peucker in degrees (fine at this scale). */
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

writeFileSync(out, JSON.stringify(lines.map((l) => [l.major, ...l.pts.flat()])));
console.log(`${lines.length} lines, ${lines.reduce((a, l) => a + l.pts.length, 0)} points -> ${out}`);
