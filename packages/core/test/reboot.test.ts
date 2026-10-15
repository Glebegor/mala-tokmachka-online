import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { Bot } from '../../../services/game/src/application/bot';
import { Sim, offsetKm, distToFrontKm } from '../src';

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

// 3. Only single building "Военный штаб" exists
assert.equal(rs.buildings.length, 1, 'only 1 building definition exists');
const hqDef = rs.buildings[0];
assert.equal(hqDef.id, 'hq');
assert.equal(hqDef.name, 'Военный штаб');
assert.equal(hqDef.hp, 10000, 'HQ has 10,000 HP');
assert.equal(hqDef.maxPerPlayer, 1, 'only 1 HQ allowed per player');
console.log('✓ Single building: "Военный штаб" with 10k HP');

// 4. Placement anywhere on the map
const testPos: [number, number] = [36.2, 48.1];
const res = sim.apply('player1', { type: 'build', def: 'hq', pos: testPos });
assert.ok(res.ok, `HQ placement succeeded: ${res.reason ?? 'ok'}`);

const hq = sim.world.buildings.find((b) => b.owner === 'player1' && b.def === 'hq');
assert.ok(hq, 'HQ spawned in world');
assert.equal(hq.hp, 10000, 'HQ has 10,000 HP');
assert.equal(hq.progress, 1, 'HQ is instantly operational (progress = 1)');
assert.equal(hq.storage, undefined, 'HQ has no physical goods storage when only money exists');
console.log('✓ HQ placement anywhere on the map succeeds with instant 10,000 HP and no extra resources');

// 5. Cannot place a second HQ
const res2 = sim.apply('player1', { type: 'build', def: 'hq', pos: offsetKm(testPos, 5, 0) });
assert.equal(res2.ok, false, 'cannot place a second HQ');
assert.equal(res2.reason, 'limit reached');
console.log('✓ Player cannot place a second HQ (limit reached)');

// 6. Cannot demolish HQ
const demoRes = sim.apply('player1', { type: 'demolish', building: hq.id });
assert.equal(demoRes.ok, false, 'cannot demolish HQ');
assert.equal(demoRes.reason, 'cannot demolish HQ');
console.log('✓ HQ cannot be demolished or moved');

// 7. Bot HQ placement: UA placed in West of Ukraine far from front near road, RU placed in East far from front near road
const bUA = new Bot('botUA', 'normal');
const bRU = new Bot('botRU', 'normal');
bUA.think(sim);
bRU.think(sim);

const uaHq = sim.world.buildings.find((b) => b.owner === 'botUA' && b.def === 'hq');
const ruHq = sim.world.buildings.find((b) => b.owner === 'botRU' && b.def === 'hq');
assert.ok(uaHq, 'Bot UA placed an HQ');
assert.ok(ruHq, 'Bot RU placed an HQ');

assert.equal(sim.side(uaHq.pos), 0, 'UA HQ is on Ukrainian territory');
assert.ok(uaHq.pos[0] <= 34.0, `UA HQ is in the west of Ukraine (lng=${uaHq.pos[0].toFixed(2)} <= 34.0)`);
assert.ok(distToFrontKm(sim.world.front, uaHq.pos) >= 60, `UA HQ is far from front (dist=${distToFrontKm(sim.world.front, uaHq.pos).toFixed(1)}km >= 60km)`);
assert.ok(sim.roads?.isNear(uaHq.pos, 1.0), 'UA HQ is placed near a road');

assert.equal(sim.side(ruHq.pos), 1, 'RU HQ is on Russian territory');
assert.ok(ruHq.pos[0] >= 37.0, `RU HQ is in the east (lng=${ruHq.pos[0].toFixed(2)} >= 37.0)`);
assert.ok(distToFrontKm(sim.world.front, ruHq.pos) <= -50, `RU HQ is far from front (dist=${Math.abs(distToFrontKm(sim.world.front, ruHq.pos)).toFixed(1)}km >= 50km)`);
assert.ok(sim.roads?.isNear(ruHq.pos, 1.0), 'RU HQ is placed near a road');
console.log('✓ Bot HQ placement: UA placed in West Ukraine far from front near road, RU in East far from front near road');

// 8. Simulation ticks cleanly without errors
for (let i = 0; i < 20; i++) sim.step(0.1);
assert.equal(sim.world.winner, null, 'match continues cleanly');
console.log('✓ Simulation ticks cleanly with single HQ and money-only economy');

console.log('All reboot tests passed successfully!');
