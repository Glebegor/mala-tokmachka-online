import type { LngLat } from './geo';

export type Command =
  | { type: 'build'; def: string; pos: LngLat }
  | { type: 'train'; building: number; unit: string }
  | { type: 'move'; units: number[]; to: LngLat }
  | { type: 'stop'; units: number[] }
  | { type: 'demolish'; building: number };

export type CommandResult = { ok: true } | { ok: false; reason: string };
