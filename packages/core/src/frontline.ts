import type { LngLat } from './geo';
import { kmPerDegLng } from './geo';
import type { FrontNode, Team } from './state';

/** Resample an authored polyline (north→south) into evenly spaced latitude nodes. */
export function buildFront(line: LngLat[], count: number): FrontNode[] {
  const pts = [...line].sort((a, b) => b[1] - a[1]);
  const north = pts[0][1];
  const south = pts[pts.length - 1][1];
  const nodes: FrontNode[] = [];
  for (let i = 0; i < count; i++) {
    const lat = north - ((north - south) * i) / (count - 1);
    nodes.push({ lat, lng: lngAtLat(pts, lat), v: 0 });
  }
  return nodes;
}

function lngAtLat(pts: LngLat[], lat: number): number {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (lat <= a[1] && lat >= b[1]) {
      const t = a[1] === b[1] ? 0 : (a[1] - lat) / (a[1] - b[1]);
      return a[0] + (b[0] - a[0]) * t;
    }
  }
  return pts[lat > pts[0][1] ? 0 : pts.length - 1][0];
}

/** Longitude of the front at the given latitude (linear between nodes). */
export function frontLngAt(front: FrontNode[], lat: number): number {
  if (lat >= front[0].lat) return front[0].lng;
  const last = front[front.length - 1];
  if (lat <= last.lat) return last.lng;
  const step = (front[0].lat - last.lat) / (front.length - 1);
  const f = (front[0].lat - lat) / step;
  const i = Math.min(front.length - 2, Math.floor(f));
  const t = f - i;
  return front[i].lng + (front[i + 1].lng - front[i].lng) * t;
}

/** Which team owns the ground at this position (team 0 = west of the front). */
export function sideOf(front: FrontNode[], p: LngLat): Team {
  return p[0] < frontLngAt(front, p[1]) ? 0 : 1;
}

/** Signed distance in km to the front, positive on team 0's side. */
export function distToFrontKm(front: FrontNode[], p: LngLat): number {
  return (frontLngAt(front, p[1]) - p[0]) * kmPerDegLng(p[1]);
}
