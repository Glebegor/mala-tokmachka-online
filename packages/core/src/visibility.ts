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
      if (u.team === team) watchers.push({ pos: u.pos, r: sim.defs.u.get(u.def)!.vision });
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
      .filter((b) => (b.team === team || seen(b.pos)) && !(b.def === 'gas_station' && b.team !== team))
      .map((b) => ({
      ...b,
      pos: p4(b.pos),
      hp: Math.round(b.hp),
      storage: b.team === team ? b.storage : undefined,
    })),
    units: w.units
      .filter((u) => !u.embarkedIn && (u.team === team || seen(u.pos, sim.defs.u.get(u.def)!.kind === 'air' ? 1 : sim.terrainAt(u.pos).concealment)))
      .map((u) => ({
        id: u.id, def: u.def, owner: u.owner, team: u.team, pos: p4(u.pos), hp: Math.round(u.hp),
        target: u.team === team ? u.target : null,
        path: u.team === team && u.path.length ? u.path.map((wp) => p4(wp.p)) : undefined,
        cooldown: 0, xp: Math.round(u.xp), rank: u.rank,
        stamina: u.team === team && u.stamina !== undefined ? Math.round(u.stamina) : undefined,
        sprint: u.sprint,
        fireMode: u.team === team ? u.fireMode : undefined,
        fuel: u.fuel !== undefined ? Math.round(u.fuel) : undefined,
        maxFuel: u.maxFuel,
        cargo: u.team === team ? u.cargo : undefined,
        route: u.team === team ? u.route : undefined,
      })),
    shots: shots.filter((s) => s.team === team || seen(s.from) || seen(s.to)).map((s) => ({ def: s.def, team: s.team, from: p4(s.from), to: p4(s.to) })),
    front: w.front.map((n) => ({ lng: r4(n.lng), lat: r4(n.lat), v: Math.round(n.v * 1e4) / 1e4 })),
    pockets: w.pockets?.length
      ? w.pockets.map((pkt) => ({ id: pkt.id, team: pkt.team, nodes: pkt.nodes.map((n) => ({ lng: r4(n.lng), lat: r4(n.lat), v: 0 })) }))
      : undefined,
    points: w.points,
    scores: [Math.round(w.scores[0]), Math.round(w.scores[1])],
    queue: w.queue.filter((q) => q.owner === playerId).map((q) => ({ building: q.building, unit: q.unit, remaining: Math.round(q.remaining) })),
  };
}
