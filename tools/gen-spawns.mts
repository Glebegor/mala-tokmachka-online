// Generates mirrored spawn pairs for a map: N positions along the front, each side set back the same distance and
// snapped to the road network on dry land. usage: tsx tools/gen-spawns.mts <mapId> <count> <setbackKm> [fromFrac] [toFrac]
import { loadRuleset } from '../services/game/src/infrastructure/modLoader';
import { buildFront, distKm, distToFrontKm, normalAt, offsetKm, RoadNetwork, TerrainGrid, type LngLat } from '../packages/core/src';

const [mapId, countArg, setbackArg, fromArg, toArg] = process.argv.slice(2);
const rs = await loadRuleset(new URL('../mods', import.meta.url).pathname);
const map = rs.maps.find((m) => m.id === mapId)!;
const count = Number(countArg), setback = Number(setbackArg);
const front = buildFront(map.front, 4);
const roads = map.roads ? new RoadNetwork(map.roads) : null;
const terrain = map.terrain ? new TerrainGrid(map.terrain, { water: 1500 }) : null;
const lo = Number(fromArg ?? 0.1), hi = Number(toArg ?? 0.95);

/** Best spot for one side: on a road, dry, and as close as possible to the wanted setback. */
function place(i: number, side: 1 | -1): { p: LngLat; d: number } {
  const node = front[i];
  const [nx, ny] = normalAt(front, i);
  const ideal = offsetKm([node.lng, node.lat], -nx * setback * side, -ny * setback * side);
  let best: { p: LngLat; d: number; score: number } | null = null;
  const consider = (p: LngLat) => {
    const d = distToFrontKm(front, p) * side;
    if (d < setback * 0.8 || ['water', 'mountain'].includes(terrain?.at(p) ?? '')) return;
    const score = Math.abs(d - setback) + distKm(p, ideal) * 0.15;
    if (!best || score < best.score) best = { p, d, score };
  };
  if (roads) for (const n of roads.nodes) if (distKm(n, ideal) < 45) consider(n);
  if (!best) consider(ideal);
  if (!best) throw new Error(`no dry spot for spawn ${i}`);
  const b = best as { p: LngLat; d: number };
  return { p: [Math.round(b.p[0] * 1000) / 1000, Math.round(b.p[1] * 1000) / 1000], d: b.d };
}

const out: [LngLat[], LngLat[]] = [[], []];
const report: string[] = [];
for (let k = 0; k < count; k++) {
  const i = Math.round((lo + ((hi - lo) * k) / (count - 1)) * (front.length - 1));
  const a = place(i, 1), b = place(i, -1);
  out[0].push(a.p);
  out[1].push(b.p);
  report.push(`${a.d.toFixed(0)}/${b.d.toFixed(0)}`);
}
console.error('setback km (team0/team1):', report.join(' '));
console.log(JSON.stringify(out));
