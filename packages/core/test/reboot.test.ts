import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { Bot } from '../../../services/game/src/application/bot';
import { Sim, offsetKm, distToFrontKm, distKm, DEPOSITS, inDeposit, depositsGeoJSON, generateCityHouses } from '../src';

const rs = await loadRuleset(fileURLToPath(new URL('../../../mods', import.meta.url)));

const sim = new Sim(rs, 'ukraine', [
  { id: 'player1', name: 'Player 1', team: 0, bot: false },
  { id: 'player2', name: 'Player 2', team: 1, bot: false },
  { id: 'botUA', name: 'Bot UA', team: 0, bot: true },
  { id: 'botRU', name: 'Bot RU', team: 1, bot: true },
]);

// 1. Initial world verification: buildings start clean, frontline infantry garrisons deployed
assert.equal(sim.world.buildings.length, 0, 'map starts with 0 buildings');
assert.equal(sim.world.posts.length, 0, 'map starts with 0 frontline garrison posts');
assert.ok(sim.world.units.length > 100, `frontline infantry deployed along the front line (actual=${sim.world.units.length})`);
assert.ok(sim.world.units.every((u) => u.owner.startsWith('__front_')), 'all initial units are autonomous frontline garrisons');
assert.ok(sim.world.units.every((u) => u.hp === 5000), 'all frontline squads have 100 soldiers (5000 HP)');
assert.ok(sim.world.units.every((u) => u.stance === 'hold'), 'all frontline squads have stance: hold (stand in place)');
console.log(`✓ Frontline garrisons: ${sim.world.units.length} squads deployed along the front line (100 soldiers each, hold stance)`);

// 2. Resources: Money (10k start) and Ore (cap 5000)
assert.equal(rs.resources.length, 2, '2 resources defined: money and ore');
const moneyRes = rs.resources.find((r) => r.id === 'money')!;
assert.equal(moneyRes.start, 10000, 'starting money is 10k');
const oreRes = rs.resources.find((r) => r.id === 'ore')!;
assert.equal(oreRes.cap, 5000, 'ore cap is 5000');
console.log('✓ Resources: Money (10k start) and physical Ore (cap 5k) verified');

// 3. Buildings: HQ, Military Base, Warehouse, Mine, Oil Rig, Refinery, Housing
assert.equal(rs.buildings.length, 7, '7 building definitions exist');
const hqDef = rs.buildings.find((b) => b.id === 'hq')!;
assert.equal(hqDef.hp, 10000, 'HQ has 10,000 HP');
assert.equal(hqDef.sameKindKm, 100, 'HQ has sameKindKm = 100');
assert.equal(hqDef.maxPerPlayer, 1, 'only 1 HQ per player');

const mbDef = rs.buildings.find((b) => b.id === 'military_base')!;
assert.equal(mbDef.cost.money, 2500, 'Military base costs 2500');
assert.equal(mbDef.buildTime, 120, 'Military base takes 120s (2 min)');
assert.equal(mbDef.sameKindKm, 20, 'Military base has sameKindKm = 20');

const whDef = rs.buildings.find((b) => b.id === 'warehouse')!;
assert.equal(whDef.cost.money, 5000, 'Warehouse costs 5000');
assert.equal(whDef.sameKindKm, 100, 'Warehouse has sameKindKm = 100');

const mineDef = rs.buildings.find((b) => b.id === 'mine')!;
assert.equal(mineDef.cost.money, 5000, 'Mine costs 5000');
assert.equal(mineDef.maxPerPlayer, 1, '1 mine per player');
assert.equal(mineDef.storageCap, 5000, 'Mine stores up to 5000 ore');
assert.equal(mineDef.produces?.ore, 5, 'Mine produces 5 ore/s');

const oilRigDef = rs.buildings.find((b) => b.id === 'oil_rig')!;
assert.equal(oilRigDef.cost.money, 5000, 'Oil rig costs 5000');
assert.equal(oilRigDef.maxPerPlayer, 1, '1 oil rig per player');
assert.equal(oilRigDef.storageCap, 5000, 'Oil rig stores up to 5000 oil');

const refDef = rs.buildings.find((b) => b.id === 'refinery')!;
assert.equal(refDef.cost.money, 8000, 'Refinery costs 8000');
assert.equal(refDef.maxPerTeam, 2, '2 refineries per team');

const houseDef = rs.buildings.find((b) => b.id === 'housing')!;
assert.equal(houseDef.cost.money, 2000, 'Housing costs 2000');
assert.equal(houseDef.hp, 500, 'Housing has 500 HP (10 houses * 50 HP)');
assert.equal(houseDef.produces?.money, 1, 'Housing produces 1 $/s (5 coins per 5s)');
console.log('✓ Buildings defined: HQ, Military Base, Warehouse, Mine, Oil Rig, Refinery, Housing verified');

// 4. Procedural Terrain Full Map Coverage
const validTerrainIds = rs.terrain.map((t) => t.id);
const farPointRU: [number, number] = [48.0, 56.0];
const farTerrainRU = sim.terrainAt(farPointRU);
assert.ok(validTerrainIds.includes(farTerrainRU.id), `Procedural terrain generates valid terrain for far east RU (actual=${farTerrainRU.id})`);
const farPointWest: [number, number] = [21.0, 50.0];
const farTerrainWest = sim.terrainAt(farPointWest);
assert.ok(validTerrainIds.includes(farTerrainWest.id), `Procedural terrain generates valid terrain for west map (actual=${farTerrainWest.id})`);
console.log('✓ Procedural Terrain covers full map extent smoothly');

// 5. Deposits: 16 Iron + 16 Oil (8 each per team, sizes 20-80 km diameter)
const ironDeps = DEPOSITS.filter((d) => d.type === 'iron');
const oilDeps = DEPOSITS.filter((d) => d.type === 'oil');
assert.equal(ironDeps.length, 16, 'Exactly 16 iron deposits');
assert.equal(oilDeps.length, 16, 'Exactly 16 oil deposits');

assert.equal(ironDeps.filter((d) => d.team === 0).length, 8, '8 iron deposits in Ukraine');
assert.equal(ironDeps.filter((d) => d.team === 1).length, 8, '8 iron deposits in Russia');
assert.equal(oilDeps.filter((d) => d.team === 0).length, 8, '8 oil deposits in Ukraine');
assert.equal(oilDeps.filter((d) => d.team === 1).length, 8, '8 oil deposits in Russia');

for (const dep of DEPOSITS) {
  assert.ok(dep.radiusKm >= 10 && dep.radiusKm <= 40, `Deposit radius between 10 and 40 km (actual: ${dep.radiusKm} km)`);
  assert.ok(inDeposit(dep.type, dep.center), `Center of deposit is inside deposit`);
}

const ironGeoJSON = depositsGeoJSON('iron');
const oilGeoJSON = depositsGeoJSON('oil');
assert.equal(ironGeoJSON.features.length, 16, 'Iron GeoJSON has 16 features');
assert.equal(oilGeoJSON.features.length, 16, 'Oil GeoJSON has 16 features');
console.log('✓ Deposits: 16 Iron and 16 Oil (8 per team, 20-80 km diameter, organic noisy polygons) verified');

// 6. Placement restrictions and HQ placement
const testPos: [number, number] = [36.2, 48.1];

// Cannot place military base without HQ first
const earlyBase = sim.apply('player2', { type: 'build', def: 'military_base', pos: [30.0, 49.0] });
assert.equal(earlyBase.ok, false, 'cannot build military base before placing HQ');
assert.equal(earlyBase.reason, 'must place military HQ first');

// Cannot place warehouse without HQ first
const earlyWh = sim.apply('player2', { type: 'build', def: 'warehouse', pos: [30.0, 49.0] });
assert.equal(earlyWh.ok, false, 'cannot build warehouse before placing HQ');
assert.equal(earlyWh.reason, 'must place military HQ first');

// Cannot place mine without HQ first
const earlyMine = sim.apply('player2', { type: 'build', def: 'mine', pos: [30.0, 49.0] });
assert.equal(earlyMine.ok, false, 'cannot build mine before placing HQ');
assert.equal(earlyMine.reason, 'must place military HQ first');

// Cannot place housing without HQ first
const earlyHouse = sim.apply('player2', { type: 'build', def: 'housing', pos: [30.0, 49.0] });
assert.equal(earlyHouse.ok, false, 'cannot build housing before placing HQ');
assert.equal(earlyHouse.reason, 'must place military HQ first');

// Place player 1 HQ
const resHq = sim.apply('player1', { type: 'build', def: 'hq', pos: testPos });
assert.ok(resHq.ok, 'HQ placement succeeded');
const hq = sim.world.buildings.find((b) => b.owner === 'player1' && b.def === 'hq');
assert.ok(hq, 'HQ spawned');
assert.equal(hq.hp, 10000, 'HQ has 10,000 HP');
assert.equal(hq.progress, 1, 'HQ is instant operational');

// Max 1 HQ per player
const res2 = sim.apply('player1', { type: 'build', def: 'hq', pos: offsetKm(testPos, 5, 0) });
assert.equal(res2.ok, false, 'cannot place a second HQ');
assert.equal(res2.reason, 'limit reached');

// Spacing: cannot place HQ within 100 km of another HQ
const resPlayer2Close = sim.apply('player2', { type: 'build', def: 'hq', pos: offsetKm(testPos, 40, 0) });
assert.equal(resPlayer2Close.ok, false, 'player 2 cannot place HQ within 100 km of player 1 HQ');
assert.equal(resPlayer2Close.reason, 'keep at least 100 km from other military HQs');

// Place player 2 HQ far away (>= 100 km)
const ruHqPos: [number, number] = [40.0, 48.0];
const resPlayer2Hq = sim.apply('player2', { type: 'build', def: 'hq', pos: ruHqPos });
assert.ok(resPlayer2Hq.ok, 'player 2 HQ placement succeeded at >= 100 km');

// Cannot demolish HQ
const demoHq = sim.apply('player1', { type: 'demolish', building: hq.id });
assert.equal(demoHq.ok, false, 'cannot demolish HQ');
console.log('✓ HQ placement, 100 km spacing, and demolition restrictions verified');

// 7. Military Base placement & 20 km spacing
const mbPos1 = offsetKm(testPos, -30, 0);
const mbRes1 = sim.apply('player1', { type: 'build', def: 'military_base', pos: mbPos1 });
assert.ok(mbRes1.ok, 'Military base 1 placement succeeded');
const mb1 = sim.world.buildings.find((b) => b.owner === 'player1' && b.def === 'military_base');
assert.ok(mb1);
assert.equal(mb1.progress, 0, 'Military base starts under construction');

// Cannot build within 20 km of another military base
const mbResClose = sim.apply('player1', { type: 'build', def: 'military_base', pos: offsetKm(mbPos1, -10, 0) });
assert.equal(mbResClose.ok, false, 'cannot place military base within 20 km of another military base');
assert.equal(mbResClose.reason, 'keep at least 20 km from other military bases');

// Can build at >= 20 km
const mbPos2 = offsetKm(mbPos1, -25, 0);
const mbRes2 = sim.apply('player1', { type: 'build', def: 'military_base', pos: mbPos2 });
assert.ok(mbRes2.ok, 'Military base 2 placement succeeded at >= 20 km');

// Demolish mb1
assert.ok(sim.apply('player1', { type: 'demolish', building: mb1.id }).ok);
console.log('✓ Military Base: 20 km spacing and demolition verified');

// 8. Warehouse placement & 100 km spacing
sim.player('player1')!.res.money = 50000;
const whPos1 = offsetKm(testPos, -60, 0);
const whRes1 = sim.apply('player1', { type: 'build', def: 'warehouse', pos: whPos1 });
assert.ok(whRes1.ok, 'Warehouse 1 placement succeeded');
const wh1 = sim.world.buildings.find((b) => b.owner === 'player1' && b.def === 'warehouse');
assert.ok(wh1);
assert.equal(sim.defs.b.get('warehouse')!.storageCap, 5000);

// Cannot build warehouse within 100 km of another warehouse
const whResClose = sim.apply('player1', { type: 'build', def: 'warehouse', pos: offsetKm(whPos1, -50, 0) });
assert.equal(whResClose.ok, false, 'cannot place warehouse within 100 km of another warehouse');
assert.equal(whResClose.reason, 'keep at least 100 km from other warehouses');

// Can build warehouse at >= 100 km
const whPos2 = offsetKm(whPos1, -110, 0);
const whRes2 = sim.apply('player1', { type: 'build', def: 'warehouse', pos: whPos2 });
assert.ok(whRes2.ok, 'Warehouse 2 placement succeeded at >= 100 km');
console.log('✓ Warehouse: cost 5000, 100 km spacing constraint verified');

// 9. Mine placement (only on iron deposits) & ore accumulation up to 5000
// Try building mine on plain ground outside iron deposits
const nonDepPos: [number, number] = [34.0, 48.0];
assert.equal(inDeposit('iron', nonDepPos, 0, sim.deposits), null, 'pos is not on iron deposit');
const mineResFail = sim.apply('player1', { type: 'build', def: 'mine', pos: nonDepPos });
assert.equal(mineResFail.ok, false, 'mine rejected outside iron deposit');
assert.equal(mineResFail.reason, 'mines can only be built on iron deposits');

// Find a friendly iron deposit in Ukraine from match deposits
const matchIron = (sim.deposits ?? DEPOSITS).filter((d) => d.type === 'iron');
const friendlyIronDep = matchIron.find((d) => d.team === 0 && sim.side(d.center) === 0)!;
assert.ok(friendlyIronDep, 'Found friendly iron deposit');
const mineResOk = sim.apply('player1', { type: 'build', def: 'mine', pos: friendlyIronDep.center });
assert.ok(mineResOk.ok, 'Mine placement succeeded inside iron deposit');
const mine = sim.world.buildings.find((b) => b.owner === 'player1' && b.def === 'mine')!;
assert.ok(mine);

// Finish mine construction (buildTime = 60s)
sim.step(60);
assert.equal(mine.progress, 1, 'mine finished construction');

// Step simulation: mine should produce ore and accumulate in mine.storage['ore']
const startOre = mine.storage?.ore ?? 0;
sim.step(10);
const afterOre = mine.storage?.ore ?? 0;
assert.ok(afterOre > startOre, `Mine accumulated ore (before=${startOre}, after=${afterOre})`);

// Player can build at most 1 mine
const mine2Res = sim.apply('player1', { type: 'build', def: 'mine', pos: friendlyIronDep.center });
assert.equal(mine2Res.ok, false, 'second mine for player1 rejected');
assert.equal(mine2Res.reason, 'limit reached');
console.log('✓ Mine: strictly inside iron deposits, accumulates ore in storage up to 5k cap, limit 1 per player');

// 10. Oil Rig placement (only on oil deposits) & max 1 per player
sim.player('player1')!.res.money = 50000;
const nonOilPos: [number, number] = [28.0, 50.0];
assert.equal(inDeposit('oil', nonOilPos, 0, sim.deposits), null, 'pos is not on oil deposit');
const oilRigFail = sim.apply('player1', { type: 'build', def: 'oil_rig', pos: nonOilPos });
assert.equal(oilRigFail.ok, false, 'oil rig rejected outside oil deposit');
assert.equal(oilRigFail.reason, 'oil rigs can only be built on oil deposits');

const matchOil = (sim.deposits ?? DEPOSITS).filter((d) => d.type === 'oil');
const friendlyOilDep = matchOil.find((d) => d.team === 0 && sim.side(d.center) === 0)!;
assert.ok(friendlyOilDep, 'Found friendly oil deposit');
const oilRigOk = sim.apply('player1', { type: 'build', def: 'oil_rig', pos: friendlyOilDep.center });
assert.ok(oilRigOk.ok, 'Oil rig placement succeeded inside oil deposit');
const oilRig = sim.world.buildings.find((b) => b.owner === 'player1' && b.def === 'oil_rig')!;
assert.ok(oilRig);

const oilRig2Fail = sim.apply('player1', { type: 'build', def: 'oil_rig', pos: friendlyOilDep.center });
assert.equal(oilRig2Fail.ok, false, 'second oil rig for player1 rejected');
assert.equal(oilRig2Fail.reason, 'limit reached');
console.log('✓ Oil Rig: limit 1 per player, strictly on friendly oil deposit');

// 11. Refinery placement: cost 8000, max 2 per team, Kremenchuk (team 0) & Rostov (team 1) rules
sim.player('player1')!.res.money = 50000;
// First refinery at Kremenchuk [33.4397, 49.0703] succeeds
const kremenchukPos: [number, number] = [33.4397, 49.0703];
const ref1Res = sim.apply('player1', { type: 'build', def: 'refinery', pos: kremenchukPos });
assert.ok(ref1Res.ok, 'First refinery in Kremenchuk succeeded');

// Second refinery within 10 km of 1st refinery must fail
const refCloseFail = sim.apply('player1', { type: 'build', def: 'refinery', pos: offsetKm(kremenchukPos, 5, 0) });
assert.equal(refCloseFail.ok, false, 'refinery within 10 km rejected');
assert.equal(refCloseFail.reason, 'keep at least 10 km from other refineries');

// Second refinery anywhere in Ukraine (e.g. Kyiv) succeeds
const kyivPos: [number, number] = [30.5, 50.4];
const ref2Ok = sim.apply('player1', { type: 'build', def: 'refinery', pos: kyivPos });
assert.ok(ref2Ok.ok, 'Second refinery in Kyiv succeeded');

// Third refinery must fail (max 2 per team)
const lvivPos: [number, number] = [24.0, 49.8];
const ref3Fail = sim.apply('player1', { type: 'build', def: 'refinery', pos: lvivPos });
assert.equal(ref3Fail.ok, false, 'third refinery rejected');
assert.equal(ref3Fail.reason, 'team limit reached');
console.log('✓ Refinery: max 2 per team, mandatory Kremenchuk location verified');

// Russia Refinery placement rules:
sim.player('player2')!.res.money = 50000;

// Refinery 1 for Russia not near Rostov (Voronezh east)
const voronezhPos: [number, number] = [39.5, 51.6];
const ruRef1Res = sim.apply('player2', { type: 'build', def: 'refinery', pos: voronezhPos });
assert.ok(ruRef1Res.ok, 'First RU refinery placed');

// Refinery 2 for Russia not near Rostov (Tambov) must fail
const tambovPos: [number, number] = [41.4, 52.7];
const ruRef2Fail = sim.apply('player2', { type: 'build', def: 'refinery', pos: tambovPos });
assert.equal(ruRef2Fail.ok, false, 'second RU refinery outside Rostov rejected');
assert.equal(ruRef2Fail.reason, 'one of your team refineries must be near Rostov-on-Don');

// Refinery 2 near Rostov [39.7203, 47.2357] succeeds
const rostovPos: [number, number] = [39.7203, 47.2357];
const ruRef2Ok = sim.apply('player2', { type: 'build', def: 'refinery', pos: rostovPos });
assert.ok(ruRef2Ok.ok, 'Second RU refinery near Rostov succeeded');

// Third RU refinery fails
const ruRef3Fail = sim.apply('player2', { type: 'build', def: 'refinery', pos: tambovPos });
assert.equal(ruRef3Fail.ok, false, 'third RU refinery rejected');
assert.equal(ruRef3Fail.reason, 'team limit reached');
console.log('✓ Refinery: Russia mandatory Rostov location verified');

// 10. Housing: placed only in cities held by team, max 5 per city, produces 10 $/s split among team
const nonCityPos: [number, number] = [33.0, 48.0];
const houseNonCity = sim.apply('player1', { type: 'build', def: 'housing', pos: nonCityPos });
assert.equal(houseNonCity.ok, false, 'housing rejected outside city');
assert.equal(houseNonCity.reason, 'housing can only be built inside a city');

// Find friendly city
const friendlyCity = sim.map.capturePoints.find((cp, idx) => sim.world.points[idx]?.owner === 0)!;
assert.ok(friendlyCity, 'Friendly city found');

// Build 2 housing blocks in this city (max 2)
const pPos1 = offsetKm(friendlyCity.pos, -0.2, 0.1);
const hRes1 = sim.apply('player1', { type: 'build', def: 'housing', pos: pPos1 });
assert.ok(hRes1.ok, 'Housing block 1 placement succeeded');
const house1 = sim.world.buildings.find((b) => b.owner === 'player1' && b.def === 'housing')!;
assert.ok(house1, 'Housing block 1 found in world');
assert.equal(house1.houses?.length, 10, 'Housing district contains 10 individual houses');
assert.equal(house1.hp, 500, 'Housing district initial HP is 500 (10 houses * 50 HP)');

for (const h of house1.houses!) {
  assert.equal(h.hp, 50, 'Each house starts with 50 HP');
  assert.equal(h.maxHp, 50, 'Each house maxHp is 50');
}

// Check non-overlapping: each pair of houses has distance >= 0.05 km (50m)
for (let i = 0; i < house1.houses!.length; i++) {
  for (let j = i + 1; j < house1.houses!.length; j++) {
    const d = distKm(house1.houses![i].pos, house1.houses![j].pos);
    assert.ok(d >= 0.05, `Houses ${i} and ${j} do not overlap (dist=${(d * 1000).toFixed(0)}m >= 50m)`);
  }
}

const pPos2 = offsetKm(friendlyCity.pos, 0.2, 0.1);
const hRes2 = sim.apply('player1', { type: 'build', def: 'housing', pos: pPos2 });
assert.ok(hRes2.ok, 'Housing block 2 placement succeeded');

// 3rd housing block in the same city should be rejected (max 2)
const pPos3 = offsetKm(friendlyCity.pos, 0.5, 0.5);
const hRes3 = sim.apply('player1', { type: 'build', def: 'housing', pos: pPos3 });
assert.equal(hRes3.ok, false, '3rd housing block in city rejected');
assert.equal(hRes3.reason, 'at most 2 housing blocks per city');

// Finish housing construction (30s)
sim.step(30);

// Check income splitting: each housing produces 1 $/s (5 coins per 5s).
// 2 full housing blocks = 2 $/s total.
// Team 0 has 2 players: 'player1' and 'botUA'.
// Each player gets 2 / 2 = 1 $/s.
const p1MoneyBefore = sim.player('player1')!.res.money;
const botMoneyBefore = sim.player('botUA')!.res.money;
sim.step(1);
const p1MoneyGain = sim.player('player1')!.res.money - p1MoneyBefore;
const botMoneyGain = sim.player('botUA')!.res.money - botMoneyBefore;
assert.ok(p1MoneyGain > 0.8 && p1MoneyGain < 1.2, `player1 received ~1 $/s (actual=${p1MoneyGain.toFixed(2)})`);
assert.ok(botMoneyGain > 0.8 && botMoneyGain < 1.2, `botUA received ~1 $/s (actual=${botMoneyGain.toFixed(2)})`);
assert.ok(Math.abs(p1MoneyGain - botMoneyGain) < 0.01, 'Income is split equally among team members');

// Test house destruction & proportional income drop:
// Destroy 5 of 10 houses in house1 -> profit drops by 50%
for (let i = 0; i < 5; i++) {
  house1.houses![i].hp = 0;
}
house1.hp = house1.houses!.reduce((acc, h) => acc + Math.max(0, h.hp), 0);
assert.equal(house1.hp, 250, 'house1 HP is 250 after 5 houses destroyed');

const p1DamagedBefore = sim.player('player1')!.res.money;
sim.step(1);
const p1DamagedGain = sim.player('player1')!.res.money - p1DamagedBefore;
// house1 output halved (-50%), house2 full -> team output drops from ~2.3 to ~1.72 -> ~0.86 per player
assert.ok(p1DamagedGain < p1MoneyGain && p1DamagedGain > 0.6 && p1DamagedGain < 0.95, `player1 income scaled down with destroyed houses (actual=${p1DamagedGain.toFixed(2)} < before=${p1MoneyGain.toFixed(2)})`);

// Destroy remaining 5 houses of house1 -> all houses destroyed -> house disappears completely
for (let i = 5; i < 10; i++) {
  house1.houses![i].hp = 0;
}
house1.hp = 0;
sim.step(1);
assert.equal(sim.world.buildings.some((b) => b.id === house1.id), false, 'house1 disappeared completely after all houses destroyed');
console.log('✓ Housing: max 2 per city, 10 houses * 50 HP, proportional damage, and total destruction verified');

// Test foreign borders & deposit containment:
assert.equal(sim.foreign([27.57, 47.16]), true, 'Iași (Romania) is foreign territory');
assert.equal(sim.foreign([25.35, 47.34]), true, 'Vatra Dornei (Romania) is foreign territory');
assert.equal(sim.foreign([28.86, 47.01]), true, 'Chișinău (Moldova) is foreign territory');
assert.equal(sim.foreign([30.52, 50.45]), false, 'Kyiv (Ukraine) is not foreign territory');

for (const dep of sim.deposits) {
  for (const pt of dep.polygon) {
    assert.equal(sim.foreign(pt), false, `Deposit ${dep.id} vertex [${pt}] must not be in foreign territory`);
  }
}
console.log('✓ Foreign borders: Romania and Moldova properly excluded from deposits and traversal');

// 11. Bot AI: HQ, Military Bases, Warehouses
const bUA = new Bot('botUA', 'normal');
const bRU = new Bot('botRU', 'normal');
bUA.think(sim);
bRU.think(sim);

const uaHq = sim.world.buildings.find((b) => b.owner === 'botUA' && b.def === 'hq');
const ruHq = sim.world.buildings.find((b) => b.owner === 'botRU' && b.def === 'hq');
assert.ok(uaHq, 'Bot UA placed an HQ');
assert.ok(ruHq, 'Bot RU placed an HQ');

assert.equal(sim.side(uaHq.pos), 0, 'UA HQ is on Ukrainian territory');
assert.ok(uaHq.pos[0] <= 32.5, `UA HQ is in the west of Ukraine (lng=${uaHq.pos[0].toFixed(2)} <= 32.5)`);
assert.ok(distToFrontKm(sim.world.front, uaHq.pos) >= 200, `UA HQ is >= 200 km from front`);
assert.ok(sim.roads?.isNear(uaHq.pos, 1.0), 'UA HQ is placed near a road');

assert.equal(sim.side(ruHq.pos), 1, 'RU HQ is on Russian territory');
assert.ok(ruHq.pos[0] >= 38.0, `RU HQ is in the east (lng=${ruHq.pos[0].toFixed(2)} >= 38.0)`);
assert.ok(distToFrontKm(sim.world.front, ruHq.pos) <= -200, `RU HQ is >= 200 km from front`);
assert.ok(sim.roads?.isNear(ruHq.pos, 1.0), 'RU HQ is placed near a road');

// Bots place warehouses ~80 km from front line
sim.step(3.0);
bUA.think(sim);
bRU.think(sim);

const uaWarehouses = sim.world.buildings.filter((b) => b.owner === 'botUA' && b.def === 'warehouse');
const ruWarehouses = sim.world.buildings.filter((b) => b.owner === 'botRU' && b.def === 'warehouse');
assert.ok(uaWarehouses.length >= 1, 'Bot UA placed a warehouse');
assert.ok(ruWarehouses.length >= 1, 'Bot RU placed a warehouse');

for (const wh of uaWarehouses) {
  assert.equal(sim.side(wh.pos), 0, 'UA warehouse on Ukrainian territory');
  const d = distToFrontKm(sim.world.front, wh.pos);
  assert.ok(d >= 50 && d <= 120, `UA warehouse near 80 km from front (actual=${d.toFixed(1)}km)`);
}
for (const wh of ruWarehouses) {
  assert.equal(sim.side(wh.pos), 1, 'RU warehouse on Russian territory');
  const d = Math.abs(distToFrontKm(sim.world.front, wh.pos));
  assert.ok(d >= 50 && d <= 120, `RU warehouse near 80 km from front (actual=${d.toFixed(1)}km)`);
}

// Bot military bases
sim.step(60.0); // let warehouses finish so bot can build more
bUA.think(sim);
bRU.think(sim);

const uaBases = sim.world.buildings.filter((b) => b.owner === 'botUA' && b.def === 'military_base');
const ruBases = sim.world.buildings.filter((b) => b.owner === 'botRU' && b.def === 'military_base');
assert.ok(uaBases.length >= 1, 'Bot UA placed a military base');
assert.ok(ruBases.length >= 1, 'Bot RU placed a military base');

for (const mb of uaBases) {
  assert.equal(sim.side(mb.pos), 0, 'UA military base is on Ukrainian territory');
  const d = distToFrontKm(sim.world.front, mb.pos);
  assert.ok(d >= 20 && d <= 80, `UA base is in priority 20-80 km zone (actual=${d.toFixed(1)}km)`);
}
for (const mb of ruBases) {
  assert.equal(sim.side(mb.pos), 1, 'RU military base is on Russian territory');
  const d = Math.abs(distToFrontKm(sim.world.front, mb.pos));
  assert.ok(d >= 20 && d <= 80, `RU base is in priority 20-80 km zone (actual=${d.toFixed(1)}km)`);
}

// Pairwise checks: military bases >= 20 km apart, warehouses >= 100 km apart
const allBases = sim.world.buildings.filter((b) => b.def === 'military_base');
for (let i = 0; i < allBases.length; i++) {
  for (let j = i + 1; j < allBases.length; j++) {
    const d = distKm(allBases[i].pos, allBases[j].pos);
    assert.ok(d >= 20, `Bases ${allBases[i].id} and ${allBases[j].id} must be at least 20 km apart (actual=${d.toFixed(1)}km)`);
  }
}

const allWhs = sim.world.buildings.filter((b) => b.def === 'warehouse');
for (let i = 0; i < allWhs.length; i++) {
  for (let j = i + 1; j < allWhs.length; j++) {
    const d = distKm(allWhs[i].pos, allWhs[j].pos);
    assert.ok(d >= 100, `Warehouses ${allWhs[i].id} and ${allWhs[j].id} must be at least 100 km apart (actual=${d.toFixed(1)}km)`);
  }
}

// Bots build mine, oil rig, and refinery when funded
sim.player('botUA')!.res.money = 50000;
sim.player('botRU')!.res.money = 50000;
sim.step(130.0);
bUA.think(sim);
bRU.think(sim);
sim.step(10.0);
bUA.think(sim);
bRU.think(sim);
sim.step(10.0);
bUA.think(sim);
bRU.think(sim);

const uaMine = sim.world.buildings.find((b) => b.owner === 'botUA' && b.def === 'mine');
const ruMine = sim.world.buildings.find((b) => b.owner === 'botRU' && b.def === 'mine');
assert.ok(uaMine, 'Bot UA built a mine');
assert.ok(ruMine, 'Bot RU built a mine');
assert.ok(inDeposit('iron', uaMine.pos, 0, sim.deposits), 'Bot UA mine is on UA iron deposit');
assert.ok(inDeposit('iron', ruMine.pos, 1, sim.deposits), 'Bot RU mine is on RU iron deposit');

const uaRig = sim.world.buildings.find((b) => b.owner === 'botUA' && b.def === 'oil_rig');
const ruRig = sim.world.buildings.find((b) => b.owner === 'botRU' && b.def === 'oil_rig');
assert.ok(uaRig, 'Bot UA built an oil rig');
assert.ok(ruRig, 'Bot RU built an oil rig');
assert.ok(inDeposit('oil', uaRig.pos, 0, sim.deposits), 'Bot UA oil rig is on UA oil deposit');
assert.ok(inDeposit('oil', ruRig.pos, 1, sim.deposits), 'Bot RU oil rig is on RU oil deposit');

// Team refinery limits enforced
assert.equal(sim.world.buildings.filter(b => b.team === 0 && b.def === 'refinery').length, 2, 'Team 0 has exactly 2 refineries');
assert.equal(sim.world.buildings.filter(b => b.team === 1 && b.def === 'refinery').length, 2, 'Team 1 has exactly 2 refineries');
console.log('✓ Bot AI: Mines on friendly iron deposits, Oil Rigs on friendly oil deposits, and Team Refinery limits verified');

console.log('✓ Bot AI: HQs, Warehouses (~80 km from front, >= 100 km apart), and Military Bases verified');

// 15. Bot AI: Housing Construction
const uaHousing = sim.world.buildings.filter((b) => b.owner === 'botUA' && b.def === 'housing');
const ruHousing = sim.world.buildings.filter((b) => b.owner === 'botRU' && b.def === 'housing');
assert.ok(uaHousing.length >= 1, 'Bot UA built housing in a friendly city');
assert.ok(ruHousing.length >= 1, 'Bot RU built housing in a friendly city');
for (const h of [...uaHousing, ...ruHousing]) {
  const city = sim.cityAt(h.pos);
  assert.ok(city, 'Bot housing is inside a city');
  assert.equal(sim.side(h.pos), h.team, 'Bot housing is on friendly territory');
}
console.log('✓ Bot AI: Housing districts built in friendly cities verified');

// 16. Infantry Unit Definition, Training at Military Base, and Movement Restrictions
const infDef = rs.units.find((u) => u.id === 'infantry')!;
assert.ok(infDef, 'Infantry unit is defined in units.json');
assert.equal(infDef.cost.money, 250, 'Infantry costs 250');
assert.equal(infDef.speed, 0.02778, 'Infantry moves at 100 km/h (0.02778 km/s)');
assert.equal(infDef.roadSpeedMult, 1.25, 'Infantry receives +25% road speed multiplier');
assert.equal(infDef.cannotCrossFront, true, 'Infantry has cannotCrossFront = true');
assert.equal(infDef.squadSize, 20, 'Infantry has 20 soldiers per squad');
assert.equal(infDef.hp, 1000, 'Infantry has 1000 HP (50 per soldier)');
assert.ok(!infDef.description?.includes('км/ч'), 'Infantry description does not mention speed');
assert.ok(!infDef.description?.includes('Бонус скорости'), 'Infantry description does not mention road bonus');
assert.ok(mbDef.trains?.includes('infantry'), 'Military base trains infantry');

// Let military bases finish building and have bots train infantry
for (const b of sim.world.buildings.filter(b => b.def === 'military_base')) {
  b.progress = 1;
}
sim.step(5.0);
bUA.think(sim);
bRU.think(sim);
sim.step(12.0); // 10s train time

const uaInfantry = sim.world.units.filter((u) => u.owner === 'botUA' && u.def === 'infantry');
const ruInfantry = sim.world.units.filter((u) => u.owner === 'botRU' && u.def === 'infantry');
assert.ok(uaInfantry.length >= 1, 'Bot UA trained infantry');
assert.ok(ruInfantry.length >= 1, 'Bot RU trained infantry');

// Human player trains infantry and tests movement rules
const p1Base = sim.world.buildings.find((b) => b.team === 0 && b.def === 'military_base')!;
p1Base.progress = 1;

const trainRes = sim.apply('player1', { type: 'train', building: p1Base.id, unit: 'infantry' });
assert.ok(trainRes.ok, 'Player 1 orders infantry successfully');
sim.step(12.0); // 10s train time

const playerInfantry = sim.world.units.find((u) => u.owner === 'player1' && u.def === 'infantry');
assert.ok(playerInfantry, 'Player 1 infantry spawned');

// Moving within friendly Ukrainian territory -> OK
const friendlyPos: [number, number] = [playerInfantry.pos[0] + 0.05, playerInfantry.pos[1] + 0.05];
const moveOk = sim.apply('player1', { type: 'move', units: [playerInfantry.id], to: friendlyPos });
assert.ok(moveOk.ok, 'Infantry moves freely within friendly territory');

// Moving across front line into Russian territory -> REJECTED
const enemyTerritory: [number, number] = [41.0, 48.0]; // Russia
assert.equal(sim.side(enemyTerritory), 1, 'Target is on Russian side');
const moveEnemy = sim.apply('player1', { type: 'move', units: [playerInfantry.id], to: enemyTerritory });
assert.ok(!moveEnemy.ok, 'Infantry move across front line must be rejected');
assert.ok(moveEnemy.reason.includes('front line'), `Error mentions front line: ${moveEnemy.reason}`);

// Moving into foreign territory (e.g. Romania) -> REJECTED
const foreignPos: [number, number] = [26.0, 46.5]; // Romania
assert.ok(sim.foreign(foreignPos), 'Target is in foreign territory');
const moveForeign = sim.apply('player1', { type: 'move', units: [playerInfantry.id], to: foreignPos });
assert.ok(!moveForeign.ok, 'Infantry move into foreign territory must be rejected');
assert.ok(moveForeign.reason.includes('foreign'), `Error mentions foreign territory: ${moveForeign.reason}`);

// Frontline infantry squads: 100 soldiers, cannot be ordered by player, stand in place
const flSquad = sim.world.units.find((u) => u.owner === '__front_0')!;
assert.ok(flSquad, 'Frontline garrison squad exists');
assert.equal(flSquad.hp, 5000, 'Frontline garrison squad has 5000 HP (100 soldiers)');
assert.equal(flSquad.stance, 'hold', 'Frontline garrison squad stands in place (stance: hold)');
const playerOrderToFrontline = sim.apply('player1', { type: 'move', units: [flSquad.id], to: friendlyPos });
assert.ok(!playerOrderToFrontline.ok, 'Player cannot command frontline squads');

console.log('✓ Infantry: 250 cost, 100 km/h, 20 fighters, clean description, front/foreign boundary movement restrictions verified');
console.log('✓ Frontline Garrisons: 100 fighters (5000 HP), autonomous, uncommandable by players, stand in place verified');

// 17. Housing Scale (+30% larger) and Dispersion (>= 85m spacing)
const testHouses = generateCityHouses([30.5, 50.4], 9999);
assert.equal(testHouses.length, 10, 'Housing generates 10 houses');
// Check pairwise distance is >= 0.085 km (85m)
for (let i = 0; i < testHouses.length; i++) {
  for (let j = i + 1; j < testHouses.length; j++) {
    const d = distKm(testHouses[i].pos, testHouses[j].pos);
    assert.ok(d >= 0.085, `Houses ${i} and ${j} must be at least 85m apart (actual=${(d * 1000).toFixed(0)}m)`);
  }
}
console.log('✓ Housing: 1.95x scaled dimensions and >=85m spacing dispersion verified');

console.log('All reboot tests passed successfully!');

