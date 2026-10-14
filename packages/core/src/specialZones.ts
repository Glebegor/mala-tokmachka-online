import { distKm, type LngLat } from './geo';
import { pointInPolygon } from './frontline';

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
    name: 'Кременчугский НПЗ',
    side: 'ua',
    buildingDef: 'oil_refinery',
    bonusTitle: 'Бонус Кременчугского НПЗ: x1.5 к производству топлива',
    bonusDesc: 'Постройка нефтеперерабатывающего завода в этой зоне увеличивает производство топлива на 50% (x1.5).',
    color: '#06b6d4', // Cyan
    center: [33.485, 49.158],
    radiusKm: 3.8,
    polygon: [
      [33.468, 49.186],
      [33.518, 49.155],
      [33.538, 49.141],
      [33.497, 49.114],
      [33.473, 49.113],
      [33.439, 49.124],
      [33.432, 49.152],
      [33.450, 49.175],
      [33.468, 49.186],
    ],
  },
  {
    id: 'alabuga_drones',
    name: 'ОЭЗ «Алабуга»',
    side: 'ru',
    buildingDef: 'drone_factory',
    bonusTitle: 'Бонус ОЭЗ «Алабуга»: x1.5 к скорости производства дронов',
    bonusDesc: 'Постройка дронового завода в этой зоне увеличивает скорость производства БПЛА на 50% (x1.5).',
    color: '#f59e0b', // Amber
    center: [52.045, 55.825],
    radiusKm: 4.2,
    polygon: [
      [51.980, 55.845],
      [52.095, 55.845],
      [52.120, 55.820],
      [52.095, 55.805],
      [51.980, 55.805],
      [51.955, 55.820],
      [51.980, 55.845],
    ],
  },
];

export function isInSpecialZone(pos: LngLat, zone: SpecialZoneDef): boolean {
  if (pointInPolygon(pos, zone.polygon)) return true;
  return distKm(pos, zone.center) <= zone.radiusKm;
}

export function isKremenchukRefinery(pos: LngLat): boolean {
  return isInSpecialZone(pos, SPECIAL_ZONES[0]);
}

export function isAlabugaDroneZone(pos: LngLat): boolean {
  return isInSpecialZone(pos, SPECIAL_ZONES[1]);
}
