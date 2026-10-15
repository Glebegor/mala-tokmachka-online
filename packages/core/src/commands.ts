import type { LngLat } from './geo';
import type { Formation, Stance } from './state';

export type Command =
  /** `to`: the far end of a line structure (trench) drawn from `pos`. */
  | { type: 'build'; def: string; pos: LngLat; to?: LngLat }
  | { type: 'train'; building: number; unit: string }
  /** Where a production building sends what it makes (null: they stay at the building). */
  | { type: 'rally'; building: number; pos: [number, number] | null }
  /** Keep training this unit whenever the queue is empty and resources allow (null: stop). */
  | { type: 'repeat'; building: number; unit: string | null }
  /** Launch drones or missiles waiting at a launcher at a target. */
  | { type: 'launchFrom'; building: number; units: number[]; target: [number, number] }
  /** Cancel one of your own training orders (full refund). */
  | { type: 'cancelTrain'; item: number }
  /**
   * `queue` appends to the current orders; `mode: 'direct'` skips roads and stays combat-ready when the way is open;
   * `attack` stops to fight whatever it meets on the way. `formation` arranges a group at the destination.
   */
  | { type: 'move'; units: number[]; to: LngLat; cohesion?: boolean; queue?: boolean; mode?: 'fast' | 'direct'; attack?: boolean; formation?: Formation; facing?: number }
  /** How units behave on their own: hold position, defend their post, or go after what they see. */
  | { type: 'stance'; units: number[]; stance: Stance }
  /** Fall back to a hospital or base by themselves below this share of health (0 = never). */
  | { type: 'retreat'; units: number[]; at: number }
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
  /**
   * Standing delivery order for a truck (resType: what to carry, 'any' for anything but fuel). Either two buildings
   * (load at the first, unload at the second) or 2–6 stops with actions and waypoints; `minLoad`: leave the last loading
   * stop only with at least this much (or a full load).
   */
  | { type: 'setRoute'; unit: number; fromBuilding?: number; toBuilding?: number; stops?: { action: 'load' | 'unload' | 'via'; building?: number; pos?: [number, number] }[]; resType?: string; minLoad?: number }
  /** Infantry ride in a vehicle with seats; small drones ride on a vehicle with a launcher (`droneCap`). */
  | { type: 'board'; unit: number; transport: number }
  /** Launch the drones a vehicle carries, optionally straight at a target. */
  | { type: 'launch'; transport: number; target?: [number, number] }
  /** Let teammates use your buildings (train, deliver, school, refuel) or keep them to yourself. */
  | { type: 'share'; allow: boolean }
  | { type: 'disembark'; transport: number }
  | { type: 'refuel'; units: number[] }
  /** Drive to another (own or allied) vehicle and hand it fuel: tankers from their load, other vehicles from their own tank. */
  | { type: 'giveFuel'; unit: number; target: number }
  /** Artillery barrage on an area (null stops it). */
  | { type: 'bombard'; units: number[]; target: [number, number] | null };

export type CommandResult = { ok: true } | { ok: false; reason: string };
