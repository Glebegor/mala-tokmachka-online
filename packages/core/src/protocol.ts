import type { Command } from './commands';
import type { MapDef, Ruleset } from './defs';
import type { BuildingView, FrontNode, Player, Shot, Team, UnitView, CapturePoint } from './state';

/** `ready`: the client has drawn the map; the start countdown waits for it. */
export type ClientMsg = { t: 'cmd'; cmd: Command } | { t: 'ping' } | { t: 'ready' } | { t: 'powerLines'; building: number };

export interface InitMsg {
  t: 'init';
  you: string;
  team: Team;
  matchId: string;
  ruleset: Omit<Ruleset, 'scripts' | 'maps'>;
  map: MapDef;
  players: Pick<Player, 'id' | 'name' | 'team' | 'bot'>[];
}

export interface SnapMsg {
  t: 'snap';
  time: number;
  /** Seconds until the match starts (3, 2, 1), 0 once it is running, -1 while waiting for players to load. */
  countdown: number;
  res: Record<string, number>;
  energyNet: number;
  /** Net production per second, per resource. */
  rates: Record<string, number>;
  buildings: BuildingView[];
  units: UnitView[];
  /** Shots fired since the previous snapshot (animation only). */
  shots: Shot[];
  front: FrontNode[];
  /** Strike craters still smoking. */
  smokes: { id: number; pos: [number, number]; expiresAt: number }[];
  /** Grey zones: contested patches behind the front. */
  grey: { team: Team; pos: [number, number]; r: number }[];
  /**
   * Ground that changed hands, as runs of grid cells (see LIBERATED_CELL): [iy, kind, first ix, count, …] where kind is
   * 0 or 1 = grey, contested after that team took it; 2 = liberated by Ukraine (blue).
   * Only sent when it changed (and in the first snapshot); missing = unchanged.
   */
  liberated?: number[];
  /** Cauldrons: closed rings around cut-off territory. */
  pockets: { id: number; team: Team; nodes: { lng: number; lat: number }[] }[];
  points: CapturePoint[];
  scores: [number, number];
  /** Training orders at your side's buildings, in order; the first one per building is in progress. */
  queue: { id: number; building: number; unit: string; owner: string; remaining: number; total: number }[];
  /** Players who keep their buildings to themselves (teammates cannot use them). */
  closed: string[];
}

export type ServerMsg =
  | InitMsg
  | SnapMsg
  | { t: 'end'; winner: Team | null; reason: string }
  | { t: 'error'; reason: string }
  | { t: 'toast'; text: string }
  | { t: 'pong' }
  /** Power lines (along roads) from a power plant to the buildings it feeds, or to a consumer from its plant. */
  | { t: 'powerLines'; building: number; lines: [number, number][][] };

export interface RoomSlot {
  id: string;
  name: string;
  team: Team;
  bot: boolean;
}

export type BotDifficulty = 'easy' | 'normal' | 'hard';
/** standard: a normal match; sandbox: a test range with endless resources, fast building and no victory. */
export type GameMode = 'standard' | 'sandbox';

export interface RoomSettings {
  mapId: string;
  matchMinutes: number; // 5..90
  teamSize: number; // 1..8
  fillBots: boolean; // pad teams with bots up to teamSize
  botDifficulty: BotDifficulty;
  startResources: 'low' | 'normal' | 'high';
  frontSpeed: 0.5 | 1 | 2;
  fogOfWar: boolean;
  mode: GameMode;
  /** Ceasefire at the start (minutes): build and deploy, no fighting, the front is closed. */
  peaceMinutes: number;
}

export const PEACE_OPTIONS = [0, 5, 10, 15, 20, 30] as const;

export const DEFAULT_SETTINGS: RoomSettings = {
  mapId: 'ukraine',
  matchMinutes: 30,
  teamSize: 8,
  fillBots: false,
  botDifficulty: 'normal',
  startResources: 'normal',
  frontSpeed: 1,
  fogOfWar: true,
  mode: 'standard',
  peaceMinutes: 15,
};

export interface RoomInfo {
  id: string;
  name: string;
  host: string;
  settings: RoomSettings;
  slots: RoomSlot[];
  status: 'open' | 'playing';
  matchId?: string;
}
