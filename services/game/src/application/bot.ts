import { type BotDifficulty, type Building, distKm, distToFrontKm, inDeposit, isReconDrone, isStrikeDrone, moveToward, nearestNode, offsetKm, type LngLat, type Player, type Sim, type Team, type Unit } from '@sw/core';

const BUILD_ORDER = [
  'military_base',
];

/** Selects a random position near a road far from the front (>= 200 km): West of Ukraine for UA, East for RU, with >= 100 km spacing from other HQs */
function findBotHqPos(sim: Sim, team: Team): LngLat {
  const roads = sim.roads?.nodes ?? [];
  const front = sim.world.front;
  const isDry = (pt: LngLat) => sim.isPlayableGround(pt) && sim.terrainAt(pt).id !== 'water';
  const existingHqs = sim.world.buildings.filter((b) => b.def === 'hq');
  const farFromHqs = (pt: LngLat) => !existingHqs.some((h) => distKm(h.pos, pt) < 100);

  const candidates: LngLat[] = [];
  const step = Math.max(1, Math.floor(roads.length / 2500));
  for (let i = 0; i < roads.length; i += step) {
    const pt = roads[i];
    if (!isDry(pt) || !farFromHqs(pt)) continue;
    if (team === 0) {
      // Ukraine: West (lng <= 32.5), on Ukrainian side, far from front (>= 200 km)
      if (pt[0] <= 32.5 && sim.side(pt) === 0 && distToFrontKm(front, pt) >= 200) {
        candidates.push(pt);
      }
    } else {
      // Russia: East (lng >= 38.0), on Russian side, far from front (<= -200 km)
      if (pt[0] >= 38.0 && sim.side(pt) === 1 && distToFrontKm(front, pt) <= -200) {
        candidates.push(pt);
      }
    }
  }

  // Fallback with slightly relaxed distance if crowded, preserving HQ spacing
  if (!candidates.length) {
    for (let i = 0; i < roads.length; i += step) {
      const pt = roads[i];
      if (!isDry(pt) || !farFromHqs(pt)) continue;
      if (team === 0) {
        if (pt[0] <= 33.5 && sim.side(pt) === 0 && distToFrontKm(front, pt) >= 160) {
          candidates.push(pt);
        }
      } else {
        if (pt[0] >= 37.5 && sim.side(pt) === 1 && distToFrontKm(front, pt) <= -160) {
          candidates.push(pt);
        }
      }
    }
  }

  if (candidates.length) {
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const ang = Math.random() * Math.PI * 2;
    const r = 0.05 + Math.random() * 0.1;
    const nudged = offsetKm(pick, Math.cos(ang) * r, Math.sin(ang) * r);
    if (isDry(nudged) && farFromHqs(nudged)) return nudged;
    return pick;
  }

  const spawns = sim.map.spawns[team];
  return spawns && spawns[0] ? spawns[0] : (team === 0 ? [26.0, 49.5] : [41.0, 48.0]);
}

/** Finds a location for a military base across team territory, prioritizing 20-80 km from the front line */
function findBotMilitaryBasePos(sim: Sim, team: Team): LngLat | null {
  const roads = sim.roads?.nodes ?? [];
  const front = sim.world.front;
  const isDry = (pt: LngLat) => sim.isPlayableGround(pt) && sim.terrainAt(pt).id !== 'water';
  const existingBases = sim.world.buildings.filter((b) => b.def === 'military_base');
  const farFromBases = (pt: LngLat) => !existingBases.some((b) => distKm(b.pos, pt) < 20);

  const priorityCandidates: LngLat[] = [];
  const allCandidates: LngLat[] = [];
  const step = Math.max(1, Math.floor(roads.length / 2500));

  for (let i = 0; i < roads.length; i += step) {
    const pt = roads[i];
    if (!isDry(pt) || sim.side(pt) !== team || !farFromBases(pt)) continue;
    const dist = Math.abs(distToFrontKm(front, pt));
    if (dist < 5) continue; // avoid active front edge

    allCandidates.push(pt);
    // Priority zone: 25-75 km from the front line (leaves margin for nudging and front movement)
    if (dist >= 25 && dist <= 75) {
      priorityCandidates.push(pt);
    }
  }

  const list = priorityCandidates.length ? priorityCandidates : allCandidates;
  if (!list.length) return null;

  for (let attempt = 0; attempt < 8; attempt++) {
    const pick = list[Math.floor(Math.random() * list.length)];
    const ang = Math.random() * Math.PI * 2;
    const r = 0.05 + Math.random() * 0.15;
    const nudged = offsetKm(pick, Math.cos(ang) * r, Math.sin(ang) * r);
    if (isDry(nudged) && sim.side(nudged) === team && farFromBases(nudged)) return nudged;
    if (farFromBases(pick)) return pick;
  }
  return list[0];
}

/** Finds a location for a warehouse at ~80 km distance from the front line, maintaining >= 100 km spacing from other warehouses */
function findBotWarehousePos(sim: Sim, team: Team): LngLat | null {
  const roads = sim.roads?.nodes ?? [];
  const front = sim.world.front;
  const isDry = (pt: LngLat) => sim.isPlayableGround(pt) && sim.terrainAt(pt).id !== 'water';
  const existingWarehouses = sim.world.buildings.filter((b) => b.def === 'warehouse');
  const farFromWarehouses = (pt: LngLat) => !existingWarehouses.some((b) => distKm(b.pos, pt) < 100);

  const idealCandidates: LngLat[] = [];
  const acceptableCandidates: LngLat[] = [];
  const step = Math.max(1, Math.floor(roads.length / 2500));

  for (let i = 0; i < roads.length; i += step) {
    const pt = roads[i];
    if (!isDry(pt) || sim.side(pt) !== team || !farFromWarehouses(pt)) continue;
    const dist = Math.abs(distToFrontKm(front, pt));
    if (dist < 20) continue;

    // Target ~80 km from the front line (65-95 km ideal)
    if (dist >= 65 && dist <= 95) {
      idealCandidates.push(pt);
    } else if (dist >= 50 && dist <= 120) {
      acceptableCandidates.push(pt);
    }
  }

  const list = idealCandidates.length ? idealCandidates : acceptableCandidates;
  if (!list.length) return null;

  for (let attempt = 0; attempt < 8; attempt++) {
    const pick = list[Math.floor(Math.random() * list.length)];
    const ang = Math.random() * Math.PI * 2;
    const r = 0.05 + Math.random() * 0.15;
    const nudged = offsetKm(pick, Math.cos(ang) * r, Math.sin(ang) * r);
    if (isDry(nudged) && sim.side(nudged) === team && farFromWarehouses(nudged)) return nudged;
    if (farFromWarehouses(pick)) return pick;
  }
  return list[0];
}

/** Finds a location for a housing district inside a friendly-controlled city (max 2 per city) */
function findBotHousingPos(sim: Sim, team: Team): LngLat | null {
  const w = sim.world;
  const limit = sim.ruleset.rules.cityHousingLimit ?? 2;

  // Find friendly cities currently controlled by the team with < limit housing blocks
  const candidates: { cp: (typeof sim.map.capturePoints)[0]; count: number }[] = [];
  for (let i = 0; i < sim.map.capturePoints.length; i++) {
    const cp = sim.map.capturePoints[i];
    if (w.points[i]?.owner !== team) continue;
    const count = w.buildings.filter((b) => b.def === 'housing' && sim.inCity(b.pos, cp)).length;
    if (count < limit) {
      candidates.push({ cp, count });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.count - b.count);

  for (const { cp } of candidates) {
    if (
      sim.isPlayableGround(cp.pos) &&
      sim.terrainAt(cp.pos).id !== 'water' &&
      !sim.foreign(cp.pos) &&
      !w.buildings.some((b) => b.def === 'housing' && distKm(b.pos, cp.pos) < 0.1) &&
      sim.cityAt(cp.pos)?.id === cp.id
    ) {
      return cp.pos;
    }

    for (const r of [0.15, 0.3, 0.5, 0.8, 1.2]) {
      for (let step = 0; step < 8; step++) {
        const ang = (step * Math.PI) / 4;
        const cand = offsetKm(cp.pos, Math.cos(ang) * r, Math.sin(ang) * r);
        if (
          sim.isPlayableGround(cand) &&
          sim.terrainAt(cand).id !== 'water' &&
          !sim.foreign(cand) &&
          sim.cityAt(cand)?.id === cp.id &&
          !w.buildings.some((b) => b.def === 'housing' && distKm(b.pos, cand) < 0.1)
        ) {
          return cand;
        }
      }
    }
  }

  return null;
}

/** Finds a valid placement for a mine or oil rig on an authentic resource deposit */
function findBotDepositPos(sim: Sim, team: Team, type: 'iron' | 'oil'): LngLat | null {
  const deposits = (sim.deposits ?? []).filter((d) => d.type === type && d.team === team);
  if (!deposits.length) return null;

  const bDef = sim.defs.b.get(type === 'iron' ? 'mine' : 'oil_rig');
  if (!bDef) return null;

  const shuffled = [...deposits].sort(() => Math.random() - 0.5);

  for (const dep of shuffled) {
    const spots: LngLat[] = [];
    if (inDeposit(type, dep.center, team, sim.deposits)) spots.push(dep.center);
    for (const rFrac of [0.05, 0.15, 0.25, 0.35, 0.5, 0.65, 0.8]) {
      const r = dep.radiusKm * rFrac;
      for (let i = 0; i < 16; i++) {
        const ang = (i * Math.PI * 2) / 16;
        spots.push(offsetKm(dep.center, Math.cos(ang) * r, Math.sin(ang) * r));
      }
    }

    for (const spot of spots) {
      if (!inDeposit(type, spot, team, sim.deposits)) continue;
      if (!sim.isPlayableGround(spot) || sim.terrainAt(spot).id === 'water') continue;
      if (sim.side(spot) !== team) continue;
      const distFromFront = Math.abs(distToFrontKm(sim.world.front, spot));
      if (distFromFront < sim.ruleset.rules.minBuildDistanceFromFront * (bDef.category === 'civil' ? 2 : 1)) continue;
      const clash = sim.world.buildings.find((x) => x.def !== 'housing' && distKm(x.pos, spot) < Math.max(1.0, sim.spacingBetween(bDef, x.def, false)));
      if (!clash) return spot;
    }
  }

  return null;
}

/** A deliberately simple opponent: builds economy, fortifies, trains a mixed army and pushes the nearest enemy point. */
export class Bot {
  private step = 0;
  private lastThink = -100;
  private lastArmyOrder = -100;
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

    // supply trucks and troops first, then whatever the rest of the money buys
    this.train(sim, p);
    this.build(sim, p);
    this.command(sim, p);
  }

  private build(sim: Sim, p: Player) {
    const w = sim.world;
    const mine = w.buildings.filter((b) => b.owner === p.id);
    if (mine.filter((b) => b.progress < 1).length >= 3) return;
    const hq = mine.find((b) => b.def === 'hq');
    if (!hq) {
      const hqPos = findBotHqPos(sim, p.team);
      sim.apply(p.id, { type: 'build', def: 'hq', pos: hqPos });
      return;
    }

    // Build warehouses at ~80 km from the front line (>= 100 km apart)
    const whDef = sim.defs.b.get('warehouse');
    if (whDef && sim.canPay(p, whDef.cost)) {
      const myWarehouses = mine.filter((b) => b.def === 'warehouse');
      if (myWarehouses.length < 1) {
        const whPos = findBotWarehousePos(sim, p.team);
        if (whPos) {
          sim.apply(p.id, { type: 'build', def: 'warehouse', pos: whPos });
        }
      }
    }

    // Build military base (up to 1 per bot, provides troop training)
    const mbDef = sim.defs.b.get('military_base');
    if (mbDef && sim.canPay(p, mbDef.cost)) {
      const myBases = mine.filter((b) => b.def === 'military_base');
      if (myBases.length < 1) {
        const pos = findBotMilitaryBasePos(sim, p.team);
        if (pos) {
          sim.apply(p.id, { type: 'build', def: 'military_base', pos });
        }
      }
    }

    // Build housing districts (up to 2 per city, provides passive income)
    const houseDef = sim.defs.b.get('housing');
    if (houseDef && sim.canPay(p, houseDef.cost)) {
      const myHousing = mine.filter((b) => b.def === 'housing');
      if (myHousing.length < 2) {
        const hPos = findBotHousingPos(sim, p.team);
        if (hPos) {
          sim.apply(p.id, { type: 'build', def: 'housing', pos: hPos });
        }
      }
    }

    // Build mine (up to 1 per bot) in friendly iron deposit
    const mineDef = sim.defs.b.get('mine');
    if (mineDef && sim.canPay(p, mineDef.cost)) {
      const myMines = mine.filter((b) => b.def === 'mine');
      if (myMines.length < 1) {
        const spot = findBotDepositPos(sim, p.team, 'iron');
        if (spot) {
          sim.apply(p.id, { type: 'build', def: 'mine', pos: spot });
        }
      }
    }

    // Build oil rig (up to 1 per bot) in friendly oil deposit
    const oilDef = sim.defs.b.get('oil_rig');
    if (oilDef && sim.canPay(p, oilDef.cost)) {
      const myRigs = mine.filter((b) => b.def === 'oil_rig');
      if (myRigs.length < 1) {
        const spot = findBotDepositPos(sim, p.team, 'oil');
        if (spot) {
          sim.apply(p.id, { type: 'build', def: 'oil_rig', pos: spot });
        }
      }
    }

    // Build refinery (up to 2 per team)
    const refDef = sim.defs.b.get('refinery');
    if (refDef && sim.canPay(p, refDef.cost)) {
      const teamRefineries = w.buildings.filter((b) => b.team === p.team && b.def === 'refinery');
      if (teamRefineries.length < 2) {
        if (p.team === 0) {
          const kremSpot: LngLat = [33.4397 + (Math.random() - 0.5) * 0.08, 49.0703 + (Math.random() - 0.5) * 0.08];
          const hasKrem = teamRefineries.some((b) => distKm(b.pos, [33.4397, 49.0703]) <= 25);
          const spot = !hasKrem ? kremSpot : offsetKm(hq.pos, 15, 15);
          if (sim.isPlayableGround(spot) && sim.side(spot) === 0) {
            sim.apply(p.id, { type: 'build', def: 'refinery', pos: spot });
          }
        } else {
          const rostovSpot: LngLat = [39.7203 + (Math.random() - 0.5) * 0.1, 47.2357 + (Math.random() - 0.5) * 0.1];
          const hasRostov = teamRefineries.some((b) => distKm(b.pos, [39.7203, 47.2357]) <= 65);
          const spot = !hasRostov ? rostovSpot : offsetKm(hq.pos, 15, 15);
          if (sim.isPlayableGround(spot) && sim.side(spot) === 1) {
            sim.apply(p.id, { type: 'build', def: 'refinery', pos: spot });
          }
        }
      }
    }

    // Build steel mill (up to 1 per bot, >= 50km from any mine)
    const steelDef = sim.defs.b.get('steel_mill');
    if (steelDef && sim.canPay(p, steelDef.cost)) {
      const mySteelMills = mine.filter((b) => b.def === 'steel_mill');
      if (mySteelMills.length < 1) {
        const anchor = mine.find((b) => b.def === 'military_base') ?? hq;
        if (anchor) {
          const allMines = w.buildings.filter((b) => b.def === 'mine');
          for (let attempt = 0; attempt < 20; attempt++) {
            const angle = (attempt / 20) * 2 * Math.PI;
            const dist = 52 + (attempt % 4) * 8;
            const spot = offsetKm(anchor.pos, Math.cos(angle) * dist, Math.sin(angle) * dist);
            if (sim.isPlayableGround(spot) && sim.side(spot) === p.team) {
              const tooClose = allMines.some((m) => distKm(m.pos, spot) < 50);
              if (!tooClose) {
                const res = sim.apply(p.id, { type: 'build', def: 'steel_mill', pos: spot });
                if (res.ok) break;
              }
            }
          }
        }
      }
    }

    // Build ammo factory (up to 1 per bot, >= 50km from any steel mill)
    const ammoDef = sim.defs.b.get('ammo_factory');
    if (ammoDef && sim.canPay(p, ammoDef.cost)) {
      const myAmmo = mine.filter((b) => b.def === 'ammo_factory');
      if (myAmmo.length < 1) {
        const allSteelMills = w.buildings.filter((b) => b.def === 'steel_mill');
        const anchor = mine.find((b) => b.def === 'military_base') ?? hq;
        if (anchor) {
          for (let attempt = 0; attempt < 20; attempt++) {
            const angle = (attempt / 20) * 2 * Math.PI + 0.3;
            const dist = 52 + (attempt % 4) * 8;
            const spot = offsetKm(anchor.pos, Math.cos(angle) * dist, Math.sin(angle) * dist);
            if (sim.isPlayableGround(spot) && sim.side(spot) === p.team) {
              const tooClose = allSteelMills.some((s) => distKm(s.pos, spot) < 50);
              if (!tooClose) {
                const res = sim.apply(p.id, { type: 'build', def: 'ammo_factory', pos: spot });
                if (res.ok) break;
              }
            }
          }
        }
      }
    }
  }


  private train(sim: Sim, p: Player) {
    const w = sim.world;
    const mySide = p.team === 0 ? 'ua' : 'ru';
    const count = (id: string) => w.units.filter((u) => u.owner === p.id && u.def === id).length;
    for (const b of w.buildings) {
      // factories are shared by the team; the barracks/base a bot uses are its own
      if (b.team !== p.team || b.progress < 1 || !sim.usable(b, p.id) || (b.owner !== p.id && b.def !== 'machine_factory' && b.def !== 'drone_factory' && b.def !== 'missile_factory')) continue;
      const d = sim.defs.b.get(b.def)!;
      if (b.def === 'military_base') {
        const money = p.res.money ?? 0;
        if (!w.queue.some((q) => q.building === b.id)) {
          const infCount = count('infantry');
          const humveeCount = count('humvee');
          const humveeMgCount = count('humvee_mg');
          const truckCount = count('truck');

          // Ensure bot buys vehicles (truck, humvee) and infantry in balanced numbers:
          // Truck: 125 (capacity 5 squads), Humvee: 150 (capacity 1 squad), Humvee MG: 200 (mobile AA), Infantry: 100
          const troopTrucks = w.units.filter((u) => u.owner === p.id && u.def === 'truck' && !u.haul).length;
          const humvees = w.units.filter((u) => u.owner === p.id && u.def === 'humvee').length;
          const transportCapacity = troopTrucks * 5 + humvees * 1;

          if (infCount < 1 && money >= 100) {
            sim.apply(p.id, { type: 'train', building: b.id, unit: 'infantry' });
          } else if (troopTrucks < 1 && money >= 125) {
            sim.apply(p.id, { type: 'train', building: b.id, unit: 'truck' });
          } else if (humvees < 1 && money >= 150) {
            sim.apply(p.id, { type: 'train', building: b.id, unit: 'humvee' });
          } else if (infCount < transportCapacity && money >= 100) {
            sim.apply(p.id, { type: 'train', building: b.id, unit: 'infantry' });
          } else if (humveeMgCount < 2 && money >= 200) {
            sim.apply(p.id, { type: 'train', building: b.id, unit: 'humvee_mg' });
          } else if (transportCapacity < infCount + 5 && money >= 125) {
            if (money >= 150 && humvees < troopTrucks) {
              sim.apply(p.id, { type: 'train', building: b.id, unit: 'humvee' });
            } else {
              sim.apply(p.id, { type: 'train', building: b.id, unit: 'truck' });
            }
          } else if (money >= 100) {
            sim.apply(p.id, { type: 'train', building: b.id, unit: 'infantry' });
          }
        }
        continue;
      }
      if (b.def === 'machine_factory') {
        // a small logistics fleet: trucks for ore, metal, ammo, a tanker, a rescue crew
        const want = count('truck') < (w.buildings.some((x) => x.owner === p.id && x.def === 'ammo_factory') ? 4 : 2) ? 'truck' : count('fuel_truck') < 1 ? 'fuel_truck' : count('rescuers') < 1 ? 'rescuers' : count('mechanic') < 1 ? 'mechanic' : null;
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
      // save up for the supply trucks before buying more troops
      const needTrucks = w.buildings.some((x) => x.team === p.team && x.def === 'machine_factory' && x.progress >= 1) && count('truck') < 2;
      if (needTrucks && (p.res.money ?? 0) < 500) continue;
      const drones = w.units.filter((u) => u.owner === p.id && u.def === 'drone').length;
      const pool = ['infantry', 'infantry', 'infantry_assault', 'infantry_at', 'infantry_recon', 'manpads', 'medic', 'tank', 'artillery', ...(drones < 1 ? ['drone'] : [])].filter((u) => d.trains!.includes(u));
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick) sim.apply(p.id, { type: 'train', building: b.id, unit: pick });
    }
  }

  /** Keep the supply chain moving: ore to the metal works, metal to ammo factory and base, ammo to depots. */
  private logistics(sim: Sim, p: Player) {
    const w = sim.world;
    const own = (def: string) => w.buildings.filter((b) => b.team === p.team && b.def === def && b.progress >= 1);
    const nearest = (from: Building, list: Building[]) => list.sort((a, b) => distKm(a.pos, from.pos) - distKm(b.pos, from.pos))[0];
    const route = (u: Unit, from?: Building, to?: Building, res?: string) => from && to && sim.apply(p.id, { type: 'setRoute', unit: u.id, fromBuilding: from.id, toBuilding: to.id, resType: res, minLoad: 1 });
    // Only use trucks that are not occupied as troop transports or reinforcing
    const myMilitaryBases = w.buildings.filter((b) => b.owner === p.id && b.def === 'military_base');
    const fallbackBase = w.buildings.filter((b) => b.team === p.team && b.def === 'military_base')[0];
    const hq = w.buildings.find((b) => b.owner === p.id && b.def === 'hq');
    const anchorBase = myMilitaryBases[0]?.pos ?? fallbackBase?.pos ?? hq?.pos ?? sim.map.center;
    const isTroopTransport = (t: Unit) => (t.cargo?.passengers?.length ?? 0) > 0 || t.reinforceTarget !== undefined || distKm(t.pos, anchorBase) <= 30;
    const trucks = w.units.filter((u) => u.owner === p.id && u.def === 'truck' && !u.haul && !isTroopTransport(u));
    const mines = own('mine'), works = own('metalworks'), steelMills = own('steel_mill'), bases = own('hq'), refineries = own('oil_refinery');
    const ammo = own('ammo_factory'), depots = own('ammo_depot');
    trucks.forEach((u, i) => {
      if (steelMills[0] && ammo[0] && (ammo[0].storage?.steel ?? 0) < 50 && i % 3 === 0) {
        route(u, steelMills[0], ammo[0], 'steel');
      } else if (ammo[0] && bases[0] && (i % 3 === 1)) {
        route(u, ammo[0], bases[0], 'ammo');
      } else if (works[0] && ammo[0] && (ammo[0].storage?.metal ?? 0) < 100 && i % 3 === 0) {
        route(u, works[0], ammo[0], 'metal');
      } else if (ammo[0] && depots.length && (i % 2 === 1 || depots.some((d) => (d.storage?.ammo ?? 0) < 3000))) {
        const needyDepot = [...depots].sort((a, b) => (a.storage?.ammo ?? 0) - (b.storage?.ammo ?? 0))[0];
        route(u, ammo[0], needyDepot, 'ammo');
      } else if (i % 2 === 0 && mines[0] && steelMills[0]) {
        route(u, mines[0], nearest(mines[0], steelMills), 'ore');
      } else if (i % 2 === 0 && mines[0] && works[0]) {
        route(u, mines[0], nearest(mines[0], works), 'ore');
      } else if (steelMills[0] && bases[0]) {
        route(u, steelMills[0], nearest(steelMills[0], bases), 'steel');
      } else if (works[0] && bases[0]) {
        route(u, works[0], nearest(works[0], bases), 'metal');
      }
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
    const myMilitaryBases = w.buildings.filter((b) => b.owner === p.id && b.def === 'military_base');
    const fallbackBase = w.buildings.filter((b) => b.team === p.team && b.def === 'military_base')[0];
    const hq = w.buildings.find((b) => b.owner === p.id && b.def === 'hq');
    const anchorBase = myMilitaryBases[0]?.pos ?? fallbackBase?.pos ?? hq?.pos ?? sim.map.center;
    const anchor: LngLat = hq?.pos ?? sim.map.center;

    // Disembark any passengers if vehicle arrived at a non-garrison destination
    for (const v of w.units) {
      if (v.owner === p.id && (v.cargo?.passengers?.length ?? 0) > 0 && !v.reinforceTarget && !v.target) {
        sim.apply(p.id, { type: 'disembark', transport: v.id });
      }
    }

    // 1. Board infantry into available transports (truck or humvee) to move them rapidly
    const transports = w.units.filter((u) =>
      u.owner === p.id &&
      (u.def === 'humvee' || (u.def === 'truck' && !u.haul)) &&
      !u.reinforceTarget &&
      (!u.target || distKm(u.pos, anchorBase) <= 20)
    );
    const unembarkedInfantry = w.units.filter((u) =>
      u.owner === p.id &&
      u.def === 'infantry' &&
      !u.embarkedIn
    );

    for (const trans of transports) {
      const td = sim.defs.u.get(trans.def);
      const cap = td?.passengerCap ?? 0;
      if (cap <= 0) continue;
      const currentPassengers = trans.cargo?.passengers?.length ?? 0;
      const slots = cap - currentPassengers;
      if (slots <= 0) continue;

      const nearbyInf = unembarkedInfantry.filter((inf) => !inf.embarkedIn && distKm(inf.pos, trans.pos) <= 15).slice(0, slots);
      for (const inf of nearbyInf) {
        sim.apply(p.id, { type: 'board', unit: inf.id, transport: trans.id });
      }
    }

    this.logistics(sim, p);

    // Return empty transports sitting idle far from base back to base to pick up next reinforcements
    const emptyVehiclesAtFront = w.units.filter((u) =>
      u.owner === p.id &&
      (u.def === 'truck' || u.def === 'humvee') &&
      !u.haul &&
      !u.reinforceTarget &&
      !u.target &&
      !(u.cargo?.passengers?.length) &&
      distKm(u.pos, anchorBase) > 15
    );
    for (const v of emptyVehiclesAtFront) {
      v.stance = 'hold';
      v.post = [anchorBase[0], anchorBase[1]];
      sim.apply(p.id, { type: 'move', units: [v.id], to: anchorBase });
    }

    const enemyPoints = sim.map.capturePoints.filter((cp) => sim.side(cp.pos) !== p.team);

    // strike drones and missiles go for enemy sites, recon drones scout over the enemy side (from their launchers)
    const send = (u: Unit, to: LngLat) =>
      u.parkedAt !== undefined ? sim.apply(p.id, { type: 'launchFrom', building: u.parkedAt, units: [u.id], target: to }) : sim.apply(p.id, { type: 'move', units: [u.id], to });
    for (const u of w.units.filter((x) => x.owner === p.id && isStrikeDrone(sim.defs.u.get(x.def)) && !x.target && !x.embarkedIn)) {
      const targets = w.buildings.filter((b) => b.team !== p.team);
      const t = targets[Math.floor(Math.random() * targets.length)];
      if (t) send(u, t.pos);
    }
    for (const u of w.units.filter((x) => x.owner === p.id && isReconDrone(sim.defs.u.get(x.def)) && !x.embarkedIn)) {
      if (u.target && !u.isLoitering) continue;
      if (u.isLoitering && Math.random() > 0.05) continue; // circle a while before moving on
      const cp = enemyPoints[Math.floor(Math.random() * enemyPoints.length)];
      if (cp) send(u, offsetKm(cp.pos, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20));
    }

    // Ground army: include vehicles and infantry.
    const isHaulTruck = (u: Unit) => u.def === 'truck' && u.haul !== undefined;
    const waitingInfantryNearBase = w.units.filter((u) => u.owner === p.id && u.def === 'infantry' && !u.embarkedIn && distKm(u.pos, anchorBase) <= 25);
    const isTrainingInfantry = w.queue.some((q) => q.unit === 'infantry' && w.buildings.find((b) => b.id === q.building)?.owner === p.id);

    const army = w.units.filter((u) => {
      if (u.owner !== p.id || u.frontPost !== undefined || sim.defs.u.get(u.def)!.kind === 'air' || isHaulTruck(u) || sim.defs.u.get(u.def)!.repairs || u.embarkedIn) return false;

      // Trucks must only depart if fully loaded (5 squads) or no more infantry available at base
      if (u.def === 'truck') {
        const passCount = u.cargo?.passengers?.length ?? 0;
        if (passCount === 0) return false;
        if (passCount < 5 && distKm(u.pos, anchorBase) <= 20 && waitingInfantryNearBase.length > 0) {
          return false; // Wait at base to fill up to 5 squads!
        }
        return true;
      }

      // Standard Humvees without passengers wait at base for infantry to board
      if (u.def === 'humvee') {
        const passCount = u.cargo?.passengers?.length ?? 0;
        if (passCount === 0 && distKm(u.pos, anchorBase) <= 20 && waitingInfantryNearBase.length > 0) {
          return false; // Wait for passenger squad to board
        }
        return true;
      }

      // Infantry near base should wait for transports if an available transport with free seats exists or is arriving at base
      const availableTransportAtBase = w.units.some(
        (t) => t.owner === p.id &&
          (t.def === 'truck' || t.def === 'humvee') &&
          !t.haul &&
          !t.reinforceTarget &&
          distKm(t.pos, anchorBase) <= 30 &&
          (sim.defs.u.get(t.def)?.passengerCap ?? 0) > (t.cargo?.passengers?.length ?? 0)
      );
      if (u.def === 'infantry' && distKm(u.pos, anchorBase) <= 20 && availableTransportAtBase) {
        return false;
      }

      return true;
    });

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

    const idle = army.filter((u) => !u.target && u.targetPost === undefined && !u.reinforceTarget);
    if (!idle.length) return;
    if (w.time - this.lastArmyOrder < 4) return;
    this.lastArmyOrder = w.time;

    // Bot ground army: prioritize frontline garrisons, stabilizing trouble spots first (opposing strength disparity)
    const friendlyGarrisons = w.units.filter((u) => u.team === p.team && u.hp > 0 && (u.def === 'frontline_infantry' || u.owner.startsWith('__front_')));
    const enemyGarrisons = w.units.filter((u) => u.team !== p.team && u.hp > 0 && (u.def === 'frontline_infantry' || u.owner.startsWith('__front_')));

    if (friendlyGarrisons.length) {
      let candidateGarrisons = friendlyGarrisons.filter((g) => distKm(g.pos, anchorBase) <= 160);
      if (!candidateGarrisons.length) {
        candidateGarrisons = [...friendlyGarrisons].sort((a, b) => distKm(a.pos, anchorBase) - distKm(b.pos, anchorBase)).slice(0, 10);
      }

      if (candidateGarrisons.length) {
        const incomingStr = new Map<number, number>();
        for (const u of w.units) {
          if (u.reinforceTarget) {
            let added = 1;
            if (u.cargo?.passengers?.length) {
              added = u.cargo.passengers.length;
            } else if ((sim.defs.u.get(u.def)?.mobility ?? 'foot') === 'foot') {
              added = u.strength ?? 1;
            }
            incomingStr.set(u.reinforceTarget, (incomingStr.get(u.reinforceTarget) ?? 0) + added);
          }
        }

        const getOpposing = (g: Unit) => {
          let best: Unit | null = null;
          let bestD = 12.0;
          for (const eg of enemyGarrisons) {
            const d = distKm(g.pos, eg.pos);
            if (d < bestD) {
              bestD = d;
              best = eg;
            }
          }
          return best;
        };

        // Prioritize motorized transports with passengers first, then vehicles, then foot infantry
        const prioritizedUnits = [...idle].sort((a, b) => {
          const aPass = a.cargo?.passengers?.length ?? 0;
          const bPass = b.cargo?.passengers?.length ?? 0;
          if (aPass !== bPass) return bPass - aPass;
          const aIsVeh = a.def === 'truck' || a.def === 'humvee' || a.def === 'humvee_mg';
          const bIsVeh = b.def === 'truck' || b.def === 'humvee' || b.def === 'humvee_mg';
          if (aIsVeh !== bIsVeh) return aIsVeh ? -1 : 1;
          return 0;
        });

        for (const u of prioritizedUnits) {
          const uBase = myMilitaryBases.find((b) => distKm(b.pos, u.pos) <= 50)?.pos ?? anchorBase;
          let localCandidates = friendlyGarrisons.filter((g) => distKm(g.pos, uBase) <= 160);
          if (!localCandidates.length) {
            localCandidates = [...friendlyGarrisons].sort((a, b) => distKm(a.pos, uBase) - distKm(b.pos, uBase)).slice(0, 3);
          }

          // Sort candidates by threat / deficit:
          // threat = oppStrength - myEffectiveStrength
          localCandidates.sort((a, b) => {
            const oppA = getOpposing(a);
            const oppB = getOpposing(b);
            const oppStrA = oppA ? (oppA.strength ?? 1) : 1;
            const oppStrB = oppB ? (oppB.strength ?? 1) : 1;
            const myStrA = (a.strength ?? 1) + (incomingStr.get(a.id) ?? 0);
            const myStrB = (b.strength ?? 1) + (incomingStr.get(b.id) ?? 0);
            let deficitA = oppStrA - myStrA;
            let deficitB = oppStrB - myStrB;
            if ((a.ammo ?? 100) <= 0 && (!oppA || (oppA.ammo ?? 100) > 0)) deficitA += 2;
            if ((b.ammo ?? 100) <= 0 && (!oppB || (oppB.ammo ?? 100) > 0)) deficitB += 2;

            // Prioritize higher deficit first (troubled spots)
            if (deficitB !== deficitA) return deficitB - deficitA;
            // Then lower total friendly strength
            if (myStrA !== myStrB) return myStrA - myStrB;
            // Then closer to the base
            return distKm(uBase, a.pos) - distKm(uBase, b.pos);
          });

          const target = localCandidates[0];
          if (target) {
            let added = 1;
            if (u.cargo?.passengers?.length) {
              added = u.cargo.passengers.length;
            } else if ((sim.defs.u.get(u.def)?.mobility ?? 'foot') === 'foot') {
              added = u.strength ?? 1;
            }
            incomingStr.set(target.id, (incomingStr.get(target.id) ?? 0) + added);
            sim.apply(p.id, { type: 'reinforce', units: [u.id], targetUnit: target.id });
          }
        }
        return;
      }
    }

    if (w.posts?.length) {
      const myPosts = w.posts.filter((post) => post.team === p.team);
      const availablePosts = myPosts.filter((post) => {
        const headingThere = army.filter((x) => x.targetPost === post.id).length;
        return post.garrison.length + headingThere < post.cap;
      });

      if (availablePosts.length) {
        for (const u of idle) {
          const target = availablePosts.find((post) => {
            const headingThere = army.filter((x) => x.targetPost === post.id).length;
            return post.garrison.length + headingThere < post.cap;
          }) ?? availablePosts[0];
          if (target) {
            sim.apply(p.id, { type: 'move', units: [u.id], to: target.pos });
          }
        }
        return;
      }

      // All friendly posts are at full capacity: rally unassigned troops behind the front as tactical reserve
      const nearestPost = myPosts.sort((a, b) => distKm(a.pos, anchor) - distKm(b.pos, anchor))[0];
      if (nearestPost) {
        const reservePos = moveToward(nearestPost.pos, anchor, 3.5);
        const far = idle.filter((u) => distKm(u.pos, reservePos) > 3.0);
        if (far.length) sim.apply(p.id, { type: 'move', units: far.map((u) => u.id), to: reservePos });
      }
      return;
    }

    // Fallback when no posts exist: rally just behind the front
    const front = w.front[nearestNode(w.front, anchor)];
    const rally = moveToward([front.lng, front.lat], anchor, 6);
    const far = idle.filter((u) => distKm(u.pos, rally) > 4);
    if (far.length) sim.apply(p.id, { type: 'move', units: far.map((u) => u.id), to: rally });
  }
}
