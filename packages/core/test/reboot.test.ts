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

// 2. Only single resource "money" exists
assert.equal(rs.resources.length, 1, 'only 1 resource exists');
assert.equal(rs.resources[0].id, 'money', 'the only resource is money');
console.log('✓ Only resource is Money');

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
console.log('✓ Buildings: "Военный штаб" and "Военная база" definitions verified');

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

// 6.5. Military Base placement and 20 km radius restriction
const basePos1 = offsetKm(testPos, 30, 0);
const mbRes1 = sim.apply('player1', { type: 'build', def: 'military_base', pos: basePos1 });
assert.ok(mbRes1.ok, 'Military base placement succeeded');
const mb1 = sim.world.buildings.find((b) => b.owner === 'player1' && b.def === 'military_base');
assert.ok(mb1, 'Military base spawned');
assert.equal(mb1.hp, 5000, 'Military base has 5000 HP');
assert.equal(mb1.progress, 1, 'Military base is instantly built');

// Cannot build 2nd military base within 20 km
const mbResClose = sim.apply('player1', { type: 'build', def: 'military_base', pos: offsetKm(basePos1, 10, 0) });
assert.equal(mbResClose.ok, false, 'cannot place military base within 20 km of another military base');
assert.equal(mbResClose.reason, 'keep at least 20 km from other military bases');

// Can build 2nd military base at distance >= 20 km
const basePos2 = offsetKm(basePos1, 25, 0);
const mbRes2 = sim.apply('player1', { type: 'build', def: 'military_base', pos: basePos2 });
assert.ok(mbRes2.ok, '2nd military base placement succeeded at >= 20 km');

// Can demolish military base (unlike HQ)
const mbDemo = sim.apply('player1', { type: 'demolish', building: mb1.id });
assert.ok(mbDemo.ok, 'Military base can be demolished');
assert.ok(!sim.world.buildings.some((b) => b.id === mb1.id), 'Military base removed from world');
console.log('✓ Military Base: placement, 20 km clash restriction, and demolition verified');

// 7. Bot HQ placement: UA placed in West of Ukraine >= 200 km from front, RU placed in East >= 200 km from front, both >= 100 km from any HQ
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

// 8. Simulation ticks cleanly without errors
for (let i = 0; i < 20; i++) sim.step(0.1);
assert.equal(sim.world.winner, null, 'match continues cleanly');
console.log('✓ Simulation ticks cleanly with single HQ and money-only economy');

console.log('All reboot tests passed successfully!');
