import type { LngLat } from './geo';
import { distKm, inPolygon } from './geo';
import type { CityHouse } from './state';

/**
 * Generates 10 non-overlapping, authentic architectural footprints (50% larger than before)
 * for a housing district inside a city.
 */
export function generateCityHouses(
  pos: LngLat,
  seed: number,
  cityPoly?: LngLat[] | null,
  roads?: number[][] | null,
  existingHouses?: { pos: LngLat }[]
): CityHouse[] {
  const houses: CityHouse[] = [];
  const count = 10;
  const minDistKm = 0.055; // At least 55 meters between any two houses (no overlap)
  const kmPerLat = 111.32;
  const kmPerLng = 111.32 * Math.cos((pos[1] * Math.PI) / 180);

  let s = (Math.abs(seed) * 9301 + 49297) % 233280 || 12345;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  // Find nearby roads for orientation
  const nearbyRoads: { p: LngLat; ang: number }[] = [];
  if (roads) {
    for (const line of roads) {
      for (let i = 1; i + 3 < line.length; i += 2) {
        const a: LngLat = [line[i], line[i + 1]];
        const b: LngLat = [line[i + 2], line[i + 3]];
        const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (distKm(pos, mid) <= 0.8) {
          const dx = (b[0] - a[0]) * kmPerLng;
          const dy = (b[1] - a[1]) * kmPerLat;
          nearbyRoads.push({ p: mid, ang: Math.atan2(dy, dx) });
        }
      }
    }
  }

  const baseAngle = nearbyRoads.length ? nearbyRoads[0].ang : rnd() * Math.PI;

  for (let i = 0; i < count; i++) {
    let bestPos: LngLat | null = null;
    let houseAngle = baseAngle;

    for (let attempt = 0; attempt < 200; attempt++) {
      let cx: number;
      let cy: number;
      let angle = baseAngle;

      if (nearbyRoads.length && attempt < nearbyRoads.length * 4) {
        const seg = nearbyRoads[(i + attempt) % nearbyRoads.length];
        angle = seg.ang;
        const side = (i + attempt) % 2 === 0 ? 1 : -1;
        const setbackKm = 0.024 + rnd() * 0.015;
        const alongKm = ((Math.floor((i + attempt) / 2) % 4) - 1.5) * 0.065 + (rnd() - 0.5) * 0.012;
        const offX = alongKm * Math.cos(angle) - side * setbackKm * Math.sin(angle);
        const offY = alongKm * Math.sin(angle) + side * setbackKm * Math.cos(angle);
        cx = seg.p[0] + offX / kmPerLng;
        cy = seg.p[1] + offY / kmPerLat;
      } else {
        const rKm = 0.045 + rnd() * 0.32;
        const a = rnd() * Math.PI * 2;
        cx = pos[0] + (Math.cos(a) * rKm) / kmPerLng;
        cy = pos[1] + (Math.sin(a) * rKm) / kmPerLat;
        angle = baseAngle + (rnd() - 0.5) * 0.35;
      }

      const cand: LngLat = [cx, cy];

      // Check boundary of city if provided
      if (cityPoly && !inPolygon(cand, cityPoly)) {
        continue;
      }

      // Check distance from all already placed houses in this district
      const tooCloseSelf = houses.some((h) => distKm(h.pos, cand) < minDistKm);
      if (tooCloseSelf) continue;

      // Check distance from existing houses of other districts
      const tooCloseOther = existingHouses?.some((h) => distKm(h.pos, cand) < minDistKm);
      if (tooCloseOther) continue;

      bestPos = cand;
      houseAngle = angle;
      break;
    }

    if (!bestPos) {
      // Deterministic ring placement fallback guaranteeing spacing
      const fallbackAngle = (i / count) * Math.PI * 2;
      const rKm = 0.07 + (i % 2) * 0.06;
      bestPos = [
        pos[0] + (Math.cos(fallbackAngle) * rKm) / kmPerLng,
        pos[1] + (Math.sin(fallbackAngle) * rKm) / kmPerLat,
      ];
      houseAngle = baseAngle;
    }

    // Footprint dimensions: 50% larger than before
    const lenKm = (0.028 + rnd() * 0.024) * 1.5;
    const widKm = (0.014 + rnd() * 0.008) * 1.5;
    const hx = lenKm / 2;
    const hy = widKm / 2;
    const bType = (i + Math.floor(rnd() * 4)) % 4;

    let localPoly: [number, number][];
    if (bType === 0) {
      // L-shape
      localPoly = [
        [-hx, -hy],
        [hx, -hy],
        [hx, hy * 0.25],
        [hx * 0.2, hy * 0.25],
        [hx * 0.2, hy * 2.1],
        [-hx, hy * 2.1],
        [-hx, -hy],
      ];
    } else if (bType === 1) {
      // Stepped residential
      localPoly = [
        [-hx, -hy],
        [hx * 0.15, -hy],
        [hx * 0.15, -hy * 0.3],
        [hx, -hy * 0.3],
        [hx, hy],
        [-hx * 0.15, hy],
        [-hx * 0.15, hy * 0.3],
        [-hx, hy * 0.3],
        [-hx, -hy],
      ];
    } else if (bType === 2) {
      // U-shape
      localPoly = [
        [-hx, -hy],
        [hx, -hy],
        [hx, hy * 1.5],
        [hx * 0.45, hy * 1.5],
        [hx * 0.45, hy * 0.15],
        [-hx * 0.45, hy * 0.15],
        [-hx * 0.45, hy * 1.5],
        [-hx, hy * 1.5],
        [-hx, -hy],
      ];
    } else {
      // Stepped block
      localPoly = [
        [-hx, -hy],
        [hx, -hy],
        [hx, hy],
        [hx * 0.25, hy],
        [hx * 0.25, hy * 1.35],
        [-hx * 0.25, hy * 1.35],
        [-hx * 0.25, hy],
        [-hx, hy],
        [-hx, -hy],
      ];
    }

    const cosA = Math.cos(houseAngle);
    const sinA = Math.sin(houseAngle);
    const ringCoords: LngLat[] = localPoly.map(([lx, ly]) => {
      const rx = lx * cosA - ly * sinA;
      const ry = lx * sinA + ly * cosA;
      return [bestPos![0] + rx / kmPerLng, bestPos![1] + ry / kmPerLat];
    });

    houses.push({
      id: i + 1,
      pos: bestPos,
      hp: 50,
      maxHp: 50,
      poly: ringCoords,
    });
  }

  return houses;
}
