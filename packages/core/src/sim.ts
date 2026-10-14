import type { Command, CommandResult } from './commands';
import type { BuildingDef, MapDef, RankDef, ResourceAmounts, Ruleset, TerrainDef, UnitDef } from './defs';
import { clamp, distKm, kmPerDegLng, moveToward, offsetKm, type LngLat } from './geo';
import { buildFront, distToFrontKm, findPinch, normalOf, pocketAt, pointInRing, respace, ringAreaKm2, sideOf } from './frontline';
import { RoadNetwork } from './roads';
import { TerrainGrid } from './terrain';
import { specialZoneAt } from './specialZones';
import type { Building, FrontNode, Player, Pocket, Shot, SlotInit, Team, Unit, UnitStatus, Waypoint, World } from './state';
import type { CapturePointDef } from './defs';

export interface Hooks {
  emit(event: string, data: Record<string, unknown>): void;
}
const NO_HOOKS: Hooks = { emit() {} };
interface MapCache {
  roads: RoadNetwork | null;
  terrain: TerrainGrid | null;
  /** Neighbouring countries nobody fights in (Belarus, Moldova, the EU): ground units may not enter. */
  forbidden: LngLat[][];
  /** City boundaries per capture point id. */
  cities: Map<string, LngLat[][]>;
}
const MAP_CACHE = new WeakMap<MapDef, MapCache>();

export const isReconDrone = (d: UnitDef | undefined) => !!d && d.kind === 'air' && d.droneType !== 'strike';
export const isStrikeDrone = (d: UnitDef | undefined) => !!d && d.droneType === 'strike';
/** Point in polygon for plain [lng, lat] rings. */
export function inPolygon(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Rings for the non-playable neighbours, stitched from the map's border lines. */
function forbiddenRings(map: MapDef): LngLat[][] {
  const byName: Record<string, LngLat[]> = {};
  for (const f of map.borders?.features ?? []) if (f.properties?.type === 'border' && f.geometry?.coordinates) byName[f.properties.name] = f.geometry.coordinates;
  const rings: LngLat[][] = [];
  const has = (...n: string[]) => n.every((x) => byName[x]);
  if (has('Ukraine — Belarus', 'Belarus — Russia', 'Poland — Belarus', 'Lithuania — Belarus')) {
    rings.push([...byName['Ukraine — Belarus'], ...byName['Belarus — Russia'].slice(1), [26.595, 55.667], ...[...byName['Lithuania — Belarus']].reverse().slice(1), ...[...byName['Poland — Belarus']].reverse().slice(1)]);
  }
  if (has('Ukraine — Moldova', 'Moldova — Romania')) rings.push([...byName['Ukraine — Moldova'], ...[...byName['Moldova — Romania']].reverse().slice(1)]);
  if (has('Ukraine — Poland', 'Ukraine — Slovakia', 'Ukraine — Hungary', 'Ukraine — Romania')) {
    rings.push([[21.0, 52.0], ...[...byName['Ukraine — Poland']].reverse(), ...[...byName['Ukraine — Slovakia']].reverse().slice(1), ...byName['Ukraine — Hungary'].slice(1), ...byName['Ukraine — Romania'].slice(1), [26.618, 44.0], [21.0, 44.0]]);
  }
  return rings;
}

function cityBoundaries(map: MapDef): Map<string, LngLat[][]> {
  const out = new Map<string, LngLat[][]>();
  const add = (id: string, ring: LngLat[] | undefined) => ring && ring.length >= 3 && out.set(id, [...(out.get(id) ?? []), ring]);
  for (const f of map.cities?.features ?? []) {
    const id = f.properties?.cityId ?? f.properties?.id;
    if (!id) continue;
    if (f.geometry?.type === 'Polygon') add(id, f.geometry.coordinates?.[0]);
    else if (f.geometry?.type === 'MultiPolygon') for (const poly of f.geometry.coordinates) add(id, poly?.[0]);
  }
  return out;
}
const NO_RANK: RankDef = { id: 'none', name: '', xp: 0, damage: 1, hp: 1, range: 1, cost: {} };
const OPEN_GROUND: TerrainDef = { id: 'open', name: 'Open', color: '#000', speed: {}, cover: 0, concealment: 1, frontResist: 0 };

export class Sim {
  readonly defs: { b: Map<string, BuildingDef>; u: Map<string, UnitDef>; t: Map<string, TerrainDef> };
  readonly map: MapDef;
  readonly roads: RoadNetwork | null;
  readonly terrain: TerrainGrid | null;
  readonly ranks: RankDef[];
  readonly forbidden: LngLat[][];
  readonly cities: Map<string, LngLat[][]>;
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
      shared = {
        roads: map.roads?.length ? new RoadNetwork(map.roads) : null,
        terrain: map.terrain ? new TerrainGrid(map.terrain, barriers) : null,
        forbidden: forbiddenRings(map),
        cities: cityBoundaries(map),
      };
      MAP_CACHE.set(map, shared);
    }
    this.roads = shared.roads;
    this.terrain = shared.terrain;
    this.forbidden = shared.forbidden;
    this.cities = shared.cities;
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
    const players: Player[] = slots.map((s) => ({ ...s, res: { ...startRes }, share: true }));
    const w: World = {
      tick: 0,
      time: 0,
      players,
      buildings: [],
      units: [],
      queue: [],
      front: buildFront(this.map.front, r.frontNodeSpacingKm),
      pockets: [],
      grey: [],
      // cities have structural health: strikes wear it down, rescuers repair it
      points: this.map.capturePoints.map((p) => {
        const maxHp = 8000 + (Math.max(1, Math.min(5, p.value ?? 1)) - 1) * 3000;
        return { id: p.id, owner: 0 as Team, hp: maxHp, maxHp, lastDamagedTime: -100 };
      }),
      scores: [0, 0],
      winner: null,
      winReason: null,
      nextId: 1,
      mapId: this.map.id,
      stats: Object.fromEntries(players.map((p) => [p.id, { kills: 0, losses: 0, buildingsBuilt: 0, buildingsDestroyed: 0, unitsTrained: 0, damage: 0 }])),
      smokes: [],
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
    const goods = this.storageFor(d);
    const stock = (k: string) => (this.ruleset.rules.sandbox ? this.storageCap({ def } as Building) : k === 'ore' && d.id === 'metalworks' ? 0 : this.ruleset.rules.startStorage);
    const storage = goods.length ? Object.fromEntries(goods.map((k) => [k, stock(k)])) : undefined;
    const b: Building = { id: this.world.nextId++, def, owner: p.id, team: p.team, pos, hp: d.hp, progress: done ? 1 : 0, road, cooldown: 0, level: 1, upgrade: null, inside: [], course: null, storage };
    this.world.buildings.push(b);
    return b;
  }

  spawnUnit(def: string, p: Player, pos: LngLat): Unit {
    const d = this.defs.u.get(def)!;
    pos = this.dry(d, pos);
    const recon = isReconDrone(d);
    const u: Unit = {
      id: this.world.nextId++, def, owner: p.id, team: p.team, pos, hp: d.hp * this.ranks[0].hp, target: null, cooldown: 0, xp: 0, rank: 0,
      transport: false, encircled: false, infil: 0, status: [], enter: 0, path: [], cap: 0,
      fireMode: 'auto',
      sprint: false,
      stamina: d.kind === 'ground' && (d.mobility ?? 'foot') === 'foot' && !d.maxFuel ? 100 : undefined,
      fuel: d.maxFuel,
      maxFuel: d.maxFuel,
      cargo: d.cargoCap ? { res: {}, cap: d.cargoCap, passengers: [], drones: d.droneCap ? [] : undefined } : undefined,
      // recon drones circle where they are until told otherwise
      loiterCenter: recon ? [pos[0], pos[1]] : undefined,
      loiterRadius: recon ? 4 : undefined,
      isLoitering: recon ? true : undefined,
    };
    this.world.units.push(u);
    return u;
  }

  /** Let a vehicle's passengers out beside it. */
  private unload(t: Unit) {
    for (const id of t.cargo?.passengers ?? []) {
      const u = this.world.units.find((x) => x.id === id);
      if (!u) continue;
      u.embarkedIn = undefined;
      u.pos = this.dry(this.defs.u.get(u.def)!, [t.pos[0] + 0.01, t.pos[1] + 0.01]);
      (u.path = []), (u.target = null);
    }
    if (t.cargo) t.cargo.passengers = [];
  }

  /** Closest place to refuel: airfields for recon drones; filling stations, fuel trucks or an HQ for vehicles. */
  private nearestFuel(u: Unit, air: boolean): LngLat | null {
    let best: LngLat | null = null;
    let bestD = Infinity;
    const take = (p: LngLat) => {
      const d = distKm(u.pos, p);
      if (d < bestD) (bestD = d), (best = p);
    };
    for (const b of this.world.buildings) {
      if (b.team !== u.team || b.progress < 1 || !this.usable(b, u.owner)) continue;
      if (air ? b.def === 'airfield' : b.def === 'gas_station' || b.def === 'hq') take(b.pos);
    }
    if (!air) for (const t of this.world.units) if (t !== u && t.owner === u.owner && this.defs.u.get(t.def)!.fuelOnly && (t.cargo?.res.fuel ?? 0) > 0) take(t.pos);
    return best;
  }

  /** Physical goods a building keeps on site: what it makes, what it uses, and what its trainees cost. */
  storageFor(d: BuildingDef): string[] {
    const fixed: Record<string, string[]> = { gas_station: ['fuel'], oil_refinery: ['fuel'], airfield: ['fuel'], mine: ['ore'], warehouse: ['metal', 'fuel', 'ore'] };
    if (fixed[d.id]) return fixed[d.id];
    const global = new Set(['money', 'people', 'energy']);
    const out = new Set<string>();
    for (const k of [...Object.keys(d.produces ?? {}), ...Object.keys(d.consumes ?? {})]) if (!global.has(k)) out.add(k);
    for (const uid of d.trains ?? []) for (const k of Object.keys(this.defs.u.get(uid)?.cost ?? {})) if (!global.has(k)) out.add(k);
    return [...out];
  }

  storageCap(b: Building): number {
    return this.defs.b.get(b.def)!.storageCap ?? this.ruleset.rules.storageCap;
  }

  /** Ground units cannot leave the theatre (neighbouring countries) or walk on water off a road. */
  isPlayableGround(p: LngLat, onRoad = false): boolean {
    if (!onRoad && this.terrain?.isBarrier(p)) return false;
    return !this.foreign(p);
  }

  /** The city (capture point) whose boundary contains this position. */
  cityAt(p: LngLat): CapturePointDef | null {
    for (const cp of this.map.capturePoints) if (this.inCity(p, cp)) return cp;
    return null;
  }

  inCity(p: LngLat, cp: CapturePointDef): boolean {
    const polys = this.cities.get(cp.id);
    if (polys?.length) {
      if (Math.abs(p[1] - cp.pos[1]) > 0.5) return false;
      return polys.some((r) => inPolygon(p, r));
    }
    const v = Math.max(1, Math.min(5, cp.value ?? 1));
    return distKm(p, cp.pos) <= [0, 2.5, 3.5, 5, 8, 12][v];
  }

  /** Defenders near one of their own cities take up to 50% less damage (full within 10 km, fading out by 20 km). */
  cityDefenseBonus(team: Team, pos: LngLat): number {
    let best = 0;
    this.map.capturePoints.forEach((cp, i) => {
      if (this.world.points[i].owner !== team || Math.abs(pos[1] - cp.pos[1]) > 0.22) return;
      const d = distKm(pos, cp.pos);
      if (d <= 20) best = Math.max(best, d <= 10 ? 0.5 : 0.5 - 0.4 * ((d - 10) / 10));
    });
    return best;
  }

  /** Is there a friendly power plant within grid range? */
  private plants: { tick: number; n: number; list: Building[] } = { tick: -1, n: -1, list: [] };
  onGrid(team: Team, pos: LngLat): boolean {
    const w = this.world;
    // refreshed once a second, or at once when a building appears or disappears
    if (this.plants.tick < 0 || w.tick - this.plants.tick >= 10 || this.plants.n !== w.buildings.length) {
      this.plants = { tick: w.tick, n: w.buildings.length, list: w.buildings.filter((o) => o.progress >= 1 && o.def === 'power_plant') };
    }
    const km = this.ruleset.rules.powerGridKm;
    return this.plants.list.some((o) => o.team === team && distKm(o.pos, pos) <= km);
  }

  /** Power lines along the roads from a power plant to what it feeds (or from a consumer back to its plant). */
  powerLines(team: Team, buildingId: number): LngLat[][] {
    const b = this.world.buildings.find((x) => x.id === buildingId && x.team === team && x.progress >= 1);
    if (!b) return [];
    const km = this.ruleset.rules.powerGridKm;
    const route = (a: LngLat, z: LngLat): LngLat[] => {
      const r = this.roads?.routeTimed(a, z, { roadSpeed: 1, offSpeed: 0.5, clear: () => true, accessKm: 35, k: 3 });
      return r ? [a, ...r.points, z] : [a, z];
    };
    if (b.def === 'power_plant') {
      return this.world.buildings
        .filter((o) => o.team === team && o.progress >= 1 && o.def !== 'power_plant' && distKm(o.pos, b.pos) <= km)
        .slice(0, 40)
        .map((o) => route(b.pos, o.pos));
    }
    let best: Building | null = null;
    for (const o of this.world.buildings) {
      if (o.team === team && o.progress >= 1 && o.def === 'power_plant' && distKm(o.pos, b.pos) <= km && (!best || distKm(o.pos, b.pos) < distKm(best.pos, b.pos))) best = o;
    }
    return best ? [route(best.pos, b.pos)] : [];
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
    return { perSecond: perTick * r.tickRate, seconds: (t.baseTime + t.timePerRank * top) * r.buildTimeMult, pupils };
  }

  /** A teammate's building can be used unless its owner has closed their buildings to the team. */
  usable(b: Building, playerId: string): boolean {
    return b.owner === playerId || this.player(b.owner)?.share !== false;
  }

  /** Seconds of ceasefire left (0 once the war is on). */
  peaceLeft(): number {
    return Math.max(0, this.ruleset.rules.peaceSeconds - this.world.time);
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
        if (!this.isPlayableGround(cmd.pos)) return fail('outside the theatre of war');
        // special zones: build there even behind the line, but only the side the zone belongs to
        const zone = specialZoneAt(cmd.pos);
        const mySide = p.team === 0 ? 'ua' : 'ru';
        if (zone && zone.side !== mySide) return fail(`${zone.name} is only available to ${zone.side === 'ua' ? 'Ukraine' : 'Russia'}`);
        if (!zone) {
          const pocket = w.pockets.length ? pocketAt(w.pockets, cmd.pos) : null;
          if (pocket) return fail(pocket.team === p.team ? 'this ground is encircled' : 'not your territory');
          if (w.grey.some((z) => distKm(z.pos, cmd.pos) <= z.r)) return fail('contested ground (grey zone)');
          const dist = distToFrontKm(w.front, cmd.pos) * (p.team === 0 ? 1 : -1);
          if (dist < 0) return fail('not your territory');
          if (d.id !== 'housing' && dist < r.minBuildDistanceFromFront * (d.category === 'civil' ? 2 : 1)) return fail('too close to the front');
        }
        if (this.terrainAt(cmd.pos).id === 'water') return fail('cannot build on water');
        if (d.needsWaterWithinKm && !this.barrierNear(cmd.pos, d.needsWaterWithinKm)) return fail('must be built on a river bank');
        if (d.id === 'housing') {
          // housing only inside a city your side holds, and only so many per city
          const city = this.cityAt(cmd.pos);
          if (!city) return fail('housing can only be built inside a city');
          if (w.points[this.map.capturePoints.indexOf(city)]?.owner !== p.team) return fail('your side must hold the city');
          if (w.buildings.filter((x) => x.def === 'housing' && this.inCity(x.pos, city)).length >= r.cityHousingLimit) return fail(`at most ${r.cityHousingLimit} housing blocks per city`);
          if (w.buildings.some((x) => x.def === 'housing' && distKm(x.pos, cmd.pos) < 0.08)) return fail('too close to another housing block');
        } else {
          // industry needs room (no other site within minBuildSpacing); field works only need their own patch
          const spacing = zone ? 0.5 : d.fieldWork ? r.fieldWorkSpacing : r.minBuildSpacing;
          const clash = w.buildings.some((x) => {
            if (x.def === 'housing') return false;
            const other = this.defs.b.get(x.def)!;
            const need = d.fieldWork || other.fieldWork ? r.fieldWorkSpacing : spacing;
            return distKm(x.pos, cmd.pos) < need;
          });
          if (clash) return fail(d.fieldWork ? 'space occupied' : `too close to another site (keep ${spacing} km apart)`);
        }
        if (!canAfford(p.res, d.cost)) return fail('not enough resources');
        pay(p.res, d.cost);
        this.spawnBuilding(d.id, p, cmd.pos);
        return ok();
      }
      case 'train': {
        // factories are shared by the whole team; the unit belongs to whoever ordered it
        const b = w.buildings.find((x) => x.id === cmd.building);
        if (!b || b.team !== p.team || b.progress < 1) return fail('building unavailable');
        if (!this.usable(b, p.id)) return fail(`${this.player(b.owner)?.name ?? 'Its owner'} keeps this building to themselves`);
        const bd = this.defs.b.get(b.def)!;
        const ud = this.defs.u.get(cmd.unit);
        if (!ud || !bd.trains?.includes(ud.id)) return fail('cannot train that here');
        if (ud.side && ud.side !== (p.team === 0 ? 'ua' : 'ru')) return fail('this unit belongs to the other side');
        if (w.queue.filter((q) => q.building === b.id).length >= 5) return fail('queue full');
        // money and people come from the treasury; metal, fuel and ore must be on site
        const treasury: ResourceAmounts = {};
        const site: ResourceAmounts = {};
        for (const [k, v] of Object.entries(ud.cost)) (k === 'money' || k === 'people' ? treasury : site)[k] = v;
        if (!canAfford(p.res, treasury)) return fail('not enough money or people');
        b.storage ??= {};
        if (!canAfford(b.storage, site)) return fail('not enough materials in this building: deliver metal or fuel by truck');
        pay(p.res, treasury);
        pay(b.storage, site);
        for (const [k, v] of Object.entries(site)) p.res[k] = Math.max(0, (p.res[k] ?? 0) - v);
        const time = ud.trainTime * r.trainTimeMult;
        w.queue.push({ id: w.nextId++, building: b.id, unit: ud.id, owner: p.id, remaining: time, total: time, paid: treasury, site });
        return ok();
      }
      case 'cancelTrain': {
        const i = w.queue.findIndex((q) => q.id === cmd.item && q.owner === p.id);
        if (i < 0) return fail('no such order');
        const [q] = w.queue.splice(i, 1);
        // money and people back to the treasury, goods back into the building's store
        const caps = new Map(this.ruleset.resources.map((x) => [x.id, x.cap]));
        for (const [k, v] of Object.entries({ ...q.paid, ...q.site })) p.res[k] = Math.min(caps.get(k) ?? 1e9, (p.res[k] ?? 0) + v);
        const b = w.buildings.find((x) => x.id === q.building);
        if (b) {
          b.storage ??= {};
          for (const [k, v] of Object.entries(q.site)) b.storage[k] = Math.min(this.storageCap(b), (b.storage[k] ?? 0) + v);
        }
        return ok();
      }
      case 'move': {
        if (!isFinitePos(cmd.to) || !Array.isArray(cmd.units) || cmd.units.length > 300) return fail('bad order');
        const set = new Set(cmd.units);
        const mine = w.units.filter((u) => set.has(u.id) && u.owner === p.id && !u.embarkedIn);
        if (this.peaceLeft() > 0 && this.side(cmd.to) !== p.team) return fail('ceasefire: nobody may cross the front yet');
        for (const u of mine) u.haul = undefined; // a manual order cancels a delivery round
        const moved = this.orderMove(mine, cmd.to, !!cmd.cohesion, !!cmd.queue, cmd.mode === 'direct');
        return moved ? ok() : fail('no way across the water: use a bridge or build a pontoon crossing');
      }
      case 'stop': {
        const set = new Set(cmd.units);
        for (const u of w.units) {
          if (!set.has(u.id) || u.owner !== p.id) continue;
          (u.target = null), (u.path = []), (u.cap = 0), (u.transport = false), (u.enter = 0), (u.haul = undefined), (u.bombardTarget = null);
          // a recon drone told to stop circles where it is
          if (isReconDrone(this.defs.u.get(u.def))) (u.loiterCenter = [u.pos[0], u.pos[1]]), (u.loiterRadius = 4), (u.isLoitering = true);
        }
        return ok();
      }
      case 'fireMode': {
        const set = new Set(cmd.units);
        if (!['auto', 'return', 'hold'].includes(cmd.mode)) return fail('bad fire mode');
        for (const u of w.units) if (set.has(u.id) && u.owner === p.id) u.fireMode = cmd.mode;
        return ok();
      }
      case 'sprint': {
        const set = new Set(cmd.units);
        for (const u of w.units) {
          if (!set.has(u.id) || u.owner !== p.id || this.defs.u.get(u.def)!.kind === 'air') continue;
          if (cmd.active && ((u.stamina ?? 1) <= 0 || (u.fuel ?? 1) <= 0)) continue;
          u.sprint = !!cmd.active;
        }
        return ok();
      }
      case 'setRoute': {
        const u = w.units.find((x) => x.id === cmd.unit && x.owner === p.id);
        if (!u) return fail('unit not found');
        if (!this.defs.u.get(u.def)!.cargoCap) return fail('not a transport');
        const from = w.buildings.find((x) => x.id === cmd.fromBuilding && x.team === p.team);
        const to = w.buildings.find((x) => x.id === cmd.toBuilding && x.team === p.team);
        if (!from || !to || from === to) return fail('pick two different buildings of your side');
        if (!this.usable(from, p.id) || !this.usable(to, p.id)) return fail('a teammate keeps that building to themselves');
        const loaded = !!u.cargo && Object.values(u.cargo.res).some((v) => v > 0);
        this.orderMove([u], loaded ? to.pos : from.pos, false, false, false);
        u.haul = { fromBuilding: from.id, toBuilding: to.id, resType: cmd.resType, state: loaded ? 'to_to' : 'to_from' };
        return ok();
      }
      case 'board': {
        const u = w.units.find((x) => x.id === cmd.unit && x.owner === p.id && !x.embarkedIn);
        const t = w.units.find((x) => x.id === cmd.transport && x.owner === p.id);
        if (!u || !t || u === t) return fail('unit not found');
        const td = this.defs.u.get(t.def)!;
        const ud = this.defs.u.get(u.def)!;
        if (ud.kind === 'air') {
          // small drones ride on a vehicle's launcher
          if (!ud.launchable) return fail('only small drones can be carried');
          if (!td.droneCap) return fail('that vehicle has no drone launcher');
          t.cargo ??= { res: {}, cap: td.cargoCap ?? 0, passengers: [] };
          t.cargo.drones ??= [];
          if (t.cargo.drones.length >= td.droneCap) return fail('launcher full');
          if (distKm(u.pos, t.pos) > 10) return fail('too far from the vehicle');
          u.embarkedIn = t.id;
          (u.path = []), (u.target = null), (u.pos = [t.pos[0], t.pos[1]]), (u.isLoitering = false), (u.loiterCenter = undefined);
          t.cargo.drones.push(u.id);
          return ok();
        }
        if (!td.passengerCap) return fail('that vehicle carries no passengers');
        if (ud.kind !== 'ground' || (ud.mobility ?? 'foot') !== 'foot') return fail('only infantry can ride along');
        t.cargo ??= { res: {}, cap: td.cargoCap ?? 0, passengers: [] };
        t.cargo.passengers ??= [];
        if (t.cargo.passengers.length >= td.passengerCap) return fail('transport full');
        if (distKm(u.pos, t.pos) > 10) return fail('too far from the transport');
        u.embarkedIn = t.id;
        (u.path = []), (u.target = null), (u.pos = [t.pos[0], t.pos[1]]);
        t.cargo.passengers.push(u.id);
        return ok();
      }
      case 'launch': {
        const t = w.units.find((x) => x.id === cmd.transport && x.owner === p.id);
        if (!t?.cargo?.drones?.length) return fail('no drones on board');
        if (cmd.target && !isFinitePos(cmd.target)) return fail('bad target');
        if (cmd.target && this.peaceLeft() > 0 && this.side(cmd.target) !== p.team) return fail('ceasefire: nobody may cross the front yet');
        const drones = t.cargo.drones.map((id) => w.units.find((x) => x.id === id)).filter((x): x is Unit => !!x);
        t.cargo.drones = [];
        drones.forEach((u, i) => {
          u.embarkedIn = undefined;
          u.pos = offsetKm(t.pos, 0.15 * Math.cos(i * 2.1), 0.15 * Math.sin(i * 2.1));
          u.bearing = t.bearing;
          if (cmd.target) this.orderMove([u], cmd.target, false, false, false);
          else if (isReconDrone(this.defs.u.get(u.def))) (u.loiterCenter = [t.pos[0], t.pos[1]]), (u.loiterRadius = 4), (u.isLoitering = true), (u.path = []);
        });
        return ok();
      }
      case 'share': {
        p.share = !!cmd.allow;
        // a closed door also stops teammates' standing deliveries to and from these buildings
        if (!p.share) for (const u of w.units) if (u.haul && u.owner !== p.id && u.team === p.team) {
          const ends = [u.haul.fromBuilding, u.haul.toBuilding].map((id) => w.buildings.find((b) => b.id === id));
          if (ends.some((b) => b?.owner === p.id)) (u.haul = undefined), (u.path = []), (u.target = null);
        }
        return ok();
      }
      case 'disembark': {
        const t = w.units.find((x) => x.id === cmd.transport && x.owner === p.id);
        if (!t?.cargo?.passengers?.length) return fail('no passengers');
        this.unload(t);
        return ok();
      }
      case 'refuel': {
        const set = new Set(cmd.units);
        for (const u of w.units) {
          if (!set.has(u.id) || u.owner !== p.id || u.fuel === undefined) continue;
          const d = this.defs.u.get(u.def)!;
          if (isStrikeDrone(d)) continue; // one-way craft
          const spot = this.nearestFuel(u, isReconDrone(d));
          if (spot) this.orderMove([u], spot, false, false, false);
        }
        return ok();
      }
      case 'bombard': {
        if (cmd.target && !isFinitePos(cmd.target)) return fail('bad target');
        if (cmd.target && this.peaceLeft() > 0) return fail('ceasefire: no shooting yet');
        const set = new Set(cmd.units);
        for (const u of w.units) {
          if (!set.has(u.id) || u.owner !== p.id || !this.defs.u.get(u.def)!.minRange) continue;
          u.bombardTarget = cmd.target;
          if (cmd.target) (u.path = []), (u.target = null);
        }
        return ok();
      }
      case 'enter': {
        const b = w.buildings.find((x) => x.id === cmd.building);
        const t = b && this.defs.b.get(b.def)!.training;
        if (!b || !t || b.team !== p.team || b.progress < 1) return fail('not a training centre of your side');
        if (!this.usable(b, p.id)) return fail('a teammate keeps this training centre to themselves');
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
        if (!b || !t || b.team !== p.team) return fail('not a training centre of your side');
        if (!this.usable(b, p.id)) return fail('a teammate keeps this training centre to themselves');
        if (b.course) return fail('a course is already running');
        const terms = this.courseTerms(b);
        if (terms.pupils < t.minUnits) return fail(`a course needs at least ${t.minUnits} units inside`);
        if ((p.res.money ?? 0) < terms.perSecond) return fail('not enough money to start a course');
        b.course = { remaining: terms.seconds, total: terms.seconds };
        return ok();
      }
      case 'release': {
        const b = w.buildings.find((x) => x.id === cmd.building);
        if (!b || b.team !== p.team || !b.inside.length) return fail('nobody inside');
        if (!this.usable(b, p.id)) return fail('a teammate keeps this training centre to themselves');
        if (b.course) return fail('a course is in progress');
        this.evict(b);
        return ok();
      }
      case 'upgrade': {
        const b = w.buildings.find((x) => x.id === cmd.building);
        if (!b || b.team !== p.team || b.progress < 1) return fail('building unavailable');
        if (!this.usable(b, p.id)) return fail('a teammate keeps this building to themselves');
        const next = this.defs.b.get(b.def)!.levels?.[b.level - 1];
        if (!next) return fail('already at the highest level');
        if (b.upgrade) return fail('upgrade already in progress');
        if (!canAfford(p.res, next.cost)) return fail('not enough resources');
        pay(p.res, next.cost);
        b.upgrade = { remaining: next.time * r.buildTimeMult, total: next.time * r.buildTimeMult };
        return ok();
      }
      case 'demolish': {
        // only the owner may tear a building down
        const i = w.buildings.findIndex((x) => x.id === cmd.building && x.owner === p.id);
        if (i < 0) return fail('not your building');
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
    if (!this.terrain) return !this.foreign(b);
    const steps = Math.max(1, Math.ceil(distKm(a, b) / 0.15));
    let leaving = this.terrain.isBarrier(a); // a unit already afloat may always make for the bank
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const p: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (!this.terrain.isBarrier(p)) leaving = false;
      else if (!leaving && !cross.some((c) => distKm(c.pos, p) <= c.r)) return false;
      if (i % 7 === 0 && this.foreign(p)) return false; // ~1 km resolution is plenty for country borders
    }
    return !this.foreign(b);
  }

  private ringBoxes: [number, number, number, number][] | null = null;
  /** Inside a neighbouring country nobody fights in? */
  private foreign(p: LngLat): boolean {
    if (!this.forbidden.length) return false;
    this.ringBoxes ??= this.forbidden.map((r) => [Math.min(...r.map((q) => q[0])), Math.min(...r.map((q) => q[1])), Math.max(...r.map((q) => q[0])), Math.max(...r.map((q) => q[1]))]);
    return this.forbidden.some((r, i) => {
      const b = this.ringBoxes![i];
      return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3] && inPolygon(p, r);
    });
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
      u.bombardTarget = null;
      if (d.kind === 'air') {
        if (this.peaceLeft() > 0 && this.side(to) !== u.team) return; // ceasefire: the front is closed
        // drones fly straight; a strike drone dives on the spot, a recon drone circles it once there
        const leg: Waypoint = { p: to, road: false, end: true };
        u.path = queue && u.path.length && !u.isLoitering ? [...u.path, leg] : [leg];
        u.target = to;
        u.cap = 0;
        u.loiterCenter = isReconDrone(d) ? to : undefined;
        u.loiterRadius = isReconDrone(d) ? 4 : undefined;
        u.isLoitering = false;
        moved++;
        return;
      }
      if (!this.isPlayableGround(to, this.roads?.isNear(to, 2) ?? false)) return; // into the sea or a neutral country
      if (this.peaceLeft() > 0 && this.side(to) !== u.team) return; // ceasefire: the front is closed
      // artillery never drives up to (or over) the front line
      if (d.minRange && distToFrontKm(this.world.front, to) * (u.team === 0 ? 1 : -1) < 0.5) return;
      const ring = Math.ceil(Math.sqrt(i));
      let dest: LngLat = [to[0] + 0.012 * ring * Math.cos(i * 2.4), to[1] + 0.009 * ring * Math.sin(i * 2.4)];
      let leg: Waypoint[] | null;
      {
        // never park a unit in the river because of its place in the formation
        if (this.blockedFor(d) && this.terrain?.isBarrier(dest)) dest = to;
        // the group shares one plan; stragglers (and units the shared plan cannot reach) plan their own, bounded per order
        const near = distKm(from, centre) <= 15 && this.lineClear(from, shared?.[0]?.p ?? to, this.crossings(u.team));
        if (shared && near) leg = shared.map((w) => ({ ...w }));
        else if (own++ < 8) leg = this.plan(u.team, from, to, d.speed, direct);
        else leg = null;
        if (leg) leg[leg.length - 1] = { p: dest, road: false };
      }
      if (!leg) return;
      if (d.minRange) {
        // cut the route where it would come within 0.5 km of the line
        const safe = leg.findIndex((w) => distToFrontKm(this.world.front, w.p) * (u.team === 0 ? 1 : -1) < 0.5);
        if (safe === 0) return;
        if (safe > 0) leg = leg.slice(0, safe);
      }
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

    const peace = this.peaceLeft() > 0;
    this.construction(dt);
    this.courses(dt);
    this.economy(dt);
    if (r.sandbox && w.tick % r.tickRate === 0) this.restock();
    this.training(dt);
    this.units(dt);
    this.repairs(dt);
    // during the ceasefire the line is frozen, nothing is captured and nobody can win
    if (!peace) this.frontline(dt);
    if (w.smokes.length && w.tick % r.tickRate === 0) w.smokes = w.smokes.filter((x) => x.expiresAt > w.time);
    if (!peace) this.territory(dt);
    if (!peace && !r.sandbox) this.checkVictory();
    if (w.tick % 2 === 0) this.refreshStatus();
    if (!peace && w.tick % r.tickRate === 0) this.greyZones();
    if (r.peaceSeconds > 0 && w.time >= r.peaceSeconds && w.time - dt < r.peaceSeconds) this.hooks.emit('ceasefireOver', {});

    if (Math.floor(w.time) !== prevSec) this.hooks.emit('tick', { time: Math.floor(w.time) });
    // the clock for the time limit starts when the ceasefire ends
    if (!r.sandbox && r.matchSeconds > 0 && w.time >= r.peaceSeconds + r.matchSeconds && w.winner === null) {
      w.winner = w.scores[0] === w.scores[1] ? null : w.scores[0] > w.scores[1] ? 0 : 1;
      w.winReason = 'time limit';
    }
  }

  /** Sandbox: treasuries and building stores are kept full so every feature can be tried at once. */
  private restock() {
    for (const p of this.world.players) for (const res of this.ruleset.resources) p.res[res.id] = res.cap;
    for (const b of this.world.buildings) {
      if (!b.storage) continue;
      const cap = this.storageCap(b);
      for (const k of Object.keys(b.storage)) b.storage[k] = cap;
    }
  }

  private construction(dt: number) {
    for (const b of this.world.buildings) {
      if (b.progress >= 1) continue;
      const d = this.defs.b.get(b.def)!;
      b.progress = Math.min(1, b.progress + dt / (d.buildTime * this.ruleset.rules.buildTimeMult));
      if (b.progress >= 1) {
        this.stat(b.owner).buildingsBuilt++;
        this.hooks.emit('buildingCompleted', { id: b.id, def: b.def, owner: b.owner });
      }
    }
    for (const b of this.world.buildings) {
      if (!b.upgrade) continue;
      b.upgrade.remaining -= dt;
      if (b.upgrade.remaining > 0) continue;
      const d = this.defs.b.get(b.def)!;
      const before = this.maxBuildingHp(b);
      b.level++;
      b.upgrade = null;
      b.hp += this.maxBuildingHp(b) - before;
      this.hooks.emit('buildingUpgraded', { id: b.id, def: d.id, owner: b.owner, level: b.level });
    }
  }

  /**
   * Grey zones, checked once a second: a ground unit that stays on the enemy's side of the front for a while with no
   * enemy unit near it turns the ground around it into contested territory. The zone fades once nobody keeps it up.
   */
  private greyZones() {
    const w = this.world;
    const r = this.ruleset.rules;
    for (const z of w.grey) z.ttl -= 1;
    for (const u of w.units) {
      if (this.defs.u.get(u.def)!.kind === 'air' || this.side(u.pos) === u.team) {
        u.infil = 0;
        continue;
      }
      const opposed = w.units.some((e) => e.team !== u.team && distKm(e.pos, u.pos) <= r.greyZoneSoloKm);
      u.infil = opposed ? 0 : u.infil + 1;
      if (u.infil < r.greyZoneSeconds) continue;
      const near = w.grey.find((z) => z.team === u.team && distKm(z.pos, u.pos) <= r.greyZoneRadiusKm * 0.5);
      if (near) near.ttl = r.greyZoneTtl;
      else if (w.grey.length < 80) w.grey.push({ id: w.nextId++, team: u.team, pos: [u.pos[0], u.pos[1]], r: r.greyZoneRadiusKm, ttl: r.greyZoneTtl });
    }
    // ground the front has since passed over is no longer "behind enemy lines"
    w.grey = w.grey.filter((z) => z.ttl > 0 && this.side(z.pos) !== z.team);
  }

  /** Work out the buffs and debuffs every unit is under right now (shown on markers and in the unit panel). */
  private refreshStatus() {
    const r = this.ruleset.rules;
    for (const u of this.world.units) {
      const d = this.defs.u.get(u.def)!;
      const s: UnitStatus[] = [];
      const rank = this.ranks[u.rank];
      if (u.rank > 0) s.push(['veteran', rank.damage]);
      if (d.kind !== 'air') {
        const t = this.terrainAt(u.pos);
        if (t.cover > 0) s.push(['cover', t.cover]);
        if (t.concealment < 1) s.push(['concealed', t.concealment]);
        if ((t.vision ?? 1) > 1) s.push(['highground', t.vision!]);
        const hold = this.holdMult(u.team, u.pos);
        if (hold > 1) s.push(['fortified', hold]);
        if (t.cover < 0) s.push(['exposed', -t.cover]);
        if ((t.vision ?? 1) < 1) s.push(['lowsight', t.vision!]);
        const speed = this.terrainSpeed(d, u.pos);
        if (speed < 1 && !u.transport) s.push(['slowed', speed]);
        const city = this.cityDefenseBonus(u.team, u.pos);
        if (city > 0) s.push(['citydefense', city]);
        if (u.transport) s.push(['transport', r.transportDamageMult]);
        if (u.encircled) s.push(['encircled', r.encircledDamageMult]);
      }
      if (u.sprint) s.push(['sprint', 2]);
      if (u.fuel !== undefined && u.maxFuel) {
        if (u.fuel <= 0) s.push(['nofuel', 0]);
        else if (u.fuel / u.maxFuel < 0.2) s.push(['lowfuel', u.fuel / u.maxFuel]);
      }
      u.status = s;
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

  private auras: { tick: number; list: Building[] } = { tick: -1, list: [] };
  private outputMult(b: Building): number {
    const r = this.ruleset.rules;
    let m = b.road ? r.roadOutputMult : 1;
    if (this.auras.tick !== this.world.tick) this.auras = { tick: this.world.tick, list: this.world.buildings.filter((o) => o.progress >= 1 && this.defs.b.get(o.def)!.aura) };
    for (const o of this.auras.list) {
      if (o.team !== b.team || o === b) continue;
      const a = this.defs.b.get(o.def)!.aura!;
      if (distKm(o.pos, b.pos) <= a.radiusKm) m *= a.outputMult;
    }
    // on the power grid (a friendly power plant within range): everything runs faster, homes earn more
    if (this.onGrid(b.team, b.pos)) m *= b.def === 'housing' ? r.housingGridMult : r.powerGridMult;
    const zone = specialZoneAt(b.pos);
    if (zone && zone.buildingDef === b.def && zone.buildingDef === 'oil_refinery') m *= 1.5;
    return m;
  }

  /**
   * Economy (team based): energy is pooled per side; money and people are shared equally between teammates;
   * goods (ore, metal, fuel) pile up in the building that makes them and must be trucked to where they are needed.
   * Consumption (e.g. ore at the metal works) comes out of the building's own stock.
   */
  private economy(dt: number) {
    const w = this.world;
    const r = this.ruleset.rules;
    const caps = new Map(this.ruleset.resources.map((x) => [x.id, x.cap]));
    const done = w.buildings.filter((b) => b.progress >= 1);
    const mults = new Map<number, number>();
    for (const b of done) mults.set(b.id, this.outputMult(b));

    const teamNet: [number, number] = [0, 0];
    for (const b of done) {
      const d = this.defs.b.get(b.def)!;
      teamNet[b.team] += (d.produces?.energy ?? 0) * mults.get(b.id)! - (d.consumes?.energy ?? 0);
    }
    const mates: [Player[], Player[]] = [w.players.filter((x) => x.team === 0), w.players.filter((x) => x.team === 1)];
    for (const p of w.players) {
      const net = teamNet[p.team];
      p.res.energy = clamp((p.res.energy ?? 0) + net * dt, 0, caps.get('energy') ?? 1e9);
      this.energyNet.set(p.id, net);
      this.income.set(p.id, { energy: net });
    }
    const powered = [0, 1].map((t) => teamNet[t] >= 0 || mates[t].some((x) => (x.res.energy ?? 0) > 0));

    for (const b of done) {
      const d = this.defs.b.get(b.def)!;
      if (!d.produces) continue;
      const team = mates[b.team];
      const n = team.length || 1;
      const m = mults.get(b.id)! * (powered[b.team] ? 1 : r.energyDeficitMult);
      b.storage ??= {};
      const consumes = Object.entries(d.consumes ?? {}).filter(([k]) => k !== 'energy');
      if (consumes.some(([k, v]) => (b.storage![k] ?? 0) < v * dt)) continue; // out of inputs: idle until a truck delivers
      for (const [k, v] of consumes) {
        b.storage[k] = Math.max(0, (b.storage[k] ?? 0) - v * dt);
        for (const tp of team) {
          const inc = this.income.get(tp.id)!;
          inc[k] = (inc[k] ?? 0) - v / n;
        }
      }
      for (const [k, v] of Object.entries(d.produces)) {
        if (k === 'energy') continue;
        let made = v * m * dt;
        if (k !== 'money' && k !== 'people') {
          // goods go into the building's own stock first
          const cap = this.storageCap(b);
          made = Math.min(made, Math.max(0, cap - (b.storage[k] ?? 0)));
          b.storage[k] = (b.storage[k] ?? 0) + made;
        }
        for (const tp of team) {
          tp.res[k] = Math.min(caps.get(k) ?? 1e9, (tp.res[k] ?? 0) + made / n);
          const inc = this.income.get(tp.id)!;
          inc[k] = (inc[k] ?? 0) + (v * m) / n;
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
      let speed = this.onGrid(b.team, b.pos) ? this.ruleset.rules.powerGridMult : 1;
      const zone = specialZoneAt(b.pos);
      if (zone && zone.buildingDef === b.def && b.def === 'drone_factory') speed *= 1.5;
      q.remaining -= dt * speed;
      if (q.remaining > 0) return true;
      const p = this.player(q.owner)!;
      if (!p) return false;
      const n = w.units.length;
      this.spawnUnit(q.unit, p, [b.pos[0] + 0.03 * Math.cos(n * 1.9), b.pos[1] + 0.02 * Math.sin(n * 1.9)]);
      this.stat(q.owner).unitsTrained++;
      this.hooks.emit('unitTrained', { owner: q.owner, def: q.unit });
      return false;
    });
  }

  /** Player tallies (bots and unknown ids get a throwaway record). */
  private stat(id: string) {
    return (this.world.stats[id] ??= { kills: 0, losses: 0, buildingsBuilt: 0, buildingsDestroyed: 0, unitsTrained: 0, damage: 0 });
  }

  maxBuildingHp(b: Building): number {
    const d = this.defs.b.get(b.def)!;
    return d.levels?.[b.level - 2]?.hp ?? d.hp;
  }

  /** Defence bonus of one fortification at its current level. */
  defenseOf(b: Building): number {
    const d = this.defs.b.get(b.def)!;
    return d.levels?.[b.level - 2]?.defenseMult ?? d.defense?.mult ?? 0;
  }

  /**
   * How much friendly fortifications divide incoming damage here (and stiffen the front). Fortifications of the same
   * kind do not stack: only the best trench in range counts, and only the best bunker, but a trench and a bunker add up.
   */
  private forts: { tick: number; list: Building[] } = { tick: -1, list: [] };
  private holdMult(team: Team, pos: LngLat): number {
    if (this.forts.tick !== this.world.tick) {
      this.forts = { tick: this.world.tick, list: this.world.buildings.filter((b) => b.progress >= 1 && this.defs.b.get(b.def)!.defense) };
    }
    let best: Map<string, number> | null = null;
    for (const b of this.forts.list) {
      if (b.team !== team || Math.abs(b.pos[1] - pos[1]) > 0.1) continue;
      const d = this.defs.b.get(b.def)!.defense;
      if (!d || distKm(b.pos, pos) > d.radiusKm) continue;
      const m = this.defenseOf(b);
      best ??= new Map();
      if (m > (best.get(b.def) ?? 0)) best.set(b.def, m);
    }
    let total = 1;
    if (best) for (const m of best.values()) total += m;
    return total;
  }

  // ---------- spatial index (rebuilt every tick) ----------
  private static readonly CELL = 0.2; // degrees
  private unitGrid = new Map<number, Unit[]>();
  private buildingGrid = new Map<number, Building[]>();
  private static key(x: number, y: number) {
    return x * 4096 + y;
  }
  private indexWorld() {
    const C = Sim.CELL;
    this.unitGrid.clear();
    this.buildingGrid.clear();
    for (const u of this.world.units) {
      const k = Sim.key(Math.floor(u.pos[0] / C), Math.floor(u.pos[1] / C));
      const b = this.unitGrid.get(k);
      b ? b.push(u) : this.unitGrid.set(k, [u]);
    }
    for (const x of this.world.buildings) {
      const k = Sim.key(Math.floor(x.pos[0] / C), Math.floor(x.pos[1] / C));
      const b = this.buildingGrid.get(k);
      b ? b.push(x) : this.buildingGrid.set(k, [x]);
    }
  }
  /** Visit everything indexed within roughly `km` of p (callers still check exact distance). */
  private near<T>(grid: Map<number, T[]>, p: LngLat, km: number, visit: (t: T) => void) {
    const C = Sim.CELL;
    const dy = Math.ceil(km / 111 / C);
    const dx = Math.ceil(km / 111 / Math.max(0.3, Math.cos((p[1] * Math.PI) / 180)) / C);
    const cx = Math.floor(p[0] / C), cy = Math.floor(p[1] / C);
    for (let x = cx - dx; x <= cx + dx; x++) for (let y = cy - dy; y <= cy + dy; y++) grid.get(Sim.key(x, y))?.forEach(visit);
  }

  /** Can this team see the spot (for indirect fire, which needs a spotter)? */
  private spotted(team: Team, pos: LngLat): boolean {
    let seen = false;
    this.near(this.unitGrid, pos, 30, (o) => {
      if (!seen && o.team === team && !o.embarkedIn && distKm(o.pos, pos) <= this.defs.u.get(o.def)!.vision) seen = true;
    });
    if (seen) return true;
    this.near(this.buildingGrid, pos, 36, (b) => {
      if (!seen && b.team === team && b.progress >= 1 && distKm(b.pos, pos) <= (this.defs.b.get(b.def)!.vision ?? 6)) seen = true;
    });
    return seen;
  }

  /** Damage a ground unit actually takes from a hit, after terrain, fortifications, nearby cities and column order. */
  private hitUnit(attacker: Unit, target: Unit, raw: number): number {
    const r = this.ruleset.rules;
    const td = this.defs.u.get(target.def)!;
    const air = td.kind === 'air';
    const cover = air ? 0 : this.terrainAt(target.pos).cover;
    const city = air ? 0 : this.cityDefenseBonus(target.team, target.pos);
    const dealt = (raw * (1 - cover) * (1 - city) * (target.transport ? r.transportDamageMult : 1)) / (air ? 1 : this.holdMult(target.team, target.pos));
    target.hp -= dealt;
    if (target.hp <= 0 && attacker.team !== target.team) {
      attacker.xp += r.xpPerKill;
      this.stat(attacker.owner).kills++;
    }
    return dealt;
  }

  private hitBuilding(attacker: Unit, b: Building, raw: number): number {
    const dealt = raw / this.holdMult(b.team, b.pos);
    b.hp -= dealt;
    b.lastDamagedTime = this.world.time;
    if (b.hp <= 0) this.stat(attacker.owner).buildingsDestroyed++;
    return dealt;
  }

  /** A blast (strike drone, shell) hurting everything of the other side within `radius` km, strongest at the centre. */
  private blast(attacker: Unit, at: LngLat, radius: number, damage: number, hitsCities: boolean): number {
    let total = 0;
    for (const e of this.world.units) {
      if (e.team === attacker.team || e.embarkedIn || e.hp <= 0 || this.defs.u.get(e.def)!.kind === 'air') continue;
      const d = distKm(at, e.pos);
      if (d <= radius) total += this.hitUnit(attacker, e, damage * (1 - d / radius));
    }
    for (const b of this.world.buildings) {
      if (b.team === attacker.team || b.hp <= 0) continue;
      const d = distKm(at, b.pos);
      if (d <= radius) total += this.hitBuilding(attacker, b, damage * 0.8 * (1 - d / radius));
    }
    if (hitsCities) {
      this.map.capturePoints.forEach((cp, i) => {
        const pt = this.world.points[i];
        if (pt.owner === attacker.team || !this.inCity(at, cp)) return;
        const loss = Math.round(damage / 3);
        pt.hp = Math.max(0, (pt.hp ?? pt.maxHp ?? 8000) - loss);
        pt.lastDamagedTime = this.world.time;
        total += loss;
      });
    }
    return total;
  }

  /** Top up fuel from whatever is in reach: airfields (recon drones); filling stations, fuel trucks or an HQ (vehicles). */
  private refuelInPlace(u: Unit, d: UnitDef, dt: number) {
    if (u.fuel === undefined || u.maxFuel === undefined || u.fuel >= u.maxFuel || isStrikeDrone(d)) return;
    const need = u.maxFuel - u.fuel;
    const fromStore = (kinds: string[], km: number, rate: number) => {
      for (const b of this.world.buildings) {
        if (!kinds.includes(b.def) || b.team !== u.team || b.progress < 1 || !this.usable(b, u.owner) || distKm(u.pos, b.pos) > km) continue;
        const have = b.storage?.fuel ?? 0;
        if (have <= 0) continue;
        const take = Math.min(rate * dt, need, have);
        b.storage!.fuel = have - take;
        u.fuel! += take;
        return true;
      }
      return false;
    };
    if (isReconDrone(d)) return void fromStore(['airfield'], 12, 30);
    if (fromStore(['gas_station'], 8, 30)) return;
    for (const t of this.world.units) {
      if (t === u || t.owner !== u.owner || !this.defs.u.get(t.def)!.fuelOnly || distKm(u.pos, t.pos) > 5) continue;
      const have = t.cargo?.res.fuel ?? 0;
      if (have <= 0) continue;
      const take = Math.min(25 * dt, need, have);
      t.cargo!.res.fuel = have - take;
      u.fuel += take;
      return;
    }
    fromStore(['hq'], 8, 15);
  }

  /** Delivery rounds: drive to the source, load (5 s), drive to the destination, unload (4 s), repeat. */
  private haulStep(u: Unit, d: UnitDef, dt: number) {
    const h = u.haul!;
    const w = this.world;
    const from = w.buildings.find((x) => x.id === h.fromBuilding && x.team === u.team);
    const to = w.buildings.find((x) => x.id === h.toBuilding && x.team === u.team);
    if (!from || !to || !u.cargo) return void (u.haul = undefined);
    const go = (b: Building) => this.orderMove([u], b.pos, false, false, false);
    switch (h.state ?? 'to_from') {
      case 'to_from':
        if (distKm(u.pos, from.pos) <= 3.5 || !u.path.length) (h.state = 'loading'), (h.timer = 5), (u.path = []);
        break;
      case 'loading':
        if ((h.timer = (h.timer ?? 5) - dt) > 0) break;
        from.storage ??= {};
        let room = u.cargo.cap - Object.values(u.cargo.res).reduce((a, v) => a + v, 0);
        // tankers carry fuel only; trucks carry anything but fuel
        const kinds = d.fuelOnly
          ? ['fuel']
          : h.resType && h.resType !== 'any'
            ? [h.resType]
            : (() => {
                const made = Object.keys(this.defs.b.get(from.def)!.produces ?? {}).find((k) => k !== 'fuel' && (from.storage![k] ?? 0) > 0);
                return made ? [made] : ['ore', 'metal'];
              })();
        for (const k of kinds) {
          if (room <= 0 || (k === 'fuel' && !d.fuelOnly)) continue;
          const take = Math.min(room, from.storage[k] ?? 0);
          if (take <= 0) continue;
          from.storage[k] -= take;
          u.cargo.res[k] = (u.cargo.res[k] ?? 0) + take;
          room -= take;
        }
        (h.state = 'to_to'), (h.timer = undefined);
        go(to);
        break;
      case 'to_to':
        if (distKm(u.pos, to.pos) <= 3.5 || !u.path.length) (h.state = 'unloading'), (h.timer = 4), (u.path = []);
        break;
      case 'unloading':
        if ((h.timer = (h.timer ?? 4) - dt) > 0) break;
        to.storage ??= {};
        const accepts = this.storageFor(this.defs.b.get(to.def)!);
        const cap = this.storageCap(to);
        for (const [k, v] of Object.entries(u.cargo.res)) {
          if (accepts.length && !accepts.includes(k)) continue;
          const put = Math.min(v, Math.max(0, cap - (to.storage[k] ?? 0)));
          to.storage[k] = (to.storage[k] ?? 0) + put;
          u.cargo.res[k] = v - put;
        }
        (h.state = 'to_from'), (h.timer = undefined);
        go(from);
        break;
    }
  }

  private units(dt: number) {
    const w = this.world;
    const r = this.ruleset.rules;
    const peace = this.peaceLeft() > 0;
    this.indexWorld();
    for (const u of w.units) {
      if (u.embarkedIn) {
        // riding along: go wherever the vehicle goes
        const t = w.units.find((x) => x.id === u.embarkedIn);
        if (t) u.pos = [t.pos[0], t.pos[1]];
        else u.embarkedIn = undefined;
        continue;
      }
      const d = this.defs.u.get(u.def)!;
      const rank = this.ranks[u.rank];
      // cut off in a cauldron: no supply, strength drains away
      u.encircled = d.kind !== 'air' && w.pockets.some((p) => p.team === u.team && pointInRing(p.nodes, u.pos));
      if (u.encircled) u.hp -= this.maxHp(u) * r.encircledAttrition * dt;
      const range = d.range * rank.range;
      const minR = (d.minRange ?? 0) * rank.range;
      u.cooldown = Math.max(0, u.cooldown - dt);

      // infantry stamina: 60 s of running, 3 minutes to recover; vehicles stop sprinting when the tank runs dry
      if (u.stamina !== undefined) {
        if (u.sprint && u.path.length) u.stamina = Math.max(0, u.stamina - (100 / 60) * dt);
        else if (!u.sprint) u.stamina = Math.min(100, u.stamina + (100 / 180) * dt);
        if (u.stamina <= 0) u.sprint = false;
      } else if (u.sprint && (u.fuel ?? 1) <= 0) u.sprint = false;
      if ((u.id + w.tick) % 5 === 0) this.refuelInPlace(u, d, dt * 5);
      if (u.haul) this.haulStep(u, d, dt);

      // fire discipline: hold = never, return = only once hit, auto = anything in range
      const canFire = !peace && u.fireMode !== 'hold' && (u.fireMode !== 'return' || u.hp < this.maxHp(u) - 0.5) && d.damage > 0 && !isStrikeDrone(d);

      // artillery barrage on a chosen area (2 s salvos, 1 km blast, a little scatter)
      let barrage = false;
      if (canFire && u.bombardTarget && d.minRange) {
        const dist = distKm(u.pos, u.bombardTarget);
        if (dist >= minR && dist <= range) {
          barrage = true;
          if (u.cooldown === 0) {
            u.cooldown = 2;
            const ang = Math.random() * Math.PI * 2;
            const spread = Math.random() * 0.4;
            const impact = offsetKm(u.bombardTarget, spread * Math.cos(ang), spread * Math.sin(ang));
            this.shots.push({ def: u.def, team: u.team, from: u.pos, to: impact });
            const dealt = this.blast(u, impact, 1, d.damage * rank.damage, false);
            u.xp += dealt * r.xpPerDamage;
            this.stat(u.owner).damage += dealt;
            this.rankUp(u);
          }
        }
      }

      // acquire the nearest enemy in range: units first, then buildings
      let tu: Unit | null = null;
      let tb: Building | null = null;
      if (canFire && !barrage) {
        const airDamage = d.airDamage ?? r.airDamageDefault;
        const dLat = range / 111;
        if (!d.minRange) {
          let best = range;
          this.near(this.unitGrid, u.pos, range, (e) => {
            if (e.team === u.team || e.hp <= 0 || e.embarkedIn || Math.abs(e.pos[1] - u.pos[1]) > dLat) return;
            if (airDamage <= 0 && this.defs.u.get(e.def)!.kind === 'air') return;
            const dist = distKm(u.pos, e.pos);
            if (dist <= best) (best = dist), (tu = e);
          });
          if (!tu) {
            this.near(this.buildingGrid, u.pos, range, (e) => {
              if (e.team === u.team || e.hp <= 0 || Math.abs(e.pos[1] - u.pos[1]) > dLat) return;
              const dist = distKm(u.pos, e.pos);
              if (dist <= best) (best = dist), (tb = e);
            });
          }
        } else {
          // indirect fire: nearest target in the ring that somebody on our side can see
          const cands: { d: number; u?: Unit; b?: Building }[] = [];
          this.near(this.unitGrid, u.pos, range, (e) => {
            if (e.team === u.team || e.hp <= 0 || e.embarkedIn || Math.abs(e.pos[1] - u.pos[1]) > dLat || this.defs.u.get(e.def)!.kind === 'air') return;
            const dist = distKm(u.pos, e.pos);
            if (dist >= minR && dist <= range) cands.push({ d: dist, u: e });
          });
          this.near(this.buildingGrid, u.pos, range, (e) => {
            if (e.team === u.team || e.hp <= 0 || Math.abs(e.pos[1] - u.pos[1]) > dLat) return;
            const dist = distKm(u.pos, e.pos);
            if (dist >= minR && dist <= range) cands.push({ d: dist, b: e });
          });
          cands.sort((a, b) => a.d - b.d);
          for (const c of cands.slice(0, 12)) {
            if (!this.spotted(u.team, (c.u ?? c.b)!.pos)) continue;
            (tu = c.u ?? null), (tb = c.b ?? null);
            break;
          }
        }
      }
      // a column that runs into the enemy halts and deploys; it drives on once the way is clear
      const engaged = !!(tu || tb) || barrage;
      u.transport = !engaged && u.path.length > 0 && u.path[0].road && d.kind !== 'air';
      if ((tu || tb) && u.cooldown === 0) {
        u.cooldown = d.minRange ? 2 : 1; // guns fire every 2 s, everything else once a second
        const base = d.damage * rank.damage * (u.encircled ? r.encircledDamageMult : 1);
        let dealt: number;
        if (tu) {
          const air = this.defs.u.get(tu.def)!.kind === 'air';
          dealt = this.hitUnit(u, tu, base * (air ? d.airDamage ?? r.airDamageDefault : 1));
          this.shots.push({ def: u.def, team: u.team, from: u.pos, to: tu.pos });
        } else {
          dealt = this.hitBuilding(u, tb!, base);
          this.shots.push({ def: u.def, team: u.team, from: u.pos, to: tb!.pos });
        }
        u.xp += dealt * r.xpPerDamage;
        this.stat(u.owner).damage += dealt;
        this.rankUp(u);
      }

      // movement: aircraft fly their own way; ground orders follow their route; idle troops close with enemies they see
      if (d.kind === 'air') {
        this.advanceAir(u, d, dt);
      } else if (u.path.length) {
        if (!(engaged && u.path[0].road)) this.advance(u, d, dt);
      } else if (!tu && !tb && canFire && !u.haul && !barrage && !d.minRange) {
        let chase: LngLat | null = null;
        let near = d.vision * 0.7;
        this.near(this.unitGrid, u.pos, near, (e) => {
          if (e.team === u.team || e.embarkedIn) return;
          const dist = distKm(u.pos, e.pos);
          if (dist < near) (near = dist), (chase = e.pos);
        });
        if (chase && (u.fuel ?? 1) > 0 && this.isPlayableGround(chase)) this.stepOffRoad(u, d, chase, d.speed * dt);
      }
    }

    // static weapons (air defence and the like)
    for (const b of w.buildings) {
      const a = this.defs.b.get(b.def)!.attack;
      if (!a || b.progress < 1 || peace) continue;
      b.cooldown = Math.max(0, b.cooldown - dt);
      if (b.cooldown > 0) continue;
      let tgt: Unit | null = null;
      let best = a.range;
      for (const e of w.units) {
        if (e.team === b.team || e.hp <= 0 || e.embarkedIn) continue;
        const air = this.defs.u.get(e.def)!.kind === 'air';
        if ((a.targets === 'air' && !air) || (a.targets === 'ground' && air)) continue;
        const dist = distKm(b.pos, e.pos);
        if (dist <= best) (best = dist), (tgt = e);
      }
      if (!tgt) continue;
      const target: Unit = tgt;
      b.cooldown = 1;
      this.shots.push({ def: b.def, team: b.team, from: b.pos, to: target.pos });
      // fast missiles are hard to intercept: most shots miss them
      if (Math.random() >= (this.defs.u.get(target.def)!.interceptChance ?? 1)) continue;
      target.hp -= a.damage;
      if (target.hp <= 0) this.stat(b.owner).kills++;
    }
    if (this.shots.length > 4000) this.shots.splice(0, this.shots.length - 4000);

    const deadU = w.units.filter((u) => u.hp <= 0);
    if (deadU.length) {
      // passengers go down with their vehicle
      const gone = new Set(deadU.map((u) => u.id));
      for (const u of w.units) if (u.embarkedIn && gone.has(u.embarkedIn) && u.hp > 0) (u.hp = 0), deadU.push(u);
      w.units = w.units.filter((u) => u.hp > 0);
      deadU.forEach((u) => {
        this.stat(u.owner).losses++;
        this.hooks.emit('unitKilled', { id: u.id, def: u.def, owner: u.owner });
      });
    }
    const deadB = w.buildings.filter((b) => b.hp <= 0);
    if (deadB.length) {
      deadB.forEach((b) => this.evict(b, 0.5));
      w.buildings = w.buildings.filter((b) => b.hp > 0);
      deadB.forEach((b) => this.hooks.emit('buildingDestroyed', { id: b.id, def: b.def, owner: b.owner }));
    }
  }

  /** A closed circle of waypoints around the loiter centre, starting from the current heading. */
  private orbit(u: Unit): Waypoint[] {
    const c = u.loiterCenter ?? u.pos;
    const r = u.loiterRadius ?? 4;
    const start = ((u.bearing ?? 0) * Math.PI) / 180;
    const out: Waypoint[] = [];
    for (let i = 1; i <= 32; i++) {
      const ang = start + (i / 32) * Math.PI * 2;
      out.push({ p: offsetKm(c, r * Math.cos(ang), r * Math.sin(ang)), road: false });
    }
    return out;
  }

  /**
   * Flight: aircraft keep moving forward and turn at most 30°/s towards the next waypoint. Recon drones circle their
   * area once there; strike drones dive on their target and explode. Running out of fuel brings a drone down.
   */
  private advanceAir(u: Unit, d: UnitDef, dt: number) {
    const recon = isReconDrone(d);
    const strike = isStrikeDrone(d);
    if (recon && !u.path.length) {
      u.loiterCenter ??= [u.pos[0], u.pos[1]];
      u.isLoitering = true;
      u.path = this.orbit(u);
    }
    if (!u.path.length) return;
    const speed = d.speed;
    const wp = u.path[0];
    const dx = (wp.p[0] - u.pos[0]) * kmPerDegLng(u.pos[1]);
    const dy = (wp.p[1] - u.pos[1]) * 111.32;
    const want = Math.abs(dx) + Math.abs(dy) > 1e-9 ? (Math.atan2(dx, dy) * 180) / Math.PI : u.bearing ?? 0;
    u.bearing ??= want;
    const diff = ((want - u.bearing + 540) % 360) - 180;
    const turn = (d.turnRate ?? 30) * dt;
    u.bearing = (u.bearing + clamp(diff, -turn, turn) + 360) % 360;
    const rad = (u.bearing * Math.PI) / 180;
    const step = speed * dt;
    const next = offsetKm(u.pos, Math.sin(rad) * step, Math.cos(rad) * step);
    if (this.peaceLeft() > 0 && this.side(next) !== u.team && this.side(u.pos) === u.team) {
      // ceasefire: turn back at the line; a recon drone circles a little further back
      (u.path = []), (u.target = null);
      if (recon) u.loiterCenter = offsetKm(u.pos, -Math.sin(rad) * 5, -Math.cos(rad) * 5);
      return;
    }
    u.pos = next;
    if (u.fuel !== undefined) {
      u.fuel = Math.max(0, u.fuel - step * 0.08);
      if (u.fuel <= 0) return void (u.hp = 0); // out of fuel: the drone is lost
    }
    const left = distKm(u.pos, wp.p);
    const ndx = (wp.p[0] - u.pos[0]) * kmPerDegLng(u.pos[1]);
    const ndy = (wp.p[1] - u.pos[1]) * 111.32;
    const off = Math.abs(((((Math.atan2(ndx, ndy) * 180) / Math.PI - u.bearing) + 540) % 360) - 180);
    // missiles are too fast for the drone rule of thumb: they hit when the next step would carry them past the target
    const reach = d.missile ? Math.max(0.25, step * 1.05) : strike && u.path.length === 1 ? Math.max(0.25, speed * 1.5) : Math.max(0.6, speed * 2.5);
    if (left > reach && !(left <= 0.8 && off > 90)) return;
    if (d.missile && strike && u.path.length === 1) u.pos = [wp.p[0], wp.p[1]];
    const done = u.path.shift()!;
    if (recon && u.isLoitering) u.path.push(done); // keep circling
    if (recon && !u.path.length) {
      u.isLoitering = true;
      u.path = this.orbit(u);
    }
    u.target = u.path.length ? u.path[u.path.length - 1].p : null;
    if (strike && !u.path.length) {
      // impact
      const dealt = this.blast(u, u.pos, d.blastKm ?? 1.8, d.damage || 320, true);
      this.stat(u.owner).damage += dealt;
      this.shots.push({ def: u.def, team: u.team, from: u.pos, to: u.pos });
      this.world.smokes.push({ id: this.world.nextId++, pos: [u.pos[0], u.pos[1]], createdAt: this.world.time, expiresAt: this.world.time + 600 });
      u.hp = 0;
    }
  }

  /**
   * Rescuers: inside a city they repair the city and its housing at once; outside they patch up buildings within 2 km.
   * Nothing is repaired within 60 s of being hit. Several rescuers work faster (up to 10 hp/s).
   */
  private repairs(dt: number) {
    const w = this.world;
    const crews = w.units.filter((u) => this.defs.u.get(u.def)!.repairs && !u.embarkedIn);
    if (!crews.length) return;
    const quiet = (t?: number) => w.time - (t ?? -100) >= 60;
    const inCity = new Map<string, { i: number; team: Team; n: number }>();
    const field = new Map<number, number>();
    for (const u of crews) {
      const i = this.map.capturePoints.findIndex((cp) => this.inCity(u.pos, cp));
      if (i >= 0) {
        const key = `${u.team}:${i}`;
        const cur = inCity.get(key);
        cur ? cur.n++ : inCity.set(key, { i, team: u.team, n: 1 });
        continue;
      }
      const b = w.buildings.find((x) => x.team === u.team && x.progress >= 1 && x.hp < this.maxBuildingHp(x) && quiet(x.lastDamagedTime) && distKm(u.pos, x.pos) <= 2);
      if (b) field.set(b.id, (field.get(b.id) ?? 0) + 1);
    }
    for (const { i, team, n } of inCity.values()) {
      const rate = Math.min(10, n) * dt;
      const pt = w.points[i];
      const cp = this.map.capturePoints[i];
      if (pt.owner === team && quiet(pt.lastDamagedTime) && (pt.hp ?? 0) < (pt.maxHp ?? 0)) pt.hp = Math.min(pt.maxHp!, (pt.hp ?? 0) + rate);
      const house = w.buildings.find((b) => b.team === team && b.def === 'housing' && b.progress >= 1 && b.hp < this.maxBuildingHp(b) && quiet(b.lastDamagedTime) && this.inCity(b.pos, cp));
      if (house) house.hp = Math.min(this.maxBuildingHp(house), house.hp + rate);
    }
    for (const [id, n] of field) {
      const b = w.buildings.find((x) => x.id === id)!;
      b.hp = Math.min(this.maxBuildingHp(b), b.hp + Math.min(10, n) * dt);
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
    if (this.foreign(next) && !this.foreign(u.pos)) return false;
    if (blocked && this.terrain!.isBarrier(next) && !this.terrain!.isBarrier(u.pos) && !this.crossings(u.team).some((x) => distKm(x.pos, next) <= x.r)) return false;
    u.pos = next;
    return true;
  }

  private advance(u: Unit, d: UnitDef, dt: number) {
    if (u.fuel !== undefined && u.fuel <= 0) return; // out of fuel: stuck until a tanker comes
    const base = (u.cap ? Math.min(d.speed, u.cap) : d.speed) * (u.sprint ? 2 : 1);
    const roadMult = this.ruleset.rules.roadSpeedMult;
    const start: LngLat = [u.pos[0], u.pos[1]];
    let budget = dt;
    for (let guard = 0; budget > 1e-6 && u.path.length && guard < 32; guard++) {
      const wp = u.path[0];
      const dist = distKm(u.pos, wp.p);
      // artillery stops short of the front
      if (d.minRange && distToFrontKm(this.world.front, wp.p) * (u.team === 0 ? 1 : -1) < 0.5) {
        u.path = [];
        break;
      }
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
    if (this.peaceLeft() > 0 && this.side(u.pos) !== u.team && this.side(start) === u.team) {
      // ceasefire: the line is closed, halt on our side of it
      (u.pos = start), (u.path = []);
    }
    const moved = distKm(start, u.pos);
    if (moved > 0) {
      u.bearing = (Math.atan2((u.pos[0] - start[0]) * kmPerDegLng(u.pos[1]), (u.pos[1] - start[1]) * 111.32) * 180) / Math.PI;
      if (u.fuel !== undefined) {
        u.fuel = Math.max(0, u.fuel - moved * 0.04 * (u.sprint ? 1.5 : 1));
        if (u.fuel <= 0) u.sprint = false;
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

    const speedAt = (node: FrontNode, base: [number, number]): number => {
      const pos: LngLat = [node.lng, node.lat];
      const force: [number, number] = [base[0], base[1]];
      this.near(this.unitGrid, pos, R, (u) => {
        const d = distKm(u.pos, pos);
        if (d > R || u.embarkedIn || u.hp <= 0) return;
        const ud = this.defs.u.get(u.def)!;
        if (ud.kind === 'air') return; // only ground troops hold or take ground
        force[u.team] += ud.damage * this.ranks[u.rank].damage * (u.encircled ? r.encircledDamageMult : 1) * (u.hp / this.maxHp(u)) * (1 - d / R);
      });
      // troops sitting unopposed behind the line loosen it
      for (const z of w.grey) if (distKm(z.pos, pos) <= z.r + r.frontNodeSpacingKm) force[z.team] += r.greyZonePush;
      const hold: [number, number] = [this.holdMult(0, pos), this.holdMult(1, pos)];
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
        const lng = n[i].lng + (nx * v * dt) / kmPerDegLng(n[i].lat);
        const lat = n[i].lat + (ny * v * dt) / 111.32;
        // the line does not advance across open sea or a big river
        if (this.terrain?.isBarrier([lng, lat]) && !this.terrain.isBarrier([n[i].lng, n[i].lat])) {
          n[i].v = 0;
          continue;
        }
        n[i].lng = lng;
        n[i].lat = lat;
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
      dead.forEach((u) => {
        this.stat(u.owner).losses++;
        this.hooks.emit('unitKilled', { id: u.id, def: u.def, owner: u.owner });
      });
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
