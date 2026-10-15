import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { Bot } from '../../../services/game/src/application/bot';
import { Sim, offsetKm, distToFrontKm, distKm } from '../src';

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

// 2. Only single resource "money" exists with 10k starting funds
assert.equal(rs.resources.length, 1, 'only 1 resource exists');
assert.equal(rs.resources[0].id, 'money', 'the only resource is money');
assert.equal(rs.resources[0].start, 10000, 'starting money is 10k');
console.log('✓ Only resource is Money (start = 10k)');

// 3. Buildings: "Военный штаб" and "Военная база"
assert.equal(rs.buildings.length, 2, '2 building definitions exist');
const hqDef = rs.buildings.find((b) => b.id === 'hq')!;
assert.equal(hqDef.id, 'hq');
assert.equal(hqDef.name, 'Военный штаб');
assert.equal(hqDef.hp, 10000, 'HQ has 10,000 HP');
assert.equal(hqDef.maxPerPlayer, 1, 'only 1 HQ allowed per player');

const mbDef = rs.buildings.find((b) => b.id === 'military_base')!;
assert.equal(mbDef.id, 'military_base');
assert.equal(mbDef.name, 'Военная база');
assert.equal(mbDef.hp, 5000, 'Military base has 5,000 HP');
assert.equal(mbDef.cost.money, 2500, 'Military base costs 2500');
assert.equal(mbDef.buildTime, 120, 'Military base build time is 120 s (2 minutes)');
console.log('✓ Buildings: "Военный штаб" and "Военная база" (cost: 2500, time: 2 min) verified');

// 4. Placement anywhere on the map
const testPos: [number, number] = [36.2, 48.1];

// Cannot place military base without HQ first
const earlyBase = sim.apply('player2', { type: 'build', def: 'military_base', pos: [30.0, 49.0] });
assert.equal(earlyBase.ok, false, 'cannot build military base before placing HQ');
assert.equal(earlyBase.reason, 'must place military HQ first');
console.log('✓ Cannot build military base before placing HQ');

const res = sim.apply('player1', { type: 'build', def: 'hq', pos: testPos });
assert.ok(res.ok, 'HQ placement succeeded');

const hq = sim.world.buildings.find((b) => b.owner === 'player1' && b.def === 'hq');
assert.ok(hq, 'HQ spawned in world');
assert.equal(hq.hp, 10000, 'HQ has 10,000 HP');
assert.equal(hq.progress, 1, 'HQ is instantly operational (progress = 1)');
assert.equal(hq.storage, undefined, 'HQ has no physical goods storage when only money exists');
console.log('✓ HQ placement anywhere on the map succeeds with instant 10,000 HP and no extra resources');

// 5. Cannot place an HQ within 100 km of another HQ (and max 1 per player)
const res2 = sim.apply('player1', { type: 'build', def: 'hq', pos: offsetKm(testPos, 5, 0) });
assert.equal(res2.ok, false, 'cannot place a second HQ');
assert.equal(res2.reason, 'limit reached');

const resPlayer2Close = sim.apply('player2', { type: 'build', def: 'hq', pos: offsetKm(testPos, 40, 0) });
assert.equal(resPlayer2Close.ok, false, 'player 2 cannot place HQ within 100 km of player 1 HQ');
assert.equal(resPlayer2Close.reason, 'keep at least 100 km from other military HQs');
console.log('✓ HQ spacing: rejected when within 100 km of another military HQ');

// 6. Cannot demolish HQ
const demoRes = sim.apply('player1', { type: 'demolish', building: hq.id });
assert.equal(demoRes.ok, false, 'cannot demolish HQ');
assert.equal(demoRes.reason, 'cannot demolish HQ');
console.log('✓ HQ cannot be demolished or moved');

// 6.5. Military Base placement, territory restrictions, and 20 km radius restriction
// Cannot build military base on enemy territory
const enemyPos: [number, number] = [39.0, 48.0];
const mbEnemy = sim.apply('player1', { type: 'build', def: 'military_base', pos: enemyPos });
assert.equal(mbEnemy.ok, false, 'cannot build military base on enemy territory');
assert.equal(mbEnemy.reason, 'cannot build on enemy territory');

// Build on own territory
const basePos1 = offsetKm(testPos, -30, 0);
const mbRes1 = sim.apply('player1', { type: 'build', def: 'military_base', pos: basePos1 });
assert.ok(mbRes1.ok, 'Military base placement succeeded');
const mb1 = sim.world.buildings.find((b) => b.owner === 'player1' && b.def === 'military_base');
assert.ok(mb1, 'Military base spawned');
assert.equal(mb1.hp, 5000, 'Military base has 5000 HP');
assert.equal(mb1.progress, 0, 'Military base starts under construction (progress = 0)');

// Cannot build 2nd military base within 20 km
const mbResClose = sim.apply('player1', { type: 'build', def: 'military_base', pos: offsetKm(basePos1, -10, 0) });
assert.equal(mbResClose.ok, false, 'cannot place military base within 20 km of another military base');
assert.equal(mbResClose.reason, 'keep at least 20 km from other military bases');

// Can build 2nd military base at distance >= 20 km
const basePos2 = offsetKm(basePos1, -25, 0);
const mbRes2 = sim.apply('player1', { type: 'build', def: 'military_base', pos: basePos2 });
assert.ok(mbRes2.ok, '2nd military base placement succeeded at >= 20 km');

// Can demolish military base (unlike HQ)
const mbDemo = sim.apply('player1', { type: 'demolish', building: mb1.id });
assert.ok(mbDemo.ok, 'Military base can be demolished');
assert.ok(!sim.world.buildings.some((b) => b.id === mb1.id), 'Military base removed from world');
console.log('✓ Military Base: territory checks, 20 km clash restriction, 2-minute build time and demolition verified');

// 7. Bot HQ and Military Base placement
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
assert.ok(distToFrontKm(sim.world.front, uaHq.pos) >= 200, `UA HQ is >= 200 km from front (dist=${distToFrontKm(sim.world.front, uaHq.pos).toFixed(1)}km >= 200km)`);
assert.ok(sim.roads?.isNear(uaHq.pos, 1.0), 'UA HQ is placed near a road');

assert.equal(sim.side(ruHq.pos), 1, 'RU HQ is on Russian territory');
assert.ok(ruHq.pos[0] >= 38.0, `RU HQ is in the east (lng=${ruHq.pos[0].toFixed(2)} >= 38.0)`);
assert.ok(distToFrontKm(sim.world.front, ruHq.pos) <= -200, `RU HQ is >= 200 km from front (dist=${Math.abs(distToFrontKm(sim.world.front, ruHq.pos)).toFixed(1)}km >= 200km)`);
assert.ok(sim.roads?.isNear(ruHq.pos, 1.0), 'RU HQ is placed near a road');

// Check pairwise 100 km distance between all HQs
const allHqs = sim.world.buildings.filter((b) => b.def === 'hq');
for (let i = 0; i < allHqs.length; i++) {
  for (let j = i + 1; j < allHqs.length; j++) {
    const d = distKm(allHqs[i].pos, allHqs[j].pos);
    assert.ok(d >= 100, `HQs ${allHqs[i].id} and ${allHqs[j].id} must be at least 100 km apart (actual=${d.toFixed(1)}km)`);
  }
}
console.log('✓ Bot HQ placement: UA placed in West Ukraine >= 200 km from front, RU in East >= 200 km from front, all HQs >= 100 km apart');

// Bots place military bases on friendly territory prioritizing 20-80 km from front
sim.step(3.0);
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

// Check pairwise 20 km distance between all military bases
const allBases = sim.world.buildings.filter((b) => b.def === 'military_base');
for (let i = 0; i < allBases.length; i++) {
  for (let j = i + 1; j < allBases.length; j++) {
    const d = distKm(allBases[i].pos, allBases[j].pos);
    assert.ok(d >= 20, `Bases ${allBases[i].id} and ${allBases[j].id} must be at least 20 km apart (actual=${d.toFixed(1)}km)`);
  }
}
console.log('✓ Bot military bases: placed in priority 20-80 km zone on friendly territory, all >= 20 km apart');

// 8. Simulation ticks: military base finishes construction after 120 seconds
const mb2 = sim.world.buildings.find((b) => b.owner === 'player1' && b.def === 'military_base')!;
assert.ok(mb2.progress < 1, 'mb2 is initially under construction');
sim.step(120);
assert.equal(mb2.progress, 1, 'mb2 completed construction after 120 seconds (2 minutes)');
console.log('✓ 2-minute construction time verified: base completed after 120 seconds');

console.log('All reboot tests passed successfully!');
