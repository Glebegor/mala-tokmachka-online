import { type BotDifficulty, distKm, moveToward, nearestNode, offsetKm, sideOf, type LngLat, type Player, type Sim } from '@sw/core';

const BUILD_ORDER = ['power_plant', 'mine', 'metalworks', 'oil_refinery', 'machine_factory', 'drone_factory', 'gas_station', 'trench', 'signal_station', 'bunker', 'rail_station', 'trench', 'power_plant', 'bunker', 'mine', 'metalworks'];

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
    const hq = mine.find((b) => b.def === 'military_base' || b.def === 'hq') ?? w.buildings.find((b) => b.team === p.team && (b.def === 'military_base' || b.def === 'hq'));
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
    const mySide = p.team === 0 ? 'ua' : 'ru';
    for (const b of w.buildings) {
      if (b.team !== p.team || b.progress < 1) continue;
      const d = sim.defs.b.get(b.def)!;
      if (!d.trains?.length) continue;
      if (w.queue.filter((q) => q.building === b.id).length >= 2) continue;
      const validUnits = d.trains.filter((uid) => {
        const ud = sim.defs.u.get(uid);
        return ud && (!ud.side || ud.side === mySide);
      });
      if (!validUnits.length) continue;
      const pick = validUnits[Math.floor(Math.random() * validUnits.length)];
      if (pick) sim.apply(p.id, { type: 'train', building: b.id, unit: pick });
    }
  }

  private command(sim: Sim, p: Player) {
    const w = sim.world;
    const army = w.units.filter((u) => u.owner === p.id && sim.defs.u.get(u.def)?.kind !== 'air' && u.def !== 'rescuers');

    // Rescuers: move to damaged friendly buildings or cities
    for (const res of w.units.filter((u) => u.owner === p.id && u.def === 'rescuers')) {
      if (res.target) continue;
      const damagedB = w.buildings.find((b) => b.team === p.team && b.progress >= 1 && b.hp < (sim.defs.b.get(b.def)?.hp ?? 100));
      if (damagedB) {
        sim.apply(p.id, { type: 'move', units: [res.id], to: damagedB.pos });
        continue;
      }
      const damagedPt = w.points.find((pt) => pt.owner === p.team && (pt.hp ?? 8000) < (pt.maxHp ?? 8000));
      if (damagedPt) {
        const cp = sim.map.capturePoints.find((x) => x.id === damagedPt.id);
        if (cp) sim.apply(p.id, { type: 'move', units: [res.id], to: cp.pos });
      }
    }

    const enemyPoints = sim.map.capturePoints.filter((cp) => sideOf(w.front, cp.pos) !== p.team);
    const hq = w.buildings.find((b) => b.owner === p.id && (b.def === 'military_base' || b.def === 'hq'));
    const anchor: LngLat = hq?.pos ?? sim.map.center;

    // Launch stored drones from airfield or launch_pad
    for (const b of w.buildings.filter((x) => x.owner === p.id && (x.def === 'airfield' || x.def === 'launch_pad') && x.progress >= 1)) {
      if (b.storedDrones) {
        for (const [droneId, count] of Object.entries(b.storedDrones)) {
          if (count > 0) {
            sim.apply(p.id, { type: 'launchDrone', building: b.id, droneDef: droneId });
            break;
          }
        }
      }
    }

    // air units / drones scout or attack
    for (const u of w.units.filter((x) => x.owner === p.id && sim.defs.u.get(x.def)?.kind === 'air')) {
      if (u.target) continue;
      const ud = sim.defs.u.get(u.def);
      if (ud?.droneType === 'strike') {
        const targets = w.buildings.filter((eb) => eb.team !== p.team);
        if (targets.length) {
          const t = targets[Math.floor(Math.random() * targets.length)];
          sim.apply(p.id, { type: 'move', units: [u.id], to: t.pos });
        }
      } else {
        const cp = enemyPoints[Math.floor(Math.random() * enemyPoints.length)];
        if (cp) sim.apply(p.id, { type: 'move', units: [u.id], to: offsetKm(cp.pos, (Math.random() - 0.5) * 15, (Math.random() - 0.5) * 15) });
      }
    }

    // spend spare money on promotions once the economy is running
    if ((p.res.money ?? 0) > 1500 && army.length) {
      sim.apply(p.id, { type: 'promote', units: army.slice(0, 4).map((u) => u.id) });
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
