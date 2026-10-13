import type { SnapMsg } from './protocol';
import type { Sim } from './sim';
import { distKm, type LngLat } from './geo';
import type { Shot, Team } from './state';

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const p4 = (p: LngLat): LngLat => [r4(p[0]), r4(p[1])];

/**
 * Fog of war: own side is fully visible, enemy objects only inside friendly vision/signal radius.
 * Ground units in concealing terrain (forest, city) must be approached closer to be spotted.
 */
export function snapshotFor(sim: Sim, playerId: string, team: Team, shots: Shot[] = []): SnapMsg {
  const w = sim.world;
  const fog = sim.ruleset.rules.fogOfWar;
  const watchers: { pos: LngLat; r: number }[] = [];
  if (fog) {
    for (const b of w.buildings) {
      if (b.team === team && b.progress >= 1) watchers.push({ pos: b.pos, r: sim.defs.b.get(b.def)!.vision ?? 6 });
    }
    for (const u of w.units) {
      if (u.team !== team) continue;
      const d = sim.defs.u.get(u.def)!;
      watchers.push({ pos: u.pos, r: d.vision * (d.kind === 'air' ? 1 : sim.terrainAt(u.pos).vision ?? 1) });
    }
  }
  const seen = (p: LngLat, conceal = 1) => !fog || watchers.some((s) => distKm(s.pos, p) <= s.r * conceal);
  const me = w.players.find((p) => p.id === playerId);

  return {
    t: 'snap',
    time: Math.round(w.time * 10) / 10,
    res: me ? { ...me.res } : {},
    energyNet: sim.energyNet.get(playerId) ?? 0,
    rates: { ...(sim.income.get(playerId) ?? {}) },
    buildings: w.buildings
      .filter((b) => b.team === team || seen(b.pos))
      .map((b) => ({
        id: b.id, def: b.def, owner: b.owner, team: b.team, pos: p4(b.pos), hp: Math.round(b.hp), progress: b.progress, road: b.road, cooldown: 0,
        course: b.team === team && b.course ? { remaining: Math.ceil(b.course.remaining), total: b.course.total } : null,
        inside: b.team === team && b.inside.length ? b.inside.map((u) => ({ def: u.def, rank: u.rank })) : undefined,
      })),
    units: w.units
      .filter((u) => u.team === team || seen(u.pos, sim.defs.u.get(u.def)!.kind === 'air' ? 1 : sim.terrainAt(u.pos).concealment))
      .map((u) => ({ id: u.id, def: u.def, owner: u.owner, team: u.team, pos: p4(u.pos), hp: Math.round(u.hp), target: u.team === team ? u.target : null, cooldown: 0, xp: Math.round(u.xp), rank: u.rank, transport: u.transport, encircled: u.encircled, entering: u.owner === playerId && u.enter ? u.enter : undefined, route: u.owner === playerId && u.path.length ? u.path.filter((w) => w.end).map((w) => p4(w.p)) : undefined })),
    shots: shots.filter((s) => s.team === team || seen(s.from) || seen(s.to)).map((s) => ({ def: s.def, team: s.team, from: p4(s.from), to: p4(s.to) })),
    front: w.front.map((n) => ({ lng: r4(n.lng), lat: r4(n.lat), v: Math.round(n.v * 1e4) / 1e4 })),
    pockets: w.pockets.map((p) => ({ id: p.id, team: p.team, nodes: p.nodes.map((n) => ({ lng: r4(n.lng), lat: r4(n.lat) })) })),
    points: w.points,
    scores: [Math.round(w.scores[0]), Math.round(w.scores[1])],
    queue: w.queue.filter((q) => q.owner === playerId).map((q) => ({ building: q.building, unit: q.unit, remaining: Math.round(q.remaining) })),
  };
}
