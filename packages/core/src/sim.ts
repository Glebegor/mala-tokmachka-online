import type { Command, CommandResult } from './commands';
import type { BuildingDef, MapDef, RankDef, ResourceAmounts, Ruleset, TerrainDef, UnitDef } from './defs';
import { clamp, distKm, kmPerDegLng, moveToward, offsetKm, type LngLat } from './geo';
import { buildFront, distToFrontKm, findPinch, nearestNode, normalOf, OccupiedIndex, pocketAt, pointInRing, respace, ringAreaKm2, sideOf } from './frontline';
import { RoadNetwork } from './roads';
import { TerrainGrid } from './terrain';
import { specialZoneAt } from './specialZones';
import { LIBERATED_CELL, type Building, type FrontNode, type HaulStop, type LiberatedCell, type Player, type Pocket, type Shot, type SlotInit, type Team, type Unit, type UnitStatus, type Waypoint, type World } from './state';
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
    for (const res of this.ruleset.resources) if (!this.isGood(res.id)) startRes[res.id] = res.start; // goods start in the HQ
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
      liberated: [],
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
      timeline: [],
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
    this.occ.tick = -1; // the territory index is rebuilt from the live front on first use
    return w;
  }

  private spawnBuilding(def: string, p: Player, pos: LngLat, done = false): Building {
    const d = this.defs.b.get(def)!;
    const road = this.roads?.isNear(pos, this.ruleset.rules.roadAccessKm) ?? false;
    const goods = this.storageFor(d);
    const stock = (k: string) => (this.ruleset.rules.sandbox ? this.storageCap({ def } as Building) : this.starterStock(d, k, p, done));
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
      morale: d.kind === 'air' ? undefined : 100,
      // players' troops stay where they are put; bots go after what they see
      stance: p.bot ? 'aggressive' : 'hold',
      post: [pos[0], pos[1]],
      retreatAt: 0,
      sprint: false,
      stamina: d.kind === 'ground' && (d.mobility ?? 'foot') === 'foot' && !d.maxFuel ? 100 : undefined,
      fuel: d.maxFuel,
      maxFuel: d.maxFuel,
      ammo: d.maxAmmo || undefined,
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
    if (!air) for (const t of this.world.units) if (t !== u && t.team === u.team && this.defs.u.get(t.def)!.fuelOnly && (t.cargo?.res.fuel ?? 0) > 0) take(t.pos);
    return best;
  }

  /** Money, people and energy are pooled; everything else (ore, metal, fuel, ammo) is a physical good kept in buildings. */
  isGood(k: string): boolean {
    return k !== 'money' && k !== 'people' && k !== 'energy';
  }

  /**
   * What a new building holds when it is finished. The HQ placed at the start holds the player's starting goods (that is
   * where everything a player owns is kept). A factory starts with enough materials for two of its dearest units so it can
   * get going; everything else starts empty: goods are produced or trucked in, never handed out with a building.
   */
  private starterStock(d: BuildingDef, k: string, p: Player, initial: boolean): number {
    if (d.id === 'hq' && initial) return this.ruleset.resources.find((r) => r.id === k)?.start ?? 0;
    const need = Math.max(0, ...(d.trains ?? []).map((u) => this.defs.u.get(u)?.cost[k] ?? 0));
    return Math.min(this.storageCap({ def: d.id } as Building), need * 2);
  }

  /** Where a player's spendable goods are kept: their HQs first, then their warehouses (finished ones). */
  homeStores(p: Player): Building[] {
    const own = this.world.buildings.filter((b) => b.owner === p.id && b.progress >= 1 && b.storage);
    return [...own.filter((b) => b.def === 'hq'), ...own.filter((b) => b.def === 'warehouse')];
  }

  /** Goods a player can spend on building and upgrades (what lies in their HQs and warehouses). */
  goods(p: Player): ResourceAmounts {
    const out: ResourceAmounts = {};
    for (const b of this.homeStores(p)) for (const [k, v] of Object.entries(b.storage!)) out[k] = (out[k] ?? 0) + v;
    return out;
  }

  /** Money and people from the treasury, goods from the HQ and warehouses. */
  canPay(p: Player, cost: ResourceAmounts): boolean {
    const g = Object.keys(cost).some((k) => this.isGood(k)) ? this.goods(p) : {};
    return Object.entries(cost).every(([k, v]) => ((this.isGood(k) ? g[k] : p.res[k]) ?? 0) >= v);
  }

  payFor(p: Player, cost: ResourceAmounts) {
    const stores = this.homeStores(p);
    for (const [k, v] of Object.entries(cost)) {
      if (!this.isGood(k)) {
        p.res[k] = (p.res[k] ?? 0) - v;
        continue;
      }
      let due = v;
      for (const b of stores) {
        const take = Math.min(due, b.storage![k] ?? 0);
        if (take <= 0) continue;
        b.storage![k] -= take;
        due -= take;
        if (due <= 0) break;
      }
    }
  }

  /** Refunds: money and people to the treasury, goods into the HQ. */
  credit(p: Player, amounts: ResourceAmounts) {
    const caps = new Map(this.ruleset.resources.map((x) => [x.id, x.cap]));
    const hq = this.homeStores(p)[0];
    for (const [k, v] of Object.entries(amounts)) {
      if (!this.isGood(k)) p.res[k] = Math.min(caps.get(k) ?? 1e9, (p.res[k] ?? 0) + v);
      else if (hq) hq.storage![k] = Math.max(0, Math.min(this.storageCap(hq), (hq.storage![k] ?? 0) + v));
    }
  }

  /** Physical goods a building keeps on site: what it makes, what it uses, and what its trainees cost. */
  storageFor(d: BuildingDef): string[] {
    const fixed: Record<string, string[]> = { hq: ['metal', 'fuel', 'ore', 'ammo'], gas_station: ['fuel'], oil_refinery: ['fuel'], airfield: ['fuel'], mine: ['ore'], warehouse: ['metal', 'fuel', 'ore', 'ammo'], ammo_depot: ['ammo'] };
    if (fixed[d.id]) return fixed[d.id];
    const global = new Set(['money', 'people', 'energy']);
    const out = new Set<string>();
    for (const k of [...Object.keys(d.produces ?? {}), ...Object.keys(d.consumes ?? {})]) if (!global.has(k)) out.add(k);
    if (d.supply) out.add('ammo'); // ammo points keep a store to hand out
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

  /**
   * Can this unit take the next course? Recruits always can; from the second rank on it must have destroyed at least one
   * enemy unit since its last course (schooling builds on real combat).
   */
  canTrain(u: Unit): boolean {
    return !!this.ranks[u.rank + 1] && this.defs.u.get(u.def)!.kind !== 'air' && (u.rank === 0 || (u.combat ?? 0) >= 1);
  }

  /** Duration of a course for the units currently inside, and what it costs per second while it runs. */
  courseTerms(b: Building): { perSecond: number; seconds: number; pupils: number } {
    const t = this.defs.b.get(b.def)!.training!;
    const r = this.ruleset.rules;
    let top = 0;
    let pupils = 0;
    let perTick = 0;
    for (const u of b.inside) {
      if (!this.canTrain(u)) continue;
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

  /** Inside one of this team's grey zones (infiltration patches or liberated ground not yet settled)? */
  inOwnGrey(team: Team, p: LngLat): boolean {
    return this.world.grey.some((z) => z.team === team && distKm(z.pos, p) <= z.r) || this.liberatedAt(p)?.team === team;
  }

  /** Stocked friendly ammo points (depots, bases), refreshed every tick. */
  private depots: { tick: number; list: Building[] } = { tick: -1, list: [] };
  /** The stocked ammo point this unit can refill at, if one is in range. */
  supplyFor(u: Unit): Building | null {
    if (this.depots.tick !== this.world.tick) {
      this.depots = { tick: this.world.tick, list: this.world.buildings.filter((b) => b.progress >= 1 && this.defs.b.get(b.def)!.supply && (b.storage?.ammo ?? 0) > 0) };
    }
    for (const b of this.depots.list) {
      if (b.team !== u.team || !this.usable(b, u.owner)) continue;
      if (distKm(b.pos, u.pos) <= this.defs.b.get(b.def)!.supply!.radiusKm) return b;
    }
    return null;
  }
  /** Refill rounds from a nearby ammo point (called once a second per unit). */
  private resupply(u: Unit, d: UnitDef, seconds: number): boolean {
    if (u.ammo === undefined || !d.maxAmmo || u.ammo >= d.maxAmmo || u.embarkedIn || u.encircled) return false; // cut off: no supply
    const b = this.supplyFor(u);
    if (!b) return false;
    const cost = d.ammoCost ?? 1;
    const rounds = Math.min(d.maxAmmo - u.ammo, this.defs.b.get(b.def)!.supply!.rounds * seconds, Math.floor((b.storage!.ammo ?? 0) / cost));
    if (rounds <= 0) return false;
    u.ammo += rounds;
    b.storage!.ammo = (b.storage!.ammo ?? 0) - rounds * cost;
    return true;
  }

  /**
   * A line structure (trench) from `a` to `b` (or, without `b`, 1 km along the nearby front centred on `a`): it must lie
   * on your own ground, clear of water and grey zones; cost and build time are per km of length.
   */
  private buildLine(p: Player, d: BuildingDef, a: LngLat, b?: LngLat): CommandResult {
    const w = this.world;
    if (!isFinitePos(a) || (b && !isFinitePos(b))) return fail('bad position');
    if (!b) {
      // a single click: a 1 km line parallel to the nearest stretch of front
      const i = nearestNode(w.front, a);
      const p0 = w.front[Math.max(0, i - 1)], p1 = w.front[Math.min(w.front.length - 1, i + 1)];
      const tx = (p1.lng - p0.lng) * kmPerDegLng(a[1]), ty = (p1.lat - p0.lat) * 111.32;
      const len = Math.hypot(tx, ty) || 1;
      const ends: [LngLat, LngLat] = [offsetKm(a, (-tx / len) * 0.5, (-ty / len) * 0.5), offsetKm(a, (tx / len) * 0.5, (ty / len) * 0.5)];
      [a, b] = ends;
    }
    const km = distKm(a, b);
    const lim = d.line!;
    if (km < lim.minKm) return fail(`a ${d.name.toLowerCase()} is at least ${lim.minKm} km long`);
    if (km > lim.maxKm) return fail(`at most ${lim.maxKm} km in one go`);
    const steps = Math.max(2, Math.ceil(km / 0.25));
    let wet = 0;
    for (let i = 0; i <= steps; i++) {
      const q: LngLat = [a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps];
      const end = i === 0 || i === steps;
      const water = this.terrainAt(q).id === 'water' || !!this.terrain?.isBarrier(q);
      if (water) wet++;
      if (!inBounds(this.map, q) || this.foreign(q)) return fail('the line leaves the theatre');
      if (d.spansWater) {
        // a bridge: dry, friendly ground at both ends, river in between
        if (end && (water || this.side(q) !== p.team)) return fail('both ends of a bridge must be on your dry ground');
        continue;
      }
      if (this.side(q) !== p.team) return fail('the whole line must be on your ground');
      if (water) return fail('the line crosses water');
      if (this.liberatedAt(q) || w.grey.some((z) => distKm(z.pos, q) <= z.r)) return fail('contested ground (grey zone)');
    }
    if (d.spansWater && !this.terrain?.isBarrier([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) && wet === 0) return fail('a bridge has to cross a river');
    const size = Math.max(0.5, Math.round(km * 10) / 10);
    const cost = Object.fromEntries(Object.entries(d.cost).map(([k, v]) => [k, Math.round(v * size)]));
    if (!this.canPay(p, cost)) return fail('not enough resources');
    this.payFor(p, cost);
    const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const site = this.spawnBuilding(d.id, p, mid);
    site.line = [[a[0], a[1]], [b[0], b[1]]];
    site.size = size;
    return ok();
  }

  /** Distance from p to a building: to its line for line structures, else to its spot. */
  reachKm(b: Building, p: LngLat): number {
    if (!b.line) return distKm(b.pos, p);
    const [a, c] = b.line;
    const kx = kmPerDegLng(p[1]);
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * 111.32, cx = (c[0] - p[0]) * kx, cy = (c[1] - p[1]) * 111.32;
    const dx = cx - ax, dy = cy - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / l2)) : 0;
    return Math.hypot(ax + dx * t, ay + dy * t);
  }

  /** Supply-chain partners must be built far apart (see `spacedFrom`). */
  chained(a: BuildingDef, b: BuildingDef): boolean {
    return !!a.spacedFrom?.includes(b.id) || !!b.spacedFrom?.includes(a.id);
  }

  /** Minimum distance between a new building of type `d` and an existing one of type `other`. */
  spacingBetween(d: BuildingDef, other: string, inZone = false): number {
    const r = this.ruleset.rules;
    const o = this.defs.b.get(other);
    if (o && this.chained(d, o) && !inZone) return r.minBuildSpacing;
    if (o && o.id === d.id && d.sameKindKm && !inZone) return d.sameKindKm;
    return r.fieldWorkSpacing;
  }

  /** Which team holds the ground here: cauldrons first, then the main front. */
  side(p: LngLat): Team {
    const pocket = this.world.pockets.length ? pocketAt(this.world.pockets, p) : null;
    if (pocket) return pocket.team;
    // the same occupied area the map paints; holes in it (the Sea of Azov) fall back to the nearest stretch of front
    if (this.map.occupiedHoles?.some((h) => inPolygon(p, h))) return sideOf(this.world.front, p);
    if (!this.map.occupiedClosure.length) return sideOf(this.world.front, p);
    // rebuilt once per tick (the front moves every tick)
    if (this.occ.tick < 0 || this.occ.tick !== this.world.tick || this.occ.front !== this.world.front) {
      this.occ = { tick: this.world.tick, front: this.world.front, index: new OccupiedIndex(this.world.front, this.map.occupiedClosure) };
    }
    return this.occ.index!.contains(p) ? 1 : 0;
  }
  private occ: { tick: number; front: FrontNode[] | null; index: OccupiedIndex | null } = { tick: -1, front: null, index: null };

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
        if (d.line) return this.buildLine(p, d, cmd.pos, cmd.to);
        if (d.maxPerPlayer && countOf(w, p.id, d.id) >= d.maxPerPlayer) return fail('limit reached');
        if (!isFinitePos(cmd.pos)) return fail('bad position');
        if (!inBounds(this.map, cmd.pos)) return fail('outside map');
        if (!this.isPlayableGround(cmd.pos)) return fail('outside the theatre of war');
        // special zones: build there even behind the line, but only the side the zone belongs to
        const zone = specialZoneAt(cmd.pos);
        const mySide = p.team === 0 ? 'ua' : 'ru';
        if (zone && zone.side !== mySide) return fail(`${zone.name} is only available to ${zone.side === 'ua' ? 'Ukraine' : 'Russia'}`);
        // ammo depots may go up on contested ground our troops hold, even behind the enemy line
        const inGrey = !!d.buildInGrey && this.inOwnGrey(p.team, cmd.pos);
        if (!zone && !inGrey) {
          const pocket = w.pockets.length ? pocketAt(w.pockets, cmd.pos) : null;
          if (pocket) return fail(pocket.team === p.team ? 'this ground is encircled' : 'not your territory');
          if (w.grey.some((z) => distKm(z.pos, cmd.pos) <= z.r) || this.liberatedAt(cmd.pos)) return fail('contested ground (grey zone)');
          if (this.side(cmd.pos) !== p.team) return fail('not your territory');
          const dist = Math.abs(distToFrontKm(w.front, cmd.pos));
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
          // every site needs its own patch; only supply-chain partners (mine and metal works, …) must be far apart
          const clash = w.buildings.find((x) => x.def !== 'housing' && distKm(x.pos, cmd.pos) < this.spacingBetween(d, x.def, !!zone));
          if (clash) {
            const other = this.defs.b.get(clash.def)!;
            return fail(this.chained(d, other) ? `keep ${r.minBuildSpacing} km from the ${other.name} (goods go by truck)` : other.id === d.id && d.sameKindKm ? `keep ${d.sameKindKm} km from the next ${d.name}` : 'space occupied');
          }
        }
        if (!this.canPay(p, d.cost)) return fail(Object.keys(d.cost).some((k) => this.isGood(k)) ? 'not enough resources (materials come from your HQ and warehouses)' : 'not enough resources');
        this.payFor(p, d.cost);
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
        for (const [k, v] of Object.entries(q.paid)) p.res[k] = Math.min(caps.get(k) ?? 1e9, (p.res[k] ?? 0) + v);
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
        for (const u of mine) (u.haul = undefined), (u.fuelTo = undefined), (u.attackMove = !!cmd.attack), (u.retreating = false); // a manual order cancels a delivery round or a fuel run
        const formation = (['spread', 'line', 'column', 'wedge'] as const).includes(cmd.formation as never) ? cmd.formation : 'spread';
        const moved = this.orderMove(mine, cmd.to, !!cmd.cohesion, !!cmd.queue, cmd.mode === 'direct', formation);
        return moved ? ok() : fail('no way across the water: use a bridge or build a pontoon crossing');
      }
      case 'stance': {
        if (!['hold', 'defend', 'aggressive'].includes(cmd.stance)) return fail('bad stance');
        const set = new Set(cmd.units);
        for (const u of w.units) if (set.has(u.id) && u.owner === p.id) (u.stance = cmd.stance), (u.post = u.path.length ? u.post : [u.pos[0], u.pos[1]]);
        return ok();
      }
      case 'retreat': {
        const at = [0, 0.25, 0.5].includes(cmd.at) ? cmd.at : 0;
        const set = new Set(cmd.units);
        for (const u of w.units) if (set.has(u.id) && u.owner === p.id) u.retreatAt = at;
        return ok();
      }
      case 'stop': {
        const set = new Set(cmd.units);
        for (const u of w.units) {
          if (!set.has(u.id) || u.owner !== p.id) continue;
          (u.target = null), (u.path = []), (u.cap = 0), (u.transport = false), (u.enter = 0), (u.haul = undefined), (u.bombardTarget = null), (u.fuelTo = undefined);
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
        const ud = this.defs.u.get(u.def)!;
        if (!ud.cargoCap) return fail('not a transport');
        // two buildings (the quick form) or a list of stops with actions and waypoints
        const raw = cmd.stops?.length ? cmd.stops : [{ action: 'load' as const, building: cmd.fromBuilding }, { action: 'unload' as const, building: cmd.toBuilding }];
        if (!Array.isArray(raw) || raw.length < 2 || raw.length > 6) return fail('a route has 2 to 6 stops');
        const stops: HaulStop[] = [];
        for (const st of raw) {
          if (st.action === 'via') {
            if (!st.pos || !isFinitePos(st.pos) || !inBounds(this.map, st.pos)) return fail('bad waypoint');
            stops.push({ action: 'via', pos: [st.pos[0], st.pos[1]] });
            continue;
          }
          if (st.action !== 'load' && st.action !== 'unload') return fail('bad stop');
          const b = w.buildings.find((x) => x.id === st.building && x.team === p.team);
          if (!b) return fail('pick buildings of your side');
          if (!this.usable(b, p.id)) return fail('a teammate keeps that building to themselves');
          stops.push({ action: st.action, building: b.id });
        }
        const loads = stops.filter((x) => x.action === 'load'), unloads = stops.filter((x) => x.action === 'unload');
        if (!loads.length || !unloads.length) return fail('a route needs somewhere to load and somewhere to unload');
        if (cmd.fromBuilding !== undefined && !cmd.stops?.length && cmd.fromBuilding === cmd.toBuilding) return fail('pick two different buildings of your side');
        // every unloading stop must take what is carried; tankers carry fuel only
        const want = ud.fuelOnly ? 'fuel' : cmd.resType && cmd.resType !== 'any' ? cmd.resType : null;
        for (const st of unloads) {
          const to = w.buildings.find((x) => x.id === st.building)!;
          const accepts = this.storageFor(this.defs.b.get(to.def)!);
          if (want && accepts.length && !accepts.includes(want)) return fail(`the ${this.defs.b.get(to.def)!.name} does not take ${want}`);
          if (!want && !loads.some((l) => this.haulKinds(w.buildings.find((x) => x.id === l.building)!, to, ud).length)) {
            return fail(`nothing on this route is wanted at the ${this.defs.b.get(to.def)!.name}`);
          }
        }
        const loaded = !!u.cargo && Object.values(u.cargo.res).some((v) => v > 0);
        const minLoad = Math.max(1, Math.min(ud.cargoCap, Math.round(Number(cmd.minLoad) || 1)));
        // already carrying something: start at the first unloading stop
        const idx = loaded ? stops.findIndex((x) => x.action === 'unload') : 0;
        u.haul = { stops, idx, state: 'moving', resType: cmd.resType, minLoad };
        this.haulGo(u);
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
          const ends = u.haul.stops.map((st) => w.buildings.find((b) => b.id === st.building));
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
      case 'giveFuel': {
        const u = w.units.find((x) => x.id === cmd.unit && x.owner === p.id && !x.embarkedIn);
        const t = w.units.find((x) => x.id === cmd.target && x.team === p.team && !x.embarkedIn);
        if (!u || !t || u === t) return fail('pick another vehicle of your side');
        const ud = this.defs.u.get(u.def)!;
        if (ud.kind === 'air' || (!ud.fuelOnly && u.fuel === undefined)) return fail('this unit has no fuel to give');
        if (this.defs.u.get(t.def)!.kind === 'air' || t.fuel === undefined || t.maxFuel === undefined) return fail('that unit takes no fuel');
        if (t.fuel >= t.maxFuel - 0.5) return fail('its tank is already full');
        (u.haul = undefined), (u.bombardTarget = null);
        u.fuelTo = t.id;
        this.orderMove([u], t.pos, false, false, false);
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
        const mine = w.units.filter((u) => set.has(u.id) && u.owner === p.id);
        const pupils = mine.filter((u) => this.canTrain(u)).slice(0, Math.max(0, free));
        if (!pupils.length) {
          if (free <= 0) return fail('training centre is full');
          const green = mine.some((u) => u.rank > 0 && this.ranks[u.rank + 1] && this.defs.u.get(u.def)!.kind !== 'air');
          return fail(green ? 'above Recruit a unit needs at least one kill since its last course' : 'no ground units that can still be trained');
        }
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
        const upCost = Object.fromEntries(Object.entries(next.cost).map(([k, v]) => [k, Math.round(v * (b.size ?? 1))]));
        if (!this.canPay(p, upCost)) return fail('not enough resources (materials come from your HQ and warehouses)');
        this.payFor(p, upCost);
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
        this.credit(p, Object.fromEntries(Object.entries(d.cost).map(([k, v]) => [k, v * 0.4 * (b.size ?? 1)])));
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
  private crossings(team: Team): { pos: LngLat; r: number; speed: number; line?: [LngLat, LngLat] }[] {
    const out: { pos: LngLat; r: number; speed: number; line?: [LngLat, LngLat] }[] = [];
    for (const b of this.world.buildings) {
      if (b.team !== team || b.progress < 1) continue;
      const c = this.defs.b.get(b.def)!.crossing;
      if (c) out.push({ pos: b.pos, r: c.radiusKm, speed: c.speed, line: b.line });
    }
    return out;
  }

  /** Is p within a crossing (around a pontoon site, or along a bridge)? */
  private inCrossing(c: { pos: LngLat; r: number; line?: [LngLat, LngLat] }, p: LngLat): boolean {
    return (c.line ? this.reachKm({ pos: c.pos, line: c.line } as Building, p) : distKm(c.pos, p)) <= c.r;
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
  private lineClear(a: LngLat, b: LngLat, cross: { pos: LngLat; r: number; line?: [LngLat, LngLat] }[]): boolean {
    if (!this.terrain) return !this.foreign(b);
    const steps = Math.max(1, Math.ceil(distKm(a, b) / 0.15));
    let leaving = this.terrain.isBarrier(a); // a unit already afloat may always make for the bank
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const p: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (!this.terrain.isBarrier(p)) leaving = false;
      else if (!leaving && !cross.some((c) => this.inCrossing(c, p))) return false;
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
  private planLeg(from: LngLat, to: LngLat, speed: number, cross: { pos: LngLat; r: number; line?: [LngLat, LngLat] }[], direct: boolean): { wps: Waypoint[]; sec: number } | null {
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
  private orderMove(units: Unit[], to: LngLat, cohesion: boolean, queue: boolean, direct: boolean, formation: 'spread' | 'line' | 'column' | 'wedge' = 'spread'): number {
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
        // strike craft aimed at (or right next to) an enemy lock on to it
        if (isStrikeDrone(d)) {
          const unit = this.world.units.find((e) => e.team !== u.team && !e.embarkedIn && this.defs.u.get(e.def)!.kind !== 'air' && distKm(e.pos, to) < 0.6);
          const bld = unit ? undefined : this.world.buildings.find((e) => e.team !== u.team && distKm(e.pos, to) < 0.6);
          u.lockOn = unit ? { unit: unit.id } : bld ? { building: bld.id } : undefined;
        }
        u.loiterRadius = isReconDrone(d) ? 4 : undefined;
        u.isLoitering = false;
        moved++;
        return;
      }
      if (!this.isPlayableGround(to, this.roads?.isNear(to, 2) ?? false)) return; // into the sea or a neutral country
      if (this.peaceLeft() > 0 && this.side(to) !== u.team) return; // ceasefire: the front is closed
      // artillery never drives up to (or over) the front line
      if (d.minRange && distToFrontKm(this.world.front, to) * (u.team === 0 ? 1 : -1) < 0.5) return;
      let dest: LngLat = this.formationSpot(formation, i, units.length, centre, to);
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

  /**
   * Where the i-th of n units stands when a group arrives: spread (a loose cluster), a line across the direction of
   * travel, a column along it, or a wedge pointing forward. Spacing ~350 m.
   */
  private formationSpot(f: 'spread' | 'line' | 'column' | 'wedge', i: number, n: number, from: LngLat, to: LngLat): LngLat {
    if (f === 'spread' || n < 2) {
      const ring = Math.ceil(Math.sqrt(i));
      return [to[0] + 0.012 * ring * Math.cos(i * 2.4), to[1] + 0.009 * ring * Math.sin(i * 2.4)];
    }
    const dx = (to[0] - from[0]) * kmPerDegLng(to[1]), dy = (to[1] - from[1]) * 111.32;
    const len = Math.hypot(dx, dy) || 1;
    const fx = dx / len, fy = dy / len; // forward
    const rx = fy, ry = -fx; // right
    const s = 0.35;
    let side = 0, back = 0;
    if (f === 'line') side = (i - (n - 1) / 2) * s;
    else if (f === 'column') back = i * s;
    else {
      const k = Math.ceil(i / 2);
      side = (i % 2 ? 1 : -1) * k * s;
      back = k * s;
    }
    return offsetKm(to, rx * side - fx * back, ry * side - fy * back);
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
    if (w.tick % r.tickRate === 0) this.healing();
    if (w.tick % r.tickRate === 3) this.morale();
    // during the ceasefire the line is frozen, nothing is captured and nobody can win
    if (!peace) this.frontline(dt), (this.occ.tick = -1); // the line moved: territory index is stale
    if (!peace && w.tick % r.tickRate === 5 && this.breakthrough()) this.occ.tick = -1;
    if (w.smokes.length && w.tick % r.tickRate === 0) w.smokes = w.smokes.filter((x) => x.expiresAt > w.time);
    if (!peace) this.territory(dt);
    if (!peace && !r.sandbox) this.checkVictory();
    if (w.tick % 2 === 0) this.refreshStatus();
    if (!peace && w.tick % r.tickRate === 0) this.greyZones(), this.liberation();
    if (r.peaceSeconds > 0 && w.time >= r.peaceSeconds && w.time - dt < r.peaceSeconds) this.hooks.emit('ceasefireOver', {});

    if (Math.floor(w.time) !== prevSec) this.hooks.emit('tick', { time: Math.floor(w.time) });
    if (Math.floor(w.time / 30) !== Math.floor(prevSec / 30) || w.tick === 1) this.sampleTimeline();
    // the clock for the time limit starts when the ceasefire ends
    if (!r.sandbox && r.matchSeconds > 0 && w.time >= r.peaceSeconds + r.matchSeconds && w.winner === null) {
      w.winner = w.scores[0] === w.scores[1] ? null : w.scores[0] > w.scores[1] ? 0 : 1;
      w.winReason = 'time limit';
    }
  }

  /** Sandbox: treasuries and building stores are kept full so every feature can be tried at once. */
  private restock() {
    for (const p of this.world.players) for (const res of this.ruleset.resources) if (!this.isGood(res.id)) p.res[res.id] = res.cap;
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
      // line structures take their time per km (a bridge also a fixed minute to start)
      b.progress = Math.min(1, b.progress + dt / ((d.buildTime * (b.size ?? 1) + (d.spansWater ? 60 : 0)) * this.ruleset.rules.buildTimeMult));
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

  /** Side last seen for grid cells near the moving front, and the contested ones by key. */
  private cellSide = new Map<number, { side: Team; seen: number }>();
  private libByKey = new Map<number, LiberatedCell>();
  private static cellKey(ix: number, iy: number) {
    return ix * 100000 + iy;
  }
  /** Contested (grey) ground at this position, if any: freshly taken ground or the penetration area around troops. */
  liberatedAt(p: LngLat): LiberatedCell | undefined {
    const key = Sim.cellKey(Math.floor(p[0] / LIBERATED_CELL.lng), Math.floor(p[1] / LIBERATED_CELL.lat));
    const c = this.libByKey.get(key);
    if (c && !c.free) return c;
    const pen = this.penByKey.get(key);
    return pen ? { ix: pen.ix, iy: pen.iy, team: pen.team, quiet: 0, free: false } : undefined;
  }
  /** Penetration area (DeepState's grey zone): ground beyond the line where a side's troops are, kept a minute after they go. */
  private penByKey = new Map<number, { ix: number; iy: number; team: Team; until: number }>();

  /**
   * Ground changing hands, checked once a second (as DeepState draws it): cells within 2 km of the moving parts of the front
   * are watched. One that changes hands turns grey for the side that took it; once no enemy ground troops have been within
   * 3 km of it for `liberateSeconds`, a Ukrainian gain turns blue (liberated) and a Russian one simply becomes occupied.
   * Grey ground that is lost again before then just goes back.
   */
  private liberation() {
    const w = this.world;
    const r = this.ruleset.rules;
    const { lng: cw, lat: ch } = LIBERATED_CELL;
    const watch = (n: FrontNode) => {
      if (Math.abs(n.v) < 1e-4) return;
      const cx = Math.floor(n.lng / cw), cy = Math.floor(n.lat / ch);
      const rx = Math.ceil(2 / (kmPerDegLng(n.lat) * cw)), ry = Math.ceil(2 / (111.32 * ch));
      for (let ix = cx - rx; ix <= cx + rx; ix++) {
        for (let iy = cy - ry; iy <= cy + ry; iy++) {
          const key = Sim.cellKey(ix, iy);
          const side = this.side([(ix + 0.5) * cw, (iy + 0.5) * ch]);
          const was = this.cellSide.get(key);
          const now = Math.floor(w.time);
          if (was) was.seen = now;
          else this.cellSide.set(key, { side, seen: now });
          if (!was || was.side === side) continue;
          was.side = side;
          const cell = this.libByKey.get(key);
          this.libByKey.delete(key);
          this.libVersion++;
          // grey ground taken straight back simply returns; anything else is contested by the side that took it
          if (cell && !cell.free && cell.team !== side) continue;
          if (this.libByKey.size < 60000) this.libByKey.set(key, { ix, iy, team: side, quiet: 0, free: false });
        }
      }
    };
    w.front.forEach(watch);
    for (const p of w.pockets) p.nodes.forEach(watch);
    // forget stretches of front that have been quiet for a while
    if (w.tick % (r.tickRate * 60) === 0) for (const [k, v] of this.cellSide) if (w.time - v.seen > 60) this.cellSide.delete(k);
    // grey ground settles once the enemy has stayed away long enough (checked every other second, half the cells each time)
    const odd = Math.floor(w.time) % 2;
    for (const [key, c] of this.libByKey) {
      if ((c.ix + c.iy) % 2 !== odd) continue;
      const at: LngLat = [(c.ix + 0.5) * cw, (c.iy + 0.5) * ch];
      if (this.side(at) !== c.team) {
        this.libByKey.delete(key);
        this.libVersion++;
        continue;
      }
      if (c.free) continue;
      let enemy = false;
      this.near(this.unitGrid, at, 3, (u) => {
        if (!enemy && u.team !== c.team && !u.embarkedIn && this.defs.u.get(u.def)!.kind !== 'air' && distKm(u.pos, at) <= 3) enemy = true;
      });
      c.quiet = enemy ? 0 : c.quiet + 2;
      if (c.quiet < r.liberateSeconds) continue;
      if (c.team === 0) (c.free = true), (c.freedAt = w.time);
      else this.libByKey.delete(key);
      this.libVersion++;
    }
    // recently liberated ground fades to plain blue after five minutes
    for (const c of this.libByKey.values()) if (c.free && c.freedAt !== undefined && w.time - c.freedAt > 300) (c.freedAt = undefined), this.libVersion++;
    this.penetration();
    if (this.libVersion !== this.libSent) (w.liberated = [...this.libByKey.values()]), (this.libSent = this.libVersion), (this.libRuns = null);
  }

  /** Grey around every ground unit standing beyond its side's line (2 km), lasting 60 s after it leaves. */
  private penetration() {
    const w = this.world;
    const { lng: cw, lat: ch } = LIBERATED_CELL;
    for (const u of w.units) {
      if (u.embarkedIn || this.defs.u.get(u.def)!.kind === 'air' || this.side(u.pos) === u.team) continue;
      const cx = Math.floor(u.pos[0] / cw), cy = Math.floor(u.pos[1] / ch);
      const rx = Math.ceil(2 / (kmPerDegLng(u.pos[1]) * cw)), ry = Math.ceil(2 / (111.32 * ch));
      for (let ix = cx - rx; ix <= cx + rx; ix++) {
        for (let iy = cy - ry; iy <= cy + ry; iy++) {
          const at: LngLat = [(ix + 0.5) * cw, (iy + 0.5) * ch];
          if (distKm(at, u.pos) > 2 || this.side(at) === u.team) continue; // only the far side of the line
          const key = Sim.cellKey(ix, iy);
          const was = this.penByKey.get(key);
          if (!was || was.team !== u.team) this.libVersion++;
          if (this.penByKey.size < 30000 || was) this.penByKey.set(key, { ix, iy, team: u.team, until: w.time + 60 });
        }
      }
    }
    for (const [key, c] of this.penByKey) {
      if (c.until < w.time || this.side([(c.ix + 0.5) * cw, (c.iy + 0.5) * ch]) === c.team) (this.penByKey.delete(key), this.libVersion++);
    }
  }
  /** Bumped whenever the contested ground changes; snapshots resend it only then. */
  libVersion = 0;
  private libSent = 0;
  private libRuns: number[] | null = null;
  /** Contested ground as runs along each row of cells: [iy, team, firstIx, length, …] (compact for the wire). */
  liberatedRuns(): number[] {
    if (this.libRuns) return this.libRuns;
    const kind = (c: LiberatedCell) => (c.free ? (c.freedAt !== undefined ? 3 : 2) : c.team);
    // the penetration area is grey too (where no taken/liberated cell lies already)
    const pen: LiberatedCell[] = [];
    for (const [key, p] of this.penByKey) if (!this.libByKey.has(key)) pen.push({ ix: p.ix, iy: p.iy, team: p.team, quiet: 0, free: false });
    const cells = [...this.world.liberated, ...pen].sort((a, b) => a.iy - b.iy || kind(a) - kind(b) || a.ix - b.ix);
    const out: number[] = [];
    for (let i = 0; i < cells.length; ) {
      const c = cells[i];
      let n = 1;
      while (i + n < cells.length && cells[i + n].iy === c.iy && kind(cells[i + n]) === kind(c) && cells[i + n].ix === c.ix + n) n++;
      out.push(c.iy, kind(c), c.ix, n);
      i += n;
    }
    return (this.libRuns = out);
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
      if (u.healing && u.hp < this.maxHp(u)) s.push(['healing', 1]);
      if (u.morale !== undefined && u.morale < 25) s.push(['broken', u.morale / 100]);
      else if (u.morale !== undefined && u.morale < 50) s.push(['lowmorale', this.moraleMult(u)]);
      if (u.ammo !== undefined && d.maxAmmo) {
        if (u.ammo < (d.ammoPerShot ?? 1)) s.push(['noammo', 0]);
        else if (u.ammo / d.maxAmmo < 0.25) s.push(['lowammo', u.ammo / d.maxAmmo]);
        if (u.ammo < d.maxAmmo && this.supplyFor(u)) s.push(['supplied', u.ammo / d.maxAmmo]);
      }
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
        if (!this.canTrain(u)) continue; // sat in without the combat record: leaves as it came
        const next = this.ranks[u.rank + 1];
        u.xp = Math.max(u.xp, next.xp);
        this.rankUp(u);
        u.combat = 0; // the next course needs fresh combat experience
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
          // money and people go to the treasury; goods stay in the building (see `goods`)
          if (!this.isGood(k)) tp.res[k] = Math.min(caps.get(k) ?? 1e9, (tp.res[k] ?? 0) + made / n);
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

  /** Record how the match stands now (for the end-of-match charts); one point per 30 s, the last one replaced at the end. */
  sampleTimeline() {
    const w = this.world;
    const per = <T,>(f: (t: Team) => T): [T, T] => [f(0), f(1)];
    const point = {
      t: Math.round(w.time),
      score: per((t) => Math.round(w.scores[t])),
      units: per((t) => w.units.filter((u) => u.team === t).length),
      buildings: per((t) => w.buildings.filter((b) => b.team === t && b.progress >= 1).length),
      cities: per((t) => w.points.filter((p) => p.owner === t).length),
    };
    const last = w.timeline[w.timeline.length - 1];
    if (last && last.t === point.t) w.timeline[w.timeline.length - 1] = point;
    else if (w.timeline.length < 2000) w.timeline.push(point);
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
      if (b.team !== team || Math.abs(b.pos[1] - pos[1]) > (b.line ? 0.2 : 0.1)) continue;
      const d = this.defs.b.get(b.def)!.defense;
      if (!d || this.reachKm(b, pos) > d.radiusKm) continue;
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

  /**
   * Aiming: a unit with `aimTime` needs that long on a new target before it can fire; switching targets starts over.
   * Returns true while it is still aiming.
   */
  private aiming(u: Unit, d: UnitDef, key: string, dt: number): boolean {
    if (!d.aimTime) return false;
    if (u.aimKey !== key) (u.aimKey = key), (u.aim = d.aimTime);
    u.aim = Math.max(0, (u.aim ?? 0) - dt);
    return u.aim > 0;
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
    target.lastHit = this.world.time;
    // being hit shakes a unit (more the harder the blow)
    if (target.morale !== undefined) target.morale = Math.max(0, target.morale - (dealt / this.maxHp(target)) * 30);
    if (target.hp <= 0 && attacker.team !== target.team) {
      attacker.xp += r.xpPerKill;
      attacker.combat = (attacker.combat ?? 0) + 1;
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
      const d = this.reachKm(b, at); // a bridge or trench is hit anywhere along its length
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
    if (u.fuel === undefined || u.maxFuel === undefined || u.fuel >= u.maxFuel || isStrikeDrone(d) || u.encircled) return; // cut off: no supply
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
      if (t === u || t.team !== u.team || !this.defs.u.get(t.def)!.fuelOnly || distKm(u.pos, t.pos) > 5) continue;
      const have = t.cargo?.res.fuel ?? 0;
      if (have <= 0) continue;
      const take = Math.min(25 * dt, need, have);
      t.cargo!.res.fuel = have - take;
      u.fuel += take;
      return;
    }
    fromStore(['hq'], 8, 15);
  }

  /**
   * Fuel run: drive up to the other vehicle (following it if it moves) and pump fuel across at 20/s. A tanker gives from
   * its load; any other vehicle from its own tank, keeping a quarter for itself.
   */
  private fuelStep(u: Unit, d: UnitDef, dt: number) {
    const t = this.world.units.find((x) => x.id === u.fuelTo && x.hp > 0 && !x.embarkedIn);
    const spare = () => (d.fuelOnly ? u.cargo?.res.fuel ?? 0 : Math.max(0, (u.fuel ?? 0) - (u.maxFuel ?? 0) * 0.25));
    if (!t || t.fuel === undefined || t.maxFuel === undefined || t.fuel >= t.maxFuel - 0.01 || spare() <= 0) return void (u.fuelTo = undefined);
    if (distKm(u.pos, t.pos) > 0.6) {
      // keep closing in; re-plan every few seconds or when the target has moved off
      const stale = !u.path.length || distKm(u.path[u.path.length - 1].p, t.pos) > 0.5;
      if (stale && (u.id + this.world.tick) % 20 === 0) this.orderMove([u], t.pos, false, false, true);
      return;
    }
    u.path = [];
    const give = Math.min(20 * dt, spare(), t.maxFuel - t.fuel);
    if (d.fuelOnly) u.cargo!.res.fuel = (u.cargo!.res.fuel ?? 0) - give;
    else u.fuel = (u.fuel ?? 0) - give;
    t.fuel += give;
  }

  /** What a truck on a route may carry from `from` to `to`: goods the source stores that the destination takes. */
  haulKinds(from: Building, to: Building, d: UnitDef, resType?: string): string[] {
    if (d.fuelOnly) return ['fuel'];
    if (resType && resType !== 'any') return [resType];
    const accepts = this.storageFor(this.defs.b.get(to.def)!);
    const produced = Object.keys(this.defs.b.get(from.def)!.produces ?? {});
    // what the source makes first, then whatever else it keeps; fuel is for tankers
    const kinds = [...new Set([...produced, ...this.storageFor(this.defs.b.get(from.def)!)])].filter((k) => k !== 'fuel' && k !== 'money' && k !== 'people' && k !== 'energy');
    return kinds.filter((k) => !accepts.length || accepts.includes(k));
  }

  /** Where a route stop is (a building or a waypoint); null if the building is gone. */
  private stopPos(st: HaulStop): LngLat | null {
    if (st.pos) return st.pos;
    return this.world.buildings.find((x) => x.id === st.building)?.pos ?? null;
  }

  /** Head for the current stop of the route. */
  private haulGo(u: Unit) {
    const h = u.haul!;
    const at = this.stopPos(h.stops[h.idx]);
    if (at) this.orderMove([u], at, false, false, false);
  }

  /**
   * Delivery rounds: drive from stop to stop in a loop. At a loading stop it takes what the next unloading stop wants
   * (5 s); at the last loading stop before an unload it waits until it has at least `minLoad` (or a full load). At an
   * unloading stop it hands over what the building takes (4 s). Waypoints are just driven through.
   */
  private haulStep(u: Unit, d: UnitDef, dt: number) {
    const h = u.haul!;
    const w = this.world;
    if (!u.cargo || !h.stops?.length) return void (u.haul = undefined);
    const st = h.stops[h.idx];
    const b = st.building !== undefined ? w.buildings.find((x) => x.id === st.building && x.team === u.team) : undefined;
    if (st.action !== 'via' && !b) return void (u.haul = undefined); // a stop's building is gone: the route ends
    const next = () => {
      (h.idx = (h.idx + 1) % h.stops.length), (h.state = 'moving'), (h.timer = undefined), (h.waiting = undefined);
      this.haulGo(u);
    };
    const load = () => Object.values(u.cargo!.res).reduce((a, v) => a + v, 0);
    switch (h.state ?? 'moving') {
      case 'moving': {
        const at = this.stopPos(st)!;
        if (distKm(u.pos, at) <= (st.action === 'via' ? 0.6 : 3.5)) {
          u.path = [];
          if (st.action === 'via') return next();
          (h.state = st.action === 'load' ? 'loading' : 'unloading'), (h.timer = st.action === 'load' ? 5 : 4);
        } else if (!u.path.length && (u.id + w.tick) % 20 === 0) this.haulGo(u); // lost the way: plan again
        break;
      }
      case 'loading': {
        if ((h.timer = (h.timer ?? 5) - dt) > 0) break;
        b!.storage ??= {};
        // what to take: what the next unloading stop wants
        let dest: Building | undefined;
        for (let i = 1; i <= h.stops.length && !dest; i++) {
          const s2 = h.stops[(h.idx + i) % h.stops.length];
          if (s2.action === 'unload') dest = w.buildings.find((x) => x.id === s2.building);
        }
        if (!dest) return void (u.haul = undefined);
        let room = u.cargo.cap - load();
        for (const kind of this.haulKinds(b!, dest, d, h.resType)) {
          if (room <= 0) break;
          const take = Math.min(room, b!.storage[kind] ?? 0);
          if (take <= 0) continue;
          b!.storage[kind] -= take;
          u.cargo.res[kind] = (u.cargo.res[kind] ?? 0) + take;
          room -= take;
        }
        // the last loading stop before unloading: wait for the minimum load (or a full truck)
        let lastLoad = true;
        for (let i = 1; i < h.stops.length; i++) {
          const s2 = h.stops[(h.idx + i) % h.stops.length];
          if (s2.action === 'unload') break;
          if (s2.action === 'load') lastLoad = false;
        }
        if (lastLoad && load() < Math.min(h.minLoad ?? 1, u.cargo.cap) && room > 0) {
          (h.timer = 5), (h.waiting = true);
          break;
        }
        next();
        break;
      }
      case 'unloading': {
        if ((h.timer = (h.timer ?? 4) - dt) > 0) break;
        b!.storage ??= {};
        const accepts = this.storageFor(this.defs.b.get(b!.def)!);
        const cap = this.storageCap(b!);
        for (const [kind, v] of Object.entries(u.cargo.res)) {
          if (accepts.length && !accepts.includes(kind)) continue;
          const put = Math.min(v, Math.max(0, cap - (b!.storage[kind] ?? 0)));
          b!.storage[kind] = (b!.storage[kind] ?? 0) + put;
          u.cargo.res[kind] = v - put;
        }
        next();
        break;
      }
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
      if (u.fuelTo) this.fuelStep(u, d, dt);

      // fire discipline: hold = never, return = only once hit, auto = anything in range
      if ((u.id + w.tick) % r.tickRate === 0) this.resupply(u, d, 1);
      // no rounds left, no shooting
      const perShot = d.ammoPerShot ?? 1;
      const canFire = (!d.maxAmmo || (u.ammo ?? 0) >= perShot) && !peace && u.fireMode !== 'hold' && (u.fireMode !== 'return' || u.hp < this.maxHp(u) - 0.5) && d.damage > 0 && !isStrikeDrone(d);

      // artillery barrage on a chosen area (2 s salvos, 1 km blast, a little scatter)
      let barrage = false;
      if (canFire && u.bombardTarget && d.minRange) {
        const dist = distKm(u.pos, u.bombardTarget);
        if (dist >= minR && dist <= range) {
          barrage = true;
          if (this.aiming(u, d, `b:${u.bombardTarget[0].toFixed(3)},${u.bombardTarget[1].toFixed(3)}`, dt)) {
            // laying the guns on a new area
          } else if (u.cooldown === 0) {
            u.cooldown = 2;
            const ang = Math.random() * Math.PI * 2;
            const spread = Math.random() * 0.4;
            const impact = offsetKm(u.bombardTarget, spread * Math.cos(ang), spread * Math.sin(ang));
            this.shots.push({ def: u.def, team: u.team, from: u.pos, to: impact });
            if (d.maxAmmo) u.ammo = (u.ammo ?? 0) - perShot;
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
            const air = this.defs.u.get(e.def)!.kind === 'air';
            // only anti-aircraft weapons engage drones and missiles; anti-aircraft teams engage nothing else
            if (air ? airDamage <= 0 : d.targets === 'air') return;
            const dist = distKm(u.pos, e.pos);
            if (dist <= best) (best = dist), (tu = e);
          });
          if (!tu && d.targets !== 'air') {
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
      if (!engaged) u.aimKey = undefined; // a gun that loses its target lays again on the next one
      u.transport = !engaged && u.path.length > 0 && u.path[0].road && d.kind !== 'air';
      // guns lay on a new target before the first round
      const aimingNow = !!(tu || tb) && !!d.aimTime && this.aiming(u, d, tu ? `u:${(tu as Unit).id}` : `b:${(tb as Building).id}`, dt);
      if ((tu || tb) && !aimingNow && u.cooldown === 0) {
        u.cooldown = d.minRange ? 2 : 1; // guns fire every 2 s, everything else once a second
        if (d.maxAmmo) u.ammo = (u.ammo ?? 0) - perShot;
        const base = d.damage * rank.damage * (u.encircled ? r.encircledDamageMult : 1) * this.moraleMult(u);
        let dealt: number;
        if (tu) {
          const td = this.defs.u.get(tu.def)!;
          const air = td.kind === 'air';
          // fast missiles are hard to hit
          dealt = air && Math.random() >= (td.interceptChance ?? 1) ? 0 : this.hitUnit(u, tu, base * (air ? d.airDamage ?? r.airDamageDefault : 1));
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
        // a column on the road halts to fight; an attack-move stops for anything it meets; a plain move pushes through
        if (!(engaged && (u.path[0].road || u.attackMove))) this.advance(u, d, dt);
      } else if (!tu && !tb && canFire && !u.haul && !barrage && !d.minRange && u.stance !== 'hold' && u.stance !== undefined) {
        // stance: aggressive units go after what they see; defenders only within 3 km of their post, then walk back
        const post = u.post ?? u.pos;
        const leash = u.stance === 'defend' ? 3 : Infinity;
        let chase: LngLat | null = null;
        let near = d.vision * 0.7;
        const airDamage = d.airDamage ?? r.airDamageDefault;
        this.near(this.unitGrid, u.pos, near, (e) => {
          if (e.team === u.team || e.embarkedIn) return;
          // only close with what it can actually hit
          if (this.defs.u.get(e.def)!.kind === 'air' ? airDamage <= 0 : d.targets === 'air') return;
          if (distKm(e.pos, post) > leash) return;
          const dist = distKm(u.pos, e.pos);
          if (dist < near) (near = dist), (chase = e.pos);
        });
        if (chase && this.isPlayableGround(chase)) this.stepOffRoad(u, d, chase, d.speed * dt * ((u.fuel ?? 1) > 0 ? 1 : 0.2));
        else if (!chase && u.stance === 'defend' && distKm(u.pos, post) > 0.3) this.stepOffRoad(u, d, post, d.speed * dt);
      }
      if (!u.path.length && !tu && !tb && u.retreatAt && !u.retreating && d.kind !== 'air' && w.tick % r.tickRate === u.id % r.tickRate && u.hp < this.maxHp(u) * u.retreatAt) this.fallBack(u);
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
      target.lastHit = this.world.time;
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

  /** Badly hurt: fall back to the nearest field hospital, else the nearest base, and hold there. */
  private fallBack(u: Unit) {
    // hospitals first (they heal), then bases; the nearest of the best kind
    const rank = (b: Building) => (this.defs.b.get(b.def)!.heals ? 0 : 1);
    let best: Building | null = null;
    for (const b of this.world.buildings) {
      if (b.team !== u.team || b.progress < 1 || !(this.defs.b.get(b.def)!.heals || b.def === 'hq')) continue;
      if (!best || rank(b) < rank(best) || (rank(b) === rank(best) && distKm(b.pos, u.pos) < distKm(best.pos, u.pos))) best = b;
    }
    if (!best) return;
    u.retreating = true;
    this.orderMove([u], best.pos, false, false, false);
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
    // locked on: the aim point follows the target while it lives
    if (strike && u.lockOn && u.path.length === 1) {
      const t = u.lockOn.unit !== undefined ? this.world.units.find((x) => x.id === u.lockOn!.unit && x.hp > 0) : this.world.buildings.find((x) => x.id === u.lockOn!.building);
      if (t) u.path[0].p = [t.pos[0], t.pos[1]];
      else u.lockOn = undefined;
    }
    const speed = d.speed;
    const wp = u.path[0];
    const dx = (wp.p[0] - u.pos[0]) * kmPerDegLng(u.pos[1]);
    const dy = (wp.p[1] - u.pos[1]) * 111.32;
    const want = Math.abs(dx) + Math.abs(dy) > 1e-9 ? (Math.atan2(dx, dy) * 180) / Math.PI : u.bearing ?? 0;
    u.bearing ??= want;
    const diff = ((want - u.bearing + 540) % 360) - 180;
    // strike craft pull hard into the terminal dive (the last 3 km) so they hit the spot instead of circling past it
    const terminal = strike && u.path.length === 1 && distKm(u.pos, wp.p) < 3;
    const turn = (d.turnRate ?? 30) * (terminal ? 6 : 1) * dt;
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
    // strike craft hit when the next step would carry them onto (or past) the aim point, and they hit it exactly
    const hitting = strike && u.path.length === 1;
    const reach = hitting ? Math.max(0.08, step * 1.05) : Math.max(0.6, speed * 2.5);
    if (left > reach && !(left <= (hitting ? reach * 2 : 0.8) && off > 90)) return;
    if (hitting) u.pos = [wp.p[0], wp.p[1]];
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
  /** Damage multiplier from morale: full above 50, down to half at 0. */
  moraleMult(u: Unit): number {
    const m = u.morale ?? 100;
    return m >= 50 ? 1 : 0.5 + m / 100;
  }

  /**
   * Morale, once a second. Encircled units lose 2 a second, units out of ammo 0.5; a unit out of the fight for 10 s
   * recovers 1 a second, 3 near its base or a field hospital. A unit still encircled at zero morale surrenders: it is
   * lost and the other side scores for it.
   */
  private morale() {
    const w = this.world;
    const r = this.ruleset.rules;
    const havens = w.buildings.filter((b) => b.progress >= 1 && (b.def === 'hq' || this.defs.b.get(b.def)!.heals));
    for (const u of w.units) {
      if (u.morale === undefined || u.embarkedIn) continue;
      const d = this.defs.u.get(u.def)!;
      let delta = 0;
      if (u.encircled) delta -= 2;
      if (d.maxAmmo && (u.ammo ?? 0) < (d.ammoPerShot ?? 1)) delta -= 0.5;
      if (!delta && w.time - (u.lastHit ?? -1e9) >= 10) delta = havens.some((b) => b.team === u.team && distKm(b.pos, u.pos) <= 8) ? 3 : 1;
      u.morale = clamp(u.morale + delta, 0, 100);
      if (u.encircled && u.morale <= 0) {
        u.hp = 0; // surrenders
        w.scores[(1 - u.team) as Team] += r.cauldronScore / 2;
        this.hooks.emit('unitSurrendered', { id: u.id, def: u.def, owner: u.owner });
      }
    }
  }

  /**
   * Medics, mechanics and field hospitals, once a second: every hurt unit in reach of a healer for its kind gets the best
   * rate on offer (healers do not stack). Nobody heals until it has been out of the fight (not hit) for 10 s.
   */
  private healing() {
    const w = this.world;
    const kindOf = (d: UnitDef): 'foot' | 'vehicle' | null => (d.kind === 'air' ? null : (d.mobility ?? 'foot') === 'foot' ? 'foot' : 'vehicle');
    const healers: { team: Team; pos: LngLat; h: NonNullable<UnitDef['heals']> }[] = [];
    for (const u of w.units) {
      const h = this.defs.u.get(u.def)!.heals;
      if (h && !u.embarkedIn) healers.push({ team: u.team, pos: u.pos, h });
    }
    for (const b of w.buildings) {
      const h = this.defs.b.get(b.def)!.heals;
      if (h && b.progress >= 1) healers.push({ team: b.team, pos: b.pos, h });
    }
    if (!healers.length) return;
    for (const u of w.units) {
      if (u.embarkedIn || w.time - (u.lastHit ?? -1e9) < 10) continue;
      const d = this.defs.u.get(u.def)!;
      const max = this.maxHp(u);
      const kind = kindOf(d);
      if (!kind || u.hp >= max) continue;
      let rate = 0;
      for (const x of healers) if (x.team === u.team && x.h.targets === kind && x.h.perSecond > rate && distKm(x.pos, u.pos) <= x.h.radiusKm) rate = x.h.perSecond;
      if (rate) u.hp = Math.min(max, u.hp + max * rate);
      if (u.retreating && u.hp >= max * 0.9) u.retreating = false; // patched up: ready for orders again
      u.healing = rate > 0;
    }
  }

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
      const c = this.crossings(u.team).find((x) => this.inCrossing(x, u.pos));
      if (c) mult = c.speed;
    }
    const next = moveToward(u.pos, to, budgetKm * mult);
    if (this.foreign(next) && !this.foreign(u.pos)) return false;
    if (blocked && this.terrain!.isBarrier(next) && !this.terrain!.isBarrier(u.pos) && !this.crossings(u.team).some((x) => this.inCrossing(x, next))) return false;
    u.pos = next;
    return true;
  }

  private advance(u: Unit, d: UnitDef, dt: number) {
    // out of fuel: it can still crawl at a fifth of its speed (pushed, towed, coasting) until a tanker comes
    const dry = u.fuel !== undefined && u.fuel <= 0;
    const base = (u.cap ? Math.min(d.speed, u.cap) : d.speed) * (u.sprint && !dry ? 2 : 1) * (dry ? 0.2 : 1);
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
        u.fuel = Math.max(0, u.fuel - moved * this.ruleset.rules.fuelPerKm * (u.sprint ? 1.5 : 1));
        if (u.fuel <= 0) u.sprint = false;
      }
    }
    if (!u.path.length) (u.target = null), (u.cap = 0), (u.transport = false), (u.attackMove = false), (u.post = [u.pos[0], u.pos[1]]);
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
      abstract[p.team] += (4 + Math.sqrt(p.res.people ?? 0) + Math.sqrt(this.goods(p).metal ?? 0)) * r.abstractPower;
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

  /**
   * The map follows the troops at once (checked every second): a ground unit that has pushed up to 4 km past the line with
   * no enemy ground troops within 2 km drags the nearest stretch of front forward so it stands on its own side again.
   * Raiders deeper than that only make grey (penetration) ground. Returns whether the line moved.
   */
  private breakthrough(): boolean {
    const w = this.world;
    const f = w.front;
    if (f.length < 5) return false;
    const moved = new Set<number>();
    for (const u of w.units) {
      if (u.embarkedIn || this.defs.u.get(u.def)!.kind === 'air' || u.hp <= 0) continue;
      if (w.pockets.some((p) => pointInRing(p.nodes, u.pos))) continue; // cauldrons have their own line
      const signed = distToFrontKm(f, u.pos) * (u.team === 0 ? 1 : -1); // < 0: beyond its line
      if (signed >= 0 || signed < -4) continue;
      let opposed = false;
      this.near(this.unitGrid, u.pos, 2, (e) => {
        if (!opposed && e.team !== u.team && !e.embarkedIn && this.defs.u.get(e.def)!.kind !== 'air' && distKm(e.pos, u.pos) <= 2) opposed = true;
      });
      if (opposed) continue;
      const i = nearestNode(f, u.pos);
      if (i <= 0 || i >= f.length - 1 || moved.has(i)) continue;
      // push the node (and, less, its neighbours) along the normal past the unit; between two nodes the line gives
      // less, so keep pushing (a few times at most) until the unit stands on its own side
      const dir = u.team === 0 ? 1 : -1; // the normal points into team 1's ground
      const touched: number[] = [];
      for (let round = 0, beyond = -signed; round < 4 && beyond > 0; round++) {
        const push = beyond + 0.5;
        for (const [k, share] of [[0, 1], [-1, 0.6], [1, 0.6], [-2, 0.3], [2, 0.3]] as const) {
          const j = i + k;
          if (j <= 0 || j >= f.length - 1 || (moved.has(j) && !touched.includes(j))) continue;
          const [nx, ny] = normalOf(f[j - 1], f[j], f[j + 1]);
          const lng = f[j].lng + (nx * dir * push * share) / kmPerDegLng(f[j].lat);
          const lat = f[j].lat + (ny * dir * push * share) / 111.32;
          if (this.terrain?.isBarrier([lng, lat]) && !this.terrain.isBarrier([f[j].lng, f[j].lat])) continue; // not across a river
          (f[j].lng = lng), (f[j].lat = lat);
          touched.push(j);
        }
        beyond = -distToFrontKm(f, u.pos) * (u.team === 0 ? 1 : -1);
      }
      for (const j of touched) moved.add(j);
    }
    return moved.size > 0;
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
      const b = w.buildings[i];
      // a depot on contested ground stands as long as that grey zone does
      if (this.side(b.pos) !== b.team && !(this.defs.b.get(b.def)!.buildInGrey && this.inOwnGrey(b.team, b.pos))) lost.push(b);
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
