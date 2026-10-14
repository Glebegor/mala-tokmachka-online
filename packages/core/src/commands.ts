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
  | { type: 'upgrade'; building: number }
  | { type: 'fireMode'; units: number[]; mode: 'auto' | 'return' | 'hold' }
  | { type: 'sprint'; units: number[]; active: boolean }
  /** Standing delivery order for a truck (resType: what to carry, 'any' for anything but fuel). */
  | { type: 'setRoute'; unit: number; fromBuilding: number; toBuilding: number; resType?: string }
  | { type: 'board'; unit: number; transport: number }
  | { type: 'disembark'; transport: number }
  | { type: 'refuel'; units: number[] }
  /** Artillery barrage on an area (null stops it). */
  | { type: 'bombard'; units: number[]; target: [number, number] | null };

export type CommandResult = { ok: true } | { ok: false; reason: string };
