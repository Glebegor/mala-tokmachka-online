import type { Command } from './commands';
import type { MapDef, Ruleset } from './defs';
import type { Building, FrontNode, Player, Team, Unit, CapturePoint } from './state';

export type ClientMsg = { t: 'cmd'; cmd: Command } | { t: 'ping' };

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
  res: Record<string, number>;
  energyNet: number;
  buildings: Building[];
  units: Unit[];
  front: FrontNode[];
  points: CapturePoint[];
  scores: [number, number];
  queue: { building: number; unit: string; remaining: number }[];
}

export type ServerMsg =
  | InitMsg
  | SnapMsg
  | { t: 'end'; winner: Team | null; reason: string }
  | { t: 'error'; reason: string }
  | { t: 'toast'; text: string }
  | { t: 'pong' };

export interface RoomSlot {
  id: string;
  name: string;
  team: Team;
  bot: boolean;
}

export type BotDifficulty = 'easy' | 'normal' | 'hard';

export interface RoomSettings {
  mapId: string;
  matchMinutes: number; // 5..90
  teamSize: number; // 1..8
  fillBots: boolean; // pad teams with bots up to teamSize
  botDifficulty: BotDifficulty;
  startResources: 'low' | 'normal' | 'high';
  frontSpeed: 0.5 | 1 | 2;
  fogOfWar: boolean;
}

export const DEFAULT_SETTINGS: RoomSettings = {
  mapId: 'zaporizhzhia',
  matchMinutes: 30,
  teamSize: 8,
  fillBots: true,
  botDifficulty: 'normal',
  startResources: 'normal',
  frontSpeed: 1,
  fogOfWar: true,
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
