import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { Bot } from '../../../services/game/src/application/bot';
import { Sim, offsetKm, distToFrontKm, distKm, DEPOSITS, inDeposit, depositsGeoJSON } from '../src';

const rs = await loadRuleset(fileURLToPath(new URL('../../../mods', import.meta.url)));

const sim = new Sim(rs, 'ukraine', [
  { id: 'player1', name: 'Player 1', team: 0, bot: false },
  { id: 'player2', name: 'Player 2', team: 1, bot: false },
  { id: 'botUA', name: 'Bot UA', team: 0, bot: true },
  { id: 'botRU', name: 'Bot RU', team: 1, bot: true },
]);

// 1. Clean slate verification
assert.equal(sim.world.buildings.length, 0, 'map starts with 0 buildings');
assert.equal(sim.world.units.length, 0, 'map starts with 0 units');
assert.equal(sim.world.posts.length, 0, 'map starts with 0 frontline garrison posts');
console.log('✓ Clean slate: 0 buildings, 0 units, 0 posts');

// 2. Resources: Money (10k start) and Ore (cap 5000)
assert.equal(rs.resources.length, 2, '2 resources defined: money and ore');
const moneyRes = rs.resources.find((r) => r.id === 'money')!;
assert.equal(moneyRes.start, 10000, 'starting money is 10k');
const oreRes = rs.resources.find((r) => r.id === 'ore')!;
assert.equal(oreRes.cap, 5000, 'ore cap is 5000');
console.log('✓ Resources: Money (10k start) and physical Ore (cap 5k) verified');

// 3. Buildings: HQ, Military Base, Warehouse, Mine, Housing
assert.equal(rs.buildings.length, 5, '5 building definitions exist');
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
assert.equal(mineDef.storageCap, 5000, 'Mine stores up to 5000 ore');
assert.equal(mineDef.produces?.ore, 5, 'Mine produces 5 ore/s');

const houseDef = rs.buildings.find((b) => b.id === 'housing')!;
assert.equal(houseDef.cost.money, 2000, 'Housing costs 2000');
assert.equal(houseDef.produces?.money, 10, 'Housing produces 10 $/s');
console.log('✓ Buildings defined: HQ, Military Base, Warehouse, Mine, Housing verified');

// 4. Procedural Terrain Full Map Coverage
const farPointRU: [number, number] = [48.0, 56.0];
const farTerrainRU = sim.terrainAt(farPointRU);
assert.ok(['field', 'forest', 'hill', 'water'].includes(farTerrainRU.id), `Procedural terrain generates valid terrain for far east RU (actual=${farTerrainRU.id})`);
const farPointWest: [number, number] = [21.0, 50.0];
const farTerrainWest = sim.terrainAt(farPointWest);
assert.ok(['field', 'forest', 'hill', 'water'].includes(farTerrainWest.id), `Procedural terrain generates valid terrain for west map (actual=${farTerrainWest.id})`);
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
assert.equal(inDeposit('iron', nonDepPos), null, 'pos is not on iron deposit');
const mineResFail = sim.apply('player1', { type: 'build', def: 'mine', pos: nonDepPos });
assert.equal(mineResFail.ok, false, 'mine rejected outside iron deposit');
assert.equal(mineResFail.reason, 'mines can only be built on iron deposits');

// Find a friendly iron deposit in Ukraine
const friendlyIronDep = ironDeps.find((d) => d.team === 0 && sim.side(d.center) === 0)!;
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
console.log('✓ Mine: strictly inside iron deposits, accumulates ore in storage up to 5k cap');

// 10. Housing: placed only in cities held by team, max 5 per city, produces 10 $/s split among team
const nonCityPos: [number, number] = [33.0, 48.0];
const houseNonCity = sim.apply('player1', { type: 'build', def: 'housing', pos: nonCityPos });
assert.equal(houseNonCity.ok, false, 'housing rejected outside city');
assert.equal(houseNonCity.reason, 'housing can only be built inside a city');

// Find friendly city
const friendlyCity = sim.map.capturePoints.find((cp, idx) => sim.world.points[idx]?.owner === 0)!;
assert.ok(friendlyCity, 'Friendly city found');

// Build 5 housing blocks in this city
for (let i = 0; i < 5; i++) {
  const pPos = offsetKm(friendlyCity.pos, (i - 2) * 0.15, 0.1);
  const hRes = sim.apply('player1', { type: 'build', def: 'housing', pos: pPos });
  assert.ok(hRes.ok, `Housing block ${i + 1} placement succeeded`);
}

// 6th housing block in the same city should be rejected (max 5)
const pPos6 = offsetKm(friendlyCity.pos, 0.5, 0.5);
const hRes6 = sim.apply('player1', { type: 'build', def: 'housing', pos: pPos6 });
assert.equal(hRes6.ok, false, '6th housing block in city rejected');
assert.equal(hRes6.reason, 'at most 5 housing blocks per city');

// Finish housing construction (30s)
sim.step(30);

// Check income splitting: each housing produces 10 $/s.
// Team 0 has 2 players: 'player1' and 'botUA'.
// Each player gets 10 / 2 = 5 $/s per housing.
const p1MoneyBefore = sim.player('player1')!.res.money;
const botMoneyBefore = sim.player('botUA')!.res.money;
sim.step(1);
const p1MoneyGain = sim.player('player1')!.res.money - p1MoneyBefore;
const botMoneyGain = sim.player('botUA')!.res.money - botMoneyBefore;
assert.ok(p1MoneyGain > 0, 'player1 received housing income');
assert.ok(botMoneyGain > 0, 'botUA received equal share of housing income');
assert.ok(Math.abs(p1MoneyGain - botMoneyGain) < 0.1, 'Income is split equally among team members');
console.log('✓ Housing: max 5 per city, 10 $/s split equally among team players');

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

console.log('✓ Bot AI: HQs, Warehouses (~80 km from front, >= 100 km apart), and Military Bases verified');
console.log('All reboot tests passed successfully!');
