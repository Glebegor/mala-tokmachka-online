import { fileURLToPath } from 'node:url';
// Training centre flow, rivers and waypoints, checked against the real base mod.
import assert from 'node:assert/strict';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { distKm, offsetKm, Sim, type LngLat } from '../src';

const rs = await loadRuleset(fileURLToPath(new URL('../../../mods', import.meta.url)));
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
assert.equal(terms.perSecond, 4, '4 recruits x 0.1 per tick x 10 ticks/s');
assert.ok(sim.apply('a', { type: 'course', building: tc.id }).ok);
assert.equal(me.res.money, money, 'nothing is charged up front');
assert.equal(sim.apply('a', { type: 'release', building: tc.id }).ok, false, 'locked in during the course');
run(terms.seconds - 2);
assert.equal(tc.inside.length, 4, 'still training');
run(4);
assert.equal(tc.inside.length, 0, 'class graduated');
assert.ok(squad.every((u) => u.rank === 1 && sim.world.units.includes(u)), 'everyone is one rank up and back on the map');
// add back what the economy earned meanwhile; what is left over is the tuition
const paid = money - me.res.money + (terms.seconds + 2) * (sim.income.get('a')?.money ?? 0);
assert.ok(Math.abs(paid - terms.perSecond * terms.seconds) < 6, `tuition was paid as it ran (${paid.toFixed(0)})`);
assert.equal(terms.seconds, 75, 'a course to Regular takes 75 s');
// above Recruit a course needs combat: a kill since the last course
const fresh = sim.apply('a', { type: 'enter', units: squad.map((u) => u.id), building: tc.id });
assert.equal(fresh.ok, false, 'regulars without a kill are turned away');
assert.match(fresh.ok ? '' : fresh.reason, /kill/);
squad[1].combat = 1;
assert.ok(sim.apply('a', { type: 'enter', units: squad.map((u) => u.id), building: tc.id }).ok, 'one with a kill may go');
assert.deepEqual(sim.world.units.filter((u) => u.enter === tc.id).map((u) => u.id), [squad[1].id], 'only that one');
assert.ok(sim.ranks[2].damage >= 1.4, 'veterans hit much harder');
console.log(`training ok: 4 units, ${terms.seconds}s, ${terms.perSecond}/s while running, ~${paid.toFixed(0)} money in total; rank 2+ needs a kill`);

// --- waypoints ---
const scout = squad[0];
// pick a direction with open ground for both legs (the map has rivers everywhere)
const open = (a: LngLat, b: LngLat) => (sim as any).lineClear(a, b, []) as boolean;
let p1: LngLat = scout.pos, p2: LngLat = scout.pos;
for (let k = 0; k < 16; k++) {
  const ang = (k / 16) * Math.PI * 2;
  p1 = offsetKm(scout.pos, 3 * Math.cos(ang), 3 * Math.sin(ang));
  p2 = offsetKm(p1, -3 * Math.sin(ang), 3 * Math.cos(ang));
  if (open(scout.pos, p1) && open(p1, p2)) break;
}
sim.apply('a', { type: 'move', units: [scout.id], to: p1 });
sim.apply('a', { type: 'move', units: [scout.id], to: p2, queue: true });
assert.equal(scout.path.filter((w) => w.end).length, 2, 'two queued orders');
run(120);
assert.ok(distKm(scout.pos, p2) < 0.5, `reached the last waypoint (${distKm(scout.pos, p2).toFixed(2)} km off, ${scout.path.length} legs left, on ${sim.terrainAt(scout.pos).id}, enter=${scout.enter}, hp=${scout.hp.toFixed(0)}, alive=${sim.world.units.includes(scout)})`);

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

// --- cauldron: a salient whose neck is closed becomes a pocket, the troops inside are cut off and finally lost ---
{
  const s2 = new Sim(rs, 'zaporizhzhia', [
    { id: 'a', name: 'a', team: 0, bot: false },
    { id: 'b', name: 'b', team: 1, bot: false },
  ]);
  const f = s2.world.front;
  const k = Math.floor(f.length / 2) - 4;
  const neck: LngLat = [f[k].lng, f[k].lat];
  // the front runs south→north with team 0 on the west. Bend nodes k+1..k+7 into a loop bulging east (into team 1's
  // ground), walked counter-clockwise, whose two ends (the jaws) are only ~2 km apart.
  const centre: LngLat = [neck[0] + 0.22, neck[1]];
  for (let i = 1; i <= 7; i++) {
    const ang = ((-160 + ((i - 1) * 320) / 6) * Math.PI) / 180;
    f[k + i].lng = centre[0] + 0.2 * Math.cos(ang);
    f[k + i].lat = centre[1] + 0.13 * Math.sin(ang);
  }
  (f[k].lng = neck[0]), (f[k].lat = neck[1] - 0.01);
  (f[k + 8].lng = neck[0]), (f[k + 8].lat = neck[1] + 0.01);
  const p0 = s2.player('a')!;
  const victim = s2.spawnUnit('infantry', p0, centre);
  assert.equal(s2.side(centre), 0, 'the salient is team 0 ground before it is cut off');
  for (let i = 0; i < 10; i++) s2.step(0.1);
  assert.equal(s2.world.pockets.length, 1, 'neck closed: a cauldron forms');
  assert.equal(s2.world.pockets[0].team, 0, 'team 0 is the one encircled');
  assert.equal(s2.side(centre), 0, 'ground inside still belongs to the encircled side');
  assert.ok(victim.encircled, 'unit inside is flagged as encircled');
  const hp = victim.hp;
  for (let i = 0; i < 100; i++) s2.step(0.1);
  assert.ok(victim.hp < hp, 'encircled units lose strength');
  // squeeze the pocket shut
  for (const n of s2.world.pockets[0]?.nodes ?? []) (n.lng = centre[0] + (n.lng - centre[0]) * 0.1), (n.lat = centre[1] + (n.lat - centre[1]) * 0.1);
  for (let i = 0; i < 20; i++) s2.step(0.1);
  assert.equal(s2.world.pockets.length, 0, 'squeezed pocket collapses');
  assert.equal(s2.world.units.includes(victim), false, 'the garrison is lost');
  assert.equal(s2.side(centre), 1, 'the ground goes to the besiegers');
  console.log('cauldron ok: formed, drained, collapsed');
}

// --- fortifications of one kind do not stack; upgrades do; grey zone after 10 s unopposed behind the line ---
{
  const s3 = new Sim(rs, 'zaporizhzhia', [
    { id: 'a', name: 'a', team: 0, bot: false },
    { id: 'b', name: 'b', team: 1, bot: false },
  ]);
  const a = s3.player('a')!;
  Object.keys(a.res).forEach((k) => (a.res[k] = 9000));
  const hq3 = s3.world.buildings.find((b) => b.owner === 'a')!;
  const hold = (p: LngLat) => (s3 as any).holdMult(0, p) as number;
  const spots = [offsetKm(hq3.pos, 2, 0), offsetKm(hq3.pos, -2, 0), offsetKm(hq3.pos, 0, 2), offsetKm(hq3.pos, 0, -2)];
  // two trench lines drawn either side of the base: both cover it, but they count as one
  assert.ok(s3.apply('a', { type: 'build', def: 'trench', pos: offsetKm(hq3.pos, -1.5, 0.6), to: offsetKm(hq3.pos, 1.5, 0.6) }).ok);
  assert.ok(s3.apply('a', { type: 'build', def: 'trench', pos: offsetKm(hq3.pos, -1.5, -0.6), to: offsetKm(hq3.pos, 1.5, -0.6) }).ok);
  assert.equal(s3.apply('a', { type: 'build', def: 'trench', pos: hq3.pos, to: offsetKm(hq3.pos, 12, 0) }).ok, false, 'at most 10 km in one go');
  const t1 = s3.world.buildings.find((b) => b.def === 'trench')!;
  assert.ok(t1.line && Math.abs((t1.size ?? 0) - 3) < 0.05, 'a 3 km line');
  assert.ok(Math.abs(s3.reachKm(t1, offsetKm(hq3.pos, 0, 1.6)) - 1) < 0.05, 'cover is measured from the line');
  for (let i = 0; i < 200; i++) s3.step(0.1); // 3 km at 6 s a km
  assert.equal(hold(hq3.pos).toFixed(2), '1.25', 'two trenches count as one');
  assert.ok(s3.apply('a', { type: 'build', def: 'bunker', pos: spots[2] }).ok);
  assert.ok(s3.apply('a', { type: 'build', def: 'bunker', pos: spots[3] }).ok);
  for (let i = 0; i < 200; i++) s3.step(0.1);
  assert.equal(hold(hq3.pos).toFixed(2), '1.85', 'trench + bunker add up, the second bunker does not');
  const trench = s3.world.buildings.find((b) => b.def === 'trench')!;
  assert.ok(s3.apply('a', { type: 'upgrade', building: trench.id }).ok);
  assert.equal(s3.apply('a', { type: 'upgrade', building: trench.id }).ok, false, 'one upgrade at a time');
  for (let i = 0; i < 110; i++) s3.step(0.1);
  assert.equal(trench.level, 2);
  assert.equal(hold(hq3.pos).toFixed(2), '2.00', 'upgraded trench gives +40%');
  assert.equal(trench.hp, 450, 'upgrade raises hit points');

  // grey zone: a lone unit sits 12 km behind the enemy line
  const front = s3.world.front[Math.floor(s3.world.front.length / 2)];
  const behind: LngLat = offsetKm([front.lng, front.lat], 12, 0);
  assert.equal(s3.side(behind), 1);
  s3.world.units = s3.world.units.filter((u) => u.team === 0); // nobody to oppose it
  const raider = s3.spawnUnit('infantry', a, behind);
  for (let i = 0; i < 80; i++) s3.step(0.1);
  assert.equal(s3.world.grey.length, 0, 'not yet: needs 10 s');
  for (let i = 0; i < 40; i++) s3.step(0.1);
  assert.equal(s3.world.grey.length, 1, 'grey zone appears after 10 s unopposed');
  assert.equal(s3.apply('a', { type: 'build', def: 'trench', pos: behind }).ok, false, 'no building in contested ground');
  raider.hp = 0;
  for (let i = 0; i < 230; i++) s3.step(0.1);
  assert.equal(s3.world.grey.length, 0, 'zone fades 20 s after the troops are gone');
  console.log('fortifications + grey zone ok');
}
