// Stress benchmark: 1,500 extra units along the front, tick and snapshot cost (npm run bench).
import { fileURLToPath } from 'node:url';
import { loadRuleset } from '../../../services/game/src/infrastructure/modLoader';
import { offsetKm, Sim, snapshotFor, type LngLat } from '../src';
const rs = await loadRuleset(fileURLToPath(new URL('../../../mods', import.meta.url)));
const slots = Array.from({ length: 16 }, (_, i) => ({ id: 'p' + i, name: 'p' + i, team: (i % 2) as 0 | 1, bot: i > 0 }));
const sim = new Sim(rs, 'ukraine', slots);
const f = sim.world.front;
const kinds = ['infantry', 'infantry', 'tank', 'infantry_assault', 'artillery', 'apc'];
for (let i = 0; i < 1500; i++) {
  const n = f[Math.floor((i / 1500) * (f.length - 2)) + 1];
  const team = (i % 2) as 0 | 1;
  const p = sim.player('p' + (team === 0 ? 2 * (i % 8) : 2 * (i % 8) + 1))!;
  const off = (team === 0 ? -1 : 1) * (3 + (i % 5));
  const pos: LngLat = offsetKm([n.lng, n.lat], off * 0.7, off * 0.7);
  sim.spawnUnit(kinds[i % kinds.length], p, pos);
}
const proto = Sim.prototype as any;
const timed: Record<string, number> = {};
for (const name of ['liberation', 'frontline', 'units', 'territory', 'economy', 'refreshStatus', 'healing', 'morale', 'breakthrough', 'greyZones']) {
  const fn = proto[name];
  proto[name] = function (...a: any[]) { const t = performance.now(); const r = fn.apply(this, a); timed[name] = (timed[name] ?? 0) + performance.now() - t; return r; };
}
const N = 600;
let snapT = 0, size = 0;
const t0 = performance.now();
for (let t = 1; t <= N; t++) {
  sim.step(0.1);
  if (t % 2 === 0) { const a = performance.now(); size += JSON.stringify(snapshotFor(sim, 'p0', 0, sim.shots.splice(0))).length; snapT += performance.now() - a; }
}
console.log(`${sim.world.units.length} units: ${((performance.now() - t0 - snapT) / N).toFixed(2)} ms/tick, snapshot ${(snapT / (N / 2)).toFixed(1)} ms, ${(size / (N / 2) / 1024).toFixed(0)} KB`);
for (const [k, v] of Object.entries(timed).sort((a, b) => b[1] - a[1])) console.log('  ', k.padEnd(14), (v / N).toFixed(2), 'ms/tick');
