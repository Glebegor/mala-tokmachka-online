import type { CapturePointDef } from './defs';
import { distKm, type LngLat } from './geo';
import type { CombatSector, Team } from './state';

/**
 * 5x5 km tactical district dimensions in degrees (~5.0 km lat, ~5.0 km lng at ~48°N).
 * Matches Hearts of Iron / East Showdown tactical province granularity.
 */
export const DISTRICT_CELL = { lng: 0.067, lat: 0.045 } as const;


/** Compute unique numeric key for a district grid cell. */
export function districtKey(ix: number, iy: number): number {
  return ix * 100000 + iy;
}

/** Get the district cell coordinates and center for any map point. */
export function districtAt(p: LngLat): { ix: number; iy: number; center: LngLat } {
  const ix = Math.floor(p[0] / DISTRICT_CELL.lng);
  const iy = Math.floor(p[1] / DISTRICT_CELL.lat);
  const center: LngLat = [(ix + 0.5) * DISTRICT_CELL.lng, (iy + 0.5) * DISTRICT_CELL.lat];
  return { ix, iy, center };
}

/** Get polygon boundary coordinates for a 5x5 km district cell. */
export function districtPolygon(ix: number, iy: number): LngLat[] {
  const x0 = ix * DISTRICT_CELL.lng;
  const y0 = iy * DISTRICT_CELL.lat;
  const x1 = x0 + DISTRICT_CELL.lng;
  const y1 = y0 + DISTRICT_CELL.lat;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}

/**
 * Generate a realistic military district/sector name based on geographical context.
 * Splits major cities into multiple urban sectors (Center, North, South, East, West),
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

  if (minDist <= 3.2) {
    if (isMajorCity) {
      if (minDist <= 1.5) return `${nearest.name} (Центр)`;
      const dLng = center[0] - nearest.pos[0];
      const dLat = center[1] - nearest.pos[1];
      if (Math.abs(dLat) > Math.abs(dLng)) {
        return dLat > 0 ? `${nearest.name} (Північ)` : `${nearest.name} (Південь)`;
      } else {
        return dLng > 0 ? `${nearest.name} (Схід)` : `${nearest.name} (Захід)`;
      }
    }
    return nearest.name;
  }

  if (minDist <= 8.5) {
    const dLng = center[0] - nearest.pos[0];
    const dLat = center[1] - nearest.pos[1];
    const latDir = dLat > 0 ? 'Північ' : 'Південь';
    const lngDir = dLng > 0 ? 'Схід' : 'Захід';
    return `${nearest.name} (${latDir}-${lngDir})`;
  }

  return `Сектор ${nearest.name} (${Math.round(minDist)} км)`;
}
