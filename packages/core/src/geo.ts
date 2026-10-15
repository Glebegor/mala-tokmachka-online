export type LngLat = [number, number];

const KM_PER_DEG = 111.32;
// km per degree of longitude, looked up every 0.05° of latitude (distances are measured millions of times a second)
const LNG_KM = new Float64Array(3601);
for (let i = 0; i <= 3600; i++) LNG_KM[i] = KM_PER_DEG * Math.cos(((i / 20 - 90) * Math.PI) / 180);
export const kmPerDegLng = (lat: number) => LNG_KM[Math.round((lat + 90) * 20)] ?? KM_PER_DEG * Math.cos((lat * Math.PI) / 180);

export function distKm(a: LngLat, b: LngLat): number {
  const dx = (a[0] - b[0]) * kmPerDegLng((a[1] + b[1]) * 0.5);
  const dy = (a[1] - b[1]) * KM_PER_DEG;
  return Math.sqrt(dx * dx + dy * dy);
}

export function moveToward(from: LngLat, to: LngLat, km: number): LngLat {
  const d = distKm(from, to);
  if (d <= km || d === 0) return [to[0], to[1]];
  const t = km / d;
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

export function offsetKm(p: LngLat, dxKm: number, dyKm: number): LngLat {
  return [p[0] + dxKm / kmPerDegLng(p[1]), p[1] + dyKm / KM_PER_DEG];
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Where the i-th of n units stands when a group arrives: spread (a loose cluster), a line across the direction of
 * travel, a column along it, or a wedge pointing forward. Spacing ~350 m. `facing` (degrees from north, clockwise)
 * turns the front another way than the direction of travel.
 */
export function formationSpot(f: 'spread' | 'line' | 'column' | 'wedge', i: number, n: number, from: LngLat, to: LngLat, facing?: number): LngLat {
  if (f === 'spread' || n < 2) {
    const ring = Math.ceil(Math.sqrt(i));
    return [to[0] + 0.012 * ring * Math.cos(i * 2.4), to[1] + 0.009 * ring * Math.sin(i * 2.4)];
  }
  const rad = facing === undefined ? 0 : (facing * Math.PI) / 180;
  const dx = facing === undefined ? (to[0] - from[0]) * kmPerDegLng(to[1]) : Math.sin(rad);
  const dy = facing === undefined ? (to[1] - from[1]) * 111.32 : Math.cos(rad);
  const len = Math.hypot(dx, dy) || 1;
  const fx = dx / len, fy = dy / len; // forward
  const rx = fy, ry = -fx; // right
  const s = 0.35;
  let side = 0, back = 0;
  if (f === 'line') side = (i - (n - 1) / 2) * s;
  else if (f === 'column') back = i * s;
  else {
    const k = Math.ceil(i / 2);
    side = (i % 2 ? 1 : -1) * k * s;
    back = k * s;
  }
  return offsetKm(to, rx * side - fx * back, ry * side - fy * back);
}