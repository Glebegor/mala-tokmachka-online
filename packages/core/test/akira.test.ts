// Features ported from the akira branch, checked against the real base mod and map.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { distKm, offsetKm, Sim, type LngLat } from '../src';

const rs = await loadRuleset(fileURLToPath(new URL('../../../mods', import.meta.url)));
const fresh = () => {
  const sim = new Sim(rs, 'ukraine', [
    { id: 'a', name: 'a', team: 0, bot: false },
    { id: 'a2', name: 'a2', team: 0, bot: false },
    { id: 'b', name: 'b', team: 1, bot: false },
  ]);
  for (const p of sim.world.players) Object.keys(p.res).forEach((k) => (p.res[k] = 50000));
  return sim;
};
const run = (sim: Sim, sec: number) => {
  for (let i = 0; i < sec * 10; i++) sim.step(0.1);
};
/** Build somewhere around `near` (searching outwards), finish it, return it. */
function place(sim: Sim, who: string, def: string, near: LngLat, from = 0, to = 90) {
  for (let r = from; r <= to; r += 3) {
    for (let k = 0; k < 12; k++) {
      const pos = offsetKm(near, r * Math.cos((k / 12) * 6.283), r * Math.sin((k / 12) * 6.283));
      if (sim.apply(who, { type: 'build', def, pos }).ok) {
        const b = sim.world.buildings[sim.world.buildings.length - 1];
        b.progress = 1;
        return b;
      }
    }
  }
  throw new Error(`could not place ${def}`);
}
const hqOf = (sim: Sim, who: string) => sim.world.buildings.find((b) => b.owner === who && b.def === 'hq')!;

// --- building rules: 35 km between industrial sites, field works anywhere, housing only in a held city ---
{
  const sim = fresh();
  const hq = hqOf(sim, 'a');
  // only supply-chain partners keep 35 km apart; anything else just needs its own patch
  assert.ok(sim.apply('a', { type: 'build', def: 'mine', pos: offsetKm(hq.pos, 10, 0) }).ok, 'a mine may stand near the base');
  assert.ok(sim.apply('a', { type: 'build', def: 'power_plant', pos: offsetKm(hq.pos, 12, 0) }).ok, 'a power plant right next to the mine');
  assert.ok(sim.apply('a', { type: 'build', def: 'warehouse', pos: offsetKm(hq.pos, 12, 2) }).ok, 'a warehouse too');
  assert.equal(sim.apply('a', { type: 'build', def: 'power_plant', pos: offsetKm(hq.pos, 12.5, 0) }).ok, false, 'but not on top of another site');
  assert.equal(sim.apply('a', { type: 'build', def: 'metalworks', pos: offsetKm(hq.pos, 25, 0) }).ok, false, 'metal works 15 km from the mine: refused');
  assert.equal(sim.apply('a', { type: 'build', def: 'machine_factory', pos: offsetKm(hq.pos, -12, 0) }).ok, false, 'machine factory 12 km from the base: refused (17.5 km)');
  assert.ok(sim.apply('a', { type: 'build', def: 'mine', pos: offsetKm(hq.pos, 0, 30) }).ok, 'a second mine far away');
  const second = sim.apply('a', { type: 'build', def: 'mine', pos: offsetKm(hq.pos, 0, 38) });
  assert.ok(!second.ok && /11.7/.test(second.reason), 'but not within 11.7 km of another mine');
  assert.ok(sim.apply('a', { type: 'build', def: 'trench', pos: offsetKm(hq.pos, 3, 0) }).ok, 'field works fit near the base');
  const city = sim.map.capturePoints.find((cp, i) => sim.world.points[i].owner === 0 && sim.cities.has(cp.id))!;
  assert.equal(sim.apply('a', { type: 'build', def: 'housing', pos: offsetKm(city.pos, 60, 60) }).ok, false, 'housing outside a city is refused');
  assert.ok(sim.apply('a', { type: 'build', def: 'housing', pos: city.pos }).ok, `housing inside ${city.name}`);
  console.log('build rules ok');
}

// --- logistics: ore from the mine to the metal works by truck, metal produced, factory trains from its own store ---
{
  const sim = fresh();
  const hq = hqOf(sim, 'a');
  const mine = place(sim, 'a', 'mine', hq.pos, 36);
  const works = place(sim, 'a', 'metalworks', mine.pos, 36);
  place(sim, 'a', 'power_plant', works.pos, 36, 120);
  assert.equal(works.storage!.ore, 0, 'a new metal works has no ore');
  const truck = sim.spawnUnit('truck', sim.player('a')!, mine.pos);
  assert.ok(sim.apply('a', { type: 'setRoute', unit: truck.id, fromBuilding: mine.id, toBuilding: works.id, resType: 'ore' }).ok);
  const metal0 = works.storage!.metal ?? 0;
  let delivered = 0;
  for (let i = 0; i < 6000 && !delivered; i++) {
    sim.step(0.1);
    if ((works.storage!.ore ?? 0) > 0 || (works.storage!.metal ?? 0) > metal0) delivered = i / 10;
  }
  assert.ok(delivered > 0, 'ore arrives at the metal works');
  run(sim, 30);
  assert.ok((works.storage!.metal ?? 0) > metal0, 'the metal works turns ore into metal');
  console.log(`logistics ok: first delivery after ${delivered.toFixed(0)} s (${distKm(mine.pos, works.pos).toFixed(0)} km)`);

  // training draws metal/fuel from the building's own store, money from the treasury; teammates share factories
  hq.storage!.metal = 0;
  assert.equal(sim.apply('a', { type: 'train', building: hq.id, unit: 'tank' }).ok, false, 'no metal on site, no tank');
  hq.storage!.metal = 500;
  assert.ok(sim.apply('a2', { type: 'train', building: hq.id, unit: 'tank' }).ok, 'a teammate may use the base');
  assert.equal(hq.storage!.metal, 460, 'metal taken from the base store');
}

// --- fuel: vehicles burn it and refuel at a filling station; drones fall when empty ---
{
  const sim = fresh();
  const hq = hqOf(sim, 'a');
  // start well away from the base (which would top it up) with ~7 km worth of fuel
  const away = [offsetKm(hq.pos, -25, 0), offsetKm(hq.pos, 0, -25), offsetKm(hq.pos, 0, 25), offsetKm(hq.pos, 25, 0)].find((p) => sim.isPlayableGround(p) && sim.side(p) === 0)!;
  const tank = sim.spawnUnit('tank', sim.player('a')!, away);
  tank.fuel = 0.3;
  sim.apply('a', { type: 'move', units: [tank.id], to: offsetKm(away, -20, 0) });
  run(sim, 120);
  assert.equal(tank.fuel, 0, 'tank burns its fuel');
  const stuck = [...tank.pos] as [number, number];
  const free = sim.spawnUnit('tank', sim.player('a')!, stuck);
  free.path = tank.path.map((w) => ({ ...w, p: [w.p[0], w.p[1]] as [number, number] })); // the same route
  run(sim, 10);
  const crawl = distKm(stuck, tank.pos), normal = distKm(stuck, free.pos);
  assert.ok(crawl > 0 && Math.abs(crawl / normal - 0.2) < 0.05, `no fuel: crawls at a fifth of the speed (${crawl.toFixed(2)} vs ${normal.toFixed(2)} km)`);
  free.hp = 0;
  const station = place(sim, 'a', 'gas_station', tank.pos, 0);
  assert.equal(station.storage!.fuel, 0, 'a new filling station is empty: fuel comes by tanker');
  station.storage!.fuel = 500;
  run(sim, 10);
  assert.ok(tank.fuel! > 50, 'refuels next to a filling station');
  assert.ok((station.storage!.fuel ?? 0) < 500, 'the station gave its own fuel');
  const drone = sim.spawnUnit('drone', sim.player('a')!, hq.pos);
  drone.fuel = 0.05;
  run(sim, 5);
  assert.equal(sim.world.units.includes(drone), false, 'a drone out of fuel is lost');
  console.log('fuel ok');
}

// --- drones: recon circles, strike drone dives, explodes and leaves smoke ---
{
  const sim = fresh();
  const hqA = hqOf(sim, 'a'), hqB = hqOf(sim, 'b');
  const recon = sim.spawnUnit('drone_pd2', sim.player('a')!, hqA.pos);
  const spot = offsetKm(hqA.pos, 20, 0);
  sim.apply('a', { type: 'move', units: [recon.id], to: spot });
  run(sim, 120);
  assert.ok(recon.isLoitering && distKm(recon.pos, spot) < 6, 'recon drone circles its area');
  const target = place(sim, 'b', 'trench', hqB.pos, 3, 30);
  const hp0 = target.hp;
  const strike = sim.spawnUnit('drone_liutyi', sim.player('a')!, offsetKm(target.pos, -30, 0));
  sim.apply('a', { type: 'move', units: [strike.id], to: target.pos });
  run(sim, 120);
  assert.equal(sim.world.units.includes(strike), false, 'strike drone is spent');
  assert.ok(target.hp < hp0 || !sim.world.buildings.includes(target), 'target hit by the blast');
  assert.equal(sim.world.smokes.length, 1, 'impact leaves smoke');
  console.log('drones ok');
}

// --- artillery: fires only at spotted targets, barrages an area, never drives to the front ---
{
  const sim = fresh();
  const a = sim.player('a')!, b = sim.player('b')!;
  const n = sim.world.front[Math.floor(sim.world.front.length / 2)];
  const front: LngLat = [n.lng, n.lat];
  const ownSide = offsetKm(front, -10, 0), enemySide = offsetKm(front, 6, 0);
  const team0Side = sim.side(ownSide) === 0 ? ownSide : offsetKm(front, 10, 0);
  const team1Side = sim.side(enemySide) === 1 ? enemySide : offsetKm(front, -6, 0);
  sim.world.units = [];
  const gun = sim.spawnUnit('artillery', a, team0Side);
  const victim = sim.spawnUnit('infantry', b, team1Side);
  victim.fireMode = 'hold';
  run(sim, 6);
  assert.equal(victim.hp, sim.maxHp(victim), 'unseen target: no fire');
  const spotter = sim.spawnUnit('drone_pd2', a, team1Side);
  spotter.fireMode = 'hold';
  run(sim, 6);
  assert.ok(victim.hp < sim.maxHp(victim), 'spotted target is shelled');
  sim.apply('a', { type: 'move', units: [gun.id], to: team1Side });
  assert.equal(gun.path.length, 0, 'artillery refuses to drive over the front');
  sim.apply('a', { type: 'bombard', units: [gun.id], target: team1Side });
  assert.ok(gun.bombardTarget, 'barrage area set');
  console.log('artillery ok');
}

// --- rescuers repair a damaged building, power grid speeds production, special zones only for their side ---
{
  const sim = fresh();
  const hq = hqOf(sim, 'a');
  const crew = sim.spawnUnit('rescuers', sim.player('a')!, offsetKm(hq.pos, 0.5, 0));
  hq.hp = 500;
  hq.lastDamagedTime = -1000;
  run(sim, 20);
  assert.ok(hq.hp > 500, 'rescuers repair the base');
  const mine = place(sim, 'a', 'mine', hq.pos, 36);
  assert.equal(sim.onGrid(0, mine.pos), false);
  place(sim, 'a', 'power_plant', mine.pos, 36, 99);
  assert.equal(sim.onGrid(0, mine.pos), true, 'a power plant within 100 km puts it on the grid');
  assert.equal(sim.apply('a', { type: 'build', def: 'drone_factory', pos: [52.045, 55.825] }).ok, false, 'Alabuga is Russian only');
  assert.ok(sim.apply('b', { type: 'build', def: 'drone_factory', pos: [52.045, 55.825] }).ok, 'Russia may build in Alabuga');
  assert.equal(sim.apply('a', { type: 'build', def: 'mine', pos: [27.5, 53.9] }).ok, false, 'no building in Belarus');
  console.log(`support ok (crew at ${crew.pos.map((x) => x.toFixed(2))})`);
}
