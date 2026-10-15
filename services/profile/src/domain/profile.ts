import type { MatchReport } from '@sw/core';
export type { MatchReport };

export interface MatchSummary {
  matchId: string;
  mapId: string;
  at: number;
  seconds: number;
  result: 'win' | 'loss' | 'draw';
  kills: number;
  losses: number;
}

/** Career record of one player, built up from finished matches. */
export interface Profile {
  id: string;
  name: string;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  kills: number;
  unitsLost: number;
  unitsTrained: number;
  buildingsBuilt: number;
  buildingsDestroyed: number;
  damage: number;
  secondsPlayed: number;
  recent: MatchSummary[];
}

export interface ProfileRepository {
  get(id: string): Promise<Profile | undefined>;
  all(): Promise<Profile[]>;
  save(profile: Profile): Promise<void>;
  /** The full record of a finished match (every player, the timeline). */
  saveMatch(report: MatchReport): Promise<void>;
  getMatch(id: string): Promise<MatchReport | undefined>;
}

export const emptyProfile = (id: string, name: string): Profile => ({
  id, name, matches: 0, wins: 0, losses: 0, draws: 0, kills: 0, unitsLost: 0, unitsTrained: 0, buildingsBuilt: 0, buildingsDestroyed: 0, damage: 0, secondsPlayed: 0, recent: [],
});

/** Fold one finished match into a profile. Reporting the same match twice changes nothing. */
export function applyMatch(p: Profile, report: MatchReport, player: MatchReport['players'][number], at: number): Profile {
  if (p.recent.some((m) => m.matchId === report.matchId)) return p;
  const result = report.winner === null ? 'draw' : report.winner === player.team ? 'win' : 'loss';
  const s = player.stats;
  return {
    ...p,
    name: player.name,
    matches: p.matches + 1,
    wins: p.wins + (result === 'win' ? 1 : 0),
    losses: p.losses + (result === 'loss' ? 1 : 0),
    draws: p.draws + (result === 'draw' ? 1 : 0),
    kills: p.kills + s.kills,
    unitsLost: p.unitsLost + s.losses,
    unitsTrained: p.unitsTrained + s.unitsTrained,
    buildingsBuilt: p.buildingsBuilt + s.buildingsBuilt,
    buildingsDestroyed: p.buildingsDestroyed + s.buildingsDestroyed,
    damage: p.damage + Math.round(s.damage),
    secondsPlayed: p.secondsPlayed + Math.round(report.seconds),
    recent: [{ matchId: report.matchId, mapId: report.mapId, at, seconds: Math.round(report.seconds), result, kills: s.kills, losses: s.losses } satisfies MatchSummary, ...p.recent].slice(0, 10),
  };
}
