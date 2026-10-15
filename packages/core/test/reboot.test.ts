import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { Sim, offsetKm } from '../src';

const rs = await loadRuleset(fileURLToPath(new URL('../../../mods', import.meta.url)));

const sim = new Sim(rs, 'ukraine', [
  { id: 'player1', name: 'Player 1', team: 0, bot: false },
  { id: 'player2', name: 'Player 2', team: 1, bot: false },
]);

// 1. Clean slate verification
assert.equal(sim.world.buildings.length, 0, 'map starts with 0 buildings');
assert.equal(sim.world.units.length, 0, 'map starts with 0 units');
assert.equal(sim.world.posts.length, 0, 'map starts with 0 frontline garrison posts');
console.log('✓ Clean slate: 0 buildings, 0 units, 0 posts');

// 2. Only single building "Военный штаб" exists
assert.equal(rs.buildings.length, 1, 'only 1 building definition exists');
const hqDef = rs.buildings[0];
assert.equal(hqDef.id, 'hq');
assert.equal(hqDef.name, 'Военный штаб');
assert.equal(hqDef.hp, 10000, 'HQ has 10,000 HP');
assert.equal(hqDef.maxPerPlayer, 1, 'only 1 HQ allowed per player');
console.log('✓ Single building: "Военный штаб" with 10k HP');

// 3. Placement anywhere on the map
const testPos: [number, number] = [36.2, 48.1];
const res = sim.apply('player1', { type: 'build', def: 'hq', pos: testPos });
assert.ok(res.ok, `HQ placement succeeded: ${res.reason ?? 'ok'}`);

const hq = sim.world.buildings.find((b) => b.owner === 'player1' && b.def === 'hq');
assert.ok(hq, 'HQ spawned in world');
assert.equal(hq.hp, 10000, 'HQ has 10,000 HP');
assert.equal(hq.progress, 1, 'HQ is instantly operational (progress = 1)');
console.log('✓ HQ placement anywhere on the map succeeds with instant 10,000 HP');

// 4. Cannot place a second HQ
const res2 = sim.apply('player1', { type: 'build', def: 'hq', pos: offsetKm(testPos, 5, 0) });
assert.equal(res2.ok, false, 'cannot place a second HQ');
assert.equal(res2.reason, 'limit reached');
console.log('✓ Player cannot place a second HQ (limit reached)');

// 5. Cannot demolish HQ
const demoRes = sim.apply('player1', { type: 'demolish', building: hq.id });
assert.equal(demoRes.ok, false, 'cannot demolish HQ');
assert.equal(demoRes.reason, 'cannot demolish HQ');
console.log('✓ HQ cannot be demolished or moved');

// 6. Simulation ticks cleanly without errors
for (let i = 0; i < 20; i++) sim.step(0.1);
assert.equal(sim.world.winner, null, 'match continues cleanly');
console.log('✓ Simulation ticks cleanly with single HQ');

console.log('All reboot clean-slate tests passed!');
