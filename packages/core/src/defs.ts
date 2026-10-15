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
  /** Local stock of physical goods (metal, fuel, ore) per resource. Goods arrive by production or by truck. */
  storageCap?: number;
  /** Fortifications and other field works (built near the front, between the HQ and the line). */
  fieldWork?: boolean;
  /** Field hospital and the like: heals friendly units of a kind within the radius (share of max HP per second). */
  heals?: HealDef;
  /** Ammo point: friendly units within the radius refill up to `rounds` rounds a second from its ammo store. */
  supply?: { radiusKm: number; rounds: number };
  /** May also be built inside your side's grey zones (contested ground), even behind the enemy line. */
  buildInGrey?: boolean;
  /** Drawn as a line (trenches): length limits in km; cost and build time are per km, cover reaches `defense.radiusKm` from the line. */
  line?: { minKm: number; maxKm: number };
  /** Bunker: troops on foot can take cover inside, fire out of it and cannot be hit until it falls. */
  garrison?: { capacity: number };
  /** Launcher: drones and missiles of these kinds wait here and take off from here (airfield: recon; launch site: strike). */
  launches?: ('recon' | 'strike')[];
  /** Railway track (a line): joins up with stations and other track within 1.5 km into a network trains run on. */
  rail?: boolean;
  /** A line that must span barrier water with both ends on your dry ground (bridges). */
  spansWater?: boolean;
  /** Two buildings of this kind must stay this far apart (km), e.g. ore mines. */
  sameKindKm?: number;
  /** Supply-chain links: these buildings must stay `minBuildSpacing` km apart (checked both ways), so goods go by truck. */
  spacedFrom?: string[];
  /** Static weapon, e.g. air defence. */
  attack?: { range: number; damage: number; targets: 'air' | 'ground' | 'all'; fx?: string; missRate?: number };
  /** Boats/pontoons: friendly ground units may cross barrier water inside this radius. */
  crossing?: { radiusKm: number; speed: number };
  /** Upgrades bought with resources: entry 0 is level 2, entry 1 is level 3, … */
  levels?: { cost: ResourceAmounts; time: number; defenseMult?: number; hp?: number }[];
  /** Training centre: ground units that walk in are schooled in batches and come out one rank higher. */
  training?: { minUnits: number; capacity: number; baseTime: number; timePerRank: number };
  /** Must be built within this many km of barrier water (river bank). */
  needsWaterWithinKm?: number;
}

/** Healing: 'foot' = troops on foot (medics, hospitals), 'vehicle' = wheeled and tracked machines (mechanics). */
export interface HealDef {
  radiusKm: number;
  perSecond: number;
  targets: 'foot' | 'vehicle';
}

export interface UnitDef {
  id: string;
  name: string;
  description?: string;
  kind: 'ground' | 'air';
  /** Mobility class looked up in each terrain's `speed` table: foot, tracked, wheeled, air (mods may add more). */
  mobility?: string;
  /** NATO APP-6 style icon: infantry, armor, artillery, uav, recon, engineer, antiair, supply. */
  symbol?: string;
  /** Firing animation: burst (small arms), shell (direct fire), arc (indirect fire), beam (drone strike). */
  fx?: string;
  /** Share of shots that visibly miss, 0..1 (animation only, damage is unaffected). */
  missRate?: number;
  /** Damage multiplier against air units (default: rules.airDamageDefault); 0 = cannot engage aircraft at all. */
  airDamage?: number;
  /** What it may shoot at: 'air' for anti-aircraft teams (MANPADS), default everything its weapons allow. */
  targets?: 'air' | 'ground' | 'all';
  /** Logistics: how much cargo it hauls, how many infantry it carries, and whether it is a fuel tanker. */
  cargoCap?: number;
  passengerCap?: number;
  fuelOnly?: boolean;
  /** Fuel tank (vehicles and drones); missing = needs no fuel. */
  maxFuel?: number;
  /** Drones: strike drones dive on their target and explode, recon drones circle their area. */
  droneType?: 'strike' | 'recon';
  /** Missiles are one-way strike craft: cruise missiles fly low and can be intercepted, ballistic ones are hard to stop. */
  missile?: 'cruise' | 'ballistic';
  /** Strike craft: blast radius on impact (km). Default 1.8. */
  blastKm?: number;
  /** Aircraft: how fast it can turn, degrees per second. Default 30. */
  turnRate?: number;
  /** Share of anti-air shots that actually hit it, 0..1. Default 1. */
  interceptChance?: number;
  /** Small drone that can ride on a vehicle with `droneCap` and be launched from it. */
  launchable?: boolean;
  /** Vehicles: how many launchable drones it carries. */
  droneCap?: number;
  /** Only this side may build it (side-specific drones). */
  side?: 'ua' | 'ru';
  /** Indirect fire: cannot hit closer than this (km) and needs a friendly spotter on the target. */
  minRange?: number;
  /** Seconds it needs to aim at a new target before the first shot (artillery). */
  aimTime?: number;
  /** How easily it is spotted (<1 stealthy, >1 loud). Default 1 on foot, 1.35 for vehicles. */
  stealth?: number;
  /** Rounds carried when full; 0 (or missing) = carries no weapon ammunition. */
  maxAmmo?: number;
  /** Rounds one shot (a burst, a shell, a missile) uses; a unit with fewer left cannot fire. Default 1. */
  ammoPerShot?: number;
  /** Ammo (resource) one round costs when refilled at a depot. Default 1. */
  ammoCost?: number;
  /** Medic or mechanic: heals friendly units of a kind within the radius (share of max HP per second). */
  heals?: HealDef;
  /** Runs only on railway track between stations (trains). */
  railOnly?: boolean;
  /** Can repair cities and buildings. */
  repairs?: boolean;
  cost: ResourceAmounts;
  trainTime: number;
  hp: number;
  speed: number; // km/s
  range: number; // km
  damage: number; // dps
  vision: number; // km
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
  /** Multiplier on how far ground units standing here can see (high ground sees further). Default 1. */
  vision?: number;
  description?: string;
  /** Connected areas of at least `minCells` cells block these mobility classes (bridges and boat crossings excepted). */
  barrier?: { minCells: number; mobility: string[] };
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
  /** Holes cut out of team 1's territory polygon, e.g. the Sea of Azov (rendering only). */
  occupiedHoles?: LngLat[][];
  /** State borders (LineString features) and country labels (Point features). In map JSON use `bordersFile`. */
  borders?: any;
  /** City boundaries from OpenStreetMap (fill + line features). In map JSON use `citiesFile`. */
  cities?: any;
  /** Fuel stations (loaded, not used by the base rules yet). In map JSON use `fuelFile`. */
  fuel?: any;
  /** Road network (see tools/build-roads.mjs). In map JSON use `roadsFile` instead. */
  roads?: RoadLine[];
  /** Terrain grid (see tools/build-terrain.mjs). In map JSON use `terrainFile` instead. */
  terrain?: TerrainGridData;
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
  airDamageDefault: number; // ground weapons against aircraft
  transportDamageMult: number; // damage taken while driving in column on a road
  maxQueuedOrders: number;
  pinchKm: number; // jaws closer than this cut the loop between them off as a cauldron
  pocketMinAreaKm2: number; // a cauldron squeezed below this collapses
  encircledDamageMult: number;
  encircledAttrition: number; // share of max HP lost per second inside a cauldron
  cauldronScore: number; // score per unit destroyed when a cauldron collapses
  courseCostPerTick: number; // money per unit per simulation tick while a course runs
  courseCostPerRank: number; // added per rank the unit already holds
  powerGridKm: number; // buildings this close to a friendly power plant are on the grid
  powerGridMult: number; // output and training speed on the grid
  housingGridMult: number; // housing income on the grid
  cityHousingLimit: number;
  storageCap: number; // per resource, per building (default)
  fieldWorkSpacing: number; // km: the ground any building takes (military sites need no more)
  civilSpacing: number; // km between two civil sites (power plants, refineries, stations…)
  startStorage: number; // goods a new building starts with
  greyZoneSeconds: number; // unopposed time behind the front before ground turns grey
  greyZoneSoloKm: number; // "unopposed" = no enemy unit this close
  greyZoneRadiusKm: number;
  greyZoneTtl: number; // seconds a grey zone lasts after the troops leave
  greyZonePush: number; // extra force for the infiltrating side on front nodes at the zone
  fuelPerKm: number; // fuel a ground vehicle burns per km driven (×1.5 when sprinting)
  liberateSeconds: number; // ground the front passes over stays grey until no enemy troops have been near it this long
  peaceSeconds: number; // ceasefire at the start: build and deploy, but nobody may fight or cross the front
  sandbox: boolean; // test mode: endless resources, stocked stores, no victory or time limit
  buildTimeMult: number; // multiplies every build, upgrade and course time
  trainTimeMult: number; // multiplies every training time
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
  frontInfluenceKm: 28,
  frontPush: 0.0024,
  frontMaxSpeed: 0.11,
  frontSmoothing: 0.2,
  abstractPower: 1,
  energyDeficitMult: 0.4,
  pointScorePerSec: 1,
  minBuildDistanceFromFront: 3,
  minBuildSpacing: 1.2,
  fogOfWar: true,
  roadSpeedMult: 2.4,
  roadAccessKm: 5,
  roadOutputMult: 1.15,
  xpPerDamage: 0.2,
  xpPerKill: 25,
  airDamageDefault: 0.25,
  transportDamageMult: 1.5,
  maxQueuedOrders: 8,
  pinchKm: 3.5,
  pocketMinAreaKm2: 40,
  encircledDamageMult: 0.6,
  encircledAttrition: 0.004,
  cauldronScore: 40,
  courseCostPerTick: 0.1,
  courseCostPerRank: 0.05,
  powerGridKm: 100,
  powerGridMult: 1.25,
  housingGridMult: 1.5,
  cityHousingLimit: 10,
  storageCap: 30000,
  fieldWorkSpacing: 1.2,
  civilSpacing: 5,
  startStorage: 500,
  greyZoneSeconds: 10,
  greyZoneSoloKm: 6,
  greyZoneRadiusKm: 5,
  greyZoneTtl: 20,
  greyZonePush: 5,
  fuelPerKm: 0.3,
  liberateSeconds: 30,
  peaceSeconds: 0,
  sandbox: false,
  buildTimeMult: 1,
  trainTimeMult: 1,
};
