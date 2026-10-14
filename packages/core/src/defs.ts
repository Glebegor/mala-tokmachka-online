import type { LngLat } from './geo';
import type { RoadLine } from './roads';
import type { TerrainGridData } from './terrain';

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
  storageCap?: number;
}

export interface UnitDef {
  id: string;
  name: string;
  kind: 'ground' | 'air';
  /** Mobility class looked up in each terrain's `speed` table: foot, tracked, wheeled, air (mods may add more). */
  mobility?: string;
  /** NATO APP-6 style icon: infantry, armor, artillery, uav, recon, engineer, antiair, supply. */
  symbol?: string;
  /** Firing animation: burst (small arms), shell (direct fire), arc (indirect fire), beam (drone strike). */
  fx?: string;
  /** Share of shots that visibly miss, 0..1 (animation only, damage is unaffected). */
  missRate?: number;
  cost: ResourceAmounts;
  trainTime: number;
  hp: number;
  speed: number; // km/s
  range: number; // km
  damage: number; // dps
  vision: number; // km
  cargoCap?: number;
  passengerCap?: number;
  fuelOnly?: boolean;
  maxFuel?: number;
  droneType?: 'strike' | 'recon';
  side?: 'ua' | 'ru';
  turnSpeed?: number; // deg/sec (for smooth drone/vehicle rotation)
  minRange?: number; // km (minimum firing range, e.g. for artillery dead zone)
  antiAir?: boolean; // true if unit can target and shoot down air units/drones
  stealth?: number; // Spotting distance multiplier (<1 = stealthy/harder to see, >1 = loud/easier to detect)
}

export interface TerrainDef {
  id: string;
  name: string;
  color: string;
  /** Speed multiplier per mobility class when moving off-road; missing classes use `default` or 1. */
  speed: Record<string, number>;
  /** Share of incoming damage absorbed by ground units standing here (negative = exposed). */
  cover: number;
  /** Multiplier on the distance at which enemies can spot ground units here (<1 = harder to see). */
  concealment: number;
  /** How much this terrain slows the front line passing through it, 0..1. */
  frontResist: number;
}

/** Veterancy step. Units start at the first rank and climb by fighting (or by paying `cost`). */
export interface RankDef {
  id: string;
  name: string;
  xp: number; // experience needed to hold this rank
  damage: number; // multipliers
  hp: number;
  range: number;
  cost: ResourceAmounts; // price of buying the promotion to this rank
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
  /** Initial line of contact. Walking along it from first to last point, team 0 is on the LEFT, team 1 on the right. */
  front: LngLat[];
  /** Points appended after the last front node to close team 1's territory into a polygon (rendering only). */
  occupiedClosure: LngLat[];
  /** Optional interior hole rings (e.g. Sea of Azov) for team 1's territory polygon (rendering only). */
  occupiedHoles?: LngLat[][];
  /** Road network (see tools/build-roads.mjs). In map JSON use `roadsFile` instead. */
  roads?: RoadLine[];
  /** Terrain grid (see tools/build-terrain.mjs). In map JSON use `terrainFile` instead. */
  terrain?: TerrainGridData;
  /** State borders and country labels GeoJSON. In map JSON use `bordersFile` instead. */
  borders?: any;
  /** Fuel stations GeoJSON. In map JSON use `fuelFile` instead. */
  fuel?: any;
  fuelFile?: string;
  /** Real OpenStreetMap city boundaries GeoJSON. In map JSON use `citiesFile` instead. */
  cities?: any;
  citiesFile?: string;
  capturePoints: CapturePointDef[];
  spawns: [LngLat[], LngLat[]];
}

export interface RulesConfig {
  tickRate: number;
  snapshotRate: number;
  matchSeconds: number;
  startUnits: string[];
  frontNodeSpacingKm: number;
  frontInfluenceKm: number;
  frontPush: number; // km/s per unit of net force
  frontMaxSpeed: number; // km/s
  frontSmoothing: number; // 0..1, how strongly neighbouring nodes share their speed
  abstractPower: number; // weight of the economy-driven "abstract war"
  energyDeficitMult: number;
  pointScorePerSec: number;
  minBuildDistanceFromFront: number; // km
  minBuildSpacing: number; // km
  fogOfWar: boolean;
  roadSpeedMult: number; // ground units on roads
  roadAccessKm: number; // a building this close to a road is "connected"
  roadOutputMult: number; // output bonus for connected buildings
  xpPerDamage: number;
  xpPerKill: number;
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
  terrain: TerrainDef[];
  ranks: RankDef[];
  maps: MapDef[];
  themes: { modId: string; css: string }[];
  scripts: ScriptSource[];
}

export const DEFAULT_RULES: RulesConfig = {
  tickRate: 10,
  snapshotRate: 5,
  matchSeconds: 1800,
  startUnits: ['infantry', 'infantry', 'infantry', 'infantry'],
  frontNodeSpacingKm: 9,
  frontInfluenceKm: 11.2,
  frontPush: 0.0004,
  frontMaxSpeed: 0.05,
  frontSmoothing: 0.35,
  abstractPower: 1,
  energyDeficitMult: 0.4,
  pointScorePerSec: 1,
  minBuildDistanceFromFront: 3,
  minBuildSpacing: 35,
  fogOfWar: true,
  roadSpeedMult: 1.2,
  roadAccessKm: 5,
  roadOutputMult: 1.15,
  xpPerDamage: 0.2,
  xpPerKill: 15,
};
