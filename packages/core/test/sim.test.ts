import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { Bot } from '../../../services/game/src/application/bot';
import { Sim, type SlotInit } from '../src';

const rs = await loadRuleset(new URL('../../../mods', import.meta.url).pathname);
const slots: SlotInit[] = [];
for (let t = 0; t < 2; t++) for (let i = 0; i < 8; i++) slots.push({ id: `b${t}${i}`, name: `bot${t}${i}`, team: t as 0 | 1, bot: true });
const sim = new Sim(rs, 'zaporizhzhia', slots);
const bots = slots.map((s) => new Bot(s.id));
const front0 = sim.world.front.map((n) => n.lng);
const t0 = Date.now();
for (let i = 0; i < 10 * 1200 && sim.world.winner === null; i++) {
  bots.forEach((b) => b.think(sim));
  sim.step(0.1);
  if (i % 3000 === 0) report(i / 10);
}
report(sim.world.time);
function report(t: number) {
  const w = sim.world;
  const shift = w.front.reduce((a, n, i) => a + (n.lng - front0[i]), 0) / w.front.length;
  console.log(`t=${t.toFixed(0)}s buildings=${w.buildings.length} units=${w.units.length} avgFrontShift=${shift.toFixed(3)}° points=${w.points.map((p) => p.owner).join('')} scores=${w.scores.map(Math.round)} winner=${w.winner} ${w.winReason ?? ''}`);
}
console.log(`wall ${Date.now() - t0}ms`);
const bad = sim.world.players.some((p) => Object.values(p.res).some((v) => !Number.isFinite(v) || v < 0));
if (bad) throw new Error('invalid resources');
