// Game modes and the features added with them: ceasefire, sandbox, closed buildings, missiles, drones on pickups.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { distKm, offsetKm, Sim, type LngLat, type RulesConfig, type Team } from '../src';

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
