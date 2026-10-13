import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type RoomSettings, type Ruleset, type SlotInit } from '@sw/core';
import { Match, type MatchReporter } from './match';

const START_MULT = { low: 0.5, normal: 1, high: 2.5 } as const;

/** Room settings are applied as overrides on top of the mod-defined ruleset. */
export function applySettings(base: Ruleset, s: RoomSettings): Ruleset {
  return {
    ...base,
    rules: {
      ...base.rules,
      matchSeconds: s.matchMinutes * 60,
      frontPush: base.rules.frontPush * s.frontSpeed,
      frontMaxSpeed: base.rules.frontMaxSpeed * s.frontSpeed,
      fogOfWar: s.fogOfWar,
    },
    resources: base.resources.map((r) => (r.id === 'energy' ? r : { ...r, start: Math.round(r.start * START_MULT[s.startResources]) })),
  };
}

export class MatchManager {
  private matches = new Map<string, Match>();
  constructor(private ruleset: Ruleset, private reporter?: MatchReporter) {}

  create(input: Partial<RoomSettings>, slots: SlotInit[]) {
    const settings: RoomSettings = { ...DEFAULT_SETTINGS, ...input };
    if (!this.ruleset.maps.some((m) => m.id === settings.mapId)) throw new Error('unknown map');
    if (!slots.length || slots.length > 16) throw new Error('bad slots');
    const id = randomUUID().slice(0, 8);
    const m = new Match(id, applySettings(this.ruleset, settings), settings.mapId, slots, settings.botDifficulty);
    if (this.reporter) m.setReporter(this.reporter);
    m.onClose = () => this.matches.delete(id);
    this.matches.set(id, m);
    return m;
  }

  get(id: string) {
    return this.matches.get(id);
  }

  get rules() {
    return this.ruleset;
  }
}
