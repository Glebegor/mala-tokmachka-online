import type { LngLat } from './geo';

/** Everything below is data: mods provide it as JSON, the engine never hard-codes content. */
export type ResourceAmounts = Record<string, number>;

export interface ResourceDef {
  id: string;
  name: string;
  color: string;
  start: number;
  cap: number;
  /** Built-in icon name (coin, bolt, person, rock, ingot, drop) or a short text glyph. */
  icon?: string;
}

export interface BuildingDef {
  id: string;
  name: string;
  category: 'civil' | 'military';
  icon: string;
  description?: string;
  cost: ResourceAmounts;
  buildTime: number;
  hp: number;
  produces?: ResourceAmounts; // per second
  consumes?: ResourceAmounts; // per second
  vision?: number; // km
  aura?: { radiusKm: number; outputMult: number };
  defense?: { radiusKm: number; mult: number };
  trains?: string[];
  maxPerPlayer?: number;
}

export interface UnitDef {
  id: string;
  name: string;
  kind: 'ground' | 'air';
  cost: ResourceAmounts;
  trainTime: number;
  hp: number;
  speed: number; // km/s
  range: number; // km
  damage: number; // dps
  vision: number; // km
}

export interface CapturePointDef {
  id: string;
  name: string;
  pos: LngLat;
  value: number;
}

export interface MapDef {
  id: string;
  name: string;
  bounds: [number, number, number, number]; // w s e n
  center: LngLat;
  zoom: number;
  /** Initial front, north→south. Team 0 holds the west side, team 1 the east side. */
  front: LngLat[];
  capturePoints: CapturePointDef[];
  spawns: [LngLat[], LngLat[]];
}

export interface RulesConfig {
  tickRate: number;
  snapshotRate: number;
  matchSeconds: number;
  startUnits: string[];
  frontNodes: number;
  frontInfluenceKm: number;
  frontPush: number; // km/s per unit of net force
  frontMaxSpeed: number; // km/s
  frontSmoothing: number; // 0..1 per second
  abstractPower: number; // weight of the economy-driven "abstract war"
  energyDeficitMult: number;
  pointScorePerSec: number;
  minBuildDistanceFromFront: number; // km
  minBuildSpacing: number; // km
  fogOfWar: boolean;
}

export interface ScriptSource {
  modId: string;
  file: string;
  source: string;
}

export interface Ruleset {
  mods: { id: string; name: string; version: string }[];
  rules: RulesConfig;
  resources: ResourceDef[];
  buildings: BuildingDef[];
  units: UnitDef[];
  maps: MapDef[];
  themes: { modId: string; css: string }[];
  scripts: ScriptSource[];
}

export const DEFAULT_RULES: RulesConfig = {
  tickRate: 10,
  snapshotRate: 5,
  matchSeconds: 1800,
  startUnits: ['infantry', 'infantry', 'infantry', 'infantry'],
  frontNodes: 56,
  frontInfluenceKm: 28,
  frontPush: 0.0004,
  frontMaxSpeed: 0.05,
  frontSmoothing: 0.35,
  abstractPower: 1,
  energyDeficitMult: 0.4,
  pointScorePerSec: 1,
  minBuildDistanceFromFront: 3,
  minBuildSpacing: 1.2,
  fogOfWar: true,
};
