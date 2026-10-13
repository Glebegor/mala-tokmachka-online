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
  cooldown: number; // static weapons
  /** Upgrade level, starting at 1. */
  level: number;
  /** Upgrade to the next level in progress. */
  upgrade: { remaining: number; total: number } | null;
  /** Units inside a training centre (server side only; clients get a summary). */
  inside: Unit[];
  /** Training course in progress. */
  course: { remaining: number; total: number } | null;
}

export type BuildingView = Omit<Building, 'inside'> & {
  /** Own team only: who is inside. */
  inside?: { def: string; rank: number }[];
};

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
  /** Driving in column on a road: fast, but cannot fire and takes extra damage. */
  transport: boolean;
  /** Cut off inside a cauldron: weaker and bleeding strength until relieved or destroyed. */
  encircled: boolean;
  /** Seconds spent unopposed on the enemy's side of the front (builds a grey zone). */
  infil: number;
  /** Active buffs and debuffs, refreshed a few times a second (see `Sim.refreshStatus`). */
  status: UnitStatus[];
  /** Id of the building this unit is walking to in order to go inside, 0 = none. */
  enter: number;
  /** Remaining waypoints (server side only). `road` legs use road speed and ignore terrain. */
  path: Waypoint[];
  /** Speed cap in km/s when ordered to move in formation, 0 = none. */
  cap: number;
}

/**
 * One buff or debuff on a unit: `[id, value]`. Ids: cover, exposed, concealed, highground, lowsight, fortified, veteran
 * (buffs unless noted), slowed, transport, encircled (debuffs). `value` is the size of the effect as a multiplier or share.
 */
export type UnitStatus = [id: string, value: number];

/** Which status ids are debuffs. */
export const DEBUFFS = new Set(['exposed', 'lowsight', 'slowed', 'transport', 'encircled']);

export interface Waypoint {
  p: LngLat;
  road: boolean;
  /** Last waypoint of one move order (orders can be queued). */
  end?: boolean;
}

/** A weapon discharge, sent to clients purely for animation. */
export interface Shot {
  def: string;
  team: Team;
  from: LngLat;
  to: LngLat;
}

export type UnitView = Omit<Unit, 'path' | 'cap' | 'enter' | 'infil'> & {
  /** Own units only: the training centre this unit is walking into. */
  entering?: number;
  /** Destinations of the queued move orders, own units only. */
  route?: LngLat[];
};

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

/** A cut-off piece of territory (cauldron): a closed ring of front nodes around ground still held by `team`. */
export interface Pocket {
  id: number;
  team: Team;
  nodes: FrontNode[];
}

/** Contested ground: a patch behind the front where one side's troops have sat unopposed. */
export interface GreyZone {
  id: number;
  team: Team; // who infiltrated
  pos: LngLat;
  r: number; // km
  ttl: number; // seconds left unless refreshed
}

export interface CapturePoint {
  id: string;
  owner: Team;
}

/** Per-player tallies for one match, reported to the profile service when it ends. */
export interface PlayerStats {
  kills: number;
  losses: number;
  buildingsBuilt: number;
  buildingsDestroyed: number;
  unitsTrained: number;
  damage: number;
}

export interface World {
  tick: number;
  time: number;
  players: Player[];
  buildings: Building[];
  units: Unit[];
  queue: TrainItem[];
  front: FrontNode[];
  pockets: Pocket[];
  grey: GreyZone[];
  points: CapturePoint[];
  scores: [number, number];
  winner: Team | null;
  winReason: string | null;
  nextId: number;
  mapId: string;
  stats: Record<string, PlayerStats>;
}

export interface SlotInit {
  id: string;
  name: string;
  team: Team;
  bot: boolean;
}
