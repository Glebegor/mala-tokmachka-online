import type { Command, CommandResult } from './commands';
import type { BuildingDef, MapDef, RankDef, ResourceAmounts, Ruleset, TerrainDef, UnitDef } from './defs';
import { clamp, distKm, kmPerDegLng, moveToward, type LngLat } from './geo';
import { buildFront, distToFrontKm, normalAt, pocketCentroid, pocketRadiusKm, resample, resolveFrontLoops, sideOf, sideOfWithPockets } from './frontline';
import { RoadNetwork } from './roads';
import { TerrainGrid } from './terrain';
import type { Building, Player, Pocket, Shot, SlotInit, Team, Unit, Waypoint, World } from './state';

export interface Hooks {
  emit(event: string, data: Record<string, unknown>): void;
}
const NO_HOOKS: Hooks = { emit() {} };
const NO_RANK: RankDef = { id: 'none', name: '', xp: 0, damage: 1, hp: 1, range: 1, cost: {} };
const OPEN_GROUND: TerrainDef = { id: 'open', name: 'Open', color: '#000', speed: {}, cover: 0, concealment: 1, frontResist: 0 };

export class Sim {
  readonly defs: { b: Map<string, BuildingDef>; u: Map<string, UnitDef>; t: Map<string, TerrainDef> };
  readonly map: MapDef;
  readonly roads: RoadNetwork | null;
  readonly terrain: TerrainGrid | null;
  readonly ranks: RankDef[];
  world: World;
  energyNet = new Map<string, number>();
  /** Net production per second for each player and resource (spending excluded). */
  income = new Map<string, Record<string, number>>();
  /** Shots fired since the buffer was last drained (animation only). */
  shots: Shot[] = [];

  constructor(
    readonly ruleset: Ruleset,
    mapId: string,
    slots: SlotInit[],
    private hooks: Hooks = NO_HOOKS,
  ) {
    this.defs = {
      b: new Map(ruleset.buildings.map((b) => [b.id, b])),
      u: new Map(ruleset.units.map((u) => [u.id, u])),
      t: new Map(ruleset.terrain.map((t) => [t.id, t])),
    };
    this.ranks = ruleset.ranks.length ? [...ruleset.ranks].sort((a, b) => a.xp - b.xp) : [NO_RANK];
    const map = ruleset.maps.find((m) => m.id === mapId);
    if (!map) throw new Error(`unknown map ${mapId}`);
    this.map = map;
    this.roads = map.roads?.length ? new RoadNetwork(map.roads) : null;
    this.terrain = map.terrain ? new TerrainGrid(map.terrain) : null;
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
      front: buildFront(this.map.front, r.frontNodeSpacingKm),
      pockets: [],
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
      const n = counters[p.team]++;
      const base = spawns[n % spawns.length];
      // players beyond the authored spawn list share a spawn, nudged aside
      const lap = Math.floor(n / spawns.length);
      const pos: LngLat = [base[0] + lap * 0.09, base[1] + lap * 0.05];
      this.spawnBuilding('hq', p, pos, true);
      r.startUnits.forEach((u, i) => this.spawnUnit(u, p, [pos[0] + 0.035 * Math.cos(i * 1.3), pos[1] + 0.025 * Math.sin(i * 1.3)]));
    }
    this.map.capturePoints.forEach((cp, i) => (w.points[i].owner = sideOf(w.front, cp.pos)));
    return w;
  }

  private spawnBuilding(def: string, p: Player, pos: LngLat, done = false): Building {
    const d = this.defs.b.get(def)!;
    const road = this.roads?.isNear(pos, this.ruleset.rules.roadAccessKm) ?? false;
    const storage: Record<string, number> = {
      metal: 500,
      fuel: 500,
      ore: 500,
    };
    const b: Building = { id: this.world.nextId++, def, owner: p.id, team: p.team, pos, hp: d.hp, progress: done ? 1 : 0, road, storage };
    this.world.buildings.push(b);
    return b;
  }

  spawnUnit(def: string, p: Player, pos: LngLat): Unit {
    const d = this.defs.u.get(def)!;
    const isDrone = def === 'drone' || d.kind === 'air';
    const isVehicle = !isDrone && (d.mobility !== 'foot' || !!d.maxFuel);
    const maxFuel = isDrone ? undefined : (d.maxFuel ?? (isVehicle ? 100 : undefined));
    const cargo = d.cargoCap ? { res: {}, cap: d.cargoCap, passengers: [] } : undefined;
    const u: Unit = {
      id: this.world.nextId++,
      def,
      owner: p.id,
      team: p.team,
      pos,
      hp: d.hp * this.ranks[0].hp,
      target: null,
      cooldown: 0,
      xp: 0,
      rank: 0,
      path: [],
      cap: 0,
      stamina: isDrone ? undefined : 100,
      sprint: false,
      fireMode: 'auto',
      fuel: maxFuel,
      maxFuel,
      cargo,
    };
    this.world.units.push(u);
    return u;
  }

  player(id: string) {
    return this.world.players.find((p) => p.id === id);
  }

  maxHp(u: Unit): number {
    return this.defs.u.get(u.def)!.hp * this.ranks[u.rank].hp;
  }

  terrainAt(p: LngLat): TerrainDef {
    return (this.terrain && this.defs.t.get(this.terrain.at(p))) || OPEN_GROUND;
  }

  /** Off-road speed multiplier for a unit type at a position. */
  terrainSpeed(d: UnitDef, p: LngLat): number {
    if (d.kind === 'air') return 1;
    const t = this.terrainAt(p);
    return t.speed[d.mobility ?? 'foot'] ?? t.speed.default ?? 1;
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
        if (sideOfWithPockets(w.front, w.pockets, cmd.pos) !== p.team) return fail('not your territory');
        const dist = Math.abs(distToFrontKm(w.front, cmd.pos));
        if (dist < r.minBuildDistanceFromFront * (d.category === 'civil' ? 2 : 1)) return fail('too close to the front');
        if (this.terrainAt(cmd.pos).id === 'water') return fail('cannot build on water');
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

        // Split cost: money & people are paid from player.res; physical goods (metal, fuel, ore) from b.storage
        const globalCost: ResourceAmounts = {};
        const localCost: ResourceAmounts = {};
        for (const [k, v] of Object.entries(ud.cost)) {
          if (k === 'money' || k === 'people') globalCost[k] = v;
          else localCost[k] = v;
        }

        if (!canAfford(p.res, globalCost)) return fail('Недостаточно денег или рекрутов');
        if (!b.storage) b.storage = {};
        if (!canAfford(b.storage, localCost)) return fail('Недостаточно сырья (металл/топливо) на складе здания');

        pay(p.res, globalCost);
        pay(b.storage, localCost);
        for (const [k, v] of Object.entries(localCost)) {
          if ((p.res[k] ?? 0) >= v) p.res[k] -= v;
        }
        w.queue.push({ building: b.id, unit: ud.id, owner: p.id, remaining: ud.trainTime });
        return ok();
      }
      case 'move': {
        if (!isFinitePos(cmd.to) || !Array.isArray(cmd.units) || cmd.units.length > 300) return fail('bad order');
        const set = new Set(cmd.units);
        for (const u of w.units) if (set.has(u.id) && u.owner === p.id) u.route = undefined;
        this.orderMove(w.units.filter((u) => set.has(u.id) && u.owner === p.id), cmd.to, !!cmd.cohesion);
        return ok();
      }
      case 'stop': {
        const set = new Set(cmd.units);
        for (const u of w.units) if (set.has(u.id) && u.owner === p.id) (u.target = null), (u.path = []), (u.cap = 0), (u.route = undefined);
        return ok();
      }
      case 'promote': {
        if (!Array.isArray(cmd.units) || cmd.units.length > 300) return fail('bad order');
        const set = new Set(cmd.units);
        let done = 0;
        let broke = false;
        for (const u of w.units) {
          if (!set.has(u.id) || u.owner !== p.id || u.rank >= this.ranks.length - 1) continue;
          const next = this.ranks[u.rank + 1];
          if (!canAfford(p.res, next.cost)) {
            broke = true;
            continue;
          }
          pay(p.res, next.cost);
          u.xp = Math.max(u.xp, next.xp);
          this.rankUp(u);
          done++;
        }
        if (!done) return fail(broke ? 'not enough resources' : 'nothing to promote');
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
      case 'fireMode': {
        const set = new Set(cmd.units);
        for (const u of w.units) if (set.has(u.id) && u.owner === p.id) u.fireMode = cmd.mode;
        return ok();
      }
      case 'sprint': {
        const set = new Set(cmd.units);
        for (const u of w.units) {
          const ud = this.defs.u.get(u.def);
          if (set.has(u.id) && u.owner === p.id && u.def !== 'drone' && ud?.kind !== 'air') {
            if (cmd.active && (u.stamina ?? 0) <= 0) continue;
            u.sprint = cmd.active;
          }
        }
        return ok();
      }
      case 'setRoute': {
        const u = w.units.find((x) => x.id === cmd.unit && x.owner === p.id);
        if (!u) return fail('unit not found');
        const ud = this.defs.u.get(u.def)!;
        if (!ud.cargoCap) return fail('not a transport');
        const b1 = w.buildings.find((x) => x.id === cmd.fromBuilding && x.owner === p.id);
        const b2 = w.buildings.find((x) => x.id === cmd.toBuilding && x.owner === p.id);
        if (!b1 || !b2) return fail('building not found');
        u.route = { fromBuilding: b1.id, toBuilding: b2.id, state: 'to_from' };
        this.orderMove([u], b1.pos, false);
        return ok();
      }
      case 'board': {
        const u = w.units.find((x) => x.id === cmd.unit && x.owner === p.id);
        const t = w.units.find((x) => x.id === cmd.transport && x.owner === p.id);
        if (!u || !t) return fail('unit not found');
        const td = this.defs.u.get(t.def)!;
        if (!td.passengerCap) return fail('transport cannot carry passengers');
        if (!t.cargo) t.cargo = { res: {}, cap: td.cargoCap ?? 500, passengers: [] };
        if (!t.cargo.passengers) t.cargo.passengers = [];
        if (t.cargo.passengers.length >= td.passengerCap) return fail('transport full');
        if (distKm(u.pos, t.pos) > 10) return fail('too far from transport');
        u.embarkedIn = t.id;
        u.path = [];
        u.target = null;
        u.pos = [...t.pos];
        t.cargo.passengers.push(u.id);
        return ok();
      }
      case 'disembark': {
        const t = w.units.find((x) => x.id === cmd.transport && x.owner === p.id);
        if (!t || !t.cargo?.passengers?.length) return fail('no passengers');
        for (const pid of t.cargo.passengers) {
          const u = w.units.find((x) => x.id === pid);
          if (u) {
            u.embarkedIn = undefined;
            u.pos = [t.pos[0] + 0.01, t.pos[1] + 0.01];
            u.path = [];
            u.target = null;
          }
        }
        t.cargo.passengers = [];
        return ok();
      }
      case 'refuel': {
        const set = new Set(cmd.units);
        for (const u of w.units) {
          if (!set.has(u.id) || u.owner !== p.id) continue;
          if (u.fuel === undefined) continue;
          let bestStation: LngLat | null = null;
          let bestDist = 1e9;
          for (const b of w.buildings) {
            if ((b.def === 'gas_station' || b.def === 'hq') && b.owner === p.id && b.progress >= 1) {
              const d = distKm(u.pos, b.pos);
              if (d < bestDist) { bestDist = d; bestStation = b.pos; }
            }
          }
          for (const ft of w.units) {
            if (ft.id !== u.id && ft.def === 'fuel_truck' && ft.owner === p.id && (ft.cargo?.res?.fuel ?? 0) > 0) {
              const d = distKm(u.pos, ft.pos);
              if (d < bestDist) { bestDist = d; bestStation = ft.pos; }
            }
          }
          if (bestStation) {
            this.orderMove([u], bestStation, false);
          }
        }
        return ok();
      }
    }
  }

  /** Plan routes: ground units take roads when that is quicker, then spread out around the destination. */
  private orderMove(units: Unit[], to: LngLat, cohesion: boolean) {
    if (!units.length) return;
    const mult = this.ruleset.rules.roadSpeedMult;
    const cap = cohesion ? Math.min(...units.map((u) => this.defs.u.get(u.def)!.speed)) : 0;
    const ground = units.filter((u) => this.defs.u.get(u.def)!.kind !== 'air');
    let shared: LngLat[] = [];
    let centre: LngLat = to;
    if (ground.length && this.roads) {
      centre = [ground.reduce((a, u) => a + u.pos[0], 0) / ground.length, ground.reduce((a, u) => a + u.pos[1], 0) / ground.length];
      shared = this.roads.route(centre, to, mult);
    }
    let own = 0;
    units.forEach((u, i) => {
      const ring = Math.ceil(Math.sqrt(i));
      const dest: LngLat = [to[0] + 0.012 * ring * Math.cos(i * 2.4), to[1] + 0.009 * ring * Math.sin(i * 2.4)];
      const d = this.defs.u.get(u.def)!;
      let road: LngLat[] = [];
      if (d.kind !== 'air' && this.roads) {
        // stragglers far from the group plan their own way (bounded so one order stays cheap)
        if (distKm(u.pos, centre) > 20 && own < 16) (road = this.roads.route(u.pos, to, mult)), own++;
        else road = shared;
      }
      const path: Waypoint[] = road.map((p, k) => ({ p, road: k > 0 }));
      path.push({ p: dest, road: false });
      u.path = path;
      u.target = dest;
      u.cap = cap;
    });
  }

  private rankUp(u: Unit) {
    while (u.rank < this.ranks.length - 1 && u.xp >= this.ranks[u.rank + 1].xp) {
      const before = this.maxHp(u);
      u.rank++;
      u.hp += this.maxHp(u) - before; // promotion brings the extra strength with it
      this.hooks.emit('unitPromoted', { id: u.id, def: u.def, owner: u.owner, rank: this.ranks[u.rank].id });
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

  private outputMult(b: Building): number {
    let m = b.road ? this.ruleset.rules.roadOutputMult : 1;
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
    for (const b of done) mults.set(b.id, this.outputMult(b));

    for (const p of w.players) {
      const mine = done.filter((b) => b.owner === p.id);
      let net = 0;
      for (const b of mine) {
        const d = this.defs.b.get(b.def)!;
        net += (d.produces?.energy ?? 0) * mults.get(b.id)! - (d.consumes?.energy ?? 0);
      }
      p.res.energy = clamp((p.res.energy ?? 0) + net * dt, 0, caps.get('energy') ?? 1e9);
      this.energyNet.set(p.id, net);
      const inc: Record<string, number> = { energy: net };
      this.income.set(p.id, inc);
      const eff = p.res.energy > 0 || net >= 0 ? 1 : this.ruleset.rules.energyDeficitMult;

      for (const b of mine) {
        if (!b.storage) b.storage = {};
        const d = this.defs.b.get(b.def)!;
        if (!d.produces) continue;
        const m = mults.get(b.id)! * eff;
        let can = true;
        for (const [k, v] of Object.entries(d.consumes ?? {})) {
          if (k !== 'energy' && (b.storage[k] ?? 0) < v * dt && (p.res[k] ?? 0) < v * dt) can = false;
        }
        if (!can) continue;
        for (const [k, v] of Object.entries(d.consumes ?? {})) {
          if (k === 'energy') continue;
          const need = v * dt;
          const fromStor = Math.min(b.storage[k] ?? 0, need);
          b.storage[k] = (b.storage[k] ?? 0) - fromStor;
          p.res[k] = Math.max(0, (p.res[k] ?? 0) - need);
          inc[k] = (inc[k] ?? 0) - v;
        }
        for (const [k, v] of Object.entries(d.produces)) {
          if (k === 'energy') continue;
          if (k === 'money' || k === 'people') {
            p.res[k] = Math.min(caps.get(k) ?? 1e9, (p.res[k] ?? 0) + v * m * dt);
            inc[k] = (inc[k] ?? 0) + v * m;
            continue;
          }
          const cap = (b.def === 'gas_station' && k === 'fuel') ? 20000 : 30000;
          const cur = b.storage[k] ?? 0;
          const added = Math.min(cap - cur, v * m * dt);
          b.storage[k] = Math.min(cap, cur + added);
          p.res[k] = Math.min(caps.get(k) ?? 1e9, (p.res[k] ?? 0) + added);
          inc[k] = (inc[k] ?? 0) + v * m;
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
      const n = w.units.length;
      this.spawnUnit(q.unit, p, [b.pos[0] + 0.03 * Math.cos(n * 1.9), b.pos[1] + 0.02 * Math.sin(n * 1.9)]);
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
    const r = this.ruleset.rules;
    for (const u of w.units) {
      if (u.embarkedIn) {
        const tr = w.units.find((x) => x.id === u.embarkedIn);
        if (tr) u.pos = [...tr.pos];
        continue;
      }

      const d = this.defs.u.get(u.def)!;
      const rank = this.ranks[u.rank];
      const range = d.range * rank.range;
      u.cooldown = Math.max(0, u.cooldown - dt);

      // Stamina update
      const isDrone = u.def === 'drone' || d.kind === 'air';
      if (!isDrone) {
        if (u.sprint) {
          if (u.path.length > 0) {
            u.stamina = Math.max(0, (u.stamina ?? 100) - (100 / 60) * dt);
            if (u.stamina <= 0) u.sprint = false;
          }
        } else {
          u.stamina = Math.min(100, (u.stamina ?? 100) + (100 / 180) * dt);
        }
      } else {
        u.stamina = undefined;
        u.sprint = false;
      }

      // Refueling for vehicles: tanks and vehicles refuel from gas_station storage tank (20k capacity) or fuel truck
      if (u.fuel !== undefined && u.maxFuel !== undefined && u.fuel < u.maxFuel) {
        let refueled = false;
        // 1. Check if near friendly gas_station (АЗС)
        for (const b of w.buildings) {
          if (b.def === 'gas_station' && b.owner === u.owner && b.progress >= 1 && distKm(u.pos, b.pos) <= 8) {
            const avail = b.storage?.fuel ?? 0;
            if (avail > 0) {
              const needed = u.maxFuel - u.fuel;
              const transfer = Math.min(30 * dt, needed, avail);
              b.storage!.fuel -= transfer;
              u.fuel = Math.min(u.maxFuel, u.fuel + transfer);
              refueled = true;
              break;
            }
          }
        }
        // 2. Check if near friendly fuel_truck
        if (!refueled) {
          for (const ft of w.units) {
            if (ft.id !== u.id && ft.def === 'fuel_truck' && ft.owner === u.owner && distKm(u.pos, ft.pos) <= 5) {
              const avail = ft.cargo?.res?.fuel ?? 0;
              if (avail > 0) {
                const needed = u.maxFuel - u.fuel;
                const transfer = Math.min(25 * dt, avail, needed);
                ft.cargo!.res.fuel -= transfer;
                u.fuel = Math.min(u.maxFuel, u.fuel + transfer);
                refueled = true;
                break;
              }
            }
          }
        }
        // 3. Fallback: HQ emergency refuel
        if (!refueled) {
          for (const b of w.buildings) {
            if (b.def === 'hq' && b.owner === u.owner && b.progress >= 1 && distKm(u.pos, b.pos) <= 8) {
              const avail = b.storage?.fuel ?? 0;
              if (avail > 0) {
                const needed = u.maxFuel - u.fuel;
                const transfer = Math.min(15 * dt, needed, avail);
                b.storage!.fuel -= transfer;
                u.fuel = Math.min(u.maxFuel, u.fuel + transfer);
                break;
              }
            }
          }
        }
      }

      // Automated logistics routes for transport vehicles
      if (u.route && u.cargo) {
        const fromB = w.buildings.find((x) => x.id === u.route!.fromBuilding && x.owner === u.owner);
        const toB = w.buildings.find((x) => x.id === u.route!.toBuilding && x.owner === u.owner);
        if (!fromB || !toB) {
          u.route = undefined;
        } else {
          const dFrom = distKm(u.pos, fromB.pos);
          const dTo = distKm(u.pos, toB.pos);
          const isFuelTruck = !!d.fuelOnly;

          if (u.route.state === 'to_from' || !u.route.state) {
            if (dFrom <= 3.5 || !u.path.length) {
              if (!fromB.storage) fromB.storage = {};
              if (!u.cargo.res) u.cargo.res = {};
              let curTotal = Object.values(u.cargo.res).reduce((a, b) => a + b, 0);
              const remainingCap = u.cargo.cap - curTotal;
              if (remainingCap > 0) {
                if (isFuelTruck) {
                  const avail = fromB.storage.fuel ?? 0;
                  const toTake = Math.min(remainingCap, avail);
                  fromB.storage.fuel = avail - toTake;
                  u.cargo.res.fuel = (u.cargo.res.fuel ?? 0) + toTake;
                } else {
                  // Only load physical transportable goods (NO money, NO people!)
                  const resKeys = ['metal', 'fuel', 'ore'];
                  for (const k of resKeys) {
                    const avail = fromB.storage[k] ?? 0;
                    if (avail > 0) {
                      const toTake = Math.min(u.cargo.cap - curTotal, avail);
                      fromB.storage[k] = avail - toTake;
                      u.cargo.res[k] = (u.cargo.res[k] ?? 0) + toTake;
                      curTotal += toTake;
                      if (curTotal >= u.cargo.cap) break;
                    }
                  }
                }
              }
              u.route.state = 'to_to';
              this.orderMove([u], toB.pos, false);
            }
          } else if (u.route.state === 'to_to') {
            if (dTo <= 3.5 || !u.path.length) {
              if (!toB.storage) toB.storage = {};
              const cap = toB.def === 'gas_station' ? 20000 : 30000;
              if (u.cargo.res) {
                for (const [k, v] of Object.entries(u.cargo.res)) {
                  toB.storage[k] = Math.min(cap, (toB.storage[k] ?? 0) + v);
                }
                u.cargo.res = {};
              }
              u.route.state = 'to_from';
              this.orderMove([u], fromB.pos, false);
            }
          }
        }
      }

      // Fire modes: 'hold' does not fire; 'return' fires only if damaged recently; 'auto' fires freely
      const canFire = u.fireMode !== 'hold' && (u.fireMode !== 'return' || u.hp < this.maxHp(u) - 0.5);

      let tu: Unit | null = null;
      let tb: Building | null = null;
      if (canFire) {
        let best = range;
        for (const e of w.units) {
          if (e.team === u.team || e.hp <= 0 || e.embarkedIn) continue;
          const dist = distKm(u.pos, e.pos);
          if (dist <= best) (best = dist), (tu = e);
        }
        if (!tu) {
          for (const e of w.buildings) {
            if (e.team === u.team || e.hp <= 0) continue;
            const dist = distKm(u.pos, e.pos);
            if (dist <= best) (best = dist), (tb = e);
          }
        }
      }

      if ((tu || tb) && u.cooldown === 0) {
        u.cooldown = 1; // one salvo per second
        const base = d.damage * rank.damage;
        let dealt: number;
        if (tu) {
          const cover = this.defs.u.get(tu.def)!.kind === 'air' ? 0 : this.terrainAt(tu.pos).cover;
          dealt = (base * (1 - cover)) / this.holdMult(tu.team, tu.pos);
          tu.hp -= dealt;
          this.shots.push({ def: u.def, team: u.team, from: u.pos, to: tu.pos });
          if (tu.hp <= 0) u.xp += r.xpPerKill;
        } else {
          dealt = base / this.holdMult(tb!.team, tb!.pos);
          tb!.hp -= dealt;
          this.shots.push({ def: u.def, team: u.team, from: u.pos, to: tb!.pos });
        }
        u.xp += dealt * r.xpPerDamage;
        this.rankUp(u);
      }

      // movement: explicit orders follow their route; idle units close with enemies they can see
      if (u.path.length) {
        this.advance(u, d, dt);
      } else if (!tu && !tb && canFire && !u.route) {
        let chase: LngLat | null = null;
        let near = d.vision * 0.7;
        for (const e of w.units) {
          if (e.team === u.team || e.embarkedIn) continue;
          const dist = distKm(u.pos, e.pos);
          if (dist < near) (near = dist), (chase = e.pos);
        }
        if (chase) u.pos = moveToward(u.pos, chase, d.speed * this.terrainSpeed(d, u.pos) * dt);
      }
    }
    if (this.shots.length > 4000) this.shots.splice(0, this.shots.length - 4000);

    const deadU = w.units.filter((u) => u.hp <= 0);
    if (deadU.length) {
      const deadIds = new Set(deadU.map((u) => u.id));
      for (const u of w.units) {
        if (u.embarkedIn && deadIds.has(u.embarkedIn)) {
          u.hp = 0; // dies with transport
        }
      }
      w.units = w.units.filter((u) => u.hp > 0);
      deadU.forEach((u) => this.hooks.emit('unitKilled', { id: u.id, def: u.def, owner: u.owner }));
    }
    const deadB = w.buildings.filter((b) => b.hp <= 0);
    if (deadB.length) {
      w.buildings = w.buildings.filter((b) => b.hp > 0);
      deadB.forEach((b) => this.hooks.emit('buildingDestroyed', { id: b.id, def: b.def, owner: b.owner }));
    }
  }

  private advance(u: Unit, d: UnitDef, dt: number) {
    if (u.fuel !== undefined && u.fuel <= 0) {
      return; // out of fuel
    }
    const sprintMult = u.sprint && u.def !== 'drone' ? 2.0 : 1.0;
    const base = (u.cap ? Math.min(d.speed, u.cap) : d.speed) * sprintMult;
    const roadMult = d.kind === 'air' ? 1 : this.ruleset.rules.roadSpeedMult;
    let budget = dt;
    let totalMovedKm = 0;
    for (let guard = 0; budget > 1e-6 && u.path.length && guard < 32; guard++) {
      const wp = u.path[0];
      const speed = base * (wp.road ? roadMult : this.terrainSpeed(d, u.pos));
      const dist = distKm(u.pos, wp.p);
      if (speed * budget >= dist) {
        totalMovedKm += dist;
        u.pos = [wp.p[0], wp.p[1]];
        budget -= dist / speed;
        u.path.shift();
      } else {
        const moved = speed * budget;
        totalMovedKm += moved;
        u.pos = moveToward(u.pos, wp.p, moved);
        budget = 0;
      }
    }
    if (u.fuel !== undefined && totalMovedKm > 0) {
      const fuelBurnRate = 0.02 * (u.sprint ? 1.5 : 1.0);
      u.fuel = Math.max(0, u.fuel - totalMovedKm * fuelBurnRate);
    }
    if (!u.path.length) (u.target = null), (u.cap = 0);
  }

  /** The "abstract war": economy and local force balance push every front node along its normal. */
  private frontline(dt: number) {
    const w = this.world;
    const r = this.ruleset.rules;
    const R = r.frontInfluenceKm;
    const n = w.front;

    const abstract: [number, number] = [0, 0];
    for (const p of w.players) {
      const hqs = w.buildings.some((b) => b.owner === p.id && b.def === 'hq' && b.progress >= 1);
      if (!hqs) continue;
      abstract[p.team] += (4 + Math.sqrt(p.res.people ?? 0) + Math.sqrt(p.res.metal ?? 0)) * r.abstractPower;
    }
    // the abstract term is spread per 100 km of front so that map size does not change its weight
    const perNode = [(abstract[0] * r.frontNodeSpacingKm) / 500, (abstract[1] * r.frontNodeSpacingKm) / 500];
    const defended = w.buildings.filter((b) => b.progress >= 1 && this.defs.b.get(b.def)!.defense);
    const degR = R / 111 + 0.05;

    const raw = n.map((node) => {
      const pos: LngLat = [node.lng, node.lat];
      const force: [number, number] = [perNode[0], perNode[1]];
      const degRx = degR / Math.max(0.3, Math.cos((node.lat * Math.PI) / 180));
      for (const u of w.units) {
        if (Math.abs(u.pos[1] - node.lat) > degR || Math.abs(u.pos[0] - node.lng) > degRx) continue;
        const d = distKm(u.pos, pos);
        if (d > R) continue;
        const ud = this.defs.u.get(u.def)!;
        force[u.team] += ud.damage * this.ranks[u.rank].damage * (u.hp / this.maxHp(u)) * (1 - d / R);
      }
      const hold: [number, number] = [1, 1];
      for (const b of defended) {
        const def = this.defs.b.get(b.def)!.defense!;
        if (distKm(b.pos, pos) <= def.radiusKm) hold[b.team] += def.mult;
      }
      const resist = this.terrainAt(pos).frontResist;
      return clamp((force[0] * hold[0] - force[1] * hold[1]) * r.frontPush, -r.frontMaxSpeed, r.frontMaxSpeed) * (1 - resist);
    });

    // neighbours share speed so the line bends instead of spiking; both ends stay anchored
    const s = clamp(r.frontSmoothing, 0, 1);
    for (let i = 1; i < n.length - 1; i++) {
      const v = raw[i] * (1 - s) + ((raw[i - 1] + raw[i + 1]) / 2) * s;
      n[i].v = v;
      if (v === 0) continue;
      const [nx, ny] = normalAt(n, i);
      const nextLng = n[i].lng + (nx * v * dt) / kmPerDegLng(n[i].lat);
      const nextLat = n[i].lat + (ny * v * dt) / 111.32;
      // Impassable water boundary: ground front cannot push into open sea / water
      if (this.terrainAt([nextLng, nextLat]).id === 'water') {
        n[i].v = 0;
        continue;
      }
      n[i].lng = nextLng;
      n[i].lat = nextLat;
    }
    n[0].v = n[n.length - 1].v = 0;

    // Detect pinching salients and resolve military cauldrons ("котлы")
    if (w.tick % 5 === 0) {
      const { main, loops } = resolveFrontLoops(n);
      if (loops.length > 0) {
        if (!w.pockets) w.pockets = [];
        for (const loop of loops) {
          const side = sideOf(main, loop[1] ? [loop[1].lng, loop[1].lat] : [loop[0].lng, loop[0].lat]);
          const encircledTeam: Team = (1 - side) as Team;
          w.pockets.push({ id: w.nextId++, team: encircledTeam, nodes: loop });
        }
      }
      w.front = main;
    }
    if (w.tick % 50 === 0) w.front = resample(w.front);
    this.updatePockets(dt);
  }

  private updatePockets(dt: number) {
    const w = this.world;
    if (!w.pockets || w.pockets.length === 0) return;
    w.pockets = w.pockets.filter((pkt) => {
      const c = pocketCentroid(pkt.nodes);
      const r = pocketRadiusKm(pkt.nodes);
      if (r <= 2.0) return false; // cauldron collapsed
      const shrinkSpeed = 0.2 * dt;
      for (const node of pkt.nodes) {
        const dx = c[0] - node.lng, dy = c[1] - node.lat;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6) {
          node.lng += (dx / d) * (shrinkSpeed / kmPerDegLng(node.lat));
          node.lat += (dy / d) * (shrinkSpeed / 111.32);
        }
      }
      return true;
    });
  }

  private territory(dt: number) {
    const w = this.world;
    const r = this.ruleset.rules;
    this.map.capturePoints.forEach((cp, i) => {
      const side = sideOfWithPockets(w.front, w.pockets, cp.pos);
      if (w.points[i].owner !== side) {
        w.points[i].owner = side;
        this.hooks.emit('pointCaptured', { id: cp.id, team: side });
      }
      w.scores[side] += cp.value * r.pointScorePerSec * dt;
    });
    // anything the front rolled over is lost (checked a few buildings per tick to spread the cost)
    const lost: Building[] = [];
    for (let i = w.tick % 5; i < w.buildings.length; i += 5) {
      if (sideOfWithPockets(w.front, w.pockets, w.buildings[i].pos) !== w.buildings[i].team) lost.push(w.buildings[i]);
    }
    if (lost.length) {
      w.buildings = w.buildings.filter((b) => !lost.includes(b));
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
