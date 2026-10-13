import { type BotDifficulty, distKm, moveToward, nearestNode, offsetKm, sideOf, type LngLat, type Player, type Sim } from '@sw/core';

const BUILD_ORDER = ['power_plant', 'housing', 'mine', 'metalworks', 'gas_station', 'trench', 'signal_station', 'housing', 'antiair', 'training_center', 'bunker', 'rail_station', 'trench', 'power_plant', 'bunker', 'mine', 'metalworks'];

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
      for (let attempt = 0; attempt < 10; attempt++) {
        const ang = Math.random() * Math.PI * 2;
        const r = 2 + Math.random() * 12;
        // defensive buildings go up between the HQ and the front
        const base = d.defense ? moveToward(hq.pos, frontPos, Math.max(0, distKm(hq.pos, frontPos) - 6 - Math.random() * 10)) : hq.pos;
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
    for (const b of w.buildings) {
      if (b.owner !== p.id || b.progress < 1) continue;
      const d = sim.defs.b.get(b.def)!;
      if (!d.trains?.length) continue;
      if (w.queue.filter((q) => q.building === b.id).length >= 2) continue;
      const drones = w.units.filter((u) => u.owner === p.id && u.def === 'drone').length;
      const pool = ['infantry', 'infantry', 'tank', 'artillery', ...(drones < 1 ? ['drone'] : [])].filter((u) => d.trains!.includes(u));
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick) sim.apply(p.id, { type: 'train', building: b.id, unit: pick });
    }
  }

  private command(sim: Sim, p: Player) {
    const w = sim.world;
    const army = w.units.filter((u) => u.owner === p.id && u.def !== 'drone');
    const enemyPoints = sim.map.capturePoints.filter((cp) => sideOf(w.front, cp.pos) !== p.team);
    const hq = w.buildings.find((b) => b.owner === p.id && b.def === 'hq');
    const anchor: LngLat = hq?.pos ?? sim.map.center;

    // drones scout over the enemy side
    for (const u of w.units.filter((x) => x.owner === p.id && x.def === 'drone')) {
      if (u.target) continue;
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
