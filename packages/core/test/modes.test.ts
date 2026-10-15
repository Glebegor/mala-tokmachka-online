// Game modes and the features added with them: ceasefire, sandbox, closed buildings, missiles, drones on pickups.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { distKm, distToFrontKm, offsetKm, Sim, snapshotFor, type LngLat, type RulesConfig, type Team } from '../src';

const base = await loadRuleset(fileURLToPath(new URL('../../../mods', import.meta.url)));
const fresh = (rules: Partial<RulesConfig> = {}) => {
  const sim = new Sim({ ...base, rules: { ...base.rules, ...rules } }, 'ukraine', [
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
const hqOf = (sim: Sim, who: string) => sim.world.buildings.find((b) => b.owner === who && b.def === 'hq')!;
/** Two spots ~0.6 km apart on either side of the front, in the middle of the line. */
function acrossTheLine(sim: Sim): [LngLat, LngLat] {
  const n = sim.world.front[Math.floor(sim.world.front.length / 2)];
  const at: LngLat = [n.lng, n.lat];
  for (let a = 0; a < 16; a++) {
    const p = offsetKm(at, 0.3 * Math.cos(a / 2.55), 0.3 * Math.sin(a / 2.55));
    const q = offsetKm(at, -0.3 * Math.cos(a / 2.55), -0.3 * Math.sin(a / 2.55));
    if (sim.side(p) === 0 && sim.side(q) === 1) return [p, q];
  }
  throw new Error('no spot across the line');
}

// --- ceasefire: no shooting, nobody crosses, the front stands still; then the war starts ---
{
  const sim = fresh({ peaceSeconds: 30 });
  const [p0, p1] = acrossTheLine(sim);
  const ua = sim.spawnUnit('infantry', sim.player('a')!, p0);
  const ru = sim.spawnUnit('infantry', sim.player('b')!, p1);
  const front0 = JSON.stringify(sim.world.front.map((n) => [n.lng, n.lat]));
  run(sim, 10);
  assert.equal(ua.hp, 100, 'nobody shoots during the ceasefire');
  assert.equal(ru.hp, 100);
  assert.equal(JSON.stringify(sim.world.front.map((n) => [n.lng, n.lat])), front0, 'the front is frozen');
  const deep = offsetKm(p1, 0, 0);
  assert.equal(sim.apply('a', { type: 'move', units: [ua.id], to: deep }).ok, false, 'orders across the line are refused');
  assert.equal(sim.apply('a', { type: 'bombard', units: [ua.id], target: deep }).ok, false, 'no barrages');
  const shark = sim.spawnUnit('drone_mini_shark', sim.player('a')!, offsetKm(p0, 0, 0));
  assert.equal(sim.apply('a', { type: 'move', units: [shark.id], to: offsetKm(p1, 0, 0) }).ok, false, 'drones may not cross either');
  assert.ok(sim.peaceLeft() > 19.9 && sim.peaceLeft() < 20.1, `ceasefire left: ${sim.peaceLeft()}`);
  run(sim, 25);
  assert.equal(sim.peaceLeft(), 0, 'ceasefire over');
  assert.ok(ua.hp < 100 || ru.hp < 100, 'the war starts once the ceasefire ends');
  console.log('ceasefire ok');
}

// --- a ground unit sent along the line during the ceasefire halts on its own side ---
{
  const sim = fresh({ peaceSeconds: 600 });
  const [p0, p1] = acrossTheLine(sim);
  const ua = sim.spawnUnit('infantry', sim.player('a')!, p0);
  // a route planned earlier that runs straight over the line (orders like this are refused now, but paths may still cross)
  ua.path = [{ p: offsetKm(p1, (p1[0] - p0[0]) * 40, (p1[1] - p0[1]) * 40), road: false, end: true }];
  for (let i = 0; i < 300; i++) {
    sim.step(0.1);
    assert.equal(sim.side(ua.pos) as Team, 0, 'never on the enemy side during the ceasefire');
  }
  assert.equal(ua.path.length, 0, 'halted at the line');
  assert.ok(distKm(ua.pos, p0) < 0.6, 'and stayed right there');
  console.log('ceasefire border ok');
}

// --- time limit counts from the end of the ceasefire ---
{
  const sim = fresh({ peaceSeconds: 5, matchSeconds: 5 });
  run(sim, 8);
  assert.equal(sim.world.winReason, null, 'the clock starts after the ceasefire');
  run(sim, 3);
  assert.equal(sim.world.winReason, 'time limit');
  console.log('time limit ok');
}

// --- sandbox: full treasuries and stores, fast building, nobody wins ---
{
  const sim = fresh({ sandbox: true, buildTimeMult: 0.1, trainTimeMult: 0.1, matchSeconds: 5 });
  const hq = hqOf(sim, 'a');
  for (const p of sim.world.players) p.res.money = 0;
  hq.storage!.metal = 0;
  run(sim, 1.2);
  const cap = base.resources.find((r) => r.id === 'money')!.cap;
  assert.equal(sim.player('a')!.res.money, cap, 'money refilled');
  assert.equal(hq.storage!.metal, sim.storageCap(hq), 'stores refilled');
  assert.ok(sim.apply('a', { type: 'train', building: hq.id, unit: 'tank' }).ok);
  const tankTime = base.units.find((u) => u.id === 'tank')!.trainTime;
  run(sim, tankTime * 0.1 + 0.5);
  assert.ok(sim.world.units.some((u) => u.owner === 'a' && u.def === 'tank'), 'trained ten times faster');
  sim.world.buildings = sim.world.buildings.filter((b) => b.owner !== 'b');
  run(sim, 10);
  assert.equal(sim.world.winner, null, 'no victory and no time limit in the sandbox');
  console.log('sandbox ok');
}

// --- closed buildings: teammates cannot use them until the owner opens them again ---
{
  const sim = fresh();
  const hq = hqOf(sim, 'a');
  assert.ok(sim.apply('a2', { type: 'train', building: hq.id, unit: 'infantry' }).ok, 'shared by default');
  assert.ok(sim.apply('a', { type: 'share', allow: false }).ok);
  assert.equal(sim.apply('a2', { type: 'train', building: hq.id, unit: 'infantry' }).ok, false, 'closed to teammates');
  assert.ok(sim.apply('a', { type: 'train', building: hq.id, unit: 'infantry' }).ok, 'the owner still can');
  const truck = sim.spawnUnit('truck', sim.player('a2')!, hq.pos);
  assert.equal(sim.apply('a2', { type: 'setRoute', unit: truck.id, fromBuilding: hq.id, toBuilding: hqOf(sim, 'a2').id }).ok, false, 'no deliveries from a closed building');
  sim.apply('a', { type: 'share', allow: true });
  assert.ok(sim.apply('a2', { type: 'setRoute', unit: truck.id, fromBuilding: hq.id, toBuilding: hqOf(sim, 'a2').id }).ok, 'open again');
  sim.apply('a', { type: 'share', allow: false });
  assert.equal(truck.haul, undefined, 'closing cancels a teammate’s standing delivery');
  console.log('closed buildings ok');
}

// --- missiles: side-specific, fly to the target, blow up; ballistic ones mostly get through air defence ---
{
  const sim = fresh();
  const hq = hqOf(sim, 'a');
  const ru = sim.player('b')!;
  const factoryA = sim.world.buildings.length;
  sim.world.buildings.push({ ...hq, id: sim.world.nextId++, def: 'missile_factory', hp: 1100, storage: { metal: 5000, fuel: 5000 } });
  const fac = sim.world.buildings[factoryA];
  assert.equal(sim.apply('a', { type: 'train', building: fac.id, unit: 'missile_iskander' }).ok, false, 'Iskander is Russian');
  assert.ok(sim.apply('a', { type: 'train', building: fac.id, unit: 'missile_neptune' }).ok, 'Neptune is Ukrainian');
  sim.world.buildings.splice(factoryA, 1);
  sim.world.queue = [];

  const hp0 = hq.hp;
  const m = sim.spawnUnit('missile_iskander', ru, offsetKm(hq.pos, 0, -150));
  assert.ok(sim.apply('b', { type: 'move', units: [m.id], to: hq.pos }).ok);
  let t = 0;
  while (sim.world.units.includes(m) && t < 600) sim.step(0.1), t++;
  assert.ok(!sim.world.units.includes(m), 'the missile is spent');
  assert.ok(hq.hp < hp0 - 200, `the target is hit hard (${Math.round(hp0 - hq.hp)} damage)`);
  assert.ok(t < 400, `150 km in ${t / 10} s`);
  assert.ok(sim.world.smokes.some((s) => distKm(s.pos, hq.pos) < 1), 'smoke on the target');

  // air defence over the approach
  const aa = { ...hq, id: sim.world.nextId++, def: 'antiair', hp: 400, storage: undefined, pos: offsetKm(hq.pos, 0, -60) };
  sim.world.buildings.push(aa);
  const fire = (def: string, n: number) => {
    let through = 0;
    for (let k = 0; k < n; k++) {
      const x = sim.spawnUnit(def, ru, offsetKm(hq.pos, 0.5 * k, -120));
      sim.apply('b', { type: 'move', units: [x.id], to: offsetKm(hq.pos, 0.5 * k, 0) });
      let hit = false;
      for (let i = 0; i < 900 && sim.world.units.includes(x); i++) {
        sim.step(0.1);
        if (x.hp > 0 && distKm(x.pos, hq.pos) < 3) hit = true;
      }
      if (hit) through++;
    }
    return through;
  };
  const cruise = fire('missile_kh101', 4);
  const ballistic = fire('missile_iskander', 4);
  assert.ok(ballistic >= 1, `ballistic missiles get through (${ballistic}/4)`);
  assert.ok(cruise <= 1, `cruise missiles are mostly shot down over air defence (${cruise}/4 got through)`);
  console.log(`missiles ok: ballistic ${ballistic}/4, cruise ${cruise}/4 through air defence`);
}

// --- small drones ride on a pickup and are launched from it ---
{
  const sim = fresh();
  const hq = hqOf(sim, 'a');
  const a = sim.player('a')!;
  const pickup = sim.spawnUnit('pickup', a, offsetKm(hq.pos, 2, 0));
  const shark = sim.spawnUnit('drone_mini_shark', a, offsetKm(hq.pos, 3, 0));
  const fp = sim.spawnUnit('drone_fire_point', a, offsetKm(hq.pos, 3, 1));
  const big = sim.spawnUnit('drone_pd2', a, offsetKm(hq.pos, 3, 2));
  const spare = sim.spawnUnit('drone', a, offsetKm(hq.pos, 3, 3));
  assert.equal(sim.apply('a', { type: 'board', unit: big.id, transport: pickup.id }).ok, false, 'PD-2 is too big for the launcher');
  assert.ok(sim.apply('a', { type: 'board', unit: shark.id, transport: pickup.id }).ok);
  assert.ok(sim.apply('a', { type: 'board', unit: fp.id, transport: pickup.id }).ok);
  assert.equal(sim.apply('a', { type: 'board', unit: spare.id, transport: pickup.id }).ok, false, 'two drones per pickup');
  assert.deepEqual(pickup.cargo!.drones, [shark.id, fp.id]);
  const inf = sim.spawnUnit('infantry', a, offsetKm(hq.pos, 2, 0.5));
  assert.ok(sim.apply('a', { type: 'board', unit: inf.id, transport: pickup.id }).ok, 'the infantry seat is separate');
  const dest = offsetKm(hq.pos, 20, 0);
  sim.apply('a', { type: 'move', units: [pickup.id], to: dest, mode: 'direct' });
  run(sim, 30);
  assert.ok(distKm(pickup.pos, hq.pos) > 5, 'the pickup drove off');
  assert.equal(distKm(shark.pos, pickup.pos), 0, 'drones ride along');
  const fuel0 = shark.fuel;
  assert.ok(sim.apply('a', { type: 'disembark', transport: pickup.id }).ok);
  assert.ok(shark.embarkedIn === pickup.id, 'dismounting lets the infantry out, not the drones');
  const target = offsetKm(pickup.pos, 0, 15);
  assert.ok(sim.apply('a', { type: 'launch', transport: pickup.id, target }).ok);
  assert.equal(pickup.cargo!.drones!.length, 0);
  assert.ok(!shark.embarkedIn && !fp.embarkedIn, 'launched');
  assert.equal(shark.fuel, fuel0);
  run(sim, 40);
  assert.ok(distKm(shark.pos, target) < 6, 'the recon drone reached its area and circles it');
  assert.ok(!sim.world.units.includes(fp), 'the strike drone dived on the target');
  assert.equal(sim.apply('a', { type: 'launch', transport: pickup.id }).ok, false, 'nothing left to launch');
  console.log('pickup drones ok');
}

// --- training queue: orders carry their total time; cancelling refunds the treasury and the building's store ---
{
  const sim = fresh();
  const hq = hqOf(sim, 'a');
  const a = sim.player('a')!;
  const money0 = a.res.money, metal0 = hq.storage!.metal;
  assert.ok(sim.apply('a', { type: 'train', building: hq.id, unit: 'tank' }).ok);
  assert.ok(sim.apply('a', { type: 'train', building: hq.id, unit: 'tank' }).ok);
  assert.ok(sim.apply('a2', { type: 'train', building: hq.id, unit: 'infantry' }).ok);
  const tank = base.units.find((u) => u.id === 'tank')!;
  assert.equal(a.res.money, money0 - 2 * tank.cost.money);
  assert.equal(hq.storage!.metal, metal0 - 2 * tank.cost.metal);
  const [first, second, theirs] = sim.world.queue;
  assert.equal(first.total, tank.trainTime);
  run(sim, 5);
  assert.ok(first.remaining < first.total && second.remaining === second.total, 'only the head trains');
  assert.equal(sim.apply('a', { type: 'cancelTrain', item: theirs.id }).ok, false, "a teammate's order is theirs to cancel");
  const before = a.res.money;
  assert.ok(sim.apply('a', { type: 'cancelTrain', item: second.id }).ok);
  assert.ok(sim.apply('a', { type: 'cancelTrain', item: first.id }).ok, 'an order in progress can be cancelled too');
  assert.equal(a.res.money, before + 2 * tank.cost.money, 'money refunded');
  assert.equal(hq.storage!.metal, metal0, 'metal back in the store');
  assert.deepEqual(sim.world.queue.map((q) => q.id), [theirs.id]);
  console.log('training queue ok');
}

// --- ground that changes hands is grey until no enemy has been near it for 30 s; then Ukrainian gains turn blue ---
{
  const sim = fresh();
  const [p0] = acrossTheLine(sim);
  const a = sim.player('a')!;
  const push = Array.from({ length: 30 }, (_, i) => sim.spawnUnit('tank', a, offsetKm(p0, (i % 6) * 0.3, Math.floor(i / 6) * 0.3)));
  for (const t of push) (t.fireMode = 'hold'), (t.fuel = undefined);
  run(sim, 60);
  const C = { lng: 0.02, lat: 0.0135 };
  const centre = (c: { ix: number; iy: number }): LngLat => [(c.ix + 0.5) * C.lng, (c.iy + 0.5) * C.lat];
  const key = (c: { ix: number; iy: number }) => `${c.ix},${c.iy}`;
  const cell = (c: { ix: number; iy: number }) => sim.world.liberated.find((x) => key(x) === key(c));
  const grey = sim.world.liberated.filter((c) => c.team === 0 && !c.free);
  assert.ok(grey.length > 10, `the ground the line passed over is grey (${grey.length} cells)`);
  assert.equal(sim.side(centre(grey[0])), 0, 'it is on our side of the line now');
  assert.equal(sim.apply('a', { type: 'build', def: 'trench', pos: centre(grey[0]) }).ok, false, 'no building on grey ground');
  for (const t of push) t.hp = 0; // stop pushing
  run(sim, 0.2);
  // an enemy squad sits next to one cell; another cell far from it has nobody near
  const watched = grey.reduce((x, y) => (sim.world.units.length && distKm(centre(y), p0) < distKm(centre(x), p0) ? y : x));
  // a freshly taken cell (its quiet clock has only just started)
  const lonely = grey.filter((c) => distKm(centre(c), centre(watched)) > 12).sort((x, y) => x.quiet - y.quiet)[0];
  assert.ok(lonely, 'two cells far apart');
  const foe = sim.spawnUnit('infantry', sim.player('b')!, offsetKm(centre(watched), 0.5, 0));
  (foe.fireMode = 'hold'), (foe.hp = 1e6);
  const q0 = lonely!.quiet;
  assert.ok(q0 <= 6, `fresh cell (${q0} s quiet)`);
  run(sim, 12);
  assert.ok(cell(lonely!) && !cell(lonely!)!.free, 'still grey after 12 s');
  run(sim, 24 - q0);
  assert.ok(cell(lonely!)?.free, 'blue (liberated) after 30 s with no enemy near');
  assert.ok(!cell(watched)?.free, 'but grey (or lost) where the enemy is still around');
  const built = sim.apply('a', { type: 'build', def: 'trench', pos: centre(lonely!) });
  assert.ok(built.ok || !/grey/.test(built.reason), `liberated ground is not grey any more (${built.ok ? 'built' : built.reason})`);
  console.log(`ground changing hands ok: ${grey.length} grey cells, liberated where the enemy stayed away`);
}

// --- fuel: vehicles burn it quickly; one vehicle can drive over and hand fuel to another (an ally's too) ---
{
  const sim = fresh();
  const hq = hqOf(sim, 'a');
  const start = offsetKm(hq.pos, 30, 0);
  const tank = sim.spawnUnit('tank', sim.player('a2')!, start);
  const fuel0 = tank.fuel!;
  tank.path = [{ p: offsetKm(start, 10, 0), road: false, end: true }];
  run(sim, 120);
  const km = distKm(start, tank.pos);
  assert.ok(Math.abs(fuel0 - tank.fuel! - km * base.rules.fuelPerKm) < 0.5, `burns ${base.rules.fuelPerKm}/km (${km.toFixed(1)} km, ${(fuel0 - tank.fuel!).toFixed(1)} fuel)`);
  tank.fuel = 0;
  const pickup = sim.spawnUnit('pickup', sim.player('a')!, offsetKm(tank.pos, 4, 3));
  assert.equal(sim.apply('a', { type: 'giveFuel', unit: pickup.id, target: hq.id + 99999 }).ok, false, 'needs a real vehicle');
  assert.ok(sim.apply('a', { type: 'giveFuel', unit: pickup.id, target: tank.id }).ok, "fuel for a teammate's tank");
  run(sim, 40);
  assert.ok(tank.fuel! > 0, `the tank got fuel (${tank.fuel!.toFixed(1)})`);
  assert.ok(pickup.fuel! >= pickup.maxFuel! * 0.25 - 0.01, 'the pickup kept a quarter for itself');
  assert.equal(pickup.fuelTo, undefined, 'and the run is over');
  // a tanker gives from its load (the pickup is topped up so it does not drink from the tanker as well)
  tank.fuel = 0;
  pickup.fuel = pickup.maxFuel;
  const tanker = sim.spawnUnit('fuel_truck', sim.player('a')!, offsetKm(tank.pos, 0.3, 0));
  tanker.cargo!.res.fuel = 50;
  sim.apply('a', { type: 'giveFuel', unit: tanker.id, target: tank.id });
  run(sim, 10);
  assert.ok(tank.fuel! >= 49 && tanker.cargo!.res.fuel! < 1, 'the tanker emptied its load into the tank');
  console.log('fuel transfer ok');
}

// --- ammo: depots in grey zones, the supplied bonus, trucks bring ammo from the factory ---
{
  const sim = fresh({ peaceSeconds: 0 });
  const [p0, p1] = acrossTheLine(sim);
  const a = sim.player('a')!;
  // a grey zone our troops hold behind the enemy line
  const behind = offsetKm(p1, (p1[0] - p0[0]) * 600, (p1[1] - p0[1]) * 400);
  assert.equal(sim.side(behind), 1, 'the spot is on the enemy side');
  sim.world.grey.push({ id: sim.world.nextId++, team: 0, pos: behind, r: 5, ttl: 3 });
  assert.equal(sim.apply('a', { type: 'build', def: 'trench', pos: behind }).ok, false, 'nothing else can be built there');
  assert.ok(sim.apply('a', { type: 'build', def: 'ammo_depot', pos: behind }).ok, 'an ammo depot can');
  const depot = sim.world.buildings[sim.world.buildings.length - 1];
  depot.progress = 1;
  run(sim, 1.5);
  assert.ok(sim.world.buildings.includes(depot), 'it stands while the grey zone does');
  run(sim, 6); // nobody keeps the zone up: it fades
  assert.ok(!sim.world.buildings.includes(depot), 'and is lost with it');

  // rounds: every shot uses one, an empty unit cannot fire, a stocked depot nearby refills it from its store
  const hq = hqOf(sim, 'a');
  const d2 = { ...hq, id: sim.world.nextId++, def: 'ammo_depot', hp: 350, pos: offsetKm(p0, (p0[0] - p1[0]) * 1500, (p0[1] - p1[1]) * 1000), storage: { ammo: 0 }, inside: [], course: null, upgrade: null };
  sim.world.buildings.push(d2);
  assert.equal(sim.side(d2.pos), 0, 'depot behind our line');
  const ua = sim.spawnUnit('infantry', a, p0);
  const ru = sim.spawnUnit('infantry', sim.player('b')!, p1);
  (ru.fireMode = 'hold'), (ru.hp = 1e6);
  assert.equal(ua.ammo, 300, 'infantry starts with 300 rounds');
  run(sim, 5);
  assert.ok(ua.ammo! <= 292 && ua.ammo! % 2 === 0, `each burst uses 2 rounds (${ua.ammo} left)`);
  ua.ammo = 1; // less than one burst
  const hp0 = ru.hp;
  run(sim, 4);
  assert.equal(ru.hp, hp0, 'not enough rounds for a burst: no shooting');
  assert.equal(ua.ammo, 1);
  assert.ok(ua.status.some(([id]) => id === 'noammo'), 'flagged out of ammo');
  d2.storage.ammo = 1000;
  run(sim, 3.2);
  assert.ok(ua.ammo! > 0, `refilled at the depot (${ua.ammo})`);
  assert.ok(d2.storage.ammo < 1000, 'from its store');
  run(sim, 3);
  assert.ok(ru.hp < hp0, 'and fires again');
  const tank = sim.spawnUnit('tank', a, offsetKm(d2.pos, 1, 0));
  tank.ammo = 0;
  (tank.fireMode = 'hold'), (ua.fireMode = 'hold'), (ua.ammo = 300); // only the tank draws from the depot now
  const before = d2.storage.ammo;
  for (let i = 0; i < 20 && !tank.ammo; i++) sim.step(0.1); // the first refill (once a second)
  assert.ok(tank.ammo! > 0);
  assert.equal(before - d2.storage.ammo, tank.ammo! * 4, 'a tank shell costs 4 ammo');

  // a truck hauls ammo from the factory to the depot
  const fac = { ...hq, id: sim.world.nextId++, def: 'ammo_factory', hp: 900, pos: offsetKm(d2.pos, -8, 0), storage: { ammo: 2000, metal: 500 }, inside: [], course: null, upgrade: null };
  sim.world.buildings.push(fac);
  const truck = sim.spawnUnit('truck', a, fac.pos);
  assert.ok(sim.apply('a', { type: 'setRoute', unit: truck.id, fromBuilding: fac.id, toBuilding: d2.id, resType: 'ammo' }).ok);
  run(sim, 120);
  assert.ok(d2.storage.ammo > 500, `ammo delivered (${Math.round(d2.storage.ammo)})`);
  console.log('ammo ok');
}

// --- only anti-air weapons engage aircraft: infantry ignores drones, a MANPADS team shoots them and nothing else ---
{
  const sim = fresh();
  const [p0, p1] = acrossTheLine(sim);
  const a = sim.player('a')!, b = sim.player('b')!;
  const orion = sim.spawnUnit('drone_orion', b, p0);
  const strike = sim.spawnUnit('drone_shahed', b, offsetKm(p0, 0.3, 0));
  const inf = sim.spawnUnit('infantry', a, offsetKm(p0, 0.2, 0.2));
  const tank = sim.spawnUnit('tank', a, offsetKm(p0, -0.2, 0.2));
  run(sim, 4);
  assert.equal(orion.hp, sim.defs.u.get('drone_orion')!.hp, 'infantry and tanks do not shoot recon drones');
  assert.equal(strike.hp, sim.defs.u.get('drone_shahed')!.hp, 'nor strike drones');
  assert.equal(inf.ammo, 300, 'no rounds wasted on them');
  const enemyInf = sim.spawnUnit('infantry', b, p1);
  enemyInf.fireMode = 'hold';
  const team = sim.spawnUnit('manpads', a, offsetKm(p0, 0, 0.3));
  const hp0 = enemyInf.hp;
  inf.fireMode = tank.fireMode = 'hold';
  run(sim, 6);
  assert.ok(!sim.world.units.includes(orion) || orion.hp < sim.defs.u.get('drone_orion')!.hp, 'MANPADS hits the recon drone');
  assert.ok(!sim.world.units.includes(strike) || strike.hp < sim.defs.u.get('drone_shahed')!.hp, 'and the strike drone');
  assert.equal(enemyInf.hp, hp0, 'but never shoots ground troops');
  assert.ok(team.ammo! < 6, `missiles used (${team.ammo} left)`);
  console.log('anti-air ok');
}

// --- delivery routes: only goods the destination takes, smart "any", wait at an empty source ---
{
  const sim = fresh();
  const a = sim.player('a')!;
  const hq = hqOf(sim, 'a');
  const mk = (def: string, dx: number, storage: Record<string, number>) => {
    const b = { ...hq, id: sim.world.nextId++, def, hp: 500, pos: offsetKm(hq.pos, dx, -4), storage, inside: [], course: null, upgrade: null };
    sim.world.buildings.push(b);
    return b;
  };
  const mine = mk('mine', 2, { ore: 0 });
  const works = mk('metalworks', 6, { ore: 0, metal: 800 });
  const truck = sim.spawnUnit('truck', a, mine.pos);
  const depot = mk('ammo_depot', -3, { ammo: 0 });
  assert.equal(sim.apply('a', { type: 'setRoute', unit: truck.id, fromBuilding: mine.id, toBuilding: depot.id, resType: 'ore' }).ok, false, 'an ammo depot takes no ore');
  assert.ok(sim.apply('a', { type: 'setRoute', unit: truck.id, fromBuilding: works.id, toBuilding: hq.id }).ok, 'metal from the works to the base');
  for (let i = 0; i < 600 && !(truck.cargo!.res.metal ?? 0); i++) sim.step(0.1);
  assert.ok((truck.cargo!.res.metal ?? 0) > 700, `"any" picked the metal (${Math.round(truck.cargo!.res.metal ?? 0)})`);
  const store = mk('warehouse', 10, { ore: 0, metal: 0, fuel: 0, ammo: 0 }); // makes nothing itself
  const t2 = sim.spawnUnit('truck', a, store.pos);
  assert.ok(sim.apply('a', { type: 'setRoute', unit: t2.id, fromBuilding: store.id, toBuilding: works.id, resType: 'ore' }).ok);
  run(sim, 12);
  assert.equal(t2.haul?.state, 'loading', 'an empty source: it waits');
  assert.ok(t2.haul?.waiting && distKm(t2.pos, store.pos) < 3.5, 'right there');
  store.storage.ore = 400;
  run(sim, 6);
  assert.notEqual(t2.haul?.state, 'loading', 'loads as soon as there is ore and drives off');
  assert.equal(store.storage.ore, 0, 'took all of it');
  console.log('delivery routes ok');
}

// --- goods are kept in buildings: the HQ holds the starting stock, builds draw on it, new sites start (nearly) empty ---
{
  const sim = fresh();
  const a = sim.player('a')!;
  const hq = hqOf(sim, 'a');
  const start = Object.fromEntries(base.resources.map((r) => [r.id, r.start]));
  assert.equal(hq.storage!.metal, start.metal, 'the HQ holds the starting metal');
  assert.equal(a.res.metal, undefined, 'goods are not a treasury number any more');
  const snap = snapshotFor(sim, 'a', 0);
  assert.equal(snap.res.metal, start.metal, 'the top bar shows what is in the HQ');
  // a bunker costs metal: it comes out of the HQ
  const bunkerCost = sim.defs.b.get('bunker')!.cost.metal!;
  let built = false;
  for (let r = 3; r < 30 && !built; r += 2) built = sim.apply('a', { type: 'build', def: 'bunker', pos: offsetKm(hq.pos, r, 0) }).ok;
  assert.ok(built);
  assert.equal(hq.storage!.metal, start.metal - bunkerCost, 'paid from the HQ store');
  hq.storage!.metal = 0;
  let refused = '';
  for (let r = 3; r < 30 && !refused; r += 2) { const x = sim.apply('a', { type: 'build', def: 'bunker', pos: offsetKm(hq.pos, -r, 0) }); if (!x.ok && /HQ/.test(x.reason)) refused = x.reason; }
  assert.ok(refused, 'no metal in the HQ, no bunker');
  // new buildings: a factory gets enough for two of its dearest units, a store or producer starts empty
  hq.storage!.metal = 5000;
  const fac = (sim as any).spawnBuilding('machine_factory', a, offsetKm(hq.pos, 60, 0));
  const dearest = Math.max(...sim.defs.b.get('machine_factory')!.trains!.map((u) => sim.defs.u.get(u)!.cost.metal ?? 0));
  assert.equal(fac.storage.metal, dearest * 2, 'a factory starts with materials for two units');
  const wh = (sim as any).spawnBuilding('warehouse', a, offsetKm(hq.pos, 0, 60));
  assert.deepEqual(Object.values(wh.storage).filter((v) => v), [], 'a warehouse starts empty');
  console.log('goods in buildings ok');
}

// --- medics heal troops on foot, mechanics repair vehicles, hospitals heal around them; nobody heals while under fire ---
{
  const sim = fresh();
  const a = sim.player('a')!;
  const hq = hqOf(sim, 'a');
  const at = offsetKm(hq.pos, 20, 0);
  const inf = sim.spawnUnit('infantry', a, at);
  const tank = sim.spawnUnit('tank', a, offsetKm(at, 0.5, 0));
  inf.hp = 40;
  tank.hp = 100;
  sim.spawnUnit('medic', a, offsetKm(at, 1, 1));
  run(sim, 5);
  assert.ok(inf.hp > 40 + 7, `the medic patches up the infantry (${inf.hp.toFixed(0)})`);
  assert.equal(tank.hp, 100, 'but cannot repair a tank');
  assert.ok(inf.status.some(([id]) => id === 'healing'), 'shown as healing');
  sim.spawnUnit('mechanic', a, offsetKm(at, -1, 0));
  run(sim, 5);
  assert.ok(tank.hp > 100 + 20, `the mechanic repairs the tank (${tank.hp.toFixed(0)})`);
  inf.hp = 40;
  inf.lastHit = sim.world.time;
  run(sim, 5);
  assert.equal(inf.hp, 40, 'nobody heals within 10 s of being hit');
  run(sim, 7);
  assert.ok(inf.hp > 40, 'then healing starts');
  // a field hospital heals faster (3%) and further (6 km)
  const sim2 = fresh();
  const hq2 = hqOf(sim2, 'a');
  sim2.world.buildings.push({ ...hq2, id: sim2.world.nextId++, def: 'med_center', hp: 450, pos: offsetKm(hq2.pos, 20, 0), storage: undefined, inside: [], course: null, upgrade: null });
  const hurt = sim2.spawnUnit('infantry', sim2.player('a')!, offsetKm(hq2.pos, 25, 0));
  hurt.hp = 20;
  run(sim2, 4);
  assert.ok(Math.abs(hurt.hp - (20 + 4 * 3)) < 3.1, `hospital: 3 hp a second for infantry (${hurt.hp.toFixed(1)})`);
  console.log('healing ok');
}

// --- artillery: dead zone of a fifth of its range, 2.5 s to lay the guns on a new target ---
{
  const sim = fresh();
  const [p0, p1] = acrossTheLine(sim);
  const a = sim.player('a')!, b = sim.player('b')!;
  const away = (p: LngLat, km: number): LngLat => offsetKm(p, (p[0] - p1[0]) * km * 270, (p[1] - p1[1]) * km * 370); // back from the line
  const gun = sim.spawnUnit('artillery', a, away(p0, 6));
  const spotter = sim.spawnUnit('infantry_recon', a, p0);
  spotter.fireMode = 'hold';
  const near = sim.spawnUnit('infantry', b, offsetKm(gun.pos, 3, 0)); // inside the 4 km dead zone (and our side: it just stands there)
  (near.fireMode = 'hold'), (near.hp = 1e6);
  sim.spawnUnit('infantry_recon', a, near.pos).fireMode = 'hold'; // it is seen
  const hp0 = near.hp;
  run(sim, 5);
  assert.equal(near.hp, hp0, 'no shot inside the dead zone');
  near.hp = 0;
  const far = sim.spawnUnit('infantry', b, p1);
  (far.fireMode = 'hold'), (far.hp = 1e6);
  const d = distKm(gun.pos, far.pos);
  assert.ok(d > 4 && d < 20, `target ${d.toFixed(1)} km away`);
  let first = 0;
  for (let i = 1; i <= 60 && !first; i++) {
    sim.step(0.1);
    if (far.hp < 1e6) first = i / 10;
  }
  assert.ok(first >= 2.4 && first <= 3.2, `first shell after aiming (${first}s)`);
  console.log(`artillery ok: dead zone 4 km, first shell after ${first}s`);
}

// --- combat system: stances, attack-move, formations, retreat ---
{
  const sim = fresh();
  const a = sim.player('a')!, b = sim.player('b')!;
  const hq = hqOf(sim, 'a');
  const at = offsetKm(hq.pos, 25, 0);
  // an enemy 3 km off, sitting tight (out of rifle range, in sight)
  const foe = sim.spawnUnit('infantry', b, offsetKm(at, 2.5, 0));
  (foe.fireMode = 'hold'), (foe.hp = 1e6);
  const holder = sim.spawnUnit('infantry', a, at);
  assert.equal(holder.stance, 'hold', 'players\' units hold position by default');
  run(sim, 10);
  assert.ok(distKm(holder.pos, at) < 0.01, 'a holding unit does not chase');
  sim.apply('a', { type: 'stance', units: [holder.id], stance: 'aggressive' });
  run(sim, 10);
  assert.ok(distKm(holder.pos, at) > 0.8, 'an aggressive one closes in');
  // defend: chases inside its 3 km leash only, then returns to its post
  const post = offsetKm(at, 0, 10);
  const def = sim.spawnUnit('infantry', a, post);
  sim.apply('a', { type: 'stance', units: [def.id], stance: 'defend' });
  const far = sim.spawnUnit('infantry', b, offsetKm(post, 3.4, 0)); // seen (4 km sight * 0.7 = 2.8) — out of reach
  (far.fireMode = 'hold'), (far.hp = 1e6);
  run(sim, 8);
  assert.ok(distKm(def.pos, post) < 0.01, 'a defender ignores enemies beyond its leash');
  const close = sim.spawnUnit('infantry', b, offsetKm(post, 2, 0));
  (close.fireMode = 'hold'), (close.hp = 1e6);
  run(sim, 5);
  const out = distKm(def.pos, post);
  assert.ok(out > 0.3, `a defender steps out for an enemy near its post (${out.toFixed(2)} km)`);
  close.hp = 0;
  run(sim, 30);
  assert.ok(distKm(def.pos, post) <= 0.35, 'and walks back once it is gone');
  // attack-move stops to fight, a plain move pushes on
  const start = offsetKm(at, 0, -12);
  const blocker = sim.spawnUnit('infantry', b, offsetKm(start, 1.5, 0.4));
  (blocker.fireMode = 'hold'), (blocker.hp = 1e6);
  const mover = sim.spawnUnit('infantry', a, start);
  const raider = sim.spawnUnit('infantry', a, offsetKm(start, 0, 0.05));
  sim.apply('a', { type: 'move', units: [mover.id], to: offsetKm(start, 5, 0), mode: 'direct' });
  sim.apply('a', { type: 'move', units: [raider.id], to: offsetKm(start, 5, 0.05), mode: 'direct', attack: true });
  run(sim, 40);
  assert.ok(distKm(mover.pos, offsetKm(start, 5, 0)) < 0.5, `a plain move pushes through (${distKm(mover.pos, offsetKm(start, 5, 0)).toFixed(2)} km short, path ${mover.path.length}, at ${distKm(mover.pos, start).toFixed(2)} km)`);
  assert.ok(distKm(raider.pos, start) < 2 && raider.attackMove, `attack-move stops to fight (${distKm(raider.pos, start).toFixed(1)} km on)`);
  // formations: a line across the direction of travel
  const squad = Array.from({ length: 5 }, (_, i) => sim.spawnUnit('infantry', a, offsetKm(at, -20, i * 0.05)));
  const goal = offsetKm(at, -20, 6);
  sim.apply('a', { type: 'move', units: squad.map((u) => u.id), to: goal, mode: 'direct', formation: 'line' });
  const ends = squad.map((u) => u.path[u.path.length - 1].p);
  const spanEW = distKm(ends[0], ends[4]);
  assert.ok(spanEW > 1.2 && Math.abs(ends[0][1] - ends[4][1]) < 0.005, `line formation: side by side across the way (${spanEW.toFixed(2)} km wide)`);
  // retreat: below the threshold a unit falls back to a field hospital by itself
  sim.world.buildings.push({ ...hq, id: sim.world.nextId++, def: 'med_center', hp: 450, pos: offsetKm(hq.pos, 5, 5), storage: undefined, inside: [], course: null, upgrade: null });
  const hurt = sim.spawnUnit('infantry', a, offsetKm(hq.pos, 30, 20));
  sim.apply('a', { type: 'retreat', units: [hurt.id], at: 0.5 });
  hurt.hp = 30;
  run(sim, 2);
  assert.ok(hurt.retreating && hurt.path.length > 0, 'a battered unit falls back');
  console.log('combat system ok: stances, attack-move, formations, retreat');
}

// --- multi-stop delivery routes: load, via a waypoint, unload at two sites; leave only with the minimum load ---
{
  const sim = fresh();
  const a = sim.player('a')!;
  const hq = hqOf(sim, 'a');
  const mk = (def: string, dx: number, dy: number, storage: Record<string, number>) => {
    const b = { ...hq, id: sim.world.nextId++, def, hp: 500, pos: offsetKm(hq.pos, dx, dy), storage, inside: [], course: null, upgrade: null };
    sim.world.buildings.push(b);
    return b;
  };
  const store = mk('warehouse', 4, -4, { ore: 0, metal: 120, fuel: 0, ammo: 0 });
  const wh2 = mk('warehouse', 8, -4, { ore: 0, metal: 0, fuel: 0, ammo: 0 });
  const truck = sim.spawnUnit('truck', a, store.pos);
  const via = offsetKm(hq.pos, 6, -7);
  assert.equal(sim.apply('a', { type: 'setRoute', unit: truck.id, stops: [{ action: 'load', building: store.id }] }).ok, false, 'needs at least two stops');
  assert.equal(sim.apply('a', { type: 'setRoute', unit: truck.id, stops: [{ action: 'load', building: store.id }, { action: 'via', pos: via }] }).ok, false, 'and somewhere to unload');
  assert.ok(sim.apply('a', { type: 'setRoute', unit: truck.id, resType: 'metal', minLoad: 300, stops: [{ action: 'load', building: store.id }, { action: 'via', pos: via }, { action: 'unload', building: wh2.id }, { action: 'unload', building: hq.id }] }).ok);
  run(sim, 15);
  assert.equal(truck.haul?.state, 'loading', 'only 120 metal there: it waits for 300');
  assert.ok(truck.haul?.waiting);
  store.storage.metal = 400;
  run(sim, 7);
  assert.ok(truck.haul!.idx >= 1, 'leaves once it has 300+');
  let sawVia = false;
  for (let i = 0; i < 2000 && (wh2.storage.metal ?? 0) < 1; i++) {
    sim.step(0.1);
    if (distKm(truck.pos, via) < 0.7) sawVia = true;
  }
  assert.ok(sawVia, 'drove through the waypoint');
  assert.ok((wh2.storage.metal ?? 0) > 300, `unloaded at the warehouse (${Math.round(wh2.storage.metal)})`);
  console.log('multi-stop routes ok');
}

// --- the map follows the troops: an unopposed unit just past the line drags the front forward at once ---
{
  const sim = fresh();
  const [p0, p1] = acrossTheLine(sim);
  const a = sim.player('a')!;
  const beyond: LngLat = [p1[0] + (p1[0] - p0[0]) * 3.3, p1[1] + (p1[1] - p0[1]) * 3.3]; // ~2 km past the line (p0–p1 is 0.6 km)
  assert.equal(sim.side(beyond), 1);
  const u = sim.spawnUnit('infantry', a, beyond);
  u.fireMode = 'hold';
  assert.ok(Math.abs(distToFrontKm(sim.world.front, beyond)) < 3, 'just past the line');
  run(sim, 1.2);
  assert.equal(sim.side(u.pos), 0, 'within a second the ground under it is ours');
  // an opposed unit does not move the line
  const sim2 = fresh();
  const [q0, q1] = acrossTheLine(sim2);
  const there: LngLat = [q1[0] + (q1[0] - q0[0]) * 3.3, q1[1] + (q1[1] - q0[1]) * 3.3];
  const v = sim2.spawnUnit('infantry', sim2.player('a')!, there);
  const foe = sim2.spawnUnit('infantry', sim2.player('b')!, offsetKm(there, 1, 0));
  (v.fireMode = 'hold'), (foe.fireMode = 'hold'), (v.hp = foe.hp = 1e6);
  run(sim2, 1.2);
  assert.equal(sim2.side(v.pos), 1, 'with the enemy beside it, it is only grey (penetration) ground');
  assert.ok(sim2.liberatedAt(v.pos), 'shown as grey');
  console.log('front follows the troops ok');
}

// --- morale: falls in a cauldron and under fire, weakens a unit, and an encircled unit at zero surrenders ---
{
  const sim = fresh();
  const a = sim.player('a')!;
  const hq = hqOf(sim, 'a');
  const u = sim.spawnUnit('infantry', a, offsetKm(hq.pos, 30, 0));
  assert.equal(u.morale, 100);
  u.morale = 30;
  assert.ok(Math.abs(sim.moraleMult(u) - 0.8) < 1e-9, 'shaken: 80% damage at 30 morale');
  run(sim, 0.5);
  assert.ok(u.status.some(([id]) => id === 'broken' || id === 'lowmorale'));
  run(sim, 5);
  assert.ok(u.morale! > 30, 'recovers out of the fight');
  // encircled: drains, no resupply, surrenders at zero
  const before = sim.world.scores[1];
  u.morale = 4;
  u.ammo = 0;
  u.encircled = true;
  (sim as any).morale();
  assert.ok(u.morale! < 4);
  (sim as any).morale();
  (sim as any).morale();
  assert.equal(u.hp, 0, 'surrenders at zero');
  assert.ok(sim.world.scores[1] > before, 'and the enemy scores for it');
  console.log('morale ok');
}

// --- bridges: drawn across a river, let your troops cross, and strike drones can bring them down ---
{
  const sim = fresh({ peaceSeconds: 0 });
  const a = sim.player('a')!, b = sim.player('b')!;
  const terr = (sim as any).terrain;
  // find a river on our ground: dry – water – dry within ~1.5 km, east–west
  let site: [LngLat, LngLat] | null = null;
  for (let x = 30; x < 36 && !site; x += 0.05) for (let y = 47.5; y < 50.5 && !site; y += 0.05) {
    const w: LngLat = [x, y], e: LngLat = [x + 0.02, y];
    if (!terr.isBarrier(w) && terr.isBarrier([x + 0.01, y]) && !terr.isBarrier(e) && sim.side(w) === 0 && sim.side(e) === 0 && !sim.liberatedAt(w)) site = [w, e];
  }
  assert.ok(site, 'found a narrow river on our side');
  const [w, e] = site!;
  assert.equal(sim.apply('a', { type: 'build', def: 'bridge', pos: offsetKm(w, 0, 3), to: offsetKm(w, 0.5, 3) }).ok, false, 'a bridge must cross a river');
  assert.ok(sim.apply('a', { type: 'build', def: 'bridge', pos: w, to: e }).ok, 'a bridge across it');
  const bridge = sim.world.buildings.find((x) => x.def === 'bridge')!;
  run(sim, 30);
  assert.ok(bridge.progress < 1, 'it takes minutes to build');
  bridge.progress = 1;
  const inf = sim.spawnUnit('infantry', a, offsetKm(w, -0.2, 0));
  inf.fireMode = 'hold';
  assert.ok(sim.apply('a', { type: 'move', units: [inf.id], to: offsetKm(e, 0.3, 0), mode: 'direct' }).ok, 'a route over the bridge');
  run(sim, 40);
  assert.ok(distKm(inf.pos, offsetKm(e, 0.3, 0)) < 0.2, 'crossed the river on it');
  // two strike drones on it
  for (let k = 0; k < 4 && sim.world.buildings.includes(bridge); k++) {
    const dr = sim.spawnUnit('drone_shahed', b, offsetKm(bridge.pos, 6, 6));
    sim.apply('b', { type: 'move', units: [dr.id], to: bridge.pos });
    run(sim, 25);
  }
  assert.ok(!sim.world.buildings.includes(bridge), 'strike drones bring the bridge down');
  console.log('bridges ok');
}

// --- strike drones hit the aim point, and lock on to a target and follow it ---
{
  const sim = fresh({ peaceSeconds: 0 });
  const a = sim.player('a')!, b = sim.player('b')!;
  const hq = hqOf(sim, 'a');
  const aim = offsetKm(hq.pos, 20, 20);
  const dr = sim.spawnUnit('drone_liutyi', a, offsetKm(aim, -15, -8));
  sim.apply('a', { type: 'move', units: [dr.id], to: aim });
  let hitAt: LngLat | null = null;
  for (let i = 0; i < 800 && sim.world.units.includes(dr); i++) (sim.step(0.1), (hitAt = [dr.pos[0], dr.pos[1]]));
  assert.ok(hitAt && distKm(hitAt, aim) < 0.05, `explodes on the spot (${hitAt ? (distKm(hitAt, aim) * 1000).toFixed(0) : '?'} m off)`);
  // a moving truck, locked on
  const truck = sim.spawnUnit('truck', b, offsetKm(hq.pos, 30, 0));
  truck.path = [{ p: offsetKm(truck.pos, 0, 15), road: false, end: true }];
  const d2 = sim.spawnUnit('drone_liutyi', a, offsetKm(truck.pos, -12, 0));
  sim.apply('a', { type: 'move', units: [d2.id], to: truck.pos });
  assert.equal(d2.lockOn?.unit, truck.id, 'locked on');
  for (let i = 0; i < 800 && sim.world.units.includes(d2); i++) sim.step(0.1);
  assert.ok(truck.hp < sim.defs.u.get('truck')!.hp, 'it hit the moving truck');
  console.log('strike drone accuracy ok');
}

// --- railways: stations joined by track; trains haul big loads fast; a cut line stops them ---
{
  const sim = fresh();
  const a = sim.player('a')!;
  const hq = hqOf(sim, 'a');
  hq.storage!.metal = 50000;
  const station = (pos: LngLat, metal: number) => {
    const b = { ...hq, id: sim.world.nextId++, def: 'rail_station', hp: 900, pos, storage: { metal, fuel: 1000, ore: 0, ammo: 0 }, inside: [], course: null, upgrade: null };
    sim.world.buildings.push(b);
    return b;
  };
  // a straight stretch of dry ground on our side, ~50 km long (searching east–west)
  let A: LngLat | null = null, B: LngLat | null = null;
  const dry = (p: LngLat) => sim.isPlayableGround(p) && sim.side(p) === 0 && sim.terrainAt(p).id !== 'water' && !sim.liberatedAt(p);
  for (let y = 48.6; y < 50.5 && !A; y += 0.1) for (let x = 28; x < 34 && !A; x += 0.1) {
    const p: LngLat = [x, y], q = offsetKm(p, 50, 0);
    let ok = true;
    for (let k = 0; k <= 250 && ok; k++) ok = dry(offsetKm(p, k * 0.2, 0));
    if (ok) (A = p), (B = q);
  }
  assert.ok(A && B, 'found 50 km of dry ground');
  const sa = station(A!, 20000), sb = station(B!, 0);
  const mid = offsetKm(A!, 25, 0);
  assert.equal(sim.apply('a', { type: 'build', def: 'railway', pos: A!, to: B! }).ok, false, 'at most 40 km of track at once');
  assert.ok(sim.apply('a', { type: 'build', def: 'railway', pos: A!, to: mid }).ok);
  assert.ok(sim.apply('a', { type: 'build', def: 'railway', pos: offsetKm(mid, 0.5, 0), to: B! }).ok, 'ends within 1.5 km join up');
  for (const b of sim.world.buildings) if (b.def === 'railway') b.progress = 1;
  assert.ok(sim.railPath(0, A!, B!), 'the stations are connected');
  const train = sim.spawnUnit('train', a, A!);
  assert.equal(sim.apply('a', { type: 'move', units: [train.id], to: B! }).ok, false, 'trains only run routes');
  assert.equal(sim.apply('a', { type: 'setRoute', unit: train.id, fromBuilding: sa.id, toBuilding: hq.id }).ok, false, 'only between stations');
  assert.ok(sim.apply('a', { type: 'setRoute', unit: train.id, fromBuilding: sa.id, toBuilding: sb.id, resType: 'metal' }).ok);
  let t = 0;
  while ((sb.storage.metal ?? 0) < 1 && t < 1500) sim.step(0.1), t++;
  assert.ok(sb.storage.metal >= 19000, `a train load arrived (${Math.round(sb.storage.metal)})`);
  assert.ok(t / 10 < 70, `50 km in ${(t / 10).toFixed(0)} s (load and unload included)`);
  // cut the line: the train cannot go on
  const seg = sim.world.buildings.find((b) => b.def === 'railway')!;
  seg.hp = 0;
  run(sim, 3);
  sa.storage.metal = 20000;
  run(sim, 30);
  assert.ok(train.haul?.noTrack || train.haul?.state !== 'moving' || !sim.railPath(0, train.pos, A!), 'no connection: it waits');
  assert.equal(sim.railPath(0, A!, B!), null, 'the network is cut');
  console.log(`railways ok: 50 km in ${(t / 10).toFixed(0)} s with 20,000 metal`);
}

// --- launchers, rally points and repeat production ---
{
  const sim = fresh({ peaceSeconds: 0, trainTimeMult: 0.05 });
  const a = sim.player('a')!;
  const hq = hqOf(sim, 'a');
  const site = (def: string, dx: number, storage?: Record<string, number>) => {
    const b = { ...hq, id: sim.world.nextId++, def, hp: 600, pos: offsetKm(hq.pos, dx, -6), storage, inside: [], course: null, upgrade: null };
    sim.world.buildings.push(b);
    return b;
  };
  const df = site('drone_factory', 10, { metal: 5000, fuel: 5000 });
  sim.apply('a', { type: 'train', building: df.id, unit: 'drone_liutyi' });
  run(sim, 2);
  const d1 = sim.world.units.find((u) => u.def === 'drone_liutyi')!;
  assert.equal(d1.parkedAt, df.id, 'no launch site yet: it waits at the factory');
  assert.equal(sim.apply('a', { type: 'move', units: [d1.id], to: offsetKm(hq.pos, 30, 30) }).ok, false, 'it cannot just fly off');
  const ls = site('launch_site', 20);
  run(sim, 3);
  assert.equal(d1.parkedAt, ls.id, 'delivered to the new launch site');
  const af = site('airfield', 30, { fuel: 1000 });
  sim.apply('a', { type: 'train', building: df.id, unit: 'drone_pd2' });
  run(sim, 2);
  const rec = sim.world.units.find((u) => u.def === 'drone_pd2')!;
  assert.equal(rec.parkedAt, af.id, 'recon drones go to the airfield');
  assert.equal(sim.apply('a', { type: 'launchFrom', building: ls.id, units: [rec.id], target: hq.pos }).ok, false, 'not from the launch site');
  assert.ok(sim.apply('a', { type: 'launchFrom', building: ls.id, units: [d1.id], target: offsetKm(hq.pos, 40, 10) }).ok);
  assert.ok(d1.parkedAt === undefined && d1.path.length > 0, 'launched');
  // rally point and repeat
  assert.ok(sim.apply('a', { type: 'rally', building: hq.id, pos: offsetKm(hq.pos, 5, 5) }).ok);
  assert.ok(sim.apply('a', { type: 'repeat', building: hq.id, unit: 'infantry' }).ok);
  const before = sim.world.units.filter((u) => u.def === 'infantry').length;
  run(sim, 6);
  const fresh2 = sim.world.units.filter((u) => u.def === 'infantry').slice(before);
  assert.ok(fresh2.length >= 2, `repeat keeps training (${fresh2.length} new)`);
  assert.ok(fresh2.every((u) => u.path.length || distKm(u.pos, offsetKm(hq.pos, 5, 5)) < 0.6), 'new units head for the rally point');
  a.res.money = 0;
  const n = sim.world.units.length;
  run(sim, 4);
  assert.ok(sim.world.units.length <= n + 1, 'no money, no more');
  console.log('launchers, rally points, repeat ok');
}

// --- bunkers: a garrison fires out, cannot be hit until it falls; shelled it dies, stormed it stumbles out shaken ---
{
  const mkBunker = (sim: Sim) => {
    const hq = hqOf(sim, 'a');
    const b = { ...hq, id: sim.world.nextId++, def: 'bunker', hp: 1400, pos: offsetKm(hq.pos, 20, 0), storage: undefined, inside: [], course: null, upgrade: null };
    sim.world.buildings.push(b);
    return b;
  };
  const sim = fresh({ peaceSeconds: 0 });
  const a = sim.player('a')!, b = sim.player('b')!;
  const bunker = mkBunker(sim);
  const men = [sim.spawnUnit('infantry', a, offsetKm(bunker.pos, 0.5, 0)), sim.spawnUnit('infantry_assault', a, offsetKm(bunker.pos, 0, 0.5))];
  const tank = sim.spawnUnit('tank', a, offsetKm(bunker.pos, 0, -0.5));
  assert.ok(sim.apply('a', { type: 'enter', units: [...men, tank].map((u) => u.id), building: bunker.id }).ok);
  run(sim, 15);
  assert.equal(bunker.inside.length, 2, 'the two squads on foot went in (not the tank)');
  tank.hp = 0;
  run(sim, 0.2);
  const foe = sim.spawnUnit('infantry', b, offsetKm(bunker.pos, 0.8, 0));
  foe.hp = 1e6;
  run(sim, 5);
  assert.ok(foe.hp < 1e6, 'the garrison fires out of the bunker');
  assert.ok(bunker.hp < 1400, 'the enemy can only hit the bunker');
  assert.ok(men.every((u) => u.hp === sim.maxHp(u)), 'the men inside are untouched');
  // shelled down: the garrison dies with it
  bunker.hp = 1;
  const gun = sim.spawnUnit('artillery', b, offsetKm(bunker.pos, 8, 0));
  (sim as any).blast(gun, bunker.pos, 1, 500, false);
  run(sim, 0.2);
  assert.ok(!sim.world.buildings.includes(bunker), 'the bunker fell');
  assert.ok(men.every((u) => !sim.world.units.includes(u)), 'shelled: the garrison is lost');
  // stormed: they come out shaken
  const sim2 = fresh({ peaceSeconds: 0 });
  const b2 = mkBunker(sim2);
  const sq = sim2.spawnUnit('infantry', sim2.player('a')!, offsetKm(b2.pos, 0.3, 0));
  sim2.apply('a', { type: 'enter', units: [sq.id], building: b2.id });
  run(sim2, 10);
  assert.equal(b2.inside.length, 1);
  b2.hp = 1;
  const rifle = sim2.spawnUnit('infantry', sim2.player('b')!, offsetKm(b2.pos, 0.6, 0));
  rifle.hp = 1e6;
  run(sim2, 3);
  assert.ok(!sim2.world.buildings.includes(b2) && sim2.world.units.includes(sq), 'stormed: the squad comes out alive');
  assert.ok(sq.status.some(([id]) => id === 'suppressed'), 'shaken for a few seconds');
  console.log('bunkers ok');
}

// --- crowding: stacking battalions in one spot is penalised ---
{
  const sim = fresh();
  const a = sim.player('a')!;
  const hq = hqOf(sim, 'a');
  const at = offsetKm(hq.pos, 25, 0);
  const few = Array.from({ length: 5 }, (_, i) => sim.spawnUnit('infantry', a, offsetKm(at, i * 0.1, 0)));
  run(sim, 1);
  assert.equal(sim.crowdOver(few[0]), 0, 'five together: fine');
  const mass = Array.from({ length: 20 }, (_, i) => sim.spawnUnit('infantry', a, offsetKm(at, (i % 5) * 0.1, 0.2 + Math.floor(i / 5) * 0.1)));
  run(sim, 1);
  const u = mass[0];
  assert.ok(sim.crowdOver(u) >= 15, `a crowd of ${u.crowd}`);
  assert.ok(sim.crowdDealt(u) <= 0.25 + 0.5 && sim.crowdTaken(u) >= 1.9, 'deals much less, takes much more');
  assert.ok(u.status.some(([id]) => id === 'crowded'), 'shown as crowded');
  console.log(`crowding ok: ${u.crowd} together → ×${sim.crowdDealt(u).toFixed(2)} dealt, ×${sim.crowdTaken(u).toFixed(2)} taken`);
}

// --- medics and mechanics work only out of the fight ---
{
  const sim = fresh();
  const a = sim.player('a')!, b = sim.player('b')!;
  const hq = hqOf(sim, 'a');
  const at = offsetKm(hq.pos, 22, 0);
  const inf = sim.spawnUnit('infantry', a, at);
  inf.hp = 40;
  inf.fireMode = 'hold';
  const medic = sim.spawnUnit('medic', a, offsetKm(at, 0.5, 0));
  const foe = sim.spawnUnit('infantry', b, offsetKm(medic.pos, 2.5, 0)); // within 3 km of the medic
  (foe.fireMode = 'hold'), (foe.hp = 1e6);
  run(sim, 5);
  assert.equal(inf.hp, 40, 'an enemy close by: the medic does not work');
  foe.hp = 0;
  run(sim, 5);
  assert.ok(inf.hp > 40, 'once it is gone, healing starts');
  console.log('healers out of the fight ok');
}
