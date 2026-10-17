import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { Sim, cellOf, cellCenter, isAdjacentCell, distKm, type Unit, type LngLat } from '../src';

const rs = await loadRuleset(fileURLToPath(new URL('../../../mods', import.meta.url)));

const sim = new Sim(rs, 'zaporizhzhia', [
  { id: 'player1', name: 'Player 1', team: 0, bot: false },
  { id: 'player2', name: 'Player 2', team: 1, bot: false },
]);

console.log('--- Testing Tile Frontline & Troop Movement (HoI Style) ---');

// 1. Initial State Verification
const uaGarrisons = sim.world.units.filter((u) => u.team === 0 && (u.owner.startsWith('__front_') || u.def === 'frontline_infantry'));
const ruGarrisons = sim.world.units.filter((u) => u.team === 1 && (u.owner.startsWith('__front_') || u.def === 'frontline_infantry'));

assert.ok(uaGarrisons.length > 0, 'UA frontline garrisons deployed');
assert.ok(ruGarrisons.length > 0, 'RU frontline garrisons deployed');
console.log(`✓ Garrisons deployed: ${uaGarrisons.length} UA, ${ruGarrisons.length} RU`);

// Find an opposing pair of garrisons
const gUA = uaGarrisons[0];
const curUaCell = cellOf(gUA.pos);
console.log(`UA garrison ID ${gUA.id} at tile [${curUaCell[0]}, ${curUaCell[1]}], pos:`, gUA.pos);

// Find adjacent enemy tile
let adjEnemyCell: [number, number] | null = null;
for (let dx = -1; dx <= 1; dx++) {
  for (let dy = -1; dy <= 1; dy++) {
    if (dx === 0 && dy === 0) continue;
    const cand: [number, number] = [curUaCell[0] + dx, curUaCell[1] + dy];
    const candCenter = cellCenter(cand[0], cand[1]);
    if (sim.side(candCenter) === 1) {
      adjEnemyCell = cand;
      break;
    }
  }
  if (adjEnemyCell) break;
}

assert.ok(adjEnemyCell, 'Found adjacent enemy tile to UA garrison');
console.log(`Adjacent enemy tile: [${adjEnemyCell[0]}, ${adjEnemyCell[1]}]`);

// 2. Test Stalemate: Enemy has equal/more troops AND has ammo -> Attack fails
// Place a strong RU garrison in that target tile with ammo
const candCenter = cellCenter(adjEnemyCell[0], adjEnemyCell[1]);
const defendingRu = sim.world.units.find((u) => u.team === 1 && cellOf(u.pos)[0] === adjEnemyCell![0] && cellOf(u.pos)[1] === adjEnemyCell![1])
  ?? sim.spawnUnit('frontline_infantry', sim.player('player2')!, candCenter);

defendingRu.hp = 25000;
defendingRu.squadSize = 500;
defendingRu.ammo = 500;
defendingRu.pos = candCenter;

gUA.hp = 25000;
gUA.squadSize = 500;
gUA.ammo = 500;

const preAttackUaAmmo = gUA.ammo;
const preAttackRuAmmo = defendingRu.ammo;

const repelledRes = sim.apply('player1', {
  type: 'attackTile',
  unitId: gUA.id,
  targetCell: adjEnemyCell,
});

assert.equal(repelledRes.ok, false, 'Attack repelled when enemy has equal troops and ammo');
assert.ok(gUA.ammo < preAttackUaAmmo, 'Attacker consumed ammo in skirmish firefight');
assert.ok(defendingRu.ammo < preAttackRuAmmo, 'Defender consumed ammo in skirmish firefight');
assert.equal(sim.side(candCenter), 1, 'Tile remains under Russian control');
console.log('✓ Attack Repelled & Skirmish Exchange: Enemy holds position when troops >= ours and has ammo');

// 3. Test Breakthrough Condition A: Enemy runs out of ammo (ammo <= 0)
defendingRu.ammo = 0; // Out of ammo!
const preUaPos = [...gUA.pos];

const winAmmoRes = sim.apply('player1', {
  type: 'attackTile',
  unitId: gUA.id,
  targetCell: adjEnemyCell,
});

assert.equal(winAmmoRes.ok, true, 'Attack succeeds when enemy ran out of ammo');
assert.equal(sim.side(candCenter), 0, 'Target tile flipped to Ukrainian control');
assert.notDeepEqual(gUA.pos, preUaPos, 'Garrison advanced into the captured tile');
assert.notDeepEqual(defendingRu.pos, candCenter, 'Defeated enemy garrison retreated from tile');
console.log('✓ Breakthrough via Ammo Depletion: Garrison takes tile when defending enemy ammo <= 0');

// 4. Test Breakthrough Condition B: Attacker has numerical superiority (myTroops > enemyTroops)
// Find another adjacent enemy tile
const curCell2 = cellOf(gUA.pos);
let adjEnemyCell2: [number, number] | null = null;
for (let dx = -1; dx <= 1; dx++) {
  for (let dy = -1; dy <= 1; dy++) {
    if (dx === 0 && dy === 0) continue;
    const cand: [number, number] = [curCell2[0] + dx, curCell2[1] + dy];
    const center = cellCenter(cand[0], cand[1]);
    if (sim.side(center) === 1) {
      adjEnemyCell2 = cand;
      break;
    }
  }
  if (adjEnemyCell2) break;
}

if (adjEnemyCell2) {
  const center2 = cellCenter(adjEnemyCell2[0], adjEnemyCell2[1]);
  const ruDefender2 = sim.world.units.find((u) => u.team === 1 && cellOf(u.pos)[0] === adjEnemyCell2![0] && cellOf(u.pos)[1] === adjEnemyCell2![1])
    ?? sim.spawnUnit('frontline_infantry', sim.player('player2')!, center2);

  ruDefender2.pos = center2;
  ruDefender2.ammo = 200;
  ruDefender2.squadSize = 300; // Smaller force (300 soldiers)

  gUA.squadSize = 500; // Superior force (500 soldiers)
  gUA.ammo = 300;

  const winSuperiorRes = sim.apply('player1', {
    type: 'attackTile',
    unitId: gUA.id,
    targetCell: adjEnemyCell2,
  });

  assert.equal(winSuperiorRes.ok, true, 'Attack succeeds when attacker has troop superiority');
  assert.equal(sim.side(center2), 0, 'Tile captured by UA garrison');
  console.log('✓ Breakthrough via Force Superiority: Garrison takes tile when myTroops > oppTroops');
}

// 5. Test Friendly Tile Movement (Relocation)
const curUaCellNow = cellOf(gUA.pos);
let friendlyNeighbor: [number, number] | null = null;
for (let dx = -1; dx <= 1; dx++) {
  for (let dy = -1; dy <= 1; dy++) {
    if (dx === 0 && dy === 0) continue;
    const cand: [number, number] = [curUaCellNow[0] + dx, curUaCellNow[1] + dy];
    if (sim.side(cellCenter(cand[0], cand[1])) === 0) {
      friendlyNeighbor = cand;
      break;
    }
  }
  if (friendlyNeighbor) break;
}
assert.ok(friendlyNeighbor, 'Found adjacent friendly tile');
const moveRes = sim.apply('player1', {
  type: 'attackTile',
  unitId: gUA.id,
  targetCell: friendlyNeighbor,
});
assert.equal(moveRes.ok, true, 'Garrison moves freely between friendly tiles');
console.log('✓ Friendly Movement: Garrison repositions between friendly tiles');

console.log('All Tile Frontline tests passed successfully!');
