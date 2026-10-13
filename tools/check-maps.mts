import { loadRuleset } from '../services/game/src/infrastructure/modLoader';
import { buildFront, distToFrontKm, TerrainGrid } from '../packages/core/src';
const rs = await loadRuleset(new URL('../mods', import.meta.url).pathname);
for (const m of rs.maps) {
  const f = buildFront(m.front, 9);
  const tg = m.terrain ? new TerrainGrid(m.terrain) : null;
  console.log(m.id, 'nodes', f.length);
  console.log(' points:', m.capturePoints.map((c) => `${c.id}:${distToFrontKm(f, c.pos).toFixed(0)}${tg ? tg.at(c.pos)[0] : ''}`).join(' '));
  console.log(' value by side:', [0, 1].map((t) => m.capturePoints.filter((c) => (distToFrontKm(f, c.pos) >= 0 ? 0 : 1) === t).reduce((a, c) => a + c.value, 0)).join(' / '));
  m.spawns.forEach((s, t) => console.log(' spawn', t, s.map((p) => `${distToFrontKm(f, p).toFixed(0)}${tg ? tg.at(p)[0] : ''}`).join(' ')));
}
