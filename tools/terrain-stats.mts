// Prints how much of each map's water counts as a movement barrier.
import { loadRuleset } from '../services/game/src/infrastructure/modLoader';
import { TerrainGrid } from '../packages/core/src';
const rs = await loadRuleset(new URL('../mods', import.meta.url).pathname);
const barriers: Record<string, number> = {};
for (const t of rs.terrain) if (t.barrier) barriers[t.id] = t.barrier.minCells;
for (const m of rs.maps) {
  if (!m.terrain) continue;
  const t0 = Date.now();
  const g = new TerrainGrid(m.terrain, barriers);
  const w = g.ids.indexOf('water');
  let water = 0, barrier = 0;
  for (let i = 0; i < g.cells.length; i++) {
    if (g.kindAt(i) === w) water++;
    if (g.cells[i] & 0x80) barrier++;
  }
  console.log(m.id, 'water cells', water, 'barrier cells', barrier, `(${Date.now() - t0} ms)`);
  for (const [name, p] of Object.entries({ dnipro_at_zaporizhzhia: [35.09, 47.84], dnipro_kherson: [32.6, 46.6], black_sea: [31.5, 45.5], field_poltava: [34.55, 49.4], oskil_reservoir: [37.45, 49.3], siverskyi_donets: [37.6, 49.0] })) console.log('  ', name, g.at(p as [number, number]), g.isBarrier(p as [number, number]));
}
