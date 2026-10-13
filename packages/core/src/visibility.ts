import type { SnapMsg } from './protocol';
import type { Sim } from './sim';
import { distKm } from './geo';
import type { Team } from './state';

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Fog of war: own side is fully visible, enemy objects only inside friendly vision/signal radius. */
export function snapshotFor(sim: Sim, playerId: string, team: Team): SnapMsg {
  const w = sim.world;
  const watchers: { pos: [number, number]; r: number }[] = [];
  for (const b of w.buildings) {
    if (b.team === team && b.progress >= 1) watchers.push({ pos: b.pos, r: sim.defs.b.get(b.def)!.vision ?? 6 });
  }
  for (const u of w.units) {
    if (u.team === team) watchers.push({ pos: u.pos, r: sim.defs.u.get(u.def)!.vision });
  }
  const fog = sim.ruleset.rules.fogOfWar;
  const seen = (p: [number, number]) => !fog || watchers.some((s) => distKm(s.pos, p) <= s.r);
  const me = w.players.find((p) => p.id === playerId);

  return {
    t: 'snap',
    time: Math.round(w.time * 10) / 10,
    res: me ? { ...me.res } : {},
    energyNet: sim.energyNet.get(playerId) ?? 0,
    buildings: w.buildings
      .filter((b) => b.team === team || seen(b.pos))
      .map((b) => ({ ...b, pos: [r4(b.pos[0]), r4(b.pos[1])], hp: Math.round(b.hp) })),
    units: w.units
      .filter((u) => u.team === team || seen(u.pos))
      .map((u) => ({ ...u, pos: [r4(u.pos[0]), r4(u.pos[1])], hp: Math.round(u.hp), target: u.team === team ? u.target : null })),
    front: w.front.map((n) => ({ lat: n.lat, lng: r4(n.lng), v: Math.round(n.v * 1e4) / 1e4 })),
    points: w.points,
    scores: [Math.round(w.scores[0]), Math.round(w.scores[1])],
    queue: w.queue.filter((q) => q.owner === playerId).map((q) => ({ building: q.building, unit: q.unit, remaining: Math.round(q.remaining) })),
  };
}
