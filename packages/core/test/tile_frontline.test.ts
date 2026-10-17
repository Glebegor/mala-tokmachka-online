import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { Sim, cellOf, cellCenter, cellKey, normalAt, offsetKm, isAdjacentCell, distKm, kmPerDegLng, OccupiedIndex, type Unit, type LngLat } from '../src';

const rs = await loadRuleset(fileURLToPath(new URL('../../../mods', import.meta.url)));

const sim = new Sim(rs, 'zaporizhzhia', [
  { id: 'player1', name: 'Player 1', team: 0, bot: false },
  { id: 'player2', name: 'Player 2', team: 1, bot: false },
]);
const simUkr = new Sim(rs, 'ukraine', [
  { id: 'player1', name: 'Player 1', team: 0, bot: false },
  { id: 'player2', name: 'Player 2', team: 1, bot: false },
]);
let ukrSpurs = 0;
for (let i = 0; i < simUkr.world.front.length - 2; i++) {
  const p0 = simUkr.world.front[i];
  const p2 = simUkr.world.front[i + 2];
  if (Math.abs(p0.lng - p2.lng) < 1e-5 && Math.abs(p0.lat - p2.lat) < 1e-5) {
    ukrSpurs++;
  }
}
console.log(`Ukraine map initial frontline length: ${simUkr.world.front.length}, spurs (A->B->A): ${ukrSpurs}`);
const ukrUaGarrisons = simUkr.world.units.filter((u) => u.team === 0 && (u.owner.startsWith('__front_') || u.def === 'frontline_infantry'));
const ukrRuGarrisons = simUkr.world.units.filter((u) => u.team === 1 && (u.owner.startsWith('__front_') || u.def === 'frontline_infantry'));
console.log(`Ukraine map initial garrisons: ${ukrUaGarrisons.length} UA, ${ukrRuGarrisons.length} RU`);

const uaGarrisonCells = new Set(ukrUaGarrisons.map((u) => cellKey(...cellOf(u.pos))));
const ruGarrisonCells = new Set(ukrRuGarrisons.map((u) => cellKey(...cellOf(u.pos))));

const hasOrthogonalEnemy = (cx: number, cy: number, oppTeam: 0 | 1) => {
  const dirs: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  return dirs.some(([dx, dy]) => simUkr.side(cellCenter(cx + dx, cy + dy)) === oppTeam);
};

let missingUa = 0;
let missingRu = 0;

for (let i = 0; i < simUkr.world.front.length - 1; i++) {
  const a = simUkr.world.front[i];
  const b = simUkr.world.front[i + 1];
  const midLat = (a.lat + b.lat) / 2;
  const kx = kmPerDegLng(midLat);
  const tx = (b.lng - a.lng) * kx;
  const ty = (b.lat - a.lat) * 111.32;
  const segLenKm = Math.hypot(tx, ty);
  if (segLenKm < 0.01) continue;

  const nx = ty / segLenKm;
  const ny = -tx / segLenKm;

  const numSteps = Math.max(1, Math.round(segLenKm / 1.35));
  for (let s = 0; s < numSteps; s++) {
    const t = (s + 0.5) / numSteps;
    const pt: LngLat = [a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t];
    if (pt[0] < 35.35 && pt[1] < 47.7) continue; // Dnipro

    const uaPos = cellCenter(...cellOf(offsetKm(pt, -nx * 0.75, -ny * 0.75)));
    const ruPos = cellCenter(...cellOf(offsetKm(pt, nx * 0.75, ny * 0.75)));
    const [uax, uay] = cellOf(uaPos);
    const [rux, ruy] = cellOf(ruPos);

    if (
      simUkr.side(uaPos) === 0 &&
      simUkr.isPlayableGround(uaPos) &&
      simUkr.terrainAt(uaPos).id !== 'water' &&
      !simUkr.foreign(uaPos) &&
      hasOrthogonalEnemy(uax, uay, 1) &&
      !uaGarrisonCells.has(cellKey(uax, uay))
    ) {
      missingUa++;
    }
    if (
      simUkr.side(ruPos) === 1 &&
      simUkr.isPlayableGround(ruPos) &&
      simUkr.terrainAt(ruPos).id !== 'water' &&
      !simUkr.foreign(ruPos) &&
      hasOrthogonalEnemy(rux, ruy, 0) &&
      !ruGarrisonCells.has(cellKey(rux, ruy))
    ) {
      missingRu++;
    }
  }
}
console.log(`Front edges missing garrisons: ${missingUa} UA tiles, ${missingRu} RU tiles!`);

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

// Check spurs in initial sim.world.front
let spurCount = 0;
for (let i = 0; i < sim.world.front.length - 2; i++) {
  const p0 = sim.world.front[i];
  const p2 = sim.world.front[i + 2];
  if (Math.abs(p0.lng - p2.lng) < 1e-5 && Math.abs(p0.lat - p2.lat) < 1e-5) {
    spurCount++;
  }
}
console.log(`Initial frontline length: ${sim.world.front.length}, spurs (A->B->A): ${spurCount}`);
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

// Place a rear friendly Russian unit to receive the retreating squad (merge/stack test when NO free sectors exist)
const rearTile: [number, number] = [adjEnemyCell[0], adjEnemyCell[1] - 1];
let rearFriend = sim.world.units.find((u) => u.team === 1 && cellOf(u.pos)[0] === rearTile[0] && cellOf(u.pos)[1] === rearTile[1]);
if (!rearFriend) {
  rearFriend = sim.spawnUnit('frontline_infantry', sim.player('player2')!, cellCenter(rearTile[0], rearTile[1]));
}
rearFriend.strength = 1;
rearFriend.squadSize = 100;
rearFriend.hp = 5000;

// Fill any other adjacent friendly cells with troops so there are NO free sectors (forcing stack into rearFriend)
const adjDirs = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1]
];
for (const [dx, dy] of adjDirs) {
  const nb: [number, number] = [adjEnemyCell[0] + dx, adjEnemyCell[1] + dy];
  if (nb[0] === curUaCell[0] && nb[1] === curUaCell[1]) continue;
  if (sim.side(cellCenter(nb[0], nb[1])) === 1) {
    const hasU = sim.world.units.some(u => u.team === 1 && cellOf(u.pos)[0] === nb[0] && cellOf(u.pos)[1] === nb[1]);
    if (!hasU) {
      sim.spawnUnit('frontline_infantry', sim.player('player2')!, cellCenter(nb[0], nb[1]));
    }
  }
}

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
// Check if world.front itself actually moved over the captured cell:
const occIndex = new OccupiedIndex(sim.world.front, sim.map.occupiedClosure);
const frontSide = occIndex.contains(candCenter) ? 1 : 0;
console.log(`Target cell side in tileMap: ${sim.side(candCenter)}, in world.front polygon: ${frontSide}`);

// Check that retreating enemy merged with rear friendly garrison in retreat tile
assert.equal(defendingRu.hp, 0, 'Defeated enemy garrison merged into friendly unit (token cleaned up)');
assert.ok((rearFriend.strength ?? 1) >= 2, 'Rear garrison gained strength from retreating squad (stacked)');
assert.ok((rearFriend.squadSize ?? 100) >= 200, 'Rear garrison headcount increased from retreating squad (stacked)');
assert.ok(rearFriend.attackDebuffUntil !== undefined && rearFriend.attackDebuffUntil > sim.world.time + 290, 'Rear unit received 5-minute attack debuff');

// Test that debuffed unit CANNOT conduct attacks
const debuffedAttack = sim.apply('player2', {
  type: 'attackTile',
  unitId: rearFriend.id,
  targetCell: adjEnemyCell,
});
assert.equal(debuffedAttack.ok, false, 'Debuffed unit cannot conduct attacks for 5 minutes');
console.log('✓ Breakthrough, Garrison Merge & 5-Minute Attack Debuff: Retreating troops merge with friends, stack strength/soldiers, and cannot attack for 5 min');

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
  ruDefender2.hp = 5000;
  ruDefender2.strength = 1;

  // Ensure the tile directly behind defender is friendly AND empty (no troops)
  const rearDx = adjEnemyCell2[0] - curCell2[0];
  const rearDy = adjEnemyCell2[1] - curCell2[1];
  const rearTile2: [number, number] = [adjEnemyCell2[0] + rearDx, adjEnemyCell2[1] + rearDy];
  sim.tileMap.setOwner(rearTile2[0], rearTile2[1], 1);
  // Clear any existing units from the rear tile so it is guaranteed empty
  sim.world.units = sim.world.units.filter((u) => u.id === ruDefender2.id || u.id === gUA.id || cellOf(u.pos)[0] !== rearTile2[0] || cellOf(u.pos)[1] !== rearTile2[1]);

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

  // Verify: Defender retreated into empty rear tile, DID NOT STACK (strength remains 1), and received 5m attack debuff!
  assert.ok(ruDefender2.hp > 0, 'Defender survived and retreated to empty rear tile (not merged/deleted)');
  const defCell = cellOf(ruDefender2.pos);
  assert.deepEqual(defCell, rearTile2, 'Defender retreated directly behind into empty rear cell');
  assert.equal(ruDefender2.strength ?? 1, 1, 'Defender did not stack (strength remains 1)');
  assert.ok(ruDefender2.attackDebuffUntil !== undefined && ruDefender2.attackDebuffUntil > sim.world.time + 290, 'Retreating defender received 5-minute attack debuff');
  console.log('✓ Breakthrough via Force Superiority: Garrison takes tile, defender retreats to empty rear cell without stacking (strength 1, 5m debuff)');
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

// 7. Test Garrison Splitting:
// Splitting existing stacked garrison (strength 2) detaches 1 squad (strength 1, 100 soldiers, 5000 hp)
assert.equal(existingGarrison.strength, 2, 'Garrison has strength 2 before split');
const splitRes = sim.apply('player1', {
  type: 'splitGarrison',
  unitId: existingGarrison.id,
});
assert.equal(splitRes.ok, true, 'splitGarrison command accepted for stacked unit');
assert.equal(existingGarrison.strength, 1, 'Original garrison strength reduced to 1');
assert.equal(existingGarrison.squadSize, 100, 'Original garrison soldiers reduced to 100');

// Find the newly spawned detached unit in the tile
const tileUnitsAfterSplit = sim.world.units.filter((u) => u.hp > 0 && cellOf(u.pos)[0] === friendTile[0] && cellOf(u.pos)[1] === friendTile[1]);
assert.equal(tileUnitsAfterSplit.length, 2, 'Tile now contains 2 separate garrison units after split');
const detachedUnit = tileUnitsAfterSplit.find((u) => u.id !== existingGarrison.id)!;
assert.ok(detachedUnit, 'Detached unit exists');
assert.equal(detachedUnit.strength, 1, 'Detached unit has strength 1');
assert.equal(detachedUnit.squadSize, 100, 'Detached unit has 100 soldiers');
assert.equal(detachedUnit.hp, 5000, 'Detached unit has 5000 HP');

// Test that splitting strength 1 unit fails
const failSplit = sim.apply('player1', {
  type: 'splitGarrison',
  unitId: existingGarrison.id,
});
assert.equal(failSplit.ok, false, 'Cannot split garrison with strength 1');
// 8. Test Defense of Advancing Garrison's Home Tile & Attack Disruption (Counter-attack):
console.log('--- Testing Advancing Garrison Home Tile Defense & Counter-attack Disruption ---');
const homeCell: [number, number] = [1770, 3470];
const targetEnemyCell: [number, number] = [1770, 3469];
const flankEnemyCell: [number, number] = [1769, 3470];

sim.tileMap.setOwner(homeCell[0], homeCell[1], 0);
sim.tileMap.setOwner(targetEnemyCell[0], targetEnemyCell[1], 1);
sim.tileMap.setOwner(flankEnemyCell[0], flankEnemyCell[1], 1);

// Remove existing units in these test cells
sim.world.units = sim.world.units.filter((u) => {
  const [cx, cy] = cellOf(u.pos);
  return !(cx === homeCell[0] && cy === homeCell[1]) &&
         !(cx === targetEnemyCell[0] && cy === targetEnemyCell[1]) &&
         !(cx === flankEnemyCell[0] && cy === flankEnemyCell[1]);
});

// Spawn attacking UA garrison with strength 2 (200 soldiers) at homeCell
const testUaAttacker = sim.spawnUnit('frontline_infantry', sim.player('player1')!, cellCenter(homeCell[0], homeCell[1]));
testUaAttacker.strength = 2;
testUaAttacker.squadSize = 200;
testUaAttacker.hp = 10000;
testUaAttacker.ammo = 100;

// Spawn enemy garrison at targetEnemyCell
const targetRuDefender = sim.spawnUnit('frontline_infantry', sim.player('player2')!, cellCenter(targetEnemyCell[0], targetEnemyCell[1]));
targetRuDefender.strength = 1;
targetRuDefender.squadSize = 100;

// Spawn flanking enemy garrison at flankEnemyCell with strength 1 (100 soldiers, WEAKER than testUaAttacker)
const weakFlankRu = sim.spawnUnit('frontline_infantry', sim.player('player2')!, cellCenter(flankEnemyCell[0], flankEnemyCell[1]));
weakFlankRu.strength = 1;
weakFlankRu.squadSize = 100;

// UA launches attack on targetEnemyCell
const uaAttackOrder = sim.apply('player1', {
  type: 'attackTile',
  unitId: testUaAttacker.id,
  targetCell: targetEnemyCell,
});
assert.equal(uaAttackOrder.ok, true, 'UA attack order accepted');
assert.ok(testUaAttacker.assault, 'UA garrison is advancing');

// Flanking enemy with WEAKER force (100 soldiers vs 200) tries to attack UA homeCell:
const weakCounterAttack = sim.apply('player2', {
  type: 'attackTile',
  unitId: weakFlankRu.id,
  targetCell: homeCell,
});
assert.equal(weakCounterAttack.ok, false, 'Enemy with equal/less force CANNOT attack home tile of advancing garrison with superior strength');
assert.ok(testUaAttacker.assault, 'UA assault continues uninterrupted');

// Now give flanking enemy SUPERIOR force (strength 3 = 300 soldiers)
weakFlankRu.strength = 3;
weakFlankRu.squadSize = 300;
weakFlankRu.hp = 15000;

const strongCounterAttack = sim.apply('player2', {
  type: 'attackTile',
  unitId: weakFlankRu.id,
  targetCell: homeCell,
});
assert.equal(strongCounterAttack.ok, true, 'Enemy with superior force disrupts advancing UA garrison and launches counter-attack');
assert.equal(testUaAttacker.assault, undefined, 'UA assault disrupted and cancelled');
assert.deepEqual(cellOf(testUaAttacker.pos), homeCell, 'UA garrison returned back to home tile to defend');
assert.ok(weakFlankRu.assault, 'Superior enemy assault started against homeCell');
console.log('✓ Advancing Garrison Defense & Disruption Verified: Weaker enemy denied, superior enemy knocks advancing unit back to home tile');

// Cancel weakFlankRu assault for next test
weakFlankRu.assault = undefined;
weakFlankRu.hp = 0;
sim.world.units = sim.world.units.filter((u) => u.id !== weakFlankRu.id);

// 9. Test Diagonal Free Sector Retreat:
// Defender attacked, directly behind is occupied, but diagonal sector is FREE -> retreats diagonally without stacking!
console.log('--- Testing Diagonal Free Sector Retreat ---');
const defTile: [number, number] = [1775, 3470];
const attTile: [number, number] = [1775, 3471]; // Attacking from South to North
const behindBlocked: [number, number] = [1775, 3469]; // Directly behind, occupied
const diagFree: [number, number] = [1776, 3469]; // Diagonal rear, FREE!

sim.tileMap.setOwner(attTile[0], attTile[1], 0);
sim.tileMap.setOwner(defTile[0], defTile[1], 1);
sim.tileMap.setOwner(behindBlocked[0], behindBlocked[1], 1);
sim.tileMap.setOwner(diagFree[0], diagFree[1], 1);

// Clear units in these cells
sim.world.units = sim.world.units.filter((u) => {
  const [cx, cy] = cellOf(u.pos);
  return !(cx === defTile[0] && cy === defTile[1]) &&
         !(cx === attTile[0] && cy === attTile[1]) &&
         !(cx === behindBlocked[0] && cy === behindBlocked[1]) &&
         !(cx === diagFree[0] && cy === diagFree[1]);
});

const attacker9 = sim.spawnUnit('frontline_infantry', sim.player('player1')!, cellCenter(attTile[0], attTile[1]));
attacker9.strength = 1;
attacker9.squadSize = 300;
attacker9.hp = 15000;

const defender9 = sim.spawnUnit('frontline_infantry', sim.player('player2')!, cellCenter(defTile[0], defTile[1]));
defender9.strength = 1;
defender9.squadSize = 100;
defender9.ammo = 0; // Out of ammo so breakthrough succeeds

// Occupy behindBlocked with a friendly Russian garrison
const blockFriend = sim.spawnUnit('frontline_infantry', sim.player('player2')!, cellCenter(behindBlocked[0], behindBlocked[1]));
blockFriend.strength = 1;
blockFriend.squadSize = 100;

// diagFree remains empty!
const order9 = sim.apply('player1', {
  type: 'attackTile',
  unitId: attacker9.id,
  targetCell: defTile,
});
assert.equal(order9.ok, true, 'Attack order accepted');
for (let i = 0; i < 60; i++) sim.step(1.0);

assert.equal(sim.side(cellCenter(defTile[0], defTile[1])), 0, 'Target tile captured');
// Verify: defender retreated into diagFree, did NOT stack into blockFriend!
assert.ok(defender9.hp > 0, 'Defender survived and retreated to diagonal free sector');
assert.deepEqual(cellOf(defender9.pos), diagFree, 'Defender chose diagonal free sector over occupied rear tile');
assert.equal(defender9.strength, 1, 'Defender did not stack (strength 1)');
assert.equal(blockFriend.strength, 1, 'Blocked friend did not absorb defender because free diagonal sector was available');
console.log('✓ Diagonal Free Sector Retreat Verified: Defender retreats to free diagonal sector without stacking when direct rear is occupied');

// 10. Test Frontline Stretching & Detaching Squad from Attacking Garrison (Requirement 4):
console.log('--- Testing Frontline Stretching & Detaching Squad ---');
// Attacker with strength 2 captures a tile, leaving empty border tile -> 1 strength detached to hold empty tile!
const stretchStart: [number, number] = [1780, 3470];
const stretchTarget: [number, number] = [1780, 3469];

sim.tileMap.setOwner(stretchStart[0], stretchStart[1], 0);
sim.tileMap.setOwner(stretchTarget[0], stretchTarget[1], 1);
// Ensure stretchStart still borders enemy on the west: [1779, 3470] = enemy
sim.tileMap.setOwner(1779, 3470, 1);

// Clear units
sim.world.units = sim.world.units.filter((u) => {
  const [cx, cy] = cellOf(u.pos);
  return !(cx === stretchStart[0] && cy === stretchStart[1]) &&
         !(cx === stretchTarget[0] && cy === stretchTarget[1]);
});

const attacker10 = sim.spawnUnit('frontline_infantry', sim.player('player1')!, cellCenter(stretchStart[0], stretchStart[1]));
attacker10.strength = 2; // Strength 2!
attacker10.squadSize = 200;
attacker10.hp = 10000;
attacker10.ammo = 100;

const defender10 = sim.spawnUnit('frontline_infantry', sim.player('player2')!, cellCenter(stretchTarget[0], stretchTarget[1]));
defender10.strength = 1;
defender10.squadSize = 100;
defender10.ammo = 0; // Out of ammo

const order10 = sim.apply('player1', {
  type: 'attackTile',
  unitId: attacker10.id,
  targetCell: stretchTarget,
});
assert.equal(order10.ok, true);
for (let i = 0; i < 60; i++) sim.step(1.0);

assert.equal(sim.side(cellCenter(stretchTarget[0], stretchTarget[1])), 0, 'Target captured');
assert.equal(attacker10.strength, 1, 'Attacker strength reduced from 2 to 1 (detached squad to cover stretched front)');
const startGarrison = sim.world.units.find((u) => u.team === 0 && u.hp > 0 && cellOf(u.pos)[0] === stretchStart[0] && cellOf(u.pos)[1] === stretchStart[1]);
assert.ok(startGarrison, 'Detached squad spawned at empty border tile [1780, 3470] to cover stretched frontline');
assert.equal(startGarrison.strength, 1, 'Detached squad has strength 1');
console.log('✓ Frontline Stretching & Detachment Verified: Attacker detached 1 squad to cover empty border tile');

// 11. Test Stranded Rear Garrison Redeployment & Stacking (Requirement 3):
console.log('--- Testing Stranded Rear Garrison Redeployment & Stacking ---');
const rearPosCell: [number, number] = [1790, 3470];
const captured11Cell: [number, number] = [1790, 3469];
const emptyFrontCell: [number, number] = [1791, 3469];

sim.tileMap.setOwner(rearPosCell[0], rearPosCell[1], 0);
sim.tileMap.setOwner(captured11Cell[0], captured11Cell[1], 1);
sim.tileMap.setOwner(emptyFrontCell[0], emptyFrontCell[1], 0);

// Set enemy north of emptyFrontCell so emptyFrontCell is an active border tile
sim.tileMap.setOwner(emptyFrontCell[0], emptyFrontCell[1] - 1, 1);
// Make sure rearPosCell has NO enemy neighbors around it (all surrounding cells are friendly 0)
for (let dx = -1; dx <= 1; dx++) {
  for (let dy = -1; dy <= 1; dy++) {
    sim.tileMap.setOwner(rearPosCell[0] + dx, rearPosCell[1] + dy, 0);
  }
}
sim.tileMap.setOwner(captured11Cell[0], captured11Cell[1], 1); // target starts as enemy

// Clear units in these test cells
sim.world.units = sim.world.units.filter((u) => {
  const [cx, cy] = cellOf(u.pos);
  return !(cx === rearPosCell[0] && cy === rearPosCell[1]) &&
         !(cx === captured11Cell[0] && cy === captured11Cell[1]) &&
         !(cx === emptyFrontCell[0] && cy === emptyFrontCell[1]);
});

// Spawn stranded garrison at rearPosCell (strength 1)
const strandedGarrison = sim.spawnUnit('frontline_infantry', sim.player('player1')!, cellCenter(rearPosCell[0], rearPosCell[1]));
strandedGarrison.strength = 1;
strandedGarrison.squadSize = 100;

// Spawn attacker11 at another adjacent friendly cell [1789, 3469]
sim.tileMap.setOwner(1789, 3469, 0);
const attacker11 = sim.spawnUnit('frontline_infantry', sim.player('player1')!, cellCenter(1789, 3469));
attacker11.strength = 1;
attacker11.squadSize = 300;
attacker11.hp = 15000;

const defender11 = sim.spawnUnit('frontline_infantry', sim.player('player2')!, cellCenter(captured11Cell[0], captured11Cell[1]));
defender11.ammo = 0;

const order11 = sim.apply('player1', {
  type: 'attackTile',
  unitId: attacker11.id,
  targetCell: captured11Cell,
});
assert.equal(order11.ok, true);
for (let i = 0; i < 60; i++) sim.step(1.0);

assert.equal(sim.side(cellCenter(captured11Cell[0], captured11Cell[1])), 0, 'Cell captured');
// Now rearPosCell has NO enemy borders at all. Stranded garrison should have started redeployment!
assert.ok(strandedGarrison.assault, 'Stranded garrison without enemy border initiated redeployment to front line');
assert.equal(strandedGarrison.assault?.isRelocation, true, 'Marked as friendly relocation');
console.log('✓ Stranded Rear Garrison Redeployment Verified: Garrison without enemy border automatically redeploys to cover front');

console.log('All Tile Frontline tests passed successfully!');
