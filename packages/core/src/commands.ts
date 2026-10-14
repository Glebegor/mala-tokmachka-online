import type { LngLat } from './geo';

export type Command =
  | { type: 'build'; def: string; pos: LngLat }
  | { type: 'train'; building: number; unit: string }
  | { type: 'move'; units: number[]; to: LngLat; cohesion?: boolean; append?: boolean }
  | { type: 'stop'; units: number[] }
  | { type: 'promote'; units: number[] }
  | { type: 'demolish'; building: number }
  | { type: 'fireMode'; units: number[]; mode: 'auto' | 'return' | 'hold' }
  | { type: 'sprint'; units: number[]; active: boolean }
  | { type: 'setRoute'; unit: number; fromBuilding: number; toBuilding: number; resType?: string }
  | { type: 'board'; unit: number; transport: number }
  | { type: 'disembark'; transport: number }
  | { type: 'refuel'; units: number[] };

export type CommandResult = { ok: true } | { ok: false; reason: string };
