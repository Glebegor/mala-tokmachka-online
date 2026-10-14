import { type BotDifficulty, type Building, distKm, isReconDrone, isStrikeDrone, moveToward, nearestNode, offsetKm, type LngLat, type Player, type Sim, type Unit } from '@sw/core';

const BUILD_ORDER = [
  'power_plant', 'housing', 'machine_factory', 'mine', 'drone_factory', 'metalworks', 'oil_refinery', 'trench', 'gas_station', 'housing',
  'signal_station', 'antiair', 'airfield', 'training_center', 'bunker', 'housing', 'rail_station', 'trench', 'warehouse', 'bunker', 'missile_factory',
];

/** A deliberately simple opponent: builds economy, fortifies, trains a mixed army and pushes the nearest enemy point. */
export class Bot {
  private step = 0;
  private lastThink = 0;
  private readonly interval: number;
  private readonly attackSize: number;
  constructor(readonly playerId: string, difficulty: BotDifficulty = 'normal') {
    this.interval = { easy: 6, normal: 2.5, hard: 1.2 }[difficulty];
    this.attackSize = { easy: 14, normal: 8, hard: 5 }[difficulty];
  }

  think(sim: Sim) {
    const w = sim.world;
    if (w.time - this.lastThink < this.interval) return;
    this.lastThink = w.time;
    const p = sim.player(this.playerId);
    if (!p) return;

    this.build(sim, p);
    this.train(sim, p);
    this.command(sim, p);
  }

  private build(sim: Sim, p: Player) {
    const w = sim.world;
    const mine = w.buildings.filter((b) => b.owner === p.id);
    if (mine.filter((b) => b.progress < 1).length >= 2) return;
    const hq = mine.find((b) => b.def === 'hq');
    if (!hq) return;
    const fn = w.front[nearestNode(w.front, hq.pos)];
    const frontPos: LngLat = [fn.lng, fn.lat];

    for (let k = 0; k < BUILD_ORDER.length; k++) {
      const def = BUILD_ORDER[(this.step + k) % BUILD_ORDER.length];
      const d = sim.defs.b.get(def);
      if (!d) continue;
      if (!Object.entries(d.cost).every(([r, v]) => (p.res[r] ?? 0) >= v)) continue;
      for (let attempt = 0; attempt < 14; attempt++) {
        const ang = Math.random() * Math.PI * 2;
        let base = hq.pos;
        let r = 2 + Math.random() * 12;
        if (def === 'housing') {
          // housing goes inside a city we hold, as near home as possible
          const cities = sim.map.capturePoints.filter((cp, i) => w.points[i].owner === p.team).sort((a, b) => distKm(a.pos, hq.pos) - distKm(b.pos, hq.pos));
          const cp = cities[attempt % Math.max(1, Math.min(4, cities.length))];
          if (!cp) break;
          base = cp.pos;
          r = Math.random() * 2.5;
        } else if (d.fieldWork) {
          // field works go up between the HQ and the front
          base = moveToward(hq.pos, frontPos, Math.max(0, distKm(hq.pos, frontPos) - 6 - Math.random() * 10));
        } else {
          // industry needs its own patch: spread out well away from other sites
          r = sim.ruleset.rules.minBuildSpacing + 1 + Math.random() * 45;
        }
        const pos = offsetKm(base, Math.cos(ang) * r, Math.sin(ang) * r);
        if (sim.apply(p.id, { type: 'build', def, pos }).ok) {
          this.step = (this.step + k + 1) % BUILD_ORDER.length;
          return;
        }
      }
    }
  }

  private train(sim: Sim, p: Player) {
    const w = sim.world;
    const mySide = p.team === 0 ? 'ua' : 'ru';
    const count = (id: string) => w.units.filter((u) => u.owner === p.id && u.def === id).length;
    for (const b of w.buildings) {
      // factories are shared by the team; the barracks a bot uses are its own
      if (b.team !== p.team || b.progress < 1 || !sim.usable(b, p.id) || (b.owner !== p.id && b.def !== 'machine_factory' && b.def !== 'drone_factory' && b.def !== 'missile_factory')) continue;
      const d = sim.defs.b.get(b.def)!;
      if (b.def === 'machine_factory') {
        // a small logistics fleet: trucks for ore and metal, a tanker, a rescue crew
        const want = count('truck') < 2 ? 'truck' : count('fuel_truck') < 1 ? 'fuel_truck' : count('rescuers') < 1 ? 'rescuers' : null;
        if (want && !w.queue.some((q) => q.building === b.id)) sim.apply(p.id, { type: 'train', building: b.id, unit: want });
        continue;
      }
      if (b.def === 'missile_factory') {
        // a missile or two in reserve; they go for enemy sites like strike drones
        const options = (d.trains ?? []).filter((id) => sim.defs.u.get(id)?.side === mySide);
        const stock = w.units.filter((u) => u.owner === p.id && sim.defs.u.get(u.def)!.missile).length;
        const pick = options[Math.floor(Math.random() * options.length)];
        if (pick && stock < 2 && !w.queue.some((q) => q.building === b.id)) sim.apply(p.id, { type: 'train', building: b.id, unit: pick });
        continue;
      }
      if (b.def === 'drone_factory') {
        // a handful of drones is plenty: idle ones only pile up at the factory
        if (w.units.filter((u) => u.owner === p.id && sim.defs.u.get(u.def)!.kind === 'air' && !sim.defs.u.get(u.def)!.missile).length >= 6) continue;
        const options = (d.trains ?? []).filter((id) => sim.defs.u.get(id)?.side === mySide);
        const pick = options[Math.floor(Math.random() * options.length)];
        if (pick && w.queue.filter((q) => q.building === b.id).length < 2) sim.apply(p.id, { type: 'train', building: b.id, unit: pick });
        continue;
      }
      if (!d.trains?.length) continue;
      if (w.queue.filter((q) => q.building === b.id).length >= 2) continue;
      const drones = w.units.filter((u) => u.owner === p.id && u.def === 'drone').length;
      const pool = ['infantry', 'infantry', 'infantry_assault', 'infantry_at', 'infantry_recon', 'tank', 'artillery', ...(drones < 1 ? ['drone'] : [])].filter((u) => d.trains!.includes(u));
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick) sim.apply(p.id, { type: 'train', building: b.id, unit: pick });
    }
  }

  /** Keep the supply chain moving: ore to the metal works, metal and fuel to the bases. */
  private logistics(sim: Sim, p: Player) {
    const w = sim.world;
    const own = (def: string) => w.buildings.filter((b) => b.team === p.team && b.def === def && b.progress >= 1);
    const nearest = (from: Building, list: Building[]) => list.sort((a, b) => distKm(a.pos, from.pos) - distKm(b.pos, from.pos))[0];
    const route = (u: Unit, from?: Building, to?: Building, res?: string) => from && to && sim.apply(p.id, { type: 'setRoute', unit: u.id, fromBuilding: from.id, toBuilding: to.id, resType: res });
    const trucks = w.units.filter((u) => u.owner === p.id && u.def === 'truck' && !u.haul);
    const mines = own('mine'), works = own('metalworks'), bases = own('hq'), refineries = own('oil_refinery');
    trucks.forEach((u, i) => {
      if (i % 2 === 0 && mines[0] && works[0]) route(u, mines[0], nearest(mines[0], works), 'ore');
      else if (works[0] && bases[0]) route(u, works[0], nearest(works[0], bases), 'metal');
    });
    for (const u of w.units.filter((x) => x.owner === p.id && x.def === 'fuel_truck' && !x.haul)) {
      const target = own('gas_station')[0] ?? bases[0];
      if (refineries[0] && target) route(u, refineries[0], target, 'fuel');
    }
    for (const u of w.units.filter((x) => x.owner === p.id && sim.defs.u.get(x.def)!.repairs && !x.target)) {
      const damaged = w.buildings.find((b) => b.team === p.team && b.progress >= 1 && b.hp < sim.maxBuildingHp(b));
      if (damaged) sim.apply(p.id, { type: 'move', units: [u.id], to: damaged.pos });
    }
  }

  private command(sim: Sim, p: Player) {
    const w = sim.world;
    this.logistics(sim, p);
    const army = w.units.filter((u) => u.owner === p.id && sim.defs.u.get(u.def)!.kind !== 'air' && !sim.defs.u.get(u.def)!.cargoCap && !sim.defs.u.get(u.def)!.repairs);
    const enemyPoints = sim.map.capturePoints.filter((cp) => sim.side(cp.pos) !== p.team);
    const hq = w.buildings.find((b) => b.owner === p.id && b.def === 'hq');
    const anchor: LngLat = hq?.pos ?? sim.map.center;

    // strike drones go for enemy sites, recon drones scout over the enemy side
    for (const u of w.units.filter((x) => x.owner === p.id && isStrikeDrone(sim.defs.u.get(x.def)) && !x.target)) {
      const targets = w.buildings.filter((b) => b.team !== p.team);
      const t = targets[Math.floor(Math.random() * targets.length)];
      if (t) sim.apply(p.id, { type: 'move', units: [u.id], to: t.pos });
    }
    for (const u of w.units.filter((x) => x.owner === p.id && isReconDrone(sim.defs.u.get(x.def)))) {
      if (u.target && !u.isLoitering) continue;
      if (u.isLoitering && Math.random() > 0.05) continue; // circle a while before moving on
      const cp = enemyPoints[Math.floor(Math.random() * enemyPoints.length)];
      if (cp) sim.apply(p.id, { type: 'move', units: [u.id], to: offsetKm(cp.pos, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20) });
    }

    // schooling: with spare money, send a squad that is not on a mission through the training centre
    for (const b of w.buildings) {
      if (b.owner !== p.id || b.progress < 1 || b.course) continue;
      const t = sim.defs.b.get(b.def)!.training;
      if (!t) continue;
      if (b.inside.length >= t.minUnits) {
        if (!sim.apply(p.id, { type: 'course', building: b.id }).ok && w.time % 60 < 3) sim.apply(p.id, { type: 'release', building: b.id });
      } else if ((p.res.money ?? 0) > 900 && !w.units.some((u) => u.enter === b.id)) {
        const pupils = army.filter((u) => !u.target && u.rank < sim.ranks.length - 1 && distKm(u.pos, b.pos) < 40).slice(0, 4);
        if (pupils.length >= t.minUnits - b.inside.length) sim.apply(p.id, { type: 'enter', units: pupils.map((u) => u.id), building: b.id });
      }
    }

    const idle = army.filter((u) => !u.target);
    if (!idle.length) return;
    if (army.length >= this.attackSize && enemyPoints.length) {
      const goal = enemyPoints.reduce((a, b) => (distKm(a.pos, anchor) < distKm(b.pos, anchor) ? a : b));
      sim.apply(p.id, { type: 'move', units: idle.map((u) => u.id), to: goal.pos, cohesion: true });
    } else {
      // rally just behind the front
      const front = w.front[nearestNode(w.front, anchor)];
      const rally = moveToward([front.lng, front.lat], anchor, 6);
      const far = idle.filter((u) => distKm(u.pos, rally) > 4);
      if (far.length) sim.apply(p.id, { type: 'move', units: far.map((u) => u.id), to: rally });
    }
  }
}
