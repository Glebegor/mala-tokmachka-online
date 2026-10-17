import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { Sim, cellOf, cellCenter, isAdjacentCell, distKm, type Unit, type LngLat } from '../src';

const rs = await loadRuleset(fileURLToPath(new URL('../../../mods', import.meta.url)));

const sim = new Sim(rs, 'zaporizhzhia', [
  { id: 'player1', name: 'Player 1', team: 0, bot: false },
  { id: 'player2', name: 'Player 2', team: 1, bot: false },
]);

console.log('--- Testing Tile Frontline & Troop Movement (HoI Style, 60s Assault) ---');

// 1. Initial State Verification: Every border tile has a garrison, strength 1 (100 soldiers, 5000 HP, 100 ammo)
const uaGarrisons = sim.world.units.filter((u) => u.team === 0 && (u.owner.startsWith('__front_') || u.def === 'frontline_infantry'));
const ruGarrisons = sim.world.units.filter((u) => u.team === 1 && (u.owner.startsWith('__front_') || u.def === 'frontline_infantry'));

assert.ok(uaGarrisons.length > 50, `UA frontline garrisons deployed across tiles (count=${uaGarrisons.length})`);
assert.ok(ruGarrisons.length > 50, `RU frontline garrisons deployed across tiles (count=${ruGarrisons.length})`);

// Verify all initial garrisons start with strength 1, 100 squadSize, 5000 HP, 100 ammo
assert.ok(uaGarrisons.every((u) => (u.strength ?? 1) === 1), 'All UA garrisons start with strength 1');
assert.ok(ruGarrisons.every((u) => (u.strength ?? 1) === 1), 'All RU garrisons start with strength 1');
assert.ok(uaGarrisons.every((u) => u.squadSize === 100), 'All UA garrisons start with 100 soldiers');
assert.ok(uaGarrisons.every((u) => u.hp === 5000), 'All UA garrisons start with 5000 HP');
assert.ok(uaGarrisons.every((u) => u.ammo === 100), 'All UA garrisons start with 100 ammo');

const dirs: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const uaDiagonalOnly = uaGarrisons.filter((u) => {
  const [cx, cy] = cellOf(u.pos);
  return !dirs.some(([dx, dy]) => sim.side(cellCenter(cx + dx, cy + dy)) === 1);
});
const ruDiagonalOnly = ruGarrisons.filter((u) => {
  const [cx, cy] = cellOf(u.pos);
  return !dirs.some(([dx, dy]) => sim.side(cellCenter(cx + dx, cy + dy)) === 0);
});
assert.equal(uaDiagonalOnly.length, 0, 'No UA diagonal corner garrisons exist');
assert.equal(ruDiagonalOnly.length, 0, 'No RU diagonal corner garrisons exist');
console.log(`✓ Frontline Garrison Deployment Verified: ${uaGarrisons.length} UA, ${ruGarrisons.length} RU (0 diagonal-only corner garrisons, 100 soldiers, 5000 HP, 100 Ammo)`);

// Find an opposing pair of garrisons
const gUA = uaGarrisons[0];
const curUaCell = cellOf(gUA.pos);
console.log(`UA garrison ID ${gUA.id} at tile [${curUaCell[0]}, ${curUaCell[1]}], pos:`, gUA.pos);

// Test Forbidden Diagonal Attacks:
const diagonalEnemyCell: [number, number] = [curUaCell[0] + 1, curUaCell[1] + 1];
const diagRes = sim.apply('player1', {
  type: 'attackTile',
  unitId: gUA.id,
  targetCell: diagonalEnemyCell,
});
assert.equal(diagRes.ok, false, 'Diagonal attack is forbidden');
console.log('✓ Diagonal Attack Forbidden: only orthogonal (cardinal) attacks are permitted');

// Find adjacent orthogonal enemy tile
const orthogonalDirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
let adjEnemyCell: [number, number] | null = null;
for (const [dx, dy] of orthogonalDirs) {
  const cand: [number, number] = [curUaCell[0] + dx, curUaCell[1] + dy];
  const candCenter = cellCenter(cand[0], cand[1]);
  if (sim.side(candCenter) === 1) {
    adjEnemyCell = cand;
    break;
  }
}

assert.ok(adjEnemyCell, 'Found orthogonal adjacent enemy tile to UA garrison');
console.log(`Adjacent enemy tile: [${adjEnemyCell[0]}, ${adjEnemyCell[1]}]`);

// 2. Test Stalemate: Enemy has equal/more troops AND has ammo -> 60s assault is repelled
const candCenter = cellCenter(adjEnemyCell[0], adjEnemyCell[1]);
const defendingRu = sim.world.units.find((u) => u.team === 1 && cellOf(u.pos)[0] === adjEnemyCell![0] && cellOf(u.pos)[1] === adjEnemyCell![1])
  ?? sim.spawnUnit('frontline_infantry', sim.player('player2')!, candCenter);

defendingRu.hp = 5000;
defendingRu.squadSize = 100;
defendingRu.ammo = 100;
defendingRu.pos = [candCenter[0], candCenter[1]];

gUA.hp = 5000;
gUA.squadSize = 100;
gUA.ammo = 100;
const startUaPos: [number, number] = [gUA.pos[0], gUA.pos[1]];

const orderRes = sim.apply('player1', {
  type: 'attackTile',
  unitId: gUA.id,
  targetCell: adjEnemyCell,
});

assert.equal(orderRes.ok, true, 'Assault order accepted');
assert.ok(gUA.assault, 'Assault object created on attacking garrison');
assert.equal(gUA.assault?.total, 60, 'Assault takes 60 seconds (1 minute march)');
assert.equal(gUA.frontStatus, 'advancing', 'Garrison status updated to advancing');

// March for 30 seconds (halfway)
for (let i = 0; i < 30; i++) sim.step(1.0);
assert.ok(gUA.assault, 'Assault still underway after 30 seconds');
assert.ok(distKm(gUA.pos, startUaPos) > 0.1, 'Garrison physically marched towards target tile');
assert.ok(distKm(gUA.pos, candCenter) < distKm(startUaPos, candCenter), 'Garrison is closer to enemy tile center');

// March remaining 30 seconds to completion (total 60s)
for (let i = 0; i < 30; i++) sim.step(1.0);
assert.equal(gUA.assault, undefined, 'Assault completed at 60 seconds');
assert.deepEqual(gUA.pos, startUaPos, 'Attacking garrison fell back to home tile after being repelled');
assert.equal(sim.side(candCenter), 1, 'Tile remains under Russian control');
assert.ok(gUA.ammo < 100, 'Attacker consumed ammo in skirmishes and repel penalty');
console.log('✓ 60-Second March & Stalemate: Garrison marches for 1 min, skirmishes, and is repelled when forces are equal and defender has ammo');

// 3. Test Breakthrough Condition A: Enemy runs out of ammo (ammo <= 0), retreats, merges & gets 2-minute attack debuff
defendingRu.ammo = 0; // Out of ammo!
gUA.ammo = 80; // Reset UA ammo
gUA.hp = 5000;

// Place a rear friendly Russian unit to receive the retreating squad (merge/stack test)
const rearTile: [number, number] = [adjEnemyCell[0], adjEnemyCell[1] - 1];
let rearFriend = sim.world.units.find((u) => u.team === 1 && cellOf(u.pos)[0] === rearTile[0] && cellOf(u.pos)[1] === rearTile[1]);
if (!rearFriend) {
  rearFriend = sim.spawnUnit('frontline_infantry', sim.player('player2')!, cellCenter(rearTile[0], rearTile[1]));
}
rearFriend.strength = 1;
rearFriend.squadSize = 100;
rearFriend.hp = 5000;

const winAmmoOrder = sim.apply('player1', {
  type: 'attackTile',
  unitId: gUA.id,
  targetCell: adjEnemyCell,
});
assert.equal(winAmmoOrder.ok, true, 'Attack order accepted against out-of-ammo defender');

// March for 60 seconds
for (let i = 0; i < 60; i++) sim.step(1.0);

assert.equal(gUA.assault, undefined, 'Assault completed');
assert.equal(sim.side(candCenter), 0, 'Target tile flipped to Ukrainian control');
assert.ok(distKm(gUA.pos, candCenter) < 0.05, 'Attacking garrison reached target tile center');

// Check that retreating enemy merged with rear friendly garrison in retreat tile
assert.equal(defendingRu.hp, 0, 'Defeated enemy garrison merged into friendly unit (token cleaned up)');
assert.ok((rearFriend.strength ?? 1) >= 2, 'Rear garrison gained strength from retreating squad (stacked)');
assert.ok((rearFriend.squadSize ?? 100) >= 200, 'Rear garrison headcount increased from retreating squad (stacked)');
assert.ok(rearFriend.attackDebuffUntil !== undefined && rearFriend.attackDebuffUntil > sim.world.time + 100, 'Rear unit received 2-minute attack debuff');

// Test that debuffed unit CANNOT conduct attacks
const debuffedAttack = sim.apply('player2', {
  type: 'attackTile',
  unitId: rearFriend.id,
  targetCell: adjEnemyCell,
});
assert.equal(debuffedAttack.ok, false, 'Debuffed unit cannot conduct attacks for 2 minutes');
console.log('✓ Breakthrough, Garrison Merge & 2-Minute Attack Debuff: Retreating troops merge with friends, stack strength/soldiers, and cannot attack for 2 min');

// 4. Test Breakthrough Condition B: Attacker has numerical superiority (myTroops > enemyTroops)
const curCell2 = cellOf(gUA.pos);
let adjEnemyCell2: [number, number] | null = null;
for (const [dx, dy] of orthogonalDirs) {
  const cand: [number, number] = [curCell2[0] + dx, curCell2[1] + dy];
  const center = cellCenter(cand[0], cand[1]);
  if (sim.side(center) === 1) {
    adjEnemyCell2 = cand;
    break;
  }
}

if (adjEnemyCell2) {
  const center2 = cellCenter(adjEnemyCell2[0], adjEnemyCell2[1]);
  const ruDefender2 = sim.world.units.find((u) => u.team === 1 && cellOf(u.pos)[0] === adjEnemyCell2![0] && cellOf(u.pos)[1] === adjEnemyCell2![1])
    ?? sim.spawnUnit('frontline_infantry', sim.player('player2')!, center2);

  ruDefender2.pos = [center2[0], center2[1]];
  ruDefender2.ammo = 100;
  ruDefender2.squadSize = 100; // 100 defenders

  gUA.squadSize = 300; // 300 attackers (superior force)
  gUA.ammo = 100;
  gUA.hp = 15000;

  const winSuperiorOrder = sim.apply('player1', {
    type: 'attackTile',
    unitId: gUA.id,
    targetCell: adjEnemyCell2,
  });

  assert.equal(winSuperiorOrder.ok, true, 'Attack order accepted');
  // March for 60 seconds
  for (let i = 0; i < 60; i++) sim.step(1.0);

  assert.equal(sim.side(center2), 0, 'Tile captured by superior UA garrison');
  assert.ok(distKm(gUA.pos, center2) < 0.05, 'Garrison reached target center');
  console.log('✓ Breakthrough via Force Superiority: Garrison takes tile after 60s march when myTroops > oppTroops');
}

// 5. Test Friendly Tile Movement (Relocation)
const curUaCellNow = cellOf(gUA.pos);
let friendlyNeighbor: [number, number] | null = null;
for (const [dx, dy] of orthogonalDirs) {
  const cand: [number, number] = [curUaCellNow[0] + dx, curUaCellNow[1] + dy];
  if (sim.side(cellCenter(cand[0], cand[1])) === 0) {
    friendlyNeighbor = cand;
    break;
  }
}
assert.ok(friendlyNeighbor, 'Found adjacent friendly tile');
const moveRes = sim.apply('player1', {
  type: 'attackTile',
  unitId: gUA.id,
  targetCell: friendlyNeighbor,
});
assert.equal(moveRes.ok, true, 'Garrison relocation order accepted');
assert.equal(gUA.assault?.isRelocation, true, 'Marked as friendly relocation');
// Step 60s
for (let i = 0; i < 60; i++) sim.step(1.0);
assert.equal(gUA.assault, undefined, 'Relocation complete');
assert.ok(distKm(gUA.pos, cellCenter(friendlyNeighbor[0], friendlyNeighbor[1])) < 0.05, 'Garrison arrived at friendly tile center');
console.log('✓ Friendly Movement: Garrison repositions to friendly tile center over 60s');

// 6. Test Friendly Garrison Stacking / Merging:
// When garrison A moves into garrison B's tile, garrison B absorbs garrison A (strength & soldiers stack), and garrison A disappears (hp = 0, removed from units)
const friendTile = friendlyNeighbor;
const existingGarrison = gUA; // gUA is now stationed at friendTile
existingGarrison.strength = 1;
existingGarrison.squadSize = 100;
existingGarrison.hp = 5000;
existingGarrison.ammo = 80;

// Find another adjacent friendly tile to spawn an incoming garrison
let neighborOfFriend: [number, number] | null = null;
for (const [dx, dy] of orthogonalDirs) {
  const cand: [number, number] = [friendTile[0] + dx, friendTile[1] + dy];
  if (sim.side(cellCenter(cand[0], cand[1])) === 0 && !(cand[0] === friendTile[0] && cand[1] === friendTile[1])) {
    neighborOfFriend = cand;
    break;
  }
}
assert.ok(neighborOfFriend, 'Found neighbor tile of friend');
const incomingGarrison = sim.spawnUnit('frontline_infantry', sim.player('player1')!, cellCenter(neighborOfFriend[0], neighborOfFriend[1]));
incomingGarrison.strength = 1;
incomingGarrison.squadSize = 100;
incomingGarrison.hp = 5000;
incomingGarrison.ammo = 90;

const mergeOrder = sim.apply('player1', {
  type: 'attackTile',
  unitId: incomingGarrison.id,
  targetCell: friendTile,
});
assert.equal(mergeOrder.ok, true, 'Relocation to occupied friendly tile accepted');
assert.equal(incomingGarrison.assault?.isRelocation, true, 'Marked as friendly relocation');

// March for 60 seconds
for (let i = 0; i < 60; i++) sim.step(1.0);

assert.equal(incomingGarrison.hp, 0, 'Incoming garrison disappeared (hp set to 0)');
assert.ok(!sim.world.units.some((u) => u.id === incomingGarrison.id), 'Incoming garrison removed from world units');
assert.equal(existingGarrison.strength, 2, 'Existing garrison strength stacked (1 + 1 = 2)');
assert.equal(existingGarrison.squadSize, 200, 'Existing garrison squadSize stacked (100 + 100 = 200)');
assert.ok(existingGarrison.hp >= 9500 && existingGarrison.hp <= 10000, `Existing garrison HP stacked (~10000, actual=${existingGarrison.hp})`);
assert.ok(existingGarrison.ammo >= 150, `Existing garrison ammo stacked (~170, actual=${existingGarrison.ammo})`);

// Verify only 1 unit exists in this tile
const unitsInTile = sim.world.units.filter((u) => u.hp > 0 && cellOf(u.pos)[0] === friendTile[0] && cellOf(u.pos)[1] === friendTile[1]);
assert.equal(unitsInTile.length, 1, 'Only exactly 1 garrison remains stationed in the tile after stacking');
console.log('✓ Friendly Garrison Stacking & Merge Verified: Neighboring garrison merged, strength stacked to 2 (200 soldiers), incoming unit disappeared without duplicate tokens');

console.log('All Tile Frontline tests passed successfully!');
