import type { LngLat } from './geo';
import { distKm, kmPerDegLng } from './geo';
import type { FrontNode, Pocket, Team } from './state';

const KM = 111.32;

/** Resample an authored polyline into nodes roughly `spacingKm` apart. */
export function buildFront(line: LngLat[], spacingKm: number): FrontNode[] {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += distKm(line[i - 1], line[i]);
  const count = Math.max(8, Math.min(1200, Math.round(total / spacingKm) + 1));
  const nodes = resample(line.map((p) => ({ lng: p[0], lat: p[1], v: 0 })), count);
  for (let i = 1; i < nodes.length - 1; i++) {
    const p = nodes[i - 1];
    const cur = nodes[i];
    const n = nodes[i + 1];
    const kx = kmPerDegLng(cur.lat);
    const v1x = (cur.lng - p.lng) * kx;
    const v1y = (cur.lat - p.lat) * 111.32;
    const v2x = (n.lng - cur.lng) * kx;
    const v2y = (n.lat - cur.lat) * 111.32;
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);
    if (len1 > 0 && len2 > 0) {
      const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
      if (dot < -0.3) {
        cur.lng = (p.lng + n.lng) / 2;
        cur.lat = (p.lat + n.lat) / 2;
      }
    }
  }
  return nodes;
}

/** Redistribute nodes evenly along the line (keeps the shape, stops nodes bunching up or drifting apart). */
export function resample(nodes: FrontNode[], count = nodes.length): FrontNode[] {
  const cum = [0];
  for (let i = 1; i < nodes.length; i++) cum.push(cum[i - 1] + distKm([nodes[i - 1].lng, nodes[i - 1].lat], [nodes[i].lng, nodes[i].lat]));
  const total = cum[cum.length - 1];
  const out: FrontNode[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = (total * k) / (count - 1);
    while (seg < nodes.length - 2 && cum[seg + 1] < d) seg++;
    const a = nodes[seg];
    const b = nodes[seg + 1];
    const len = cum[seg + 1] - cum[seg];
    const t = len > 0 ? Math.min(1, Math.max(0, (d - cum[seg]) / len)) : 0;
    out.push({ lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t, v: a.v + (b.v - a.v) * t });
  }
  return out;
}

/**
 * Keep node spacing healthy without moving nodes that are fine: split segments that stretched too far and drop nodes
 * that bunched up. Unlike a global resample this never rounds off the corners of the line.
 */
export function respace(nodes: FrontNode[], spacingKm: number): FrontNode[] {
  const out: FrontNode[] = [nodes[0]];
  for (let i = 1; i < nodes.length; i++) {
    const cur = nodes[i];
    const last = out[out.length - 1];
    const next = nodes[i + 1];
    // drop a node squeezed between two close neighbours
    if (next && distKm([last.lng, last.lat], [next.lng, next.lat]) < spacingKm) continue;
    const gap = distKm([last.lng, last.lat], [cur.lng, cur.lat]);
    const parts = Math.min(8, Math.ceil(gap / (spacingKm * 1.7)));
    for (let k = 1; k < parts; k++) {
      const t = k / parts;
      out.push({ lng: last.lng + (cur.lng - last.lng) * t, lat: last.lat + (cur.lat - last.lat) * t, v: last.v + (cur.v - last.v) * t });
    }
    out.push(cur);
  }
  return out;
}

/**
 * Distance to the front in km, signed: positive on team 0's side (left of the line's direction).
 * Where two segments are equally close (their shared vertex) the one whose infinite line is farther decides the side.
 */
export function distToFrontKm(front: FrontNode[], p: LngLat): number {
  const kx = kmPerDegLng(p[1]);
  let best = Infinity;
  let bestPerp = -1;
  let side = 1;
  let ax = (front[0].lng - p[0]) * kx;
  let ay = (front[0].lat - p[1]) * KM;
  for (let i = 1; i < front.length; i++) {
    const bx = (front[i].lng - p[0]) * kx;
    const by = (front[i].lat - p[1]) * KM;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 > 0) {
      const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
      const qx = ax + dx * t;
      const qy = ay + dy * t;
      const d2 = qx * qx + qy * qy;
      const cross = dx * -ay - dy * -ax; // >0 when p is left of a→b
      const perp = Math.abs(cross) / Math.sqrt(len2);
      if (d2 < best - 1e-9 || (Math.abs(d2 - best) <= 1e-9 && perp > bestPerp)) {
        best = d2;
        bestPerp = perp;
        side = cross >= 0 ? 1 : -1;
      }
    }
    ax = bx;
    ay = by;
  }
  return Math.sqrt(best) * side;
}

/** Which team holds the ground at this position, by the side of the nearest stretch of front (reliable near the line only). */
export function sideOf(front: FrontNode[], p: LngLat): Team {
  return distToFrontKm(front, p) >= 0 ? 0 : 1;
}

/**
 * Is p inside team 1's area: the ring made of the front line followed by the map's closure points (exactly what the client
 * paints red)? Ray casting over the nodes and the closure without building the ring.
 */
export function inOccupied(front: FrontNode[], closure: LngLat[], p: LngLat): boolean {
  const n = front.length + closure.length;
  const at = (i: number): [number, number] => (i < front.length ? [front[i].lng, front[i].lat] : closure[i - front.length]);
  let inside = false;
  let [jx, jy] = at(n - 1);
  for (let i = 0; i < n; i++) {
    const [ix, iy] = at(i);
    if (iy > p[1] !== jy > p[1] && p[0] < ((jx - ix) * (p[1] - iy)) / (jy - iy) + ix) inside = !inside;
    jx = ix;
    jy = iy;
  }
  return inside;
}

/**
 * `inOccupied` for many queries: the ring's segments bucketed into latitude bands, so a ray cast only looks at the few
 * segments that cross the query's latitude. Rebuild it whenever the front moves.
 */
export class OccupiedIndex {
  private bands: number[][] = [];
  private xs: Float64Array;
  private ys: Float64Array;
  private y0 = 0;
  private static readonly H = 0.05; // degrees of latitude per band
  constructor(front: FrontNode[], closure: LngLat[]) {
    const n = front.length + closure.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const q = i < front.length ? [front[i].lng, front[i].lat] : closure[i - front.length];
      this.xs[i] = q[0];
      this.ys[i] = q[1];
    }
    let lo = Infinity;
    for (let i = 0; i < n; i++) lo = Math.min(lo, this.ys[i]);
    this.y0 = lo;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = Math.floor((Math.min(this.ys[i], this.ys[j]) - lo) / OccupiedIndex.H);
      const b = Math.floor((Math.max(this.ys[i], this.ys[j]) - lo) / OccupiedIndex.H);
      for (let k = a; k <= b; k++) (this.bands[k] ??= []).push(i);
    }
  }
  contains(p: LngLat): boolean {
    const segs = this.bands[Math.floor((p[1] - this.y0) / OccupiedIndex.H)];
    if (!segs) return false;
    const { xs, ys } = this;
    const n = xs.length;
    let inside = false;
    for (const i of segs) {
      const j = i === 0 ? n - 1 : i - 1;
      if (ys[i] > p[1] !== ys[j] > p[1] && p[0] < ((xs[j] - xs[i]) * (p[1] - ys[i])) / (ys[j] - ys[i]) + xs[i]) inside = !inside;
    }
    return inside;
  }
}

/** Index of the front node closest to a position. */
export function nearestNode(front: FrontNode[], p: LngLat): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < front.length; i++) {
    const d = distKm([front[i].lng, front[i].lat], p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Unit normal at node i pointing into team 1's side (to the right of the line), in km space. */
export function normalAt(front: FrontNode[], i: number): [number, number] {
  const a = front[Math.max(0, i - 1)];
  const b = front[Math.min(front.length - 1, i + 1)];
  const tx = (b.lng - a.lng) * kmPerDegLng(front[i].lat);
  const ty = (b.lat - a.lat) * KM;
  const len = Math.hypot(tx, ty) || 1;
  return [ty / len, -tx / len];
}

/** Unit normal at `cur` pointing to the right of the direction prev→next (team 1's side), in km space. */
export function normalOf(prev: FrontNode, cur: FrontNode, next: FrontNode): [number, number] {
  const tx = (next.lng - prev.lng) * kmPerDegLng(cur.lat);
  const ty = (next.lat - prev.lat) * KM;
  const len = Math.hypot(tx, ty) || 1;
  return [ty / len, -tx / len];
}

/** Signed area of a closed ring in km² (positive = counter-clockwise, i.e. its inside is on the left). */
export function ringAreaKm2(nodes: FrontNode[]): number {
  if (nodes.length < 3) return 0;
  const k = kmPerDegLng(nodes[0].lat);
  let a = 0;
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i];
    const q = nodes[(i + 1) % nodes.length];
    a += p.lng * k * (q.lat * KM) - q.lng * k * (p.lat * KM);
  }
  return a / 2;
}

export function pointInRing(nodes: { lng: number; lat: number }[], p: LngLat): boolean {
  let inside = false;
  for (let i = 0, j = nodes.length - 1; i < nodes.length; j = i++) {
    const a = nodes[i];
    const b = nodes[j];
    if (a.lat > p[1] !== b.lat > p[1] && p[0] < ((b.lng - a.lng) * (p[1] - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

/** The pocket (cauldron) this position is inside, if any. */
export function pocketAt(pockets: Pocket[], p: LngLat): Pocket | null {
  for (const pocket of pockets) if (pointInRing(pocket.nodes, p)) return pocket;
  return null;
}

function segmentsIntersect(
  p1x: number, p1y: number, p2x: number, p2y: number,
  p3x: number, p3y: number, p4x: number, p4y: number
): boolean {
  if (
    Math.max(p1x, p2x) < Math.min(p3x, p4x) ||
    Math.min(p1x, p2x) > Math.max(p3x, p4x) ||
    Math.max(p1y, p2y) < Math.min(p3y, p4y) ||
    Math.min(p1y, p2y) > Math.max(p3y, p4y)
  ) {
    return false;
  }
  const ccw = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
  return (
    ccw(p1x, p1y, p3x, p3y, p4x, p4y) !== ccw(p2x, p2y, p3x, p3y, p4x, p4y) &&
    ccw(p1x, p1y, p2x, p2y, p3x, p3y) !== ccw(p1x, p1y, p2x, p2y, p4x, p4y)
  );
}

/**
 * Look for two stretches of the line that have closed to within `maxKm` of each other (the jaws of a pincer meeting)
 * or crossed each other (self-intersection forming an encirclement).
 * Returns the node range [from, to] that would be cut off as a loop, or null. `minGap` ignores neighbours.
 */
export function findPinch(nodes: FrontNode[], maxKm: number, minGap = 4): { from: number; to: number } | null {
  // 1. Check for shared vertices or touching points (same coordinate with gap >= minGap)
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    for (let j = i + minGap; j < nodes.length; j++) {
      const b = nodes[j];
      if (Math.abs(a.lng - b.lng) < 1e-4 && Math.abs(a.lat - b.lat) < 1e-4) {
        // Strip common stem if the lines run parallel into the neck
        let from = i;
        let to = j;
        while (
          from + 1 < to - 1 &&
          Math.abs(nodes[from + 1].lng - nodes[to - 1].lng) < 1e-4 &&
          Math.abs(nodes[from + 1].lat - nodes[to - 1].lat) < 1e-4 &&
          to - 1 - (from + 1) >= 4
        ) {
          from++;
          to--;
        }
        return { from, to };
      }
    }
  }

  // 2. Check for crossing / self-intersecting segments
  for (let i = 0; i < nodes.length - 1; i++) {
    const a1 = nodes[i];
    const a2 = nodes[i + 1];
    for (let j = i + minGap; j < nodes.length - 1; j++) {
      const b1 = nodes[j];
      const b2 = nodes[j + 1];
      if (segmentsIntersect(a1.lng, a1.lat, a2.lng, a2.lat, b1.lng, b1.lat, b2.lng, b2.lat)) {
        return { from: i + 1, to: j };
      }
    }
  }

  // 3. Check for pincer jaws within maxKm
  let best: { from: number; to: number; d: number } | null = null;
  const latMargin = (maxKm * 1.5) / KM;
  for (let i = 0; i < nodes.length; i++) {
    const kx = kmPerDegLng(nodes[i].lat);
    for (let j = i + minGap; j < nodes.length - 1; j++) {
      const minLat = Math.min(nodes[j].lat, nodes[j + 1].lat) - latMargin;
      const maxLat = Math.max(nodes[j].lat, nodes[j + 1].lat) + latMargin;
      if (nodes[i].lat < minLat || nodes[i].lat > maxLat) continue;

      const ax = (nodes[j].lng - nodes[i].lng) * kx, ay = (nodes[j].lat - nodes[i].lat) * KM;
      const bx = (nodes[j + 1].lng - nodes[i].lng) * kx, by = (nodes[j + 1].lat - nodes[i].lat) * KM;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-9;
      const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
      const d = Math.hypot(ax + dx * t, ay + dy * t);
      if (d <= maxKm && (!best || d < best.d)) best = { from: i + 1, to: t < 0.5 ? j : j + 1, d };
    }
  }
  return best && best.to - best.from >= minGap ? { from: best.from, to: best.to } : null;
}

