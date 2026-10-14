import type { Command, CommandResult } from './commands';
import type { BuildingDef, CapturePointDef, MapDef, RankDef, ResourceAmounts, Ruleset, TerrainDef, UnitDef } from './defs';
import { clamp, distKm, kmPerDegLng, moveToward, offsetKm, type LngLat } from './geo';
import { buildFront, distToFrontKm, normalAt, pocketCentroid, pocketRadiusKm, pointInPolygon, resample, resolveFrontLoops, sideOf, sideOfWithPockets } from './frontline';
import { RoadNetwork } from './roads';
import { TerrainGrid } from './terrain';
import { isAlabugaDroneZone, isKremenchukRefinery } from './specialZones';
import type { Building, CapturePoint, Player, Pocket, Shot, SlotInit, Team, Unit, Waypoint, World } from './state';

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
  readonly forbiddenRings: LngLat[][] = [];
  readonly cityPolys = new Map<string, LngLat[][]>();
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

    // Build foreign non-playable country borders (Belarus, Moldova, Western Europe)
    const rings: LngLat[][] = [];
    if (map.borders?.features) {
      const byName: Record<string, LngLat[]> = {};
      for (const f of map.borders.features) {
        if (f.properties?.type === 'border' && f.geometry?.coordinates) {
          byName[f.properties.name] = f.geometry.coordinates;
        }
      }
      if (byName['Ukraine — Belarus'] && byName['Belarus — Russia'] && byName['Poland — Belarus'] && byName['Lithuania — Belarus']) {
        rings.push([
          ...byName['Ukraine — Belarus'],
          ...byName['Belarus — Russia'].slice(1),
          [26.595, 55.667],
          ...[...byName['Lithuania — Belarus']].reverse().slice(1),
          ...[...byName['Poland — Belarus']].reverse().slice(1),
        ]);
      }
      if (byName['Ukraine — Moldova'] && byName['Moldova — Romania']) {
        rings.push([
          ...byName['Ukraine — Moldova'],
          ...[...byName['Moldova — Romania']].reverse().slice(1),
        ]);
      }
      if (byName['Ukraine — Poland'] && byName['Ukraine — Slovakia'] && byName['Ukraine — Hungary'] && byName['Ukraine — Romania']) {
        rings.push([
          [21.0, 52.0],
          ...[...byName['Ukraine — Poland']].reverse(),
          ...[...byName['Ukraine — Slovakia']].reverse().slice(1),
          ...byName['Ukraine — Hungary'].slice(1),
          ...byName['Ukraine — Romania'].slice(1),
          [26.618, 44.0],
          [21.0, 44.0],
        ]);
      }
    }
    this.forbiddenRings = rings;

    if (map.cities?.features) {
      for (const f of map.cities.features) {
        const cityId = f.properties?.cityId;
        if (!cityId) continue;
        if (f.geometry?.type === 'Polygon') {
          const poly = f.geometry.coordinates?.[0] as LngLat[];
          if (poly) {
            const list = this.cityPolys.get(cityId) ?? [];
            list.push(poly);
            this.cityPolys.set(cityId, list);
          }
        } else if (f.geometry?.type === 'MultiPolygon') {
          for (const polyCoords of f.geometry.coordinates) {
            const poly = polyCoords?.[0] as LngLat[];
            if (poly) {
              const list = this.cityPolys.get(cityId) ?? [];
              list.push(poly);
              this.cityPolys.set(cityId, list);
            }
          }
        }
      }
    }

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
      points: this.map.capturePoints.map((p) => {
        const val = Math.max(1, Math.min(5, p.value ?? 1));
        const maxHp = 8000 + (val - 1) * 3000;
        return { id: p.id, owner: 0 as Team, hp: maxHp, maxHp, lastDamagedTime: -100 };
      }),
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

  allowedStorageResources(d: BuildingDef): string[] {
    if (d.id === 'gas_station') return ['fuel'];
    if (d.id === 'oil_refinery') return ['fuel'];
    if (d.id === 'mine') return ['ore'];
    if (d.id === 'warehouse') return ['metal', 'fuel', 'ore'];

    const res = new Set<string>();
    if (d.produces) {
      for (const k of Object.keys(d.produces)) {
        if (k !== 'money' && k !== 'people' && k !== 'energy') res.add(k);
      }
    }
    if (d.consumes) {
      for (const k of Object.keys(d.consumes)) {
        if (k !== 'money' && k !== 'people' && k !== 'energy') res.add(k);
      }
    }
    if (d.trains) {
      for (const uid of d.trains) {
        const u = this.defs.u.get(uid);
        if (u?.cost) {
          for (const k of Object.keys(u.cost)) {
            if (k !== 'money' && k !== 'people' && k !== 'energy') res.add(k);
          }
        }
      }
    }
    return [...res];
  }

  private spawnBuilding(def: string, p: Player, pos: LngLat, done = false): Building {
    const d = this.defs.b.get(def)!;
    const road = this.roads?.isNear(pos, this.ruleset.rules.roadAccessKm) ?? false;
    const allowed = this.allowedStorageResources(d);
    let storage: Record<string, number> | undefined;
    if (allowed.length > 0) {
      storage = {};
      for (const k of allowed) {
        if (k === 'fuel' && d.id === 'gas_station') storage[k] = 500;
        else if (k === 'ore' && d.id === 'metalworks') storage[k] = 0;
        else storage[k] = 500;
      }
    }
    const b: Building = { id: this.world.nextId++, def, owner: p.id, team: p.team, pos, hp: d.hp, progress: done ? 1 : 0, road, storage };
    this.world.buildings.push(b);
    return b;
  }

  spawnUnit(def: string, p: Player, pos: LngLat): Unit {
    const d = this.defs.u.get(def)!;
    const isDrone = def === 'drone' || d.kind === 'air';
    const isVehicle = !isDrone && (d.mobility !== 'foot' || !!d.maxFuel);
    const isInfantry = d.kind === 'ground' && d.mobility === 'foot' && !d.maxFuel;
    const maxFuel = isDrone ? (d.maxFuel ?? 100) : (d.maxFuel ?? (isVehicle ? 100 : undefined));
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
      stamina: isInfantry ? 100 : undefined,
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

  isPlayableGround(p: LngLat, onRoad = false): boolean {
    if (!onRoad && this.terrainAt(p).id === 'water') return false;
    for (const ring of this.forbiddenRings) {
      if (pointInPolygon(p, ring)) return false;
    }
    return true;
  }

  isPosInCity(pos: LngLat, cp: { id: string; pos: LngLat; value?: number }): boolean {
    const val = Math.max(1, Math.min(5, cp.value ?? 1));
    const rKm = val === 5 ? 12 : val === 4 ? 8 : val === 3 ? 5 : val === 2 ? 3.5 : 2.5;
    // Fast degree check before calculating distKm
    if (Math.abs(pos[1] - cp.pos[1]) > 0.15) return false;
    const d = distKm(pos, cp.pos);
    if (d > rKm * 1.5) return false;
    const polys = this.cityPolys.get(cp.id);
    if (polys) {
      for (const p of polys) {
        if (pointInPolygon(pos, p)) return true;
      }
    }
    return d <= rKm;
  }

  cityDefenseBonus(team: Team, pos: LngLat): number {
    let maxBonus = 0;
    for (const cp of this.map.capturePoints) {
      const pt = this.world.points.find((p) => p.id === cp.id);
      if (!pt || pt.owner !== team) continue;
      if (Math.abs(pos[1] - cp.pos[1]) > 0.22) continue;
      const d = distKm(pos, cp.pos);
      if (d <= 20) {
        const bonus = d <= 10 ? 0.5 : 0.5 - 0.4 * ((d - 10) / 10);
        if (bonus > maxBonus) maxBonus = bonus;
      }
    }
    return maxBonus;
  }

  /** Off-road speed multiplier for a unit type at a position. */
  terrainSpeed(d: UnitDef, p: LngLat): number {
    if (d.kind === 'air') return 1;
    if (!this.isPlayableGround(p, false)) return 0;
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
        if (ud.side && ud.side !== (p.team === 0 ? 'ua' : 'ru')) return fail('cannot train enemy unit');
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
        this.orderMove(w.units.filter((u) => set.has(u.id) && u.owner === p.id), cmd.to, !!cmd.cohesion, !!cmd.append);
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
            if (cmd.active && u.stamina !== undefined && u.stamina <= 0) continue;
            if (cmd.active && u.fuel !== undefined && u.fuel <= 0) continue;
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
        const hasCargo = u.cargo && Object.values(u.cargo.res).some((v) => v > 0);
        if (hasCargo) {
          u.route = { fromBuilding: b1.id, toBuilding: b2.id, resType: cmd.resType, state: 'to_to' };
          this.orderMove([u], b2.pos, false);
        } else {
          u.route = { fromBuilding: b1.id, toBuilding: b2.id, resType: cmd.resType, state: 'to_from' };
          this.orderMove([u], b1.pos, false);
        }
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
      case 'bombard': {
        const set = new Set(cmd.units);
        for (const u of w.units) {
          if (!set.has(u.id) || u.owner !== p.id) continue;
          const d = this.defs.u.get(u.def)!;
          if (d.symbol === 'artillery' || d.minRange) {
            u.bombardTarget = cmd.target;
            if (cmd.target) {
              u.path = [];
              u.target = null;
            }
          }
        }
        return ok();
      }
    }
  }

  /** Plan routes: ground units take roads when that is quicker, then spread out around the destination. */
  private orderMove(units: Unit[], to: LngLat, cohesion: boolean, append = false) {
    if (!units.length) return;
    const ground = units.filter((u) => this.defs.u.get(u.def)!.kind !== 'air');
    if (ground.length) {
      const nearRoad = this.roads?.isNear(to, 2) ?? false;
      if (!this.isPlayableGround(to, nearRoad)) {
        return; // Ground units cannot enter water or foreign non-playable countries
      }
    }
    const mult = this.ruleset.rules.roadSpeedMult;
    const cap = cohesion ? Math.min(...units.map((u) => this.defs.u.get(u.def)!.speed)) : 0;
    let shared: LngLat[] = [];
    let centre: LngLat = to;
    if (ground.length && this.roads && !append) {
      centre = [ground.reduce((a, u) => a + u.pos[0], 0) / ground.length, ground.reduce((a, u) => a + u.pos[1], 0) / ground.length];
      shared = this.roads.route(centre, to, mult);
    }
    let own = 0;
    units.forEach((u, i) => {
      const d = this.defs.u.get(u.def)!;
      u.bombardTarget = undefined; // clear manual bombard target on move
      if (d.droneType === 'strike') {
        const leg: Waypoint = { p: to, road: false };
        if (append && u.path.length) {
          u.path.push(leg);
        } else {
          u.path = [leg];
        }
        u.target = to;
        u.cap = 0;
        u.loiterCenter = undefined;
        u.loiterRadius = undefined;
        u.loiterAngle = undefined;
        u.isLoitering = false;
        return;
      }
      if (d.droneType === 'recon') {
        const leg: Waypoint = { p: to, road: false };
        if (append && u.path.length) {
          u.path.push(leg);
        } else {
          u.path = [leg];
        }
        u.target = u.path[0].p;
        u.cap = 0;
        u.loiterCenter = to;
        u.loiterRadius = 4.0;
        u.loiterAngle = undefined;
        u.isLoitering = false; // navigation mode until arrival!
        return;
      }
      if (d.symbol === 'artillery' || d.minRange) {
        // Artillery must NEVER cross or be ordered across the frontline
        const distFront = distToFrontKm(this.world.front, to) * (u.team === 0 ? 1 : -1);
        if (distFront < 0.5) {
          return; // reject ordering artillery across the frontline
        }
      }
      u.loiterCenter = undefined;
      u.loiterRadius = undefined;
      u.loiterAngle = undefined;
      u.isLoitering = false;
      const ring = Math.ceil(Math.sqrt(i));
      const dest: LngLat = [to[0] + 0.012 * ring * Math.cos(i * 2.4), to[1] + 0.009 * ring * Math.sin(i * 2.4)];
      const startPos = append && u.path.length ? u.path[u.path.length - 1].p : u.pos;
      let road: LngLat[] = [];
      if (d.kind !== 'air' && this.roads) {
        if (!append && distKm(u.pos, centre) <= 20) {
          road = shared;
        } else {
          road = this.roads.route(startPos, dest, mult);
        }
      }
      let legWaypoints: Waypoint[] = road.map((p, k) => ({ p, road: k > 0 }));
      legWaypoints.push({ p: dest, road: false });

      if (d.symbol === 'artillery' || d.minRange) {
        // Truncate route if any waypoint gets too close to frontline
        const safeWaypoints: Waypoint[] = [];
        for (const wp of legWaypoints) {
          const df = distToFrontKm(this.world.front, wp.p) * (u.team === 0 ? 1 : -1);
          if (df < 0.5) break;
          safeWaypoints.push(wp);
        }
        if (!safeWaypoints.length) return;
        legWaypoints = safeWaypoints;
      }

      if (append && u.path.length) {
        u.path.push(...legWaypoints);
      } else {
        u.path = legWaypoints;
      }
      u.target = u.path[0].p;
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
    this.repairs(dt);
    this.frontline(dt);
    this.territory(dt);
    this.checkVictory();

    if (w.smokes?.length) {
      w.smokes = w.smokes.filter((s) => s.expiresAt > w.time);
    }

    if (Math.floor(w.time) !== prevSec) this.hooks.emit('tick', { time: Math.floor(w.time) });
    if (r.matchSeconds > 0 && w.time >= r.matchSeconds && w.winner === null) {
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
    let powerBoost = 1.0;
    for (const o of this.world.buildings) {
      if (o.team !== b.team || o.progress < 1 || o === b) continue;
      if (o.def === 'power_plant' && distKm(o.pos, b.pos) <= 100) {
        powerBoost = 1.25;
      }
      const a = this.defs.b.get(o.def)!.aura;
      if (a && o.def !== 'power_plant' && distKm(o.pos, b.pos) <= a.radiusKm) m *= a.outputMult;
    }
    m *= powerBoost;

    // Special zone bonus: Kremenchuk Oil Refinery gives 1.5x fuel production
    if (b.def === 'oil_refinery' && isKremenchukRefinery(b.pos)) {
      m *= 1.5;
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
          if (k === 'energy') continue;
          if ((b.storage[k] ?? 0) < v * dt) {
            can = false;
            break;
          }
        }
        if (!can) continue;
        for (const [k, v] of Object.entries(d.consumes ?? {})) {
          if (k === 'energy') continue;
          const need = v * dt;
          b.storage[k] = Math.max(0, (b.storage[k] ?? 0) - need);
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
      let speed = 1.0;
      if (w.buildings.some((o) => o.team === b.team && o.progress >= 1 && o.def === 'power_plant' && distKm(o.pos, b.pos) <= 100)) {
        speed *= 1.25;
      }
      if (b.def === 'drone_factory' && isAlabugaDroneZone(b.pos)) {
        speed *= 1.5;
      }
      q.remaining -= dt * speed;
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

      // Stamina update (foot infantry only)
      if (u.stamina !== undefined) {
        if (u.sprint) {
          if (u.path.length > 0) {
            u.stamina = Math.max(0, u.stamina - (100 / 60) * dt);
            if (u.stamina <= 0) u.sprint = false;
          }
        } else {
          u.stamina = Math.min(100, u.stamina + (100 / 180) * dt);
        }
      } else {
        // Vehicles have no stamina: sprint consumes 1.5x fuel and remains active until toggled off or out of fuel
        if (u.sprint && u.fuel !== undefined && u.fuel <= 0) {
          u.sprint = false;
        }
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
              u.route.state = 'loading';
              u.route.timer = 5.0; // 5 seconds loading duration
              u.path = [];
            }
          } else if (u.route.state === 'loading') {
            u.route.timer = (u.route.timer ?? 5.0) - dt;
            if (u.route.timer <= 0) {
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
                  // Non-fuel trucks: CANNOT take fuel under any circumstances! Only fuel_truck can carry fuel.
                  let allowedKeys: string[];
                  if (u.route.resType && u.route.resType !== 'any') {
                    allowedKeys = [u.route.resType];
                  } else {
                    // Prioritize resource produced by fromB if available, otherwise non-fuel goods
                    const bDef = this.defs.b.get(fromB.def);
                    const prodKey = bDef?.produces ? Object.keys(bDef.produces)[0] : null;
                    if (prodKey && prodKey !== 'fuel' && (fromB.storage[prodKey] ?? 0) > 0) {
                      allowedKeys = [prodKey];
                    } else {
                      allowedKeys = ['ore', 'metal', 'ammo'];
                    }
                  }
                  for (const k of allowedKeys) {
                    if (k === 'fuel') continue; // Strict safety: normal trucks CANNOT take fuel
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
              u.route.timer = undefined;
              this.orderMove([u], toB.pos, false);
            }
          } else if (u.route.state === 'to_to') {
            if (dTo <= 3.5 || !u.path.length) {
              u.route.state = 'unloading';
              u.route.timer = 4.0; // 4 seconds unloading duration
              u.path = [];
            }
          } else if (u.route.state === 'unloading') {
            u.route.timer = (u.route.timer ?? 4.0) - dt;
            if (u.route.timer <= 0) {
              if (!toB.storage) toB.storage = {};
              const cap = toB.def === 'gas_station' ? 20000 : 30000;
              const toDef = this.defs.b.get(toB.def)!;
              const allowed = this.allowedStorageResources(toDef);
              if (u.cargo.res) {
                for (const [k, v] of Object.entries(u.cargo.res)) {
                  if (allowed.length === 0 || allowed.includes(k)) {
                    toB.storage[k] = Math.min(cap, (toB.storage[k] ?? 0) + v);
                  }
                }
                u.cargo.res = {};
              }
              u.route.state = 'to_from';
              u.route.timer = undefined;
              this.orderMove([u], fromB.pos, false);
            }
          }
        }
      }

      // Fire modes: 'hold' does not fire; 'return' fires only if damaged recently; 'auto' fires freely
      const canFire = u.fireMode !== 'hold' && (u.fireMode !== 'return' || u.hp < this.maxHp(u) - 0.5);

      const minR = (d.minRange ?? 0) * rank.range;
      let handledBombard = false;
      if (canFire && u.bombardTarget && (d.symbol === 'artillery' || d.minRange)) {
        const distToBombard = distKm(u.pos, u.bombardTarget);
        if (distToBombard >= minR && distToBombard <= range) {
          handledBombard = true;
          if (u.cooldown === 0) {
            u.cooldown = 2.0; // artillery bombardment salvo cadence
            const base = d.damage * rank.damage;
            const scatterAng = Math.random() * Math.PI * 2;
            const scatterDist = Math.random() * 0.4;
            const impactPos = offsetKm(u.bombardTarget, scatterDist * Math.cos(scatterAng), scatterDist * Math.sin(scatterAng));
            this.shots.push({ def: u.def, team: u.team, from: u.pos, to: impactPos });

            // Blast radius 1.0 km
            const blastRadius = 1.0;
            let dealtTotal = 0;
            for (const eu of w.units) {
              if (eu.team !== u.team && !eu.embarkedIn && eu.hp > 0) {
                const ed = this.defs.u.get(eu.def)!;
                if (ed.kind === 'air') continue; // Artillery shells hit ground, cannot damage airborne drones
                const du = distKm(impactPos, eu.pos);
                if (du <= blastRadius) {
                  const cover = this.terrainAt(eu.pos).cover;
                  const cityDef = this.cityDefenseBonus(eu.team, eu.pos);
                  const dealt = (base * (1 - du / blastRadius) * (1 - cover) * (1 - cityDef)) / this.holdMult(eu.team, eu.pos);
                  eu.hp -= dealt;
                  dealtTotal += dealt;
                  if (eu.hp <= 0) u.xp += r.xpPerKill;
                }
              }
            }
            for (const eb of w.buildings) {
              if (eb.team !== u.team && eb.hp > 0) {
                const db = distKm(impactPos, eb.pos);
                if (db <= blastRadius) {
                  const dealt = (base * 0.8 * (1 - db / blastRadius)) / this.holdMult(eb.team, eb.pos);
                  eb.hp -= dealt;
                  eb.lastDamagedTime = this.world.time;
                  dealtTotal += dealt;
                }
              }
            }
            u.xp += dealtTotal * r.xpPerDamage;
            this.rankUp(u);
          }
        }
      }

      let tu: Unit | null = null;
      let tb: Building | null = null;
      if (canFire && !handledBombard) {
        let best = range;
        for (const e of w.units) {
          if (e.team === u.team || e.hp <= 0 || e.embarkedIn) continue;
          const ed = this.defs.u.get(e.def)!;
          if (ed.kind === 'air' && !d.antiAir) continue; // Tanks, infantry, artillery cannot target or shoot down drones!
          const dist = distKm(u.pos, e.pos);
          if (dist >= minR && dist <= best) (best = dist), (tu = e);
        }
        if (!tu) {
          for (const e of w.buildings) {
            if (e.team === u.team || e.hp <= 0) continue;
            const dist = distKm(u.pos, e.pos);
            if (dist >= minR && dist <= best) (best = dist), (tb = e);
          }
        }
      }

      if ((tu || tb) && u.cooldown === 0) {
        u.cooldown = d.symbol === 'artillery' ? 2.0 : 1; // one salvo per second (artillery 2.0s)
        const base = d.damage * rank.damage;
        let dealt: number;
        if (tu) {
          const cover = this.defs.u.get(tu.def)!.kind === 'air' ? 0 : this.terrainAt(tu.pos).cover;
          const cityDef = this.cityDefenseBonus(tu.team, tu.pos);
          dealt = (base * (1 - cover) * (1 - cityDef)) / this.holdMult(tu.team, tu.pos);
          tu.hp -= dealt;
          this.shots.push({ def: u.def, team: u.team, from: u.pos, to: tu.pos });
          if (tu.hp <= 0) u.xp += r.xpPerKill;
        } else {
          dealt = base / this.holdMult(tb!.team, tb!.pos);
          tb!.hp -= dealt;
          tb!.lastDamagedTime = this.world.time;
          this.shots.push({ def: u.def, team: u.team, from: u.pos, to: tb!.pos });
        }
        u.xp += dealt * r.xpPerDamage;
        this.rankUp(u);
      }

      // movement: explicit orders follow their route; idle units close with enemies they can see
      if (u.path.length) {
        this.advance(u, d, dt);
      } else if (d.droneType === 'recon' && u.loiterCenter) {
        this.advance(u, d, dt);
      } else if (d.kind !== 'air' && !tu && !tb && canFire && !u.route && !handledBombard) {
        if (d.symbol === 'artillery' || d.minRange) {
          continue; // Artillery never wanders off to chase enemies in idle
        }
        let chase: LngLat | null = null;
        let near = d.vision * 0.7;
        for (const e of w.units) {
          if (e.team === u.team || e.embarkedIn) continue;
          const dist = distKm(u.pos, e.pos);
          if (dist < near) (near = dist), (chase = e.pos);
        }
        if (chase && this.isPlayableGround(chase, false)) {
          const nextPos = moveToward(u.pos, chase, d.speed * this.terrainSpeed(d, u.pos) * dt);
          if (this.isPlayableGround(nextPos, false)) u.pos = nextPos;
        }
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
    if (d.droneType === 'recon' && u.loiterCenter && !u.isLoitering && !u.path.length) {
      // Reached destination: establish circular orbit route of radius 4.0 km
      u.isLoitering = true;
      const rKm = u.loiterRadius ?? 4.0;
      const startAng = (u.bearing !== undefined ? u.bearing : 0) * (Math.PI / 180);
      const numPts = 32;
      const orbit: Waypoint[] = [];
      for (let i = 1; i <= numPts; i++) {
        const ang = startAng + (i / numPts) * (Math.PI * 2);
        const wpPos = offsetKm(u.loiterCenter, rKm * Math.cos(ang), rKm * Math.sin(ang));
        orbit.push({ p: wpPos, road: false });
      }
      u.path = orbit;
      u.target = orbit[0].p;
    }
    const sprintMult = u.sprint && u.def !== 'drone' ? 2.0 : 1.0;
    const base = (u.cap ? Math.min(d.speed, u.cap) : d.speed) * sprintMult;
    const roadMult = d.kind === 'air' ? 1 : this.ruleset.rules.roadSpeedMult;
    let budget = dt;
    let totalMovedKm = 0;
    for (let guard = 0; budget > 1e-6 && u.path.length && guard < 32; guard++) {
      const wp = u.path[0];
      const speed = base * (wp.road ? roadMult : this.terrainSpeed(d, u.pos));
      if (speed <= 0) {
        u.path = [];
        u.target = null;
        break;
      }
      const dist = distKm(u.pos, wp.p);
      const nextPos: LngLat = speed * budget >= dist ? [wp.p[0], wp.p[1]] : moveToward(u.pos, wp.p, speed * budget);
      if (d.kind !== 'air' && !this.isPlayableGround(nextPos, wp.road)) {
        u.path = [];
        u.target = null;
        break;
      }
      if (d.symbol === 'artillery' || d.minRange) {
        // Artillery must NEVER cross the frontline
        const distFront = distToFrontKm(this.world.front, nextPos) * (u.team === 0 ? 1 : -1);
        if (distFront < 0.5) {
          u.path = [];
          u.target = null;
          break;
        }
      }
      const dx = (nextPos[0] - u.pos[0]) * kmPerDegLng(u.pos[1]);
      const dy = (nextPos[1] - u.pos[1]) * 111.32;
      if (Math.abs(dx) + Math.abs(dy) > 1e-6) {
        u.bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
      }
      if (speed * budget >= dist) {
        totalMovedKm += dist;
        u.pos = nextPos;
        budget -= dist / speed;
        const reachedWp = u.path.shift()!;
        if (d.droneType === 'recon' && u.isLoitering) {
          // Endless circular orbit: cycle reached waypoint to end of path
          u.path.push(reachedWp);
        }
        if (d.droneType === 'recon' && u.loiterCenter && !u.isLoitering && !u.path.length) {
          // Reached loiter center: start circular orbit!
          u.isLoitering = true;
          const rKm = u.loiterRadius ?? 4.0;
          const startAng = (u.bearing !== undefined ? u.bearing : 0) * (Math.PI / 180);
          const numPts = 32;
          const orbit: Waypoint[] = [];
          for (let i = 1; i <= numPts; i++) {
            const ang = startAng + (i / numPts) * (Math.PI * 2);
            const wpPos = offsetKm(u.loiterCenter, rKm * Math.cos(ang), rKm * Math.sin(ang));
            orbit.push({ p: wpPos, road: false });
          }
          u.path = orbit;
          u.target = orbit[0].p;
        } else if (u.path.length > 0) {
          u.target = u.path[0].p;
        }
      } else {
        const moved = speed * budget;
        totalMovedKm += moved;
        u.pos = nextPos;
        budget = 0;
      }
    }
    if (u.fuel !== undefined && totalMovedKm > 0) {
      const fuelBurnRate = (d.kind === 'air' ? 0.08 : 0.04) * (u.sprint ? 1.5 : 1.0);
      u.fuel = Math.max(0, u.fuel - totalMovedKm * fuelBurnRate);
      if (u.fuel <= 0) {
        if (d.kind === 'air') u.hp = 0;
        if (u.sprint) u.sprint = false;
      }
    }
    if (!u.path.length) {
      if (d.droneType === 'strike') {
        const blastRadius = d.id === 'drone_fire_point' ? 1.2 : 1.8;
        const damage = d.damage || 320;
        let totalDealt = 0;
        for (const eu of this.world.units) {
          if (eu.team !== u.team && !eu.embarkedIn) {
            const dist = distKm(u.pos, eu.pos);
            if (dist <= blastRadius) {
              const cityDef = this.cityDefenseBonus(eu.team, eu.pos);
              const dealt = damage * (1 - dist / blastRadius) * (1 - cityDef);
              eu.hp -= dealt;
              totalDealt += dealt;
            }
          }
        }
        for (const eb of this.world.buildings) {
          if (eb.team !== u.team) {
            const dist = distKm(u.pos, eb.pos);
            if (dist <= blastRadius) {
              const dealt = (damage * (1 - dist / blastRadius)) / this.holdMult(eb.team, eb.pos);
              eb.hp -= dealt;
              eb.lastDamagedTime = this.world.time;
              totalDealt += dealt;
            }
          }
        }
        for (const cp of this.map.capturePoints) {
          const pt = this.world.points.find((p) => p.id === cp.id);
          if (pt && pt.owner !== u.team && this.isPosInCity(u.pos, cp)) {
            const cityDamage = Math.round(damage / 3);
            pt.hp = Math.max(0, (pt.hp ?? pt.maxHp ?? 8000) - cityDamage);
            pt.lastDamagedTime = this.world.time;
            totalDealt += cityDamage;
          }
        }
        u.xp += totalDealt * this.ruleset.rules.xpPerDamage;
        this.shots.push({ def: u.def, team: u.team, from: u.pos, to: u.pos });
        if (!this.world.smokes) this.world.smokes = [];
        this.world.smokes.push({
          id: this.world.nextId++,
          pos: [u.pos[0], u.pos[1]],
          createdAt: this.world.time,
          expiresAt: this.world.time + 600,
        });
        u.hp = 0;
        u.target = null;
        u.cap = 0;
        return;
      }
      if (d.droneType === 'recon' && u.loiterCenter) {
        return;
      }
      (u.target = null), (u.cap = 0);
    }
  }

  private repairs(dt: number) {
    const w = this.world;
    const rescuers = w.units.filter((u) => u.def === 'rescuers' && u.hp > 0 && !u.embarkedIn);
    if (!rescuers.length) return;

    // Pre-filter damaged friendly cities off cooldown (most ticks this is empty!)
    const damagedCities: { cp: CapturePointDef; pt: CapturePoint }[] = [];
    for (const cp of this.map.capturePoints) {
      const pt = w.points.find((p) => p.id === cp.id);
      if (!pt) continue;
      const maxHp = pt.maxHp ?? (8000 + (Math.max(1, Math.min(5, cp.value ?? 1)) - 1) * 3000);
      if ((pt.hp ?? maxHp) < maxHp && w.time - (pt.lastDamagedTime ?? -100) >= 60) {
        damagedCities.push({ cp, pt });
      }
    }

    // Pre-filter damaged friendly buildings off cooldown
    const damagedBuildings: Building[] = [];
    for (const b of w.buildings) {
      if (b.progress < 1) continue;
      const bDef = this.defs.b.get(b.def);
      if (bDef && b.hp < bDef.hp && w.time - (b.lastDamagedTime ?? -100) >= 60) {
        damagedBuildings.push(b);
      }
    }

    if (!damagedCities.length && !damagedBuildings.length) return;

    const cityAssignments = new Map<string, number>();
    const buildingAssignments = new Map<number, number>();

    for (const u of rescuers) {
      let bestTarget: { type: 'city'; id: string; dist: number } | { type: 'building'; id: number; dist: number } | null = null;

      for (const { cp, pt } of damagedCities) {
        if (pt.owner !== u.team) continue;
        if (this.isPosInCity(u.pos, cp)) {
          const d = distKm(u.pos, cp.pos);
          if (!bestTarget || d < bestTarget.dist) {
            bestTarget = { type: 'city', id: cp.id, dist: d };
          }
        }
      }

      for (const b of damagedBuildings) {
        if (b.team !== u.team) continue;
        if (Math.abs(u.pos[1] - b.pos[1]) > 0.03) continue;
        const d = distKm(u.pos, b.pos);
        if (d <= 2.0) {
          if (!bestTarget || d < bestTarget.dist) {
            bestTarget = { type: 'building', id: b.id, dist: d };
          }
        }
      }

      if (bestTarget) {
        if (bestTarget.type === 'city') {
          cityAssignments.set(bestTarget.id, (cityAssignments.get(bestTarget.id) ?? 0) + 1);
        } else {
          buildingAssignments.set(bestTarget.id, (buildingAssignments.get(bestTarget.id) ?? 0) + 1);
        }
      }
    }

    // Apply repairs: 1 HP/s per rescuer, max 10 HP/s
    for (const [cityId, count] of cityAssignments) {
      const pt = w.points.find((p) => p.id === cityId);
      if (!pt) continue;
      const cp = this.map.capturePoints.find((p) => p.id === cityId);
      const maxHp = pt.maxHp ?? (8000 + (Math.max(1, Math.min(5, cp?.value ?? 1)) - 1) * 3000);
      const repairRate = Math.min(10, count);
      pt.hp = Math.min(maxHp, (pt.hp ?? maxHp) + repairRate * dt);
    }

    for (const [bId, count] of buildingAssignments) {
      const b = w.buildings.find((x) => x.id === bId);
      if (!b) continue;
      const bDef = this.defs.b.get(b.def);
      if (!bDef) continue;
      const repairRate = Math.min(10, count);
      b.hp = Math.min(bDef.hp, b.hp + repairRate * dt);
    }
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
        if (ud.kind === 'air' || ud.droneType === 'strike') continue;
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
