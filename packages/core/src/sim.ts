import type { Command, CommandResult } from './commands';
import type { BuildingDef, MapDef, RankDef, ResourceAmounts, Ruleset, TerrainDef, UnitDef } from './defs';
import { clamp, distKm, kmPerDegLng, moveToward, type LngLat } from './geo';
import { buildFront, distToFrontKm, findPinch, normalOf, pocketAt, pointInRing, respace, ringAreaKm2, sideOf } from './frontline';
import { RoadNetwork } from './roads';
import { TerrainGrid } from './terrain';
import type { Building, FrontNode, Player, Pocket, Shot, SlotInit, Team, Unit, Waypoint, World } from './state';

export interface Hooks {
  emit(event: string, data: Record<string, unknown>): void;
}
const NO_HOOKS: Hooks = { emit() {} };
const MAP_CACHE = new WeakMap<MapDef, { roads: RoadNetwork | null; terrain: TerrainGrid | null }>();
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
    // road graph and terrain grid are immutable and expensive to build: share them between matches on the same map
    let shared = MAP_CACHE.get(map);
    if (!shared) {
      const barriers: Record<string, number> = {};
      for (const t of ruleset.terrain) if (t.barrier) barriers[t.id] = t.barrier.minCells;
      shared = { roads: map.roads?.length ? new RoadNetwork(map.roads) : null, terrain: map.terrain ? new TerrainGrid(map.terrain, barriers) : null };
      MAP_CACHE.set(map, shared);
    }
    this.roads = shared.roads;
    this.terrain = shared.terrain;
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
    const teamSize = [0, 1].map((t) => players.filter((p) => p.team === t).length);
    // spawns are authored as mirrored pairs: both teams use the same indices, spread evenly along the front
    const perTeam = Math.max(teamSize[0], teamSize[1]);
    for (const p of players) {
      const spawns = this.map.spawns[p.team];
      const n = counters[p.team]++;
      const idx = perTeam <= spawns.length ? Math.floor(((n + 0.5) * spawns.length) / perTeam) : n % spawns.length;
      const base = spawns[idx];
      // players beyond the authored spawn list share a spawn, nudged aside
      const lap = perTeam <= spawns.length ? 0 : Math.floor(n / spawns.length);
      const pos: LngLat = [base[0] + lap * 0.09, base[1] + lap * 0.05];
      this.spawnBuilding('hq', p, pos, true);
      r.startUnits.forEach((u, i) => this.spawnUnit(u, p, [pos[0] + 0.035 * Math.cos(i * 1.3), pos[1] + 0.025 * Math.sin(i * 1.3)]));
    }
    this.map.capturePoints.forEach((cp, i) => (w.points[i].owner = this.side(cp.pos)));
    return w;
  }

  private spawnBuilding(def: string, p: Player, pos: LngLat, done = false): Building {
    const d = this.defs.b.get(def)!;
    const road = this.roads?.isNear(pos, this.ruleset.rules.roadAccessKm) ?? false;
    const b: Building = { id: this.world.nextId++, def, owner: p.id, team: p.team, pos, hp: d.hp, progress: done ? 1 : 0, road, cooldown: 0, inside: [], course: null };
    this.world.buildings.push(b);
    return b;
  }

  spawnUnit(def: string, p: Player, pos: LngLat): Unit {
    const d = this.defs.u.get(def)!;
    pos = this.dry(d, pos);
    const u: Unit = { id: this.world.nextId++, def, owner: p.id, team: p.team, pos, hp: d.hp * this.ranks[0].hp, target: null, cooldown: 0, xp: 0, rank: 0, transport: false, encircled: false, enter: 0, path: [], cap: 0 };
    this.world.units.push(u);
    return u;
  }

  /** Never drop a ground unit into a river: fall back to dry spots around the intended position. */
  private dry(d: UnitDef, pos: LngLat): LngLat {
    if (!this.blockedFor(d) || !this.terrain?.isBarrier(pos)) return pos;
    for (let k = 1; k <= 32; k++) {
      const r = 0.02 * Math.ceil(k / 8);
      const q: LngLat = [pos[0] + r * Math.cos(k * 0.785), pos[1] + r * 0.7 * Math.sin(k * 0.785)];
      if (!this.terrain.isBarrier(q)) return q;
    }
    return pos;
  }

  /** Everyone inside walks out, e.g. when a course ends or the building is lost (`hpMult` < 1). */
  private evict(b: Building, hpMult = 1) {
    b.inside.forEach((u, i) => {
      const d = this.defs.u.get(u.def)!;
      u.pos = this.dry(d, [b.pos[0] + 0.022 * Math.cos(i * 1.1 + 0.4), b.pos[1] + 0.016 * Math.sin(i * 1.1 + 0.4)]);
      u.hp = Math.max(1, u.hp * hpMult);
      u.path = [];
      u.target = null;
      u.enter = 0;
      u.transport = false;
      this.world.units.push(u);
    });
    b.inside = [];
    b.course = null;
  }

  /** Duration of a course for the units currently inside, and what it costs per second while it runs. */
  courseTerms(b: Building): { perSecond: number; seconds: number; pupils: number } {
    const t = this.defs.b.get(b.def)!.training!;
    const r = this.ruleset.rules;
    let top = 0;
    let pupils = 0;
    let perTick = 0;
    for (const u of b.inside) {
      if (!this.ranks[u.rank + 1]) continue;
      pupils++;
      top = Math.max(top, u.rank + 1);
      perTick += r.courseCostPerTick + r.courseCostPerRank * u.rank;
    }
    return { perSecond: perTick * r.tickRate, seconds: t.baseTime + t.timePerRank * top, pupils };
  }

  /** Which team holds the ground here: cauldrons first, then the main front. */
  side(p: LngLat): Team {
    const pocket = this.world.pockets.length ? pocketAt(this.world.pockets, p) : null;
    return pocket ? pocket.team : sideOf(this.world.front, p);
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
        const dist = distToFrontKm(w.front, cmd.pos) * (p.team === 0 ? 1 : -1);
        const pocket = w.pockets.length ? pocketAt(w.pockets, cmd.pos) : null;
        if (pocket) return fail(pocket.team === p.team ? 'this ground is encircled' : 'not your territory');
        if (dist < 0) return fail('not your territory');
        if (dist < r.minBuildDistanceFromFront * (d.category === 'civil' ? 2 : 1)) return fail('too close to the front');
        if (this.terrainAt(cmd.pos).id === 'water') return fail('cannot build on water');
        if (d.needsWaterWithinKm && !this.barrierNear(cmd.pos, d.needsWaterWithinKm)) return fail('must be built on a river bank');
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
        if (!isFinitePos(cmd.to) || !Array.isArray(cmd.units) || cmd.units.length > 300) return fail('bad order');
        const set = new Set(cmd.units);
        const moved = this.orderMove(w.units.filter((u) => set.has(u.id) && u.owner === p.id), cmd.to, !!cmd.cohesion, !!cmd.queue, cmd.mode === 'direct');
        return moved ? ok() : fail('no way across the water: use a bridge or build a pontoon crossing');
      }
      case 'stop': {
        const set = new Set(cmd.units);
        for (const u of w.units) if (set.has(u.id) && u.owner === p.id) (u.target = null), (u.path = []), (u.cap = 0), (u.transport = false), (u.enter = 0);
        return ok();
      }
      case 'enter': {
        const b = w.buildings.find((x) => x.id === cmd.building);
        const t = b && this.defs.b.get(b.def)!.training;
        if (!b || !t || b.owner !== p.id || b.progress < 1) return fail('not a training centre of yours');
        if (b.course) return fail('a course is in progress');
        if (!Array.isArray(cmd.units) || cmd.units.length > 300) return fail('bad order');
        const set = new Set(cmd.units);
        const free = t.capacity - b.inside.length - w.units.filter((u) => u.enter === b.id).length;
        const pupils = w.units
          .filter((u) => set.has(u.id) && u.owner === p.id && this.defs.u.get(u.def)!.kind !== 'air' && u.rank < this.ranks.length - 1)
          .slice(0, Math.max(0, free));
        if (!pupils.length) return fail(free <= 0 ? 'training centre is full' : 'no ground units that can still be trained');
        if (!this.orderMove(pupils, b.pos, false, false, false)) return fail('no way to the training centre');
        for (const u of pupils) if (u.path.length) u.enter = b.id;
        return ok();
      }
      case 'course': {
        const b = w.buildings.find((x) => x.id === cmd.building);
        const t = b && this.defs.b.get(b.def)!.training;
        if (!b || !t || b.owner !== p.id) return fail('not a training centre of yours');
        if (b.course) return fail('a course is already running');
        const terms = this.courseTerms(b);
        if (terms.pupils < t.minUnits) return fail(`a course needs at least ${t.minUnits} units inside`);
        if ((p.res.money ?? 0) < terms.perSecond) return fail('not enough money to start a course');
        b.course = { remaining: terms.seconds, total: terms.seconds };
        return ok();
      }
      case 'release': {
        const b = w.buildings.find((x) => x.id === cmd.building);
        if (!b || b.owner !== p.id || !b.inside.length) return fail('nobody inside');
        if (b.course) return fail('a course is in progress');
        this.evict(b);
        return ok();
      }
      case 'demolish': {
        const i = w.buildings.findIndex((x) => x.id === cmd.building && x.owner === p.id);
        if (i < 0) return fail('not found');
        const b = w.buildings[i];
        if (b.def === 'hq') return fail('cannot demolish HQ');
        const d = this.defs.b.get(b.def)!;
        for (const [k, v] of Object.entries(d.cost)) p.res[k] = (p.res[k] ?? 0) + v * 0.4;
        this.evict(b);
        w.buildings.splice(i, 1);
        return ok();
      }
    }
  }

  // ---------- movement planning ----------
  private blockedFor(d: UnitDef): boolean {
    if (d.kind === 'air') return false;
    const mob = d.mobility ?? 'foot';
    return this.ruleset.terrain.some((t) => t.barrier?.mobility.includes(mob));
  }

  /** Friendly boat/pontoon crossings in service. */
  private crossings(team: Team): { pos: LngLat; r: number; speed: number }[] {
    const out: { pos: LngLat; r: number; speed: number }[] = [];
    for (const b of this.world.buildings) {
      if (b.team !== team || b.progress < 1) continue;
      const c = this.defs.b.get(b.def)!.crossing;
      if (c) out.push({ pos: b.pos, r: c.radiusKm, speed: c.speed });
    }
    return out;
  }

  private barrierNear(p: LngLat, km: number): boolean {
    if (!this.terrain) return false;
    for (let a = 0; a < 16; a++) {
      for (const r of [km * 0.5, km]) {
        const q: LngLat = [p[0] + (Math.cos((a / 16) * 6.2832) * r) / kmPerDegLng(p[1]), p[1] + (Math.sin((a / 16) * 6.2832) * r) / 111.32];
        if (this.terrain.isBarrier(q)) return true;
      }
    }
    return false;
  }

  /** Can a ground unit of this team walk/drive cross-country from a to b without entering a river? */
  private lineClear(a: LngLat, b: LngLat, cross: { pos: LngLat; r: number }[]): boolean {
    if (!this.terrain) return true;
    const steps = Math.max(1, Math.ceil(distKm(a, b) / 0.15));
    let leaving = this.terrain.isBarrier(a); // a unit already afloat may always make for the bank
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const p: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (!this.terrain.isBarrier(p)) leaving = false;
      else if (!leaving && !cross.some((c) => distKm(c.pos, p) <= c.r)) return false;
    }
    return true;
  }

  /** One stretch without boats: straight if open, by road if that is quicker (or the only way). */
  private planLeg(from: LngLat, to: LngLat, speed: number, cross: { pos: LngLat; r: number }[], direct: boolean): { wps: Waypoint[]; sec: number } | null {
    const off = speed * 0.85; // rough cross-country average, terrain is applied for real while moving
    const clear = (a: LngLat, b: LngLat) => this.lineClear(a, b, cross);
    const open = clear(from, to);
    const straight = open ? distKm(from, to) / off : Infinity;
    if (open && (direct || straight < 60)) return { wps: [{ p: to, road: false }], sec: straight }; // short hops are not worth mounting up for
    const road = this.roads?.routeTimed(from, to, { roadSpeed: speed * this.ruleset.rules.roadSpeedMult, offSpeed: off, clear, usable: (n) => !this.terrain?.isBarrier(n) }) ?? null;
    if (road && road.seconds < straight) {
      const wps: Waypoint[] = road.points.map((p, k) => ({ p, road: k > 0 }));
      wps.push({ p: to, road: false });
      return { wps, sec: road.seconds };
    }
    return open ? { wps: [{ p: to, road: false }], sec: straight } : null;
  }

  /** Quickest way for a ground unit: direct, by road (bridges), or via a friendly boat crossing. */
  private plan(team: Team, from: LngLat, to: LngLat, speed: number, direct: boolean): Waypoint[] | null {
    const cross = this.crossings(team);
    let best = this.planLeg(from, to, speed, cross, direct);
    const span = distKm(from, to);
    for (const c of cross) {
      // only crossings roughly on the way are worth trying
      if (distKm(from, c.pos) + distKm(c.pos, to) > span * 1.8 + 60) continue;
      const a = this.planLeg(from, c.pos, speed, cross, direct);
      if (!a) continue;
      const b = this.planLeg(c.pos, to, speed, cross, direct);
      if (!b) continue;
      if (!best || a.sec + b.sec < best.sec) best = { wps: [...a.wps, ...b.wps], sec: a.sec + b.sec };
    }
    return best ? best.wps : null;
  }

  /**
   * Plan routes for a move order. Ground units travel by road in transport mode when that is quicker, rivers are only
   * crossed on bridges (roads) or at boat crossings. Returns how many units got a route.
   */
  private orderMove(units: Unit[], to: LngLat, cohesion: boolean, queue: boolean, direct: boolean): number {
    if (!units.length) return 0;
    const r = this.ruleset.rules;
    const cap = cohesion ? Math.min(...units.map((u) => this.defs.u.get(u.def)!.speed)) : 0;
    const startOf = (u: Unit): LngLat => (queue && u.path.length ? u.path[u.path.length - 1].p : u.pos);
    const ground = units.filter((u) => this.defs.u.get(u.def)!.kind !== 'air');
    let centre: LngLat = to;
    let shared: Waypoint[] | null = null;
    if (ground.length) {
      centre = [ground.reduce((a, u) => a + startOf(u)[0], 0) / ground.length, ground.reduce((a, u) => a + startOf(u)[1], 0) / ground.length];
      const slowest = Math.min(...ground.map((u) => this.defs.u.get(u.def)!.speed));
      shared = this.plan(ground[0].team, centre, to, slowest, direct);
    }
    let own = 0;
    let moved = 0;
    units.forEach((u, i) => {
      const d = this.defs.u.get(u.def)!;
      const from = startOf(u);
      if (queue && u.path.filter((w) => w.end).length >= r.maxQueuedOrders) return;
      const ring = Math.ceil(Math.sqrt(i));
      let dest: LngLat = [to[0] + 0.012 * ring * Math.cos(i * 2.4), to[1] + 0.009 * ring * Math.sin(i * 2.4)];
      let leg: Waypoint[] | null;
      if (d.kind === 'air') {
        leg = [{ p: dest, road: false }];
      } else {
        // never park a unit in the river because of its place in the formation
        if (this.blockedFor(d) && this.terrain?.isBarrier(dest)) dest = to;
        // the group shares one plan; stragglers (and units the shared plan cannot reach) plan their own, bounded per order
        const near = distKm(from, centre) <= 15 && this.lineClear(from, shared?.[0]?.p ?? to, this.crossings(u.team));
        if (shared && near) leg = shared.map((w) => ({ ...w }));
        else if (own++ < 24) leg = this.plan(u.team, from, to, d.speed, direct);
        else leg = null;
        if (leg) leg[leg.length - 1] = { p: dest, road: false };
      }
      if (!leg) return;
      leg[leg.length - 1].end = true;
      u.enter = 0;
      u.path = queue ? [...u.path, ...leg] : leg;
      u.target = dest;
      u.cap = cap;
      moved++;
    });
    return moved;
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
    this.courses(dt);
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

  /** Training centres: admit units that have arrived, run courses, graduate the class. */
  private courses(dt: number) {
    const w = this.world;
    for (const u of w.units) {
      if (!u.enter || u.path.length) continue;
      const b = w.buildings.find((x) => x.id === u.enter);
      const t = b && this.defs.b.get(b.def)!.training;
      u.enter = 0;
      if (!b || !t || b.course || b.inside.length >= t.capacity || distKm(u.pos, b.pos) > 3) continue;
      u.hp = Math.max(u.hp, 1);
      b.inside.push(u);
    }
    if (w.buildings.some((b) => b.inside.length)) {
      const inside = new Set(w.buildings.flatMap((b) => b.inside));
      if (w.units.some((u) => inside.has(u))) w.units = w.units.filter((u) => !inside.has(u));
    }
    for (const b of w.buildings) {
      if (!b.course) continue;
      // tuition is paid as the course runs; with an empty treasury the class waits
      const owner = this.player(b.owner);
      const fee = this.courseTerms(b).perSecond * dt;
      if (!owner || (owner.res.money ?? 0) < fee) continue;
      owner.res.money -= fee;
      b.course.remaining -= dt;
      if (b.course.remaining > 0) continue;
      for (const u of b.inside) {
        const next = this.ranks[u.rank + 1];
        if (!next) continue;
        u.xp = Math.max(u.xp, next.xp);
        this.rankUp(u);
        u.hp = this.maxHp(u); // graduates leave rested and at full strength
      }
      this.hooks.emit('courseFinished', { id: b.id, owner: b.owner, units: b.inside.length });
      this.evict(b);
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
        const d = this.defs.b.get(b.def)!;
        if (!d.produces) continue;
        const m = mults.get(b.id)! * eff;
        let can = true;
        for (const [k, v] of Object.entries(d.consumes ?? {})) {
          if (k !== 'energy' && (p.res[k] ?? 0) < v * dt) can = false;
        }
        if (!can) continue;
        for (const [k, v] of Object.entries(d.consumes ?? {})) {
          if (k === 'energy') continue;
          p.res[k] -= v * dt;
          inc[k] = (inc[k] ?? 0) - v;
        }
        for (const [k, v] of Object.entries(d.produces)) {
          if (k === 'energy') continue;
          p.res[k] = Math.min(caps.get(k) ?? 1e9, (p.res[k] ?? 0) + v * m * dt);
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
      const d = this.defs.u.get(u.def)!;
      const rank = this.ranks[u.rank];
      // cut off in a cauldron: no supply, strength drains away
      u.encircled = d.kind !== 'air' && w.pockets.some((p) => p.team === u.team && pointInRing(p.nodes, u.pos));
      if (u.encircled) u.hp -= this.maxHp(u) * r.encircledAttrition * dt;
      const range = d.range * rank.range;
      u.cooldown = Math.max(0, u.cooldown - dt);

      // acquire the nearest enemy in range: units first, then buildings
      let tu: Unit | null = null;
      let tb: Building | null = null;
      let best = range;
      for (const e of w.units) {
        if (e.team === u.team || e.hp <= 0) continue;
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
      // a column that runs into the enemy halts and deploys; it drives on once the way is clear
      const engaged = !!(tu || tb);
      u.transport = !engaged && u.path.length > 0 && u.path[0].road && d.kind !== 'air';
      if (engaged && u.cooldown === 0) {
        u.cooldown = 1; // one salvo per second
        const base = d.damage * rank.damage * (u.encircled ? r.encircledDamageMult : 1);
        let dealt: number;
        if (tu) {
          const td = this.defs.u.get(tu.def)!;
          const air = td.kind === 'air';
          const cover = air ? 0 : this.terrainAt(tu.pos).cover;
          dealt = (base * (air ? d.airDamage ?? r.airDamageDefault : 1) * (1 - cover) * (tu.transport ? r.transportDamageMult : 1)) / this.holdMult(tu.team, tu.pos);
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
        if (!(engaged && u.path[0].road && d.kind !== 'air')) this.advance(u, d, dt);
      } else if (!tu && !tb) {
        let chase: LngLat | null = null;
        let near = d.vision * 0.7;
        for (const e of w.units) {
          if (e.team === u.team) continue;
          const dist = distKm(u.pos, e.pos);
          if (dist < near) (near = dist), (chase = e.pos);
        }
        if (chase) this.stepOffRoad(u, d, chase, d.speed * dt);
      }
    }

    // static weapons (air defence and the like)
    for (const b of w.buildings) {
      const a = this.defs.b.get(b.def)!.attack;
      if (!a || b.progress < 1) continue;
      b.cooldown = Math.max(0, b.cooldown - dt);
      if (b.cooldown > 0) continue;
      let tgt: Unit | null = null;
      let best = a.range;
      for (const e of w.units) {
        if (e.team === b.team || e.hp <= 0) continue;
        const air = this.defs.u.get(e.def)!.kind === 'air';
        if ((a.targets === 'air' && !air) || (a.targets === 'ground' && air)) continue;
        const dist = distKm(b.pos, e.pos);
        if (dist <= best) (best = dist), (tgt = e);
      }
      if (!tgt) continue;
      b.cooldown = 1;
      tgt.hp -= a.damage;
      this.shots.push({ def: b.def, team: b.team, from: b.pos, to: tgt.pos });
    }
    if (this.shots.length > 4000) this.shots.splice(0, this.shots.length - 4000);

    const deadU = w.units.filter((u) => u.hp <= 0);
    if (deadU.length) {
      w.units = w.units.filter((u) => u.hp > 0);
      deadU.forEach((u) => this.hooks.emit('unitKilled', { id: u.id, def: u.def, owner: u.owner }));
    }
    const deadB = w.buildings.filter((b) => b.hp <= 0);
    if (deadB.length) {
      deadB.forEach((b) => this.evict(b, 0.5));
      w.buildings = w.buildings.filter((b) => b.hp > 0);
      deadB.forEach((b) => this.hooks.emit('buildingDestroyed', { id: b.id, def: b.def, owner: b.owner }));
    }
  }

  /**
   * Cross-country step towards `to` using at most `budgetKm` of open-ground distance (terrain makes it shorter).
   * Returns false when a river stops the unit.
   */
  private stepOffRoad(u: Unit, d: UnitDef, to: LngLat, budgetKm: number): boolean {
    let mult = this.terrainSpeed(d, u.pos);
    const blocked = this.blockedFor(d) && this.terrain;
    if (blocked && this.terrain!.isBarrier(u.pos)) {
      // afloat: boats set the pace inside a crossing; a unit stranded outside one may still struggle to the bank
      const c = this.crossings(u.team).find((x) => distKm(x.pos, u.pos) <= x.r);
      if (c) mult = c.speed;
    }
    const next = moveToward(u.pos, to, budgetKm * mult);
    if (blocked && this.terrain!.isBarrier(next) && !this.terrain!.isBarrier(u.pos) && !this.crossings(u.team).some((x) => distKm(x.pos, next) <= x.r)) return false;
    u.pos = next;
    return true;
  }

  private advance(u: Unit, d: UnitDef, dt: number) {
    const base = u.cap ? Math.min(d.speed, u.cap) : d.speed;
    const roadMult = d.kind === 'air' ? 1 : this.ruleset.rules.roadSpeedMult;
    let budget = dt;
    for (let guard = 0; budget > 1e-6 && u.path.length && guard < 32; guard++) {
      const wp = u.path[0];
      const dist = distKm(u.pos, wp.p);
      if (wp.road) {
        const speed = base * roadMult;
        if (speed * budget >= dist) {
          u.pos = [wp.p[0], wp.p[1]];
          budget -= dist / speed;
          u.path.shift();
        } else {
          u.pos = moveToward(u.pos, wp.p, speed * budget);
          budget = 0;
        }
      } else {
        const before = u.pos;
        if (!this.stepOffRoad(u, d, wp.p, base * budget)) {
          // the crossing it counted on is gone: halt at the bank and drop the orders
          u.path = [];
          break;
        }
        budget = 0;
        if (distKm(u.pos, wp.p) < 0.02 || (before[0] === u.pos[0] && before[1] === u.pos[1])) u.path.shift();
      }
    }
    if (!u.path.length) (u.target = null), (u.cap = 0), (u.transport = false);
    else u.target = u.path[u.path.length - 1].p;
  }

  /** The "abstract war": economy and local force balance push every front node along its normal. */
  private frontline(dt: number) {
    const w = this.world;
    const r = this.ruleset.rules;
    const R = r.frontInfluenceKm;

    const abstract: [number, number] = [0, 0];
    for (const p of w.players) {
      const hqs = w.buildings.some((b) => b.owner === p.id && b.def === 'hq' && b.progress >= 1);
      if (!hqs) continue;
      abstract[p.team] += (4 + Math.sqrt(p.res.people ?? 0) + Math.sqrt(p.res.metal ?? 0)) * r.abstractPower;
    }
    // the abstract term is spread per 100 km of front so that map size does not change its weight
    const perNode: [number, number] = [(abstract[0] * r.frontNodeSpacingKm) / 500, (abstract[1] * r.frontNodeSpacingKm) / 500];
    const defended = w.buildings.filter((b) => b.progress >= 1 && this.defs.b.get(b.def)!.defense);
    const degR = R / 111 + 0.05;

    const speedAt = (node: FrontNode, base: [number, number]): number => {
      const pos: LngLat = [node.lng, node.lat];
      const force: [number, number] = [base[0], base[1]];
      const degRx = degR / Math.max(0.3, Math.cos((node.lat * Math.PI) / 180));
      for (const u of w.units) {
        if (Math.abs(u.pos[1] - node.lat) > degR || Math.abs(u.pos[0] - node.lng) > degRx) continue;
        const d = distKm(u.pos, pos);
        if (d > R) continue;
        const ud = this.defs.u.get(u.def)!;
        force[u.team] += ud.damage * this.ranks[u.rank].damage * (u.encircled ? r.encircledDamageMult : 1) * (u.hp / this.maxHp(u)) * (1 - d / R);
      }
      const hold: [number, number] = [1, 1];
      for (const b of defended) {
        const def = this.defs.b.get(b.def)!.defense!;
        if (distKm(b.pos, pos) <= def.radiusKm) hold[b.team] += def.mult;
      }
      const resist = this.terrainAt(pos).frontResist;
      return clamp((force[0] * hold[0] - force[1] * hold[1]) * r.frontPush, -r.frontMaxSpeed, r.frontMaxSpeed) * (1 - resist);
    };

    // neighbours share speed so the line bends instead of spiking
    const s = clamp(r.frontSmoothing, 0, 1);
    const move = (n: FrontNode[], closed: boolean, base: [number, number]) => {
      const len = n.length;
      const raw = n.map((node) => speedAt(node, base));
      for (let i = closed ? 0 : 1; i < (closed ? len : len - 1); i++) {
        const pi = (i - 1 + len) % len;
        const ni = (i + 1) % len;
        const v = raw[i] * (1 - s) + ((raw[pi] + raw[ni]) / 2) * s;
        n[i].v = v;
        if (v === 0) continue;
        const [nx, ny] = normalOf(n[pi], n[i], n[ni]);
        n[i].lng += (nx * v * dt) / kmPerDegLng(n[i].lat);
        n[i].lat += (ny * v * dt) / 111.32;
      }
      if (!closed) n[0].v = n[len - 1].v = 0; // both ends of the main line stay anchored
    };

    move(w.front, false, perNode);
    for (const pocket of w.pockets) {
      // a cauldron gets nothing from its side's economy; the besiegers squeeze with extra weight
      const base: [number, number] = pocket.team === 0 ? [0, perNode[1] * 1.5] : [perNode[0] * 1.5, 0];
      move(pocket.nodes, true, base);
    }

    if (w.tick % 5 === 0) this.pinch();
    if (w.tick % 10 === 0) this.collapsePockets();
    if (w.tick % 20 === 0) {
      w.front = respace(w.front, r.frontNodeSpacingKm);
      for (const p of w.pockets) {
        const ring = respace([...p.nodes, p.nodes[0]], r.frontNodeSpacingKm * 0.6);
        ring.pop();
        if (ring.length >= 3) p.nodes = ring;
      }
    }
  }

  /** When the jaws of a pincer meet, the loop of front between them is cut off and becomes a cauldron. */
  private pinch() {
    const w = this.world;
    const r = this.ruleset.rules;
    const hit = findPinch(w.front, r.pinchKm, 5);
    if (!hit) return;
    const loop = w.front.slice(hit.from, hit.to + 1);
    w.front = [...w.front.slice(0, hit.from), ...w.front.slice(hit.to + 1)];
    const area = ringAreaKm2(loop);
    // too small to matter: the kink is simply straightened out
    if (Math.abs(area) < r.pocketMinAreaKm2 * 1.5 || loop.length < 4 || w.pockets.length >= 8) return;
    // the loop keeps the line's direction, so team 0 is still on its left: counter-clockwise means team 0 is inside
    const team: Team = area > 0 ? 0 : 1;
    const pocket: Pocket = { id: w.nextId++, team, nodes: loop.map((n) => ({ ...n, v: 0 })) };
    w.pockets.push(pocket);
    const trapped = w.units.filter((u) => u.team === team && pointInRing(pocket.nodes, u.pos)).length;
    this.hooks.emit('cauldronFormed', { id: pocket.id, team, units: trapped, areaKm2: Math.round(Math.abs(area)) });
  }

  /** A cauldron squeezed too small (or emptied of defenders) collapses: whoever is still inside is lost. */
  private collapsePockets() {
    const w = this.world;
    const r = this.ruleset.rules;
    for (const pocket of [...w.pockets]) {
      const inside = w.units.filter((u) => u.team === pocket.team && this.defs.u.get(u.def)!.kind !== 'air' && pointInRing(pocket.nodes, u.pos));
      const holds = w.buildings.some((b) => b.team === pocket.team && pointInRing(pocket.nodes, b.pos));
      const area = Math.abs(ringAreaKm2(pocket.nodes));
      if (area >= r.pocketMinAreaKm2 && pocket.nodes.length >= 4 && (inside.length || holds)) continue;
      w.pockets = w.pockets.filter((p) => p !== pocket);
      for (const u of inside) u.hp = 0; // they surrender
      const victor = (1 - pocket.team) as Team;
      w.scores[victor] += inside.length * r.cauldronScore;
      this.hooks.emit('cauldronDestroyed', { id: pocket.id, team: pocket.team, units: inside.length });
    }
    if (w.units.some((u) => u.hp <= 0)) {
      const dead = w.units.filter((u) => u.hp <= 0);
      w.units = w.units.filter((u) => u.hp > 0);
      dead.forEach((u) => this.hooks.emit('unitKilled', { id: u.id, def: u.def, owner: u.owner }));
    }
  }

  private territory(dt: number) {
    const w = this.world;
    const r = this.ruleset.rules;
    this.map.capturePoints.forEach((cp, i) => {
      const side = this.side(cp.pos);
      if (w.points[i].owner !== side) {
        w.points[i].owner = side;
        this.hooks.emit('pointCaptured', { id: cp.id, team: side });
      }
      w.scores[side] += cp.value * r.pointScorePerSec * dt;
    });
    // anything the front rolled over is lost (checked a few buildings per tick to spread the cost)
    const lost: Building[] = [];
    for (let i = w.tick % 5; i < w.buildings.length; i += 5) {
      if (this.side(w.buildings[i].pos) !== w.buildings[i].team) lost.push(w.buildings[i]);
    }
    if (lost.length) {
      lost.forEach((b) => this.evict(b, 0.5));
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
