import type { LngLat } from './geo';
import type { ResourceAmounts } from './defs';

export type Team = 0 | 1;

export interface Player {
  id: string;
  name: string;
  team: Team;
  bot: boolean;
  res: ResourceAmounts;
}

export interface Building {
  id: number;
  def: string;
  owner: string;
  team: Team;
  pos: LngLat;
  hp: number;
  progress: number; // 0..1, 1 = complete
  road: boolean; // connected to the road network
  storage?: Record<string, number>; // local resource storage (max 30,000 per resource)
}

export interface UnitCargo {
  res: Record<string, number>;
  cap: number;
  passengers?: number[]; // IDs of embarked units
}

export interface UnitRoute {
  fromBuilding: number;
  toBuilding: number;
  resType?: string;
  state?: 'to_from' | 'loading' | 'to_to' | 'unloading';
  timer?: number;
}

export interface Unit {
  id: number;
  def: string;
  owner: string;
  team: Team;
  pos: LngLat;
  hp: number;
  target: LngLat | null;
  cooldown: number;
  xp: number;
  rank: number; // index into ruleset.ranks
  /** Remaining waypoints (server side only). `road` legs use road speed and ignore terrain. */
  path: Waypoint[];
  /** Speed cap in km/s when ordered to move in formation, 0 = none. */
  cap: number;
  stamina?: number; // 0..100
  sprint?: boolean; // 2x speed for all non-drones, 1.5x fuel for vehicles
  fireMode?: 'auto' | 'return' | 'hold';
  fuel?: number;
  maxFuel?: number;
  cargo?: UnitCargo;
  route?: UnitRoute;
  embarkedIn?: number; // transport unit ID carrying this passenger
  loiterCenter?: LngLat;
  loiterAngle?: number;
}

export interface SmokeCloud {
  id: number;
  pos: LngLat;
  createdAt: number;
  expiresAt: number;
}

export interface Waypoint {
  p: LngLat;
  road: boolean;
}

/** A weapon discharge, sent to clients purely for animation. */
export interface Shot {
  def: string;
  team: Team;
  from: LngLat;
  to: LngLat;
}

export type UnitView = Omit<Unit, 'path' | 'cap'> & { path?: LngLat[] };

export interface TrainItem {
  building: number;
  unit: string;
  owner: string;
  remaining: number;
}

export interface FrontNode {
  lng: number;
  lat: number;
  v: number; // km/s along the normal, + = team 0 advancing
}

export interface Pocket {
  id: number;
  team: Team; // team inside the pocket
  nodes: FrontNode[];
}

export interface CapturePoint {
  id: string;
  owner: Team;
}

export interface World {
  tick: number;
  time: number;
  players: Player[];
  buildings: Building[];
  units: Unit[];
  queue: TrainItem[];
  front: FrontNode[];
  pockets?: Pocket[];
  points: CapturePoint[];
  scores: [number, number];
  winner: Team | null;
  winReason: string | null;
  nextId: number;
  mapId: string;
  smokes?: SmokeCloud[];
}

export interface SlotInit {
  id: string;
  name: string;
  team: Team;
  bot: boolean;
}
