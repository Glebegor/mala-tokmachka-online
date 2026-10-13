import { fileURLToPath } from 'node:url';
import { loadRuleset } from '../services/game/src/infrastructure/modLoader';
import { buildFront, distToFrontKm, TerrainGrid } from '../packages/core/src';
const rs = await loadRuleset(fileURLToPath(new URL('../mods', import.meta.url)));
for (const m of rs.maps) {
  const f = buildFront(m.front, 9);
  const tg = m.terrain ? new TerrainGrid(m.terrain) : null;
  console.log(m.id, 'nodes', f.length);
  console.log(' points:', m.capturePoints.map((c) => `${c.id}:${distToFrontKm(f, c.pos).toFixed(0)}${tg ? tg.at(c.pos)[0] : ''}`).join(' '));
  m.spawns.forEach((s, t) => console.log(' spawn', t, s.map((p) => `${distToFrontKm(f, p).toFixed(0)}${tg ? tg.at(p)[0] : ''}`).join(' ')));
}
