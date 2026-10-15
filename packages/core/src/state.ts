import type { LngLat } from './geo';
import type { ResourceAmounts } from './defs';

export type Team = 0 | 1;

export interface Player {
  id: string;
  name: string;
  team: Team;
  bot: boolean;
  res: ResourceAmounts;
  /** Teammates may train at, supply and use this player's buildings. */
  share: boolean;
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
  /** Local stock of physical goods (own team only in snapshots). */
  storage?: Record<string, number>;
  lastDamagedTime?: number;
  /** Line structures (trenches): the two ends, and the length in km (cost, build time and upgrades scale with it). */
  line?: [LngLat, LngLat];
  size?: number;
  /** What last damaged it: a blast (artillery, missile, drone) kills a garrison with the building, direct fire does not. */
  lastHitBy?: 'blast' | 'direct';
  /** Production buildings: where new units walk to (none = they stay at the building). */
  rally?: LngLat;
  /** Keeps training this unit whenever its queue is empty and the resources are there. */
  repeat?: string;
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
  /** Own team only: who is inside, and whether each one can take the next course. */
  inside?: { def: string; rank: number; ready: boolean }[];
};

export interface UnitCargo {
  res: Record<string, number>;
  cap: number;
  passengers?: number[]; // ids of units riding inside
  drones?: number[]; // ids of launchable drones carried (pickups)
}

/** One stop of a delivery route: load or unload at a building, or just drive through a waypoint. */
export interface HaulStop {
  action: 'load' | 'unload' | 'via';
  building?: number;
  pos?: LngLat;
}

/** A standing delivery order for a truck: 2–6 stops driven in a loop (load, unload, waypoints), repeat. */
export interface Haul {
  stops: HaulStop[];
  /** The stop it is heading for (or working at). */
  idx: number;
  state?: 'moving' | 'loading' | 'unloading';
  resType?: string;
  /** Leave the last loading stop only with at least this much on board (or full). */
  minLoad?: number;
  timer?: number;
  /** At a loading stop, waiting for enough goods. */
  waiting?: boolean;
  /** A train with no track to its next stop: it waits until there is a connection. */
  noTrack?: boolean;
  /** Track segments the current leg runs on (a train re-plans when one is cut). */
  railSegs?: number[];
}

export type Stance = 'hold' | 'defend' | 'aggressive';
export type Formation = 'spread' | 'line' | 'column' | 'wedge';

export interface SmokeCloud {
  id: number;
  pos: LngLat;
  createdAt: number;
  expiresAt: number;
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
  /** 0–100. Falls when encircled, out of ammo or under fire; below 50 it fights worse; encircled at 0 it surrenders. */
  morale?: number;
  /** Shaken after its bunker fell: cannot fire and takes more damage until this time. */
  suppressedUntil?: number;
  /** What an aggressive or defending unit was last closing with (server side). */
  chase?: LngLat;
  /** Friendly ground units within 1.5 km (itself included): above 6 the crowd is penalised. */
  crowd?: number;
  /** Had a target last time it looked (server side). */
  engaged?: boolean;
  /** Seconds it has stood still (digging in: the longer, the better protected). */
  still?: number;
  /** Sim time it last took damage (healing waits until it has been out of the fight for a while). */
  lastHit?: number;
  /** A medic, mechanic or hospital is patching it up (server side, shown as a status). */
  healing?: boolean;
  /** Enemy units destroyed since its last course: above the first rank a course needs at least one. */
  combat?: number;
  /** Driving in column on a road: fast, but cannot fire and takes extra damage. */
  transport: boolean;
  /** Cut off inside a cauldron: weaker and bleeding strength until relieved or destroyed. */
  encircled: boolean;
  stamina?: number; // infantry, 0..100
  sprint?: boolean; // double speed: drains stamina (infantry) or burns 1.5x fuel (vehicles)
  fireMode?: 'auto' | 'return' | 'hold';
  /** Behaviour when idle: hold = never moves on its own; defend = engages enemies near its post and returns; aggressive = chases what it sees. */
  stance?: Stance;
  /** Where it was put (a defending unit returns here). */
  post?: LngLat;
  /** Falls back to a hospital or base by itself below this share of its health (0 = never). */
  retreatAt?: number;
  retreating?: boolean;
  /** Strike craft locked on a target: follows it until impact. */
  lockOn?: { unit?: number; building?: number };
  /** Moving with an attack-move order: stops to fight whatever it meets. */
  attackMove?: boolean;
  fuel?: number;
  maxFuel?: number;
  /** Rounds left (see UnitDef.maxAmmo). */
  ammo?: number;
  cargo?: UnitCargo;
  haul?: Haul;
  embarkedIn?: number; // the transport this unit rides in
  /** Drones and missiles waiting at a launcher (or their factory) for a launch order. */
  parkedAt?: number;
  /** Driving over to another vehicle to hand it fuel (unit id). */
  fuelTo?: number;
  loiterCenter?: LngLat;
  loiterRadius?: number;
  isLoitering?: boolean;
  bombardTarget?: LngLat | null; // artillery barrage area
  /** Aiming (artillery): what it is laying its guns on and how long until it can fire. */
  aimKey?: string;
  aim?: number;
  bearing?: number; // degrees, 0 = north
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
export const DEBUFFS = new Set(['exposed', 'lowsight', 'slowed', 'transport', 'encircled', 'lowfuel', 'nofuel', 'lowammo', 'noammo', 'lowmorale', 'broken', 'suppressed', 'crowded']);

export interface Waypoint {
  p: LngLat;
  road: boolean;
  /** On railway track (trains): full speed, no terrain. */
  rail?: boolean;
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
  /** Own units: the planned path (thinned) for route lines and ETA. */
  path?: LngLat[];
  /** Own units only: the training centre this unit is walking into. */
  entering?: number;
  /** Destinations of the queued move orders, own units only. */
  route?: LngLat[];
};

export interface TrainItem {
  id: number;
  building: number;
  unit: string;
  owner: string;
  remaining: number;
  total: number;
  /** What was paid, refunded if the order is cancelled: treasury share and goods taken from the building's store. */
  paid: ResourceAmounts;
  site: ResourceAmounts;
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

/**
 * Grid cell (see LIBERATED_CELL) of ground that changed hands, as on DeepState: grey (contested) until no enemy ground
 * troops have been near it for a while; then Ukrainian gains turn blue (liberated) and Russian ones plain occupied.
 */
export interface LiberatedCell {
  ix: number;
  iy: number;
  team: Team; // the side that took it
  quiet: number; // seconds without enemy ground troops nearby
  free: boolean; // settled and shown as liberated (team 0 only)
  /** When it turned blue (recently liberated ground is shown brighter). */
  freedAt?: number;
}

/** Size of a liberated-ground cell in degrees (about 1.5 km). */
export const LIBERATED_CELL = { lng: 0.02, lat: 0.0135 } as const;

export interface CapturePoint {
  id: string;
  owner: Team;
  hp?: number;
  maxHp?: number;
  lastDamagedTime?: number;
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

/** One sample of how the match stood (taken every 30 s) for the end-of-match charts. */
export interface TimelinePoint {
  t: number; // match seconds
  score: [number, number];
  units: [number, number];
  buildings: [number, number];
  cities: [number, number];
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
  /** Ground the front has just passed over: contested until held (see `RulesConfig.liberateSeconds`). */
  liberated: LiberatedCell[];
  points: CapturePoint[];
  scores: [number, number];
  winner: Team | null;
  winReason: string | null;
  nextId: number;
  mapId: string;
  stats: Record<string, PlayerStats>;
  smokes: SmokeCloud[];
  timeline: TimelinePoint[];
}

export interface SlotInit {
  id: string;
  name: string;
  team: Team;
  bot: boolean;
}
