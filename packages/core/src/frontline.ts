import type { LngLat } from './geo';
import { distKm, kmPerDegLng } from './geo';
import type { FrontNode, Team } from './state';

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
        side = cross >= 0 ? 1 : -1;
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
