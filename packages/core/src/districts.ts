import type { CapturePointDef } from './defs';
import { distKm, type LngLat } from './geo';
import type { CombatSector, Team } from './state';

/**
 * Tactical district/province dimensions in degrees (~4.0 km lat, ~4.0 km lng at ~48°N).
 * Matches Hearts of Iron IV / East Showdown tactical province granularity.
 */
export const DISTRICT_CELL = { lng: 0.054, lat: 0.036 } as const;

/** Compute unique numeric key for a district grid cell. */
export function districtKey(ix: number, iy: number): number {
  return ix * 100000 + iy;
}

/** Deterministic pseudo-random hash for organic province jitter. */
export function districtHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Returns the jittered seed/center coordinate for district (ix, iy).
 * The deterministic offset creates organic, irregular province puzzle pieces.
 */
export function districtSeed(ix: number, iy: number): LngLat {
  const jx = (districtHash(ix, iy) - 0.5) * 0.62;
  const jy = (districtHash(ix + 101, iy + 203) - 0.5) * 0.62;
  return [
    Math.round(((ix + 0.5 + jx) * DISTRICT_CELL.lng) * 1e5) / 1e5,
    Math.round(((iy + 0.5 + jy) * DISTRICT_CELL.lat) * 1e5) / 1e5,
  ];
}

/**
 * Get the district cell coordinates and center for any map point in O(1).
 * Uses exact Voronoi nearest-seed query across neighboring cells.
 */
export function districtAt(p: LngLat): { ix: number; iy: number; center: LngLat } {
  const cx = Math.floor(p[0] / DISTRICT_CELL.lng);
  const cy = Math.floor(p[1] / DISTRICT_CELL.lat);
  let bestDist = Infinity;
  let bestIx = cx;
  let bestIy = cy;
  let bestCenter: LngLat = [0, 0];

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const ix = cx + dx;
      const iy = cy + dy;
      const s = districtSeed(ix, iy);
      const d = (p[0] - s[0]) ** 2 + (p[1] - s[1]) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestIx = ix;
        bestIy = iy;
        bestCenter = s;
      }
    }
  }
  return { ix: bestIx, iy: bestIy, center: bestCenter };
}

/**
 * Clip a convex polygon against the perpendicular bisector between c1 and c2 (Sutherland-Hodgman).
 * Keeps the half-plane containing c1.
 */
function clipPolyByHalfPlane(poly: LngLat[], c1: LngLat, c2: LngLat): LngLat[] {
  const mx = (c1[0] + c2[0]) / 2;
  const my = (c1[1] + c2[1]) / 2;
  const nx = c2[0] - c1[0];
  const ny = c2[1] - c1[1];
  const isInside = (p: LngLat) => (p[0] - mx) * nx + (p[1] - my) * ny <= 1e-9;

  const out: LngLat[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const aIn = isInside(a);
    const bIn = isInside(b);
    if (aIn && bIn) {
      out.push(b);
    } else if (aIn && !bIn) {
      const da = (a[0] - mx) * nx + (a[1] - my) * ny;
      const db = (b[0] - mx) * nx + (b[1] - my) * ny;
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    } else if (!aIn && bIn) {
      const da = (a[0] - mx) * nx + (a[1] - my) * ny;
      const db = (b[0] - mx) * nx + (b[1] - my) * ny;
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      out.push(b);
    }
  }
  return out;
}

/**
 * Generate organic Voronoi polygon boundary coordinates for a HoI4-style district.
 * Non-overlapping, seamless tessellation with natural irregular borders.
 */
export function districtPolygon(ix: number, iy: number): LngLat[] {
  const c = districtSeed(ix, iy);
  const dx = DISTRICT_CELL.lng;
  const dy = DISTRICT_CELL.lat;

  // Initial bounding box around cell
  let poly: LngLat[] = [
    [(ix - 1.2) * dx, (iy - 1.2) * dy],
    [(ix + 2.2) * dx, (iy - 1.2) * dy],
    [(ix + 2.2) * dx, (iy + 2.2) * dy],
    [(ix - 1.2) * dx, (iy + 2.2) * dy],
  ];

  for (let ox = -2; ox <= 2; ox++) {
    for (let oy = -2; oy <= 2; oy++) {
      if (ox === 0 && oy === 0) continue;
      const neighbor = districtSeed(ix + ox, iy + oy);
      poly = clipPolyByHalfPlane(poly, c, neighbor);
      if (poly.length < 3) break;
    }
  }
  if (poly.length >= 3) {
    // Close polygon ring and round coordinates to 5 decimals for crisp rendering
    const closed = poly.map((p): LngLat => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
    closed.push(closed[0]);
    return closed;
  }
  return [];
}

/**
 * Generate a realistic military district/sector name based on geographical context.
 * Splits major cities into multiple urban sectors (Center, North, South, East, West or named districts),
 * names towns and villages directly, and gives tactical sector names to fields/steppes.
 */
export function districtName(center: LngLat, capturePoints: CapturePointDef[]): string {
  if (!capturePoints.length) return `Сектор ${Math.floor(center[0])}-${Math.floor(center[1])}`;

  let nearest = capturePoints[0];
  let minDist = distKm(center, nearest.pos);
  for (let i = 1; i < capturePoints.length; i++) {
    const d = distKm(center, capturePoints[i].pos);
    if (d < minDist) {
      minDist = d;
      nearest = capturePoints[i];
    }
  }

  const isMajorCity = (nearest.value ?? 0) >= 4;
  const isDonetsk = nearest.id.toLowerCase().includes('donetsk') || nearest.name.toLowerCase().includes('донецьк') || nearest.name.toLowerCase().includes('donetsk');

  if (minDist <= 3.8) {
    if (isDonetsk) {
      if (minDist <= 1.2) return `${nearest.name} (Центр)`;
      const dLng = center[0] - nearest.pos[0];
      const dLat = center[1] - nearest.pos[1];
      if (dLat > 0 && Math.abs(dLng) < 0.03) return `${nearest.name} (Київський р-н)`;
      if (dLat > 0 && dLng < 0) return `${nearest.name} (Куйбишевський р-н)`;
      if (dLat <= 0 && dLng < 0) return `${nearest.name} (Кіровський р-н)`;
      if (dLat < 0 && Math.abs(dLng) < 0.03) return `${nearest.name} (Ленінський р-н)`;
      if (dLat >= 0 && dLng > 0) return `${nearest.name} (Калінінський р-н)`;
      return `${nearest.name} (Будьоннівський р-н)`;
    }

    if (isMajorCity) {
      if (minDist <= 1.5) return `${nearest.name} (Центр)`;
      const dLng = center[0] - nearest.pos[0];
      const dLat = center[1] - nearest.pos[1];
      if (Math.abs(dLat) > Math.abs(dLng)) {
        return dLat > 0 ? `${nearest.name} (Північний р-н)` : `${nearest.name} (Південний р-н)`;
      } else {
        return dLng > 0 ? `${nearest.name} (Східний р-н)` : `${nearest.name} (Західний р-н)`;
      }
    }
    return nearest.name;
  }

  if (minDist <= 7.5) {
    const dLng = center[0] - nearest.pos[0];
    const dLat = center[1] - nearest.pos[1];
    const latDir = dLat > 0 ? 'Північ' : 'Південь';
    const lngDir = dLng > 0 ? 'Схід' : 'Захід';
    return `${nearest.name} (${latDir}-${lngDir})`;
  }

  return `Сектор ${nearest.name} (${Math.round(minDist)} км)`;
}
