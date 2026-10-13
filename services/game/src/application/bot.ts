import { type BotDifficulty, distKm, moveToward, offsetKm, sideOf, type LngLat, type Player, type Sim } from '@sw/core';

const BUILD_ORDER = ['power_plant', 'housing', 'mine', 'metalworks', 'gas_station', 'trench', 'signal_station', 'housing', 'bunker', 'rail_station', 'trench', 'power_plant', 'bunker', 'mine', 'metalworks'];

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

    for (let k = 0; k < BUILD_ORDER.length; k++) {
      const def = BUILD_ORDER[(this.step + k) % BUILD_ORDER.length];
      const d = sim.defs.b.get(def);
      if (!d) continue;
      if (!Object.entries(d.cost).every(([r, v]) => (p.res[r] ?? 0) >= v)) continue;
      for (let attempt = 0; attempt < 10; attempt++) {
        const ang = Math.random() * Math.PI * 2;
        const r = 2 + Math.random() * 12;
        // defensive buildings sit closer to the front
        const pull = d.defense ? (p.team === 0 ? 8 : -8) : 0;
        const pos = offsetKm(hq.pos, Math.cos(ang) * r + pull, Math.sin(ang) * r);
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

    const idle = army.filter((u) => !u.target);
    if (!idle.length) return;
    if (army.length >= this.attackSize && enemyPoints.length) {
      const goal = enemyPoints.reduce((a, b) => (distKm(a.pos, anchor) < distKm(b.pos, anchor) ? a : b));
      sim.apply(p.id, { type: 'move', units: idle.map((u) => u.id), to: goal.pos });
    } else {
      // rally just behind the front
      const lat = anchor[1];
      const front = w.front.reduce((a, b) => (Math.abs(a.lat - lat) < Math.abs(b.lat - lat) ? a : b));
      const rally = offsetKm([front.lng, front.lat], p.team === 0 ? -6 : 6, 0);
      const far = idle.filter((u) => distKm(u.pos, rally) > 4);
      if (far.length) sim.apply(p.id, { type: 'move', units: far.map((u) => u.id), to: rally });
    }
  }
}
