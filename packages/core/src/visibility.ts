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
export function snapshotFor(sim: Sim, playerId: string, team: Team, shots: Shot[] = [], countdown = 0): SnapMsg {
  const w = sim.world;
  const fog = sim.ruleset.rules.fogOfWar;
  const watchers: { pos: LngLat; r: number }[] = [];
  if (fog) {
    for (const b of w.buildings) {
      if (b.team === team && b.progress >= 1) watchers.push({ pos: b.pos, r: sim.defs.b.get(b.def)!.vision ?? 6 });
    }
    for (const u of w.units) {
      if (u.team !== team || u.embarkedIn) continue;
      const d = sim.defs.u.get(u.def)!;
      watchers.push({ pos: u.pos, r: d.vision * (d.kind === 'air' ? 1 : sim.terrainAt(u.pos).vision ?? 1) });
    }
  }
  const seen = (p: LngLat, conceal = 1) => !fog || watchers.some((s) => distKm(s.pos, p) <= s.r * conceal);
  const me = w.players.find((p) => p.id === playerId);

  return {
    t: 'snap',
    time: Math.round(w.time * 10) / 10,
    countdown,
    res: me ? { ...me.res } : {},
    energyNet: sim.energyNet.get(playerId) ?? 0,
    rates: { ...(sim.income.get(playerId) ?? {}) },
    buildings: w.buildings
      // enemy filling stations are never shown; everything else enemy only when seen
      .filter((b) => b.team === team || (seen(b.pos) && b.def !== 'gas_station'))
      .map((b) => ({
        id: b.id, def: b.def, owner: b.owner, team: b.team, pos: p4(b.pos), hp: Math.round(b.hp), progress: b.progress, road: b.road, cooldown: 0, level: b.level,
        upgrade: b.team === team && b.upgrade ? { remaining: Math.ceil(b.upgrade.remaining), total: b.upgrade.total } : null,
        course: b.team === team && b.course ? { remaining: Math.ceil(b.course.remaining), total: b.course.total } : null,
        inside: b.team === team && b.inside.length ? b.inside.map((u) => ({ def: u.def, rank: u.rank })) : undefined,
        storage: b.team === team && b.storage ? Object.fromEntries(Object.entries(b.storage).map(([k, v]) => [k, Math.floor(v)])) : undefined,
      })),
    units: w.units
      .filter((u) => {
        if (u.embarkedIn) return false; // riders are inside their vehicle
        if (u.team === team) return true;
        const d = sim.defs.u.get(u.def)!;
        if (d.kind === 'air') return seen(u.pos);
        // vehicles are louder than men on foot; terrain hides both
        const stealth = d.stealth ?? ((d.mobility ?? 'foot') === 'foot' ? 1 : 1.35);
        return seen(u.pos, sim.terrainAt(u.pos).concealment * stealth);
      })
      .map((u) => {
        const own = u.team === team;
        const mine = u.owner === playerId;
        return {
          id: u.id, def: u.def, owner: u.owner, team: u.team, pos: p4(u.pos), hp: Math.round(u.hp),
          target: own ? u.target : null, cooldown: 0, xp: Math.round(u.xp), rank: u.rank, transport: u.transport, encircled: u.encircled, status: u.status,
          bearing: u.bearing !== undefined ? Math.round(u.bearing) : undefined,
          entering: mine && u.enter ? u.enter : undefined,
          route: mine && u.path.length ? u.path.filter((w) => w.end).map((w) => p4(w.p)) : undefined,
          // the planned path (thinned to ~60 points) for route lines and arrival times
          path: mine && u.path.length && !u.isLoitering ? u.path.filter((_, i, a) => a.length <= 60 || i % Math.ceil(a.length / 60) === 0 || i === a.length - 1).map((w) => p4(w.p)) : undefined,
          stamina: own && u.stamina !== undefined ? Math.round(u.stamina) : undefined,
          sprint: u.sprint,
          fireMode: own ? u.fireMode : undefined,
          fuel: own && u.fuel !== undefined ? Math.round(u.fuel) : undefined,
          maxFuel: own ? u.maxFuel : undefined,
          cargo: own && u.cargo ? { cap: u.cargo.cap, res: Object.fromEntries(Object.entries(u.cargo.res).map(([k, v]) => [k, Math.round(v)])), passengers: u.cargo.passengers, drones: u.cargo.drones } : undefined,
          haul: own ? u.haul : undefined,
          loiterCenter: own && u.loiterCenter ? p4(u.loiterCenter) : undefined,
          loiterRadius: own ? u.loiterRadius : undefined,
          isLoitering: own ? u.isLoitering : undefined,
          bombardTarget: own && u.bombardTarget ? p4(u.bombardTarget) : undefined,
        };
      }),
    shots: shots.filter((s) => s.team === team || seen(s.from) || seen(s.to)).map((s) => ({ def: s.def, team: s.team, from: p4(s.from), to: p4(s.to) })),
    front: w.front.map((n) => ({ lng: r4(n.lng), lat: r4(n.lat), v: Math.round(n.v * 1e4) / 1e4 })),
    smokes: w.smokes.filter((x) => seen(x.pos, 2.5)).map((x) => ({ id: x.id, pos: p4(x.pos), expiresAt: Math.round(x.expiresAt) })),
    grey: w.grey.map((z) => ({ team: z.team, pos: p4(z.pos), r: z.r })),
    pockets: w.pockets.map((p) => ({ id: p.id, team: p.team, nodes: p.nodes.map((n) => ({ lng: r4(n.lng), lat: r4(n.lat) })) })),
    points: w.points,
    scores: [Math.round(w.scores[0]), Math.round(w.scores[1])],
    closed: w.players.filter((p) => p.team === team && !p.share).map((p) => p.id),
    queue: w.queue.filter((q) => w.buildings.find((b) => b.id === q.building)?.team === team).map((q) => ({ building: q.building, unit: q.unit, remaining: Math.round(q.remaining) })),
  };
}
