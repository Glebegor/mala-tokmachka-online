// Training centre flow, rivers and waypoints, checked against the real base mod.
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { distKm, offsetKm, Sim, type LngLat } from '../src';

const rs = await loadRuleset(new URL('../../../mods', import.meta.url).pathname);
const sim = new Sim(rs, 'ukraine', [
  { id: 'a', name: 'a', team: 0, bot: false },
  { id: 'b', name: 'b', team: 1, bot: false },
]);
const run = (sec: number) => {
  for (let i = 0; i < sec * 10; i++) sim.step(0.1);
};
const me = sim.player('a')!;
Object.keys(me.res).forEach((k) => (me.res[k] = 5000));
const hq = sim.world.buildings.find((b) => b.owner === 'a')!;
const mine = () => sim.world.units.filter((u) => u.owner === 'a' && u.def === 'infantry');

// --- training centre ---
let spot: LngLat = hq.pos;
for (let k = 1; k < 40; k++) {
  spot = offsetKm(hq.pos, 3 + k, 2);
  if (sim.apply('a', { type: 'build', def: 'training_center', pos: spot }).ok) break;
}
const tc = sim.world.buildings.find((b) => b.def === 'training_center')!;
assert.ok(tc, 'training centre placed');
run(rs.buildings.find((b) => b.id === 'training_center')!.buildTime + 1);
assert.equal(tc.progress, 1);

const squad = mine().slice(0, 4);
assert.equal(sim.apply('a', { type: 'course', building: tc.id }).ok, false, 'no course with an empty centre');
assert.ok(sim.apply('a', { type: 'enter', units: squad.slice(0, 2).map((u) => u.id), building: tc.id }).ok);
run(400);
assert.equal(tc.inside.length, 2, 'two units walked in');
assert.equal(sim.world.units.includes(squad[0]), false, 'units inside are off the map');
const two = sim.apply('a', { type: 'course', building: tc.id });
assert.equal(two.ok, false, 'needs at least 3');
assert.ok(sim.apply('a', { type: 'enter', units: squad.slice(2).map((u) => u.id), building: tc.id }).ok);
run(400);
assert.equal(tc.inside.length, 4);
const money = me.res.money;
const terms = sim.courseTerms(tc);
assert.ok(sim.apply('a', { type: 'course', building: tc.id }).ok);
assert.equal(me.res.money, money - terms.cost.money, 'course is paid for');
assert.equal(sim.apply('a', { type: 'release', building: tc.id }).ok, false, 'locked in during the course');
run(terms.seconds - 2);
assert.equal(tc.inside.length, 4, 'still training');
run(4);
assert.equal(tc.inside.length, 0, 'class graduated');
assert.ok(squad.every((u) => u.rank === 1 && sim.world.units.includes(u)), 'everyone is one rank up and back on the map');
console.log(`training ok: 4 units, ${terms.seconds}s, cost ${JSON.stringify(terms.cost)}`);

// --- waypoints ---
const scout = squad[0];
const p1 = offsetKm(scout.pos, 3, 0), p2 = offsetKm(scout.pos, 3, 3);
sim.apply('a', { type: 'move', units: [scout.id], to: p1 });
sim.apply('a', { type: 'move', units: [scout.id], to: p2, queue: true });
assert.equal(scout.path.filter((w) => w.end).length, 2, 'two queued orders');
run(120);
assert.ok(distKm(scout.pos, p2) < 0.5, 'reached the last waypoint');

// --- rivers: no walking through the Dnipro, bridges and pontoons only ---
const west: LngLat = [33.25, 46.95], east: LngLat = [33.6, 46.6]; // either side of the lower Dnipro
assert.ok(!sim.terrain!.isBarrier(west) && !sim.terrain!.isBarrier(east));
const swimmer = sim.spawnUnit('infantry', me, west);
sim.apply('a', { type: 'move', units: [swimmer.id], to: east, mode: 'direct' });
let wet = 0;
for (let i = 0; i < 3000 && swimmer.path.length; i++) {
  sim.step(0.1);
  if (sim.terrain!.isBarrier(swimmer.pos) && !swimmer.path[0]?.road) wet++;
}
assert.equal(wet, 0, 'never in the river off a bridge');
console.log(`river ok: unit ${swimmer.path.length ? 'still driving round' : distKm(swimmer.pos, east) < 1 ? 'arrived by bridge' : 'stopped on the near bank'}`);
