// Features ported from the akira branch, checked against the real base mod and map.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { Bot } from '../../../services/game/src/application/bot';
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
  // ore mine ↔ metal works 17.5 km; mines 2.9 km from each other; other civil sites 5 km; military only their ground
  assert.ok(sim.apply('a', { type: 'build', def: 'mine', pos: offsetKm(hq.pos, 10, 0) }).ok, 'a mine near the base');
  assert.ok(sim.apply('a', { type: 'build', def: 'mine', pos: offsetKm(hq.pos, 13.2, 0) }).ok, 'a second mine 3.2 km away');
  assert.equal(sim.apply('a', { type: 'build', def: 'mine', pos: offsetKm(hq.pos, 15.5, 0) }).ok, false, 'not within 2.9 km of another mine');
  assert.equal(sim.apply('a', { type: 'build', def: 'power_plant', pos: offsetKm(hq.pos, 10, 3) }).ok, false, 'a power plant 3 km from a mine: too close (5 km)');
  assert.ok(sim.apply('a', { type: 'build', def: 'power_plant', pos: offsetKm(hq.pos, 10, 5.5) }).ok, 'at 5.5 km it fits');
  assert.equal(sim.apply('a', { type: 'build', def: 'metalworks', pos: offsetKm(hq.pos, 25, 0) }).ok, false, 'metal works 12 km from a mine: refused (17.5 km)');
  assert.ok(sim.apply('a', { type: 'build', def: 'machine_factory', pos: offsetKm(hq.pos, -8, 0) }).ok, 'a machine factory near the base (no chain any more)');
  assert.ok(sim.apply('a', { type: 'build', def: 'bunker', pos: offsetKm(hq.pos, 10, 1) }).ok, 'military sites only need their own ground');
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

// --- frontline posts: autonomous holding, reinforcement, supply, slow advance on superiority, and flank gaps ---
{
  const sim = fresh();
  const a = sim.player('a')!;
  const b = sim.player('b')!;
  assert.ok(sim.world.posts.length > 0, `front posts initialized (${sim.world.posts.length} posts)`);
  const myPost = sim.world.posts.find((p) => p.team === 0)!;
  assert.ok(myPost, 'friendly post exists');
  assert.equal(myPost.cap, 4, 'cap is 4');
  assert.ok(myPost.garrison.length >= 1, 'initial garrison present');

  // moving unit directly to post assigns targetPost and joins garrison upon arrival
  const extra = sim.spawnUnit('infantry', a, offsetKm(myPost.pos, -0.4, -0.4));
  assert.equal(extra.frontPost, undefined);
  const moveRes = sim.apply('a', { type: 'move', units: [extra.id], to: myPost.pos });
  assert.ok(moveRes.ok, 'order to post accepted');
  assert.equal(extra.targetPost, myPost.id, 'targetPost set on unit');
  run(sim, 5);
  assert.equal(extra.frontPost, myPost.id, 'unit joined garrison');
  assert.equal(extra.owner, '__front_0', 'transferred to frontline bot control');
  assert.equal(extra.stance, 'defend', 'defend stance adopted');
  assert.ok(myPost.garrison.includes(extra.id), 'unit in post.garrison');

  // stalemate firefight: equal frontline garrison units trade fire without fatal damage (hp >= 30)
  const enemyPost = sim.world.posts.find((p) => p.team === 1 && p.nodeIdx === myPost.nodeIdx);
  if (enemyPost && enemyPost.garrison[0]) {
    const friendUnit = sim.world.units.find((u) => u.id === myPost.garrison[0])!;
    const enemyUnit = sim.world.units.find((u) => u.id === enemyPost.garrison[0])!;
    assert.equal(friendUnit.owner, '__front_0', 'frontline unit owned by bot');
    assert.equal(enemyUnit.owner, '__front_1', 'enemy frontline unit owned by bot');
    myPost.advancing = false;
    enemyPost.advancing = false;
    friendUnit.ammo = 300;
    enemyUnit.ammo = 300;
    run(sim, 10);
    assert.ok(enemyUnit.hp >= 30 && enemyUnit.hp > 0, 'stalemate: garrison units trade fire but do not kill each other');
    assert.ok(friendUnit.hp >= 30 && friendUnit.hp > 0, 'stalemate: friendly garrison survives');
  }

  // reinforcing to superiority triggers autonomous advance
  const u1 = sim.spawnUnit('infantry_assault', a, myPost.pos);
  const u2 = sim.spawnUnit('infantry_assault', a, myPost.pos);
  u1.frontPost = myPost.id;
  u2.frontPost = myPost.id;
  myPost.garrison.push(u1.id, u2.id);
  run(sim, 2);
  assert.ok(myPost.advancing, 'post is advancing on force superiority');

  // regular ground troops cannot receive orders into enemy territory
  const hq = hqOf(sim, 'a');
  const enemyCity = sim.map.capturePoints.find((cp, i) => sim.world.points[i].owner === 1)!;
  const regularTroop = sim.spawnUnit('infantry', a, offsetKm(hq.pos, 5, 0));
  const badOrder = sim.apply('a', { type: 'move', units: [regularTroop.id], to: enemyCity.pos });
  assert.equal(badOrder.ok, false, 'ground troops cannot cross the front line');
  assert.match(badOrder.reason, /Ground troops cannot cross the front line/);

  // no posts in water region (Kherson / Kakhovka reservoir)
  const waterPosts = sim.world.posts.filter((p) => p.pos[0] < 35.3 && p.pos[1] < 47.75);
  assert.equal(waterPosts.length, 0, 'no posts spawned along the Dnipro water line / Kherson water region');

  console.log('frontline garrisons & line holding ok');
}

// --- bot AI: reinforces friendly frontline posts, supplies ammo to depots, never marches ground troops into enemy territory ---
{
  const sim = fresh();
  const bot = new Bot('a', 'normal');
  const hq = hqOf(sim, 'a');
  const myPost = sim.world.posts.find((p) => p.team === 0)!;
  myPost.garrison = []; // empty post that needs reinforcement

  // Bot army unit: idle ground unit
  const squad = sim.spawnUnit('infantry', sim.player('a')!, offsetKm(hq.pos, 5, 0));
  assert.equal(squad.targetPost, undefined);

  // Advance time past bot think interval
  sim.world.time = 10;
  bot.think(sim);

  // The squad should be ordered to reinforce a friendly post
  assert.ok(squad.targetPost !== undefined, 'bot dispatches idle squad to reinforce friendly post');
  const targetPost = sim.world.posts.find((p) => p.id === squad.targetPost);
  assert.equal(targetPost?.team, 0, 'target post is friendly');

  // Verify logistics: truck routes ammo to ammo_depot
  const fac = place(sim, 'a', 'ammo_factory', hq.pos, 36);
  const depot = place(sim, 'a', 'ammo_depot', myPost.pos, 0, 10);
  const truck = sim.spawnUnit('truck', sim.player('a')!, fac.pos);
  // Advance time past think interval
  sim.world.time += 10;
  bot.think(sim);
  assert.ok(truck.haul, 'bot assigns haul route to truck');
  assert.equal(truck.haul.resType, 'ammo', 'truck is assigned to transport ammo');

  console.log('bot AI reinforces frontline posts and supplies ammo ok');
}

// --- marching units peace condition & advance into empty sectors ---
{
  const sim = fresh();
  sim.world.time = rs.rules.peaceSeconds + 1; // outside ceasefire
  const myPost = sim.world.posts.find((p) => p.team === 0)!;
  const oppPost = sim.world.posts.find((p) => p.team === 1 && p.nodeIdx === myPost.nodeIdx);

  // 1. Marching unit test: unit en route to myPost (targetPost set) does not fight enemy nearby
  const marching = sim.spawnUnit('infantry', sim.player('a')!, offsetKm(myPost.pos, 5, 0));
  marching.targetPost = myPost.id;
  const enemyNear = sim.spawnUnit('infantry', sim.player('b')!, offsetKm(marching.pos, 0.4, 0));
  const marchHp0 = marching.hp;
  const enemyHp0 = enemyNear.hp;
  run(sim, 2);
  assert.equal(marching.hp, marchHp0, 'marching unit takes no fire from enemy');
  assert.equal(enemyNear.hp, enemyHp0, 'marching unit does not fire at enemy');
  assert.equal(marching.engaged, false, 'marching unit is not engaged');

  // 2. Empty sector advance: when opposing sector has 0 defenders, friendly garrison advances and pushes the front
  if (oppPost) {
    // clear opposing garrison
    for (const id of oppPost.garrison) {
      const u = sim.world.units.find((x) => x.id === id);
      if (u) u.hp = 0;
    }
    oppPost.garrison = [];

    // Ensure myPost has at least 1 unit with ammo
    if (myPost.garrison.length === 0) {
      const u = sim.spawnUnit('infantry', sim.player('a')!, myPost.pos);
      u.frontPost = myPost.id;
      u.owner = '__front_0';
      u.ammo = 100;
      myPost.garrison.push(u.id);
    } else {
      for (const id of myPost.garrison) {
        const u = sim.world.units.find((x) => x.id === id);
        if (u) u.ammo = 100;
      }
    }

    const frontIdx = myPost.nodeIdx;
    const frontStart = [sim.world.front[frontIdx].lng, sim.world.front[frontIdx].lat];
    const postStart = [...myPost.pos];
    run(sim, 5);

    assert.ok(myPost.advancing, 'garrison advances into empty enemy breach');
    const postShift = distKm(postStart as any, myPost.pos as any);
    const frontShift = distKm(frontStart as any, [sim.world.front[frontIdx].lng, sim.world.front[frontIdx].lat] as any);
    assert.ok(postShift > 0.05, `post visibly advances: shift=${postShift.toFixed(3)}km`);
    assert.ok(frontShift > 0.05, `frontline is pushed: shift=${frontShift.toFixed(3)}km`);
  }

  console.log('marching peace & empty sector advance ok');
}

