import type { LngLat } from './geo';

export type Command =
  | { type: 'build'; def: string; pos: LngLat }
  | { type: 'train'; building: number; unit: string }
  /** `queue` appends to the current orders; `mode: 'direct'` skips roads and stays combat-ready when the way is open. */
  | { type: 'move'; units: number[]; to: LngLat; cohesion?: boolean; queue?: boolean; mode?: 'fast' | 'direct' }
  | { type: 'stop'; units: number[] }
  /** Send ground units into a training centre. */
  | { type: 'enter'; units: number[]; building: number }
  /** Pay for and start a course for everyone inside. */
  | { type: 'course'; building: number }
  /** Let everyone inside walk out (not during a course). */
  | { type: 'release'; building: number }
  | { type: 'demolish'; building: number }
  /** Buy the next level of a building that has `levels` (trenches, bunkers). */
  | { type: 'upgrade'; building: number };

export type CommandResult = { ok: true } | { ok: false; reason: string };
