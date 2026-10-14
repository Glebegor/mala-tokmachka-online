import { distKm, type LngLat } from './geo';
import { pointInRing } from './frontline';

/** Places with a production bonus for one side (from the akira branch). */
export interface SpecialZoneDef {
  id: string;
  name: string;
  side: 'ua' | 'ru';
  buildingDef: string;
  bonusTitle: string;
  bonusDesc: string;
  color: string;
  center: LngLat;
  radiusKm: number;
  polygon: LngLat[];
}

export const SPECIAL_ZONES: SpecialZoneDef[] = [
  {
    id: 'kremenchuk_refinery',
    name: 'Kremenchuk Refinery',
    side: 'ua',
    buildingDef: 'oil_refinery',
    bonusTitle: 'Kremenchuk Refinery: fuel output ×1.5',
    bonusDesc: 'An oil refinery built inside this zone produces 50% more fuel. Only Ukraine can build here.',
    color: '#06b6d4',
    center: [33.485, 49.158],
    radiusKm: 3.8,
    polygon: [[33.468, 49.186], [33.518, 49.155], [33.538, 49.141], [33.497, 49.114], [33.473, 49.113], [33.439, 49.124], [33.432, 49.152], [33.45, 49.175], [33.468, 49.186]],
  },
  {
    id: 'alabuga_drones',
    name: 'Alabuga Special Economic Zone',
    side: 'ru',
    buildingDef: 'drone_factory',
    bonusTitle: 'Alabuga: drone production ×1.5 faster',
    bonusDesc: 'A drone factory built inside this zone builds drones 50% faster. Only Russia can build here.',
    color: '#f59e0b',
    center: [52.045, 55.825],
    radiusKm: 4.2,
    polygon: [[51.98, 55.845], [52.095, 55.845], [52.12, 55.82], [52.095, 55.805], [51.98, 55.805], [51.955, 55.82], [51.98, 55.845]],
  },
];

const ring = (pts: LngLat[]) => pts.map(([lng, lat]) => ({ lng, lat }));

export function isInSpecialZone(pos: LngLat, zone: SpecialZoneDef): boolean {
  return pointInRing(ring(zone.polygon), pos) || distKm(pos, zone.center) <= zone.radiusKm;
}

/** The special zone at this position, if any. */
export function specialZoneAt(pos: LngLat): SpecialZoneDef | null {
  return SPECIAL_ZONES.find((z) => isInSpecialZone(pos, z)) ?? null;
}
