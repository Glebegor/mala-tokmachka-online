import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { Bot } from '../../../services/game/src/application/bot';
import { distToFrontKm, Sim, type LngLat, type SlotInit } from '../src';

const rs = await loadRuleset(new URL('../../../mods', import.meta.url).pathname);
const slots: SlotInit[] = [];
for (let t = 0; t < 2; t++) for (let i = 0; i < 8; i++) slots.push({ id: `b${t}${i}`, name: `bot${t}${i}`, team: t as 0 | 1, bot: true });
const sim = new Sim(rs, process.argv[2] ?? 'ukraine', slots);
const bots = slots.map((s) => new Bot(s.id));
const front0 = sim.world.front.map((n) => [n.lng, n.lat]);
let shots = 0;
const t0 = Date.now();
for (let i = 0; i < 10 * 1200 && sim.world.winner === null; i++) {
  bots.forEach((b) => b.think(sim));
  sim.step(0.1);
  shots += sim.shots.length;
  sim.shots = [];
  if (i % 3000 === 0) report(i / 10);
}
report(sim.world.time);
function report(t: number) {
  const w = sim.world;
  const shift = front0.reduce((a, p) => a + Math.abs(distToFrontKm(w.front, p as LngLat)), 0) / front0.length;
  const wet = w.units.filter((u) => sim.defs.u.get(u.def)!.kind !== 'air' && !(u.path[0]?.road) && sim.terrain?.isBarrier(u.pos) && !w.buildings.some((b) => b.team === u.team && sim.defs.b.get(b.def)!.crossing)).length;
  const moving = w.units.filter((u) => u.path.length).length;
  const transport = w.units.filter((u) => u.transport).length;
  const school = w.buildings.reduce((a, b) => a + b.inside.length, 0);
  const ranks = [0, 1, 2, 3, 4].map((r) => w.units.filter((u) => u.rank === r).length).join('/');
  console.log(`t=${t.toFixed(0)}s buildings=${w.buildings.length} units=${w.units.length} nodes=${w.front.length} avgFrontShift=${shift.toFixed(1)}km moving=${moving} transport=${transport} inSchool=${school} inRiver=${wet} shots=${shots} ranks=${ranks} points=${w.points.map((p) => p.owner).join('')} scores=${w.scores.map(Math.round)} winner=${w.winner} ${w.winReason ?? ''}`);
}
console.log(`wall ${Date.now() - t0}ms`);
const bad = sim.world.players.some((p) => Object.values(p.res).some((v) => !Number.isFinite(v) || v < 0));
if (bad) throw new Error('invalid resources');
if (sim.world.front.some((n) => !Number.isFinite(n.lng) || !Number.isFinite(n.lat))) throw new Error('front has NaN');
if (sim.world.units.some((u) => !Number.isFinite(u.pos[0]) || !Number.isFinite(u.pos[1]))) throw new Error('unit position NaN');
