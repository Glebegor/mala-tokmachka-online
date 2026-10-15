import type { LngLat } from './geo';
import { distKm, inPolygon, offsetKm } from './geo';

export type DepositType = 'iron' | 'oil';

export interface ResourceDeposit {
  id: string;
  type: DepositType;
  team: 0 | 1;
  name: string;
  center: LngLat;
  radiusKm: number; // base radius: 10..40 km (diameter 20..80 km)
  polygon: LngLat[];
}

/** Generates an organic, noisy polygon contour around a center with base radius (10-40 km). */
function createOrganicPolygon(center: LngLat, baseRadiusKm: number, seed: number): LngLat[] {
  const numPoints = 40;
  const ring: LngLat[] = [];
  const s1 = seed * 1.618;
  const s2 = seed * 2.718;
  const s3 = seed * 3.141;
  const s4 = seed * 0.577;

  for (let i = 0; i < numPoints; i++) {
    const theta = (i / numPoints) * Math.PI * 2;
    // Harmonic organic jitter (2 to 7 waves around the circle)
    const noise =
      0.18 * Math.sin(2 * theta + s1) +
      0.14 * Math.cos(3 * theta + s2) +
      0.10 * Math.sin(5 * theta + s3) +
      0.06 * Math.cos(7 * theta + s4);
    // Keep radius strictly within bounds: diameter must be between 20 km and 80 km (radius 10..40 km)
    const rKm = Math.min(40, Math.max(10, baseRadiusKm * (1 + noise)));
    ring.push(offsetKm(center, rKm * Math.cos(theta), rKm * Math.sin(theta)));
  }
  // Close the ring
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

interface DepositDef {
  id: string;
  type: DepositType;
  team: 0 | 1;
  name: string;
  center: LngLat;
  radiusKm: number;
  seed: number;
}

const DEPOSIT_DEFS: DepositDef[] = [
  // ===================== UKRAINE IRON (8 deposits) =====================
  {
    id: 'iron_ua_1',
    type: 'iron',
    team: 0,
    name: 'Криворожское месторождение железа',
    center: [33.39, 47.91],
    radiusKm: 36, // ~72 km diameter
    seed: 101,
  },
  {
    id: 'iron_ua_2',
    type: 'iron',
    team: 0,
    name: 'Кременчугское железорудное поле',
    center: [33.52, 49.12],
    radiusKm: 28, // ~56 km diameter
    seed: 102,
  },
  {
    id: 'iron_ua_3',
    type: 'iron',
    team: 0,
    name: 'Никопольско-Марганецкий бассейн',
    center: [34.45, 47.62],
    radiusKm: 26, // ~52 km diameter
    seed: 103,
  },
  {
    id: 'iron_ua_4',
    type: 'iron',
    team: 0,
    name: 'Белозерское железное месторождение',
    center: [34.98, 47.25],
    radiusKm: 22, // ~44 km diameter
    seed: 104,
  },
  {
    id: 'iron_ua_5',
    type: 'iron',
    team: 0,
    name: 'Коростенское месторождение руды',
    center: [28.65, 50.88],
    radiusKm: 30, // ~60 km diameter
    seed: 105,
  },
  {
    id: 'iron_ua_6',
    type: 'iron',
    team: 0,
    name: 'Кропивницкое рудное поле',
    center: [32.22, 48.55],
    radiusKm: 24, // ~48 km diameter
    seed: 106,
  },
  {
    id: 'iron_ua_7',
    type: 'iron',
    team: 0,
    name: 'Полтавское железное поле',
    center: [34.50, 49.65],
    radiusKm: 18, // ~36 km diameter
    seed: 107,
  },
  {
    id: 'iron_ua_8',
    type: 'iron',
    team: 0,
    name: 'Ровненское рудное поле',
    center: [26.20, 50.60],
    radiusKm: 25, // ~50 km diameter
    seed: 108,
  },

  // ===================== UKRAINE OIL (8 deposits) =====================
  {
    id: 'oil_ua_1',
    type: 'oil',
    team: 0,
    name: 'Гадячско-Миргородское нефтяное поле',
    center: [33.95, 50.18],
    radiusKm: 34, // ~68 km diameter
    seed: 201,
  },
  {
    id: 'oil_ua_2',
    type: 'oil',
    team: 0,
    name: 'Прилукское нефтяное месторождение',
    center: [32.35, 50.62],
    radiusKm: 25, // ~50 km diameter
    seed: 202,
  },
  {
    id: 'oil_ua_3',
    type: 'oil',
    team: 0,
    name: 'Ахтырское нефтегазовое поле',
    center: [34.92, 50.28],
    radiusKm: 28, // ~56 km diameter
    seed: 203,
  },
  {
    id: 'oil_ua_4',
    type: 'oil',
    team: 0,
    name: 'Шебелинское нефтегазовое месторождение',
    center: [36.50, 49.45],
    radiusKm: 35, // ~70 km diameter
    seed: 204,
  },
  {
    id: 'oil_ua_5',
    type: 'oil',
    team: 0,
    name: 'Долинское нефтяное месторождение',
    center: [24.00, 48.95],
    radiusKm: 22, // ~44 km diameter
    seed: 205,
  },
  {
    id: 'oil_ua_6',
    type: 'oil',
    team: 0,
    name: 'Бориславское нефтяное поле',
    center: [23.45, 49.28],
    radiusKm: 20, // ~40 km diameter
    seed: 206,
  },
  {
    id: 'oil_ua_7',
    type: 'oil',
    team: 0,
    name: 'Причерноморское шельфовое нефтяное поле',
    center: [30.40, 46.22],
    radiusKm: 26, // ~52 km diameter
    seed: 207,
  },
  {
    id: 'oil_ua_8',
    type: 'oil',
    team: 0,
    name: 'Кобелякское нефтяное месторождение',
    center: [34.18, 48.92],
    radiusKm: 21, // ~42 km diameter
    seed: 208,
  },

  // ===================== RUSSIA IRON (8 deposits) =====================
  {
    id: 'iron_ru_1',
    type: 'iron',
    team: 1,
    name: 'Курская магнитная аномалия',
    center: [35.35, 52.33],
    radiusKm: 38, // ~76 km diameter
    seed: 301,
  },
  {
    id: 'iron_ru_2',
    type: 'iron',
    team: 1,
    name: 'Лебединское железное месторождение',
    center: [37.85, 51.30],
    radiusKm: 35, // ~70 km diameter
    seed: 302,
  },
  {
    id: 'iron_ru_3',
    type: 'iron',
    team: 1,
    name: 'Павловское рудное поле',
    center: [40.08, 50.45],
    radiusKm: 28, // ~56 km diameter
    seed: 303,
  },
  {
    id: 'iron_ru_4',
    type: 'iron',
    team: 1,
    name: 'Липецкое железное месторождение',
    center: [39.57, 52.60],
    radiusKm: 27, // ~54 km diameter
    seed: 304,
  },
  {
    id: 'iron_ru_5',
    type: 'iron',
    team: 1,
    name: 'Тульское рудное поле',
    center: [38.20, 54.05],
    radiusKm: 24, // ~48 km diameter
    seed: 305,
  },
  {
    id: 'iron_ru_6',
    type: 'iron',
    team: 1,
    name: 'Шахтинское железное месторождение',
    center: [40.20, 47.72],
    radiusKm: 22, // ~44 km diameter
    seed: 306,
  },
  {
    id: 'iron_ru_7',
    type: 'iron',
    team: 1,
    name: 'Балаковское рудное поле',
    center: [47.80, 52.05],
    radiusKm: 30, // ~60 km diameter
    seed: 307,
  },
  {
    id: 'iron_ru_8',
    type: 'iron',
    team: 1,
    name: 'Сызранское железное месторождение',
    center: [48.45, 53.15],
    radiusKm: 25, // ~50 km diameter
    seed: 308,
  },

  // ===================== RUSSIA OIL (8 deposits) =====================
  {
    id: 'oil_ru_1',
    type: 'oil',
    team: 1,
    name: 'Волго-Уральское нефтяное поле (Самара)',
    center: [50.15, 53.20],
    radiusKm: 38, // ~76 km diameter
    seed: 401,
  },
  {
    id: 'oil_ru_2',
    type: 'oil',
    team: 1,
    name: 'Саратовское нефтяное месторождение',
    center: [46.00, 51.55],
    radiusKm: 32, // ~64 km diameter
    seed: 402,
  },
  {
    id: 'oil_ru_3',
    type: 'oil',
    team: 1,
    name: 'Котовское нефтяное месторождение',
    center: [44.80, 50.30],
    radiusKm: 30, // ~60 km diameter
    seed: 403,
  },
  {
    id: 'oil_ru_4',
    type: 'oil',
    team: 1,
    name: 'Миллеровское нефтеносное поле',
    center: [40.40, 48.95],
    radiusKm: 24, // ~48 km diameter
    seed: 404,
  },
  {
    id: 'oil_ru_5',
    type: 'oil',
    team: 1,
    name: 'Ставропольское нефтяное поле',
    center: [42.00, 45.05],
    radiusKm: 28, // ~56 km diameter
    seed: 405,
  },
  {
    id: 'oil_ru_6',
    type: 'oil',
    team: 1,
    name: 'Борисоглебское нефтяное месторождение',
    center: [42.08, 51.35],
    radiusKm: 22, // ~44 km diameter
    seed: 406,
  },
  {
    id: 'oil_ru_7',
    type: 'oil',
    team: 1,
    name: 'Тамбовское нефтяное поле',
    center: [40.50, 52.90],
    radiusKm: 20, // ~40 km diameter
    seed: 407,
  },
  {
    id: 'oil_ru_8',
    type: 'oil',
    team: 1,
    name: 'Касимовское нефтяное месторождение',
    center: [41.40, 54.95],
    radiusKm: 26, // ~52 km diameter
    seed: 408,
  },
];

export const DEPOSITS: ResourceDeposit[] = DEPOSIT_DEFS.map((d) => ({
  id: d.id,
  type: d.type,
  team: d.team,
  name: d.name,
  center: d.center,
  radiusKm: d.radiusKm,
  polygon: createOrganicPolygon(d.center, d.radiusKm, d.seed),
}));

/** Tests if a given point is inside any deposit of the specified type. */
export function inDeposit(type: DepositType, p: LngLat, team?: 0 | 1): ResourceDeposit | null {
  for (const dep of DEPOSITS) {
    if (dep.type !== type) continue;
    if (team !== undefined && dep.team !== team) continue;
    // Bounding circle fast-rejection
    if (distKm(p, dep.center) > dep.radiusKm * 1.35) continue;
    if (inPolygon(p, dep.polygon)) return dep;
  }
  return null;
}

/** Converts deposits into a GeoJSON FeatureCollection for MapLibre layer rendering. */
export function depositsGeoJSON(filterType?: DepositType, team?: 0 | 1): any {
  let list = filterType ? DEPOSITS.filter((d) => d.type === filterType) : DEPOSITS;
  if (team !== undefined) list = list.filter((d) => d.team === team);
  return {
    type: 'FeatureCollection',
    features: list.map((d) => ({
      type: 'Feature',
      properties: {
        id: d.id,
        type: d.type,
        team: d.team,
        name: d.name,
        radiusKm: d.radiusKm,
        center: d.center,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [d.polygon],
      },
    })),
  };
}
