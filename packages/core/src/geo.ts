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
