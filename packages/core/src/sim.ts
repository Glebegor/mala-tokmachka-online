import type { Command, CommandResult } from './commands';
import type { BuildingDef, MapDef, ResourceAmounts, Ruleset, UnitDef } from './defs';
import { clamp, distKm, moveToward, type LngLat } from './geo';
import { buildFront, distToFrontKm, sideOf } from './frontline';
import type { Building, Player, SlotInit, Team, Unit, World } from './state';

export interface Hooks {
  emit(event: string, data: Record<string, unknown>): void;
}
const NO_HOOKS: Hooks = { emit() {} };

export class Sim {
  readonly defs: { b: Map<string, BuildingDef>; u: Map<string, UnitDef> };
  readonly map: MapDef;
  world: World;
  energyNet = new Map<string, number>();

  constructor(
    readonly ruleset: Ruleset,
    mapId: string,
    slots: SlotInit[],
    private hooks: Hooks = NO_HOOKS,
  ) {
    this.defs = {
      b: new Map(ruleset.buildings.map((b) => [b.id, b])),
      u: new Map(ruleset.units.map((u) => [u.id, u])),
    };
    const map = ruleset.maps.find((m) => m.id === mapId);
    if (!map) throw new Error(`unknown map ${mapId}`);
    this.map = map;
    this.world = this.createWorld(slots);
  }

  setHooks(h: Hooks) {
    this.hooks = h;
  }

  // ---------- setup ----------
  private createWorld(slots: SlotInit[]): World {
    const r = this.ruleset.rules;
    const startRes: ResourceAmounts = {};
    for (const res of this.ruleset.resources) startRes[res.id] = res.start;
    const players: Player[] = slots.map((s) => ({ ...s, res: { ...startRes } }));
    const w: World = {
      tick: 0,
      time: 0,
      players,
      buildings: [],
      units: [],
      queue: [],
      front: buildFront(this.map.front, r.frontNodes),
      points: this.map.capturePoints.map((p) => ({ id: p.id, owner: 0 as Team })),
      scores: [0, 0],
      winner: null,
      winReason: null,
      nextId: 1,
      mapId: this.map.id,
    };
    this.world = w;
    const counters: [number, number] = [0, 0];
    for (const p of players) {
      const spawns = this.map.spawns[p.team];
      const base = spawns[counters[p.team]++ % spawns.length];
      const jitter = (n: number): number => ((n * 9301 + 49297) % 233280) / 233280 - 0.5;
      const pos: LngLat = [base[0] + jitter(counters[p.team]) * 0.12, base[1] + jitter(counters[p.team] + 7) * 0.12];
      this.spawnBuilding('hq', p, pos, true);
      r.startUnits.forEach((u, i) => this.spawnUnit(u, p, [pos[0] + 0.03 * Math.cos(i), pos[1] + 0.03 * Math.sin(i)]));
    }
    this.refreshPointOwners();
    return w;
  }

  private spawnBuilding(def: string, p: Player, pos: LngLat, done = false): Building {
    const d = this.defs.b.get(def)!;
    const b: Building = { id: this.world.nextId++, def, owner: p.id, team: p.team, pos, hp: d.hp, progress: done ? 1 : 0 };
    this.world.buildings.push(b);
    return b;
  }

  spawnUnit(def: string, p: Player, pos: LngLat): Unit {
    const d = this.defs.u.get(def)!;
    const u: Unit = { id: this.world.nextId++, def, owner: p.id, team: p.team, pos, hp: d.hp, target: null, cooldown: 0 };
    this.world.units.push(u);
    return u;
  }

  player(id: string) {
    return this.world.players.find((p) => p.id === id);
  }

  // ---------- commands ----------
  apply(playerId: string, cmd: Command): CommandResult {
    const w = this.world;
    const p = this.player(playerId);
    if (!p) return fail('unknown player');
    if (w.winner !== null) return fail('match over');
    const r = this.ruleset.rules;

    switch (cmd.type) {
      case 'build': {
        const d = this.defs.b.get(cmd.def);
        if (!d) return fail('unknown building');
        if (d.maxPerPlayer && countOf(w, p.id, d.id) >= d.maxPerPlayer) return fail('limit reached');
        if (!isFinitePos(cmd.pos)) return fail('bad position');
        if (!inBounds(this.map, cmd.pos)) return fail('outside map');
        if (sideOf(w.front, cmd.pos) !== p.team) return fail('not your territory');
        const dist = distToFrontKm(w.front, cmd.pos) * (p.team === 0 ? 1 : -1);
        if (d.category === 'civil' && dist < r.minBuildDistanceFromFront * 2) return fail('too close to the front');
        if (dist < r.minBuildDistanceFromFront) return fail('too close to the front');
        if (w.buildings.some((b) => distKm(b.pos, cmd.pos) < r.minBuildSpacing)) return fail('space occupied');
        if (!canAfford(p.res, d.cost)) return fail('not enough resources');
        pay(p.res, d.cost);
        this.spawnBuilding(d.id, p, cmd.pos);
        return ok();
      }
      case 'train': {
        const b = w.buildings.find((x) => x.id === cmd.building);
        if (!b || b.owner !== p.id || b.progress < 1) return fail('building unavailable');
        const bd = this.defs.b.get(b.def)!;
        const ud = this.defs.u.get(cmd.unit);
        if (!ud || !bd.trains?.includes(ud.id)) return fail('cannot train that here');
        if (w.queue.filter((q) => q.building === b.id).length >= 5) return fail('queue full');
        if (!canAfford(p.res, ud.cost)) return fail('not enough resources');
        pay(p.res, ud.cost);
        w.queue.push({ building: b.id, unit: ud.id, owner: p.id, remaining: ud.trainTime });
        return ok();
      }
      case 'move': {
        if (!isFinitePos(cmd.to) || cmd.units.length > 200) return fail('bad order');
        const set = new Set(cmd.units);
        const mine = w.units.filter((u) => set.has(u.id) && u.owner === p.id);
        mine.forEach((u, i) => {
          const ring = Math.ceil(Math.sqrt(i));
          u.target = [cmd.to[0] + 0.012 * ring * Math.cos(i * 2.4), cmd.to[1] + 0.012 * ring * Math.sin(i * 2.4)];
        });
        return ok();
      }
      case 'stop': {
        const set = new Set(cmd.units);
        w.units.filter((u) => set.has(u.id) && u.owner === p.id).forEach((u) => (u.target = null));
        return ok();
      }
      case 'demolish': {
        const i = w.buildings.findIndex((x) => x.id === cmd.building && x.owner === p.id);
        if (i < 0) return fail('not found');
        const b = w.buildings[i];
        if (b.def === 'hq') return fail('cannot demolish HQ');
        const d = this.defs.b.get(b.def)!;
        for (const [k, v] of Object.entries(d.cost)) p.res[k] = (p.res[k] ?? 0) + v * 0.4;
        w.buildings.splice(i, 1);
        return ok();
      }
    }
  }

  // ---------- simulation ----------
  step(dt: number) {
    const w = this.world;
    if (w.winner !== null) return;
    const r = this.ruleset.rules;
    w.tick++;
    const prevSec = Math.floor(w.time);
    w.time += dt;

    this.construction(dt);
    this.economy(dt);
    this.training(dt);
    this.units(dt);
    this.frontline(dt);
    this.territory(dt);
    this.checkVictory();

    if (Math.floor(w.time) !== prevSec) this.hooks.emit('tick', { time: Math.floor(w.time) });
    if (w.time >= r.matchSeconds && w.winner === null) {
      w.winner = w.scores[0] === w.scores[1] ? null : w.scores[0] > w.scores[1] ? 0 : 1;
      w.winReason = 'time limit';
    }
  }

  private construction(dt: number) {
    for (const b of this.world.buildings) {
      if (b.progress >= 1) continue;
      const d = this.defs.b.get(b.def)!;
      b.progress = Math.min(1, b.progress + dt / d.buildTime);
      if (b.progress >= 1) this.hooks.emit('buildingCompleted', { id: b.id, def: b.def, owner: b.owner });
    }
  }

  private auraMult(b: Building): number {
    let m = 1;
    for (const o of this.world.buildings) {
      if (o.team !== b.team || o.progress < 1 || o === b) continue;
      const a = this.defs.b.get(o.def)!.aura;
      if (a && distKm(o.pos, b.pos) <= a.radiusKm) m *= a.outputMult;
    }
    return m;
  }

  private economy(dt: number) {
    const w = this.world;
    const caps = new Map(this.ruleset.resources.map((r) => [r.id, r.cap]));
    const done = w.buildings.filter((b) => b.progress >= 1);
    const mults = new Map<number, number>();
    for (const b of done) mults.set(b.id, this.auraMult(b));

    for (const p of w.players) {
      const mine = done.filter((b) => b.owner === p.id);
      let net = 0;
      for (const b of mine) {
        const d = this.defs.b.get(b.def)!;
        net += (d.produces?.energy ?? 0) * mults.get(b.id)! - (d.consumes?.energy ?? 0);
      }
      p.res.energy = clamp((p.res.energy ?? 0) + net * dt, 0, caps.get('energy') ?? 1e9);
      this.energyNet.set(p.id, net);
      const eff = p.res.energy > 0 || net >= 0 ? 1 : this.ruleset.rules.energyDeficitMult;

      for (const b of mine) {
        const d = this.defs.b.get(b.def)!;
        if (!d.produces) continue;
        const m = mults.get(b.id)! * eff;
        let can = true;
        for (const [k, v] of Object.entries(d.consumes ?? {})) {
          if (k !== 'energy' && (p.res[k] ?? 0) < v * dt) can = false;
        }
        if (!can) continue;
        for (const [k, v] of Object.entries(d.consumes ?? {})) if (k !== 'energy') p.res[k] -= v * dt;
        for (const [k, v] of Object.entries(d.produces)) {
          if (k === 'energy') continue;
          p.res[k] = Math.min(caps.get(k) ?? 1e9, (p.res[k] ?? 0) + v * m * dt);
        }
      }
    }
  }

  private training(dt: number) {
    const w = this.world;
    const heads = new Set<number>();
    w.queue = w.queue.filter((q) => {
      const b = w.buildings.find((x) => x.id === q.building);
      if (!b) return false; // building lost: order cancelled
      if (heads.has(q.building)) return true;
      heads.add(q.building);
      q.remaining -= dt;
      if (q.remaining > 0) return true;
      const p = this.player(q.owner)!;
      this.spawnUnit(q.unit, p, [b.pos[0] + 0.02, b.pos[1] - 0.015]);
      this.hooks.emit('unitTrained', { owner: q.owner, def: q.unit });
      return false;
    });
  }

  private holdMult(team: Team, pos: LngLat): number {
    let m = 1;
    for (const b of this.world.buildings) {
      if (b.team !== team || b.progress < 1) continue;
      const d = this.defs.b.get(b.def)!.defense;
      if (d && distKm(b.pos, pos) <= d.radiusKm) m += d.mult;
    }
    return m;
  }

  private units(dt: number) {
    const w = this.world;
    for (const u of w.units) {
      const d = this.defs.u.get(u.def)!;
      u.cooldown = Math.max(0, u.cooldown - dt);

      // acquire nearest enemy in range
      let tgt: { pos: LngLat; hp: number; unit?: Unit; b?: Building; dist: number } | null = null;
      for (const e of w.units) {
        if (e.team === u.team) continue;
        const dist = distKm(u.pos, e.pos);
        if (dist <= d.range && (!tgt || dist < tgt.dist)) tgt = { pos: e.pos, hp: e.hp, unit: e, dist };
      }
      if (!tgt) {
        for (const e of w.buildings) {
          if (e.team === u.team) continue;
          const dist = distKm(u.pos, e.pos);
          if (dist <= d.range && (!tgt || dist < tgt.dist)) tgt = { pos: e.pos, hp: e.hp, b: e, dist };
        }
      }
      if (tgt && u.cooldown === 0) {
        const dmg = d.damage * 1.0; // 1 second salvo
        u.cooldown = 1;
        if (tgt.unit) {
          tgt.unit.hp -= dmg / this.holdMult(tgt.unit.team, tgt.unit.pos);
        } else if (tgt.b) {
          tgt.b.hp -= dmg / this.holdMult(tgt.b.team, tgt.b.pos);
        }
      }

      // move: explicit order wins, idle units chase visible enemies
      let dest = u.target;
      if (!dest && !tgt) {
        let best = Infinity;
        for (const e of w.units) {
          if (e.team === u.team) continue;
          const dist = distKm(u.pos, e.pos);
          if (dist < d.vision * 0.7 && dist < best) {
            best = dist;
            dest = e.pos;
          }
        }
      }
      if (dest) {
        u.pos = moveToward(u.pos, dest, d.speed * dt);
        if (u.target && distKm(u.pos, u.target) < 0.05) u.target = null;
      }
    }

    // death
    const deadU = w.units.filter((u) => u.hp <= 0);
    if (deadU.length) {
      w.units = w.units.filter((u) => u.hp > 0);
      deadU.forEach((u) => this.hooks.emit('unitKilled', { id: u.id, def: u.def, owner: u.owner }));
    }
    const deadB = w.buildings.filter((b) => b.hp <= 0);
    if (deadB.length) {
      w.buildings = w.buildings.filter((b) => b.hp > 0);
      deadB.forEach((b) => this.hooks.emit('buildingDestroyed', { id: b.id, def: b.def, owner: b.owner }));
    }
  }

  /** The "abstract war": economy and local force balance push the front nodes. */
  private frontline(dt: number) {
    const w = this.world;
    const r = this.ruleset.rules;
    const R = r.frontInfluenceKm;

    const abstract: [number, number] = [0, 0];
    for (const p of w.players) {
      const hqs = w.buildings.filter((b) => b.owner === p.id && b.def === 'hq' && b.progress >= 1).length;
      if (!hqs) continue;
      abstract[p.team] += (4 + Math.sqrt(p.res.people ?? 0) + Math.sqrt(p.res.metal ?? 0)) * r.abstractPower;
    }
    const perNode = [abstract[0] / w.front.length, abstract[1] / w.front.length];

    const accel = w.front.map((n) => {
      const pos: LngLat = [n.lng, n.lat];
      const force: [number, number] = [perNode[0], perNode[1]];
      for (const u of w.units) {
        const d = distKm(u.pos, pos);
        if (d > R) continue;
        const ud = this.defs.u.get(u.def)!;
        force[u.team] += ud.damage * (u.hp / ud.hp) * (1 - d / R);
      }
      const f0 = force[0] * this.holdMult(0, pos);
      const f1 = force[1] * this.holdMult(1, pos);
      return (f0 - f1) * r.frontPush;
    });

    const n = w.front;
    for (let i = 0; i < n.length; i++) {
      const prev = n[Math.max(0, i - 1)];
      const next = n[Math.min(n.length - 1, i + 1)];
      const smooth = ((prev.lng + next.lng) / 2 - n[i].lng) * r.frontSmoothing;
      const wobble = Math.sin(w.time * 0.6 + i * 1.7) * 0.00035;
      const kmPerDeg = 111.32 * Math.cos((n[i].lat * Math.PI) / 180);
      n[i].v = clamp(accel[i], -r.frontMaxSpeed, r.frontMaxSpeed);
      n[i].lng += ((n[i].v * dt) / kmPerDeg) + smooth * dt * 0.1 + wobble * dt;
    }
  }

  private refreshPointOwners() {
    const w = this.world;
    this.map.capturePoints.forEach((cp, i) => {
      w.points[i].owner = sideOf(w.front, cp.pos);
    });
  }

  private territory(dt: number) {
    const w = this.world;
    const r = this.ruleset.rules;
    this.map.capturePoints.forEach((cp, i) => {
      const side = sideOf(w.front, cp.pos);
      if (w.points[i].owner !== side) {
        w.points[i].owner = side;
        this.hooks.emit('pointCaptured', { id: cp.id, team: side });
      }
      w.scores[side] += cp.value * r.pointScorePerSec * dt;
    });
    // anything the front rolled over is lost
    const lost = w.buildings.filter((b) => sideOf(w.front, b.pos) !== b.team);
    if (lost.length) {
      w.buildings = w.buildings.filter((b) => sideOf(w.front, b.pos) === b.team);
      lost.forEach((b) => this.hooks.emit('buildingDestroyed', { id: b.id, def: b.def, owner: b.owner }));
    }
  }

  private checkVictory() {
    const w = this.world;
    const pts = w.points;
    if (pts.every((p) => p.owner === 0)) return this.win(0, 'all points captured');
    if (pts.every((p) => p.owner === 1)) return this.win(1, 'all points captured');
    for (const t of [0, 1] as Team[]) {
      const had = w.players.some((p) => p.team === t);
      const hq = w.buildings.some((b) => b.team === t && b.def === 'hq');
      if (had && !hq && w.time > 5) return this.win((1 - t) as Team, 'headquarters destroyed');
    }
  }

  private win(team: Team, reason: string) {
    this.world.winner = team;
    this.world.winReason = reason;
  }
}

const ok = (): CommandResult => ({ ok: true });
const fail = (reason: string): CommandResult => ({ ok: false, reason });
const isFinitePos = (p: LngLat) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const inBounds = (m: MapDef, p: LngLat) => p[0] >= m.bounds[0] && p[0] <= m.bounds[2] && p[1] >= m.bounds[1] && p[1] <= m.bounds[3];
const countOf = (w: World, owner: string, def: string) => w.buildings.filter((b) => b.owner === owner && b.def === def).length;

export function canAfford(have: ResourceAmounts, cost: ResourceAmounts): boolean {
  return Object.entries(cost).every(([k, v]) => (have[k] ?? 0) >= v);
}
function pay(have: ResourceAmounts, cost: ResourceAmounts) {
  for (const [k, v] of Object.entries(cost)) have[k] = (have[k] ?? 0) - v;
}
