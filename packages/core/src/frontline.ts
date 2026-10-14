import type { LngLat } from './geo';
import { distKm, kmPerDegLng } from './geo';
import type { FrontNode, Pocket, Team } from './state';

const KM = 111.32;

/** Resample an authored polyline into nodes roughly `spacingKm` apart. */
export function buildFront(line: LngLat[], spacingKm: number): FrontNode[] {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += distKm(line[i - 1], line[i]);
  const count = Math.max(8, Math.min(2500, Math.round(total / spacingKm) + 1));
  return resample(line.map((p) => ({ lng: p[0], lat: p[1], v: 0 })), count);
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
        if (i === 1 && t === 0 && p[0] < front[0].lng) {
          side = 1;
        } else {
          side = cross >= 0 ? 1 : -1;
        }
      }
    }
    ax = bx;
    ay = by;
  }
  return Math.sqrt(best) * side;
}

/** Which team holds the ground at this position. */
export function sideOf(front: FrontNode[], p: LngLat): Team {
  return distToFrontKm(front, p) >= 0 ? 0 : 1;
}

/** Check if point p is inside a closed polygon ring using ray-casting. */
export function pointInPolygon(p: LngLat, ring: (FrontNode | LngLat)[]): boolean {
  let inside = false;
  const x = p[0], y = p[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = Array.isArray(ring[i]) ? (ring[i] as LngLat) : [(ring[i] as FrontNode).lng, (ring[i] as FrontNode).lat];
    const pj = Array.isArray(ring[j]) ? (ring[j] as LngLat) : [(ring[j] as FrontNode).lng, (ring[j] as FrontNode).lat];
    const xi = pi[0], yi = pi[1];
    const xj = pj[0], yj = pj[1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Which team holds ground at position p, accounting for isolated military cauldrons ("котлы"). */
export function sideOfWithPockets(front: FrontNode[], pockets: Pocket[] | undefined, p: LngLat): Team {
  if (pockets && pockets.length > 0) {
    for (const pkt of pockets) {
      if (pointInPolygon(p, pkt.nodes)) {
        return pkt.team;
      }
    }
  }
  return sideOf(front, p);
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

/** Intersection of line segment AB and CD in (lng, lat) space. */
export function lineSegmentIntersection(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number]
): [number, number] | null {
  const dx1 = b[0] - a[0], dy1 = b[1] - a[1];
  const dx2 = d[0] - c[0], dy2 = d[1] - c[1];
  const det = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(det) < 1e-12) return null;
  const s = ((c[0] - a[0]) * dy2 - (c[1] - a[1]) * dx2) / det;
  const t = ((c[0] - a[0]) * dy1 - (c[1] - a[1]) * dx1) / det;
  if (s >= 0.02 && s <= 0.98 && t >= 0.02 && t <= 0.98) {
    return [a[0] + dx1 * s, a[1] + dy1 * s];
  }
  return null;
}

export function pocketCentroid(nodes: FrontNode[]): LngLat {
  let slng = 0, slat = 0;
  for (const n of nodes) {
    slng += n.lng;
    slat += n.lat;
  }
  return [slng / nodes.length, slat / nodes.length];
}

export function pocketRadiusKm(nodes: FrontNode[]): number {
  const c = pocketCentroid(nodes);
  let maxD = 0;
  for (const n of nodes) {
    const d = distKm(c, [n.lng, n.lat]);
    if (d > maxD) maxD = d;
  }
  return maxD;
}

/**
 * Detects pinching salients or self-intersections along the frontline.
 * Separates isolated cauldrons ("котлы") into independent closed loops,
 * and reconnects the main frontline cleanly without self-intersections.
 */
export function resolveFrontLoops(nodes: FrontNode[], pinchDistKm = 4.0): { main: FrontNode[]; loops: FrontNode[][] } {
  let cur = [...nodes];
  const loops: FrontNode[][] = [];
  let found = true;
  let guard = 0;
  while (found && guard++ < 8) {
    found = false;
    for (let i = 0; i < cur.length - 2 && !found; i++) {
      const pA: [number, number] = [cur[i].lng, cur[i].lat];
      const pB: [number, number] = [cur[i + 1].lng, cur[i + 1].lat];
      for (let j = i + 12; j < cur.length - 1 && !found; j++) {
        const pC: [number, number] = [cur[j].lng, cur[j].lat];
        const pD: [number, number] = [cur[j + 1].lng, cur[j + 1].lat];

        let inter = lineSegmentIntersection(pA, pB, pC, pD);
        if (!inter) {
          const d = distKm(pA, pC);
          if (d < pinchDistKm) {
            inter = [(pA[0] + pC[0]) / 2, (pA[1] + pC[1]) / 2];
          }
        }

        if (inter) {
          found = true;
          const midNode: FrontNode = { lng: inter[0], lat: inter[1], v: 0 };
          // The separated loop is the military pocket ("котёл")
          const loop = [midNode, ...cur.slice(i + 1, j + 1), midNode];
          loops.push(resample(loop, Math.max(12, Math.min(100, j - i + 2))));
          // The main frontline bypasses the loop and continues forward cleanly
          cur = [...cur.slice(0, i + 1), midNode, ...cur.slice(j + 1)];
          cur = resample(cur, Math.max(8, cur.length));
        }
      }
    }
  }
  return { main: cur, loops };
}
