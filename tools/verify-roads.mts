import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../packages/core/src/roads';

const lines = JSON.parse(readFileSync('mods/base/maps/ukraine.roads.json', 'utf8'));
console.log('Testing RoadNetwork with', lines.length, 'lines...');
const t0 = Date.now();
const net = new RoadNetwork(lines, 4);
const t1 = Date.now();
console.log(`RoadNetwork created in ${t1 - t0}ms, nodes: ${net.size}`);
const comps = net.components();
console.log('Top 5 component sizes:', comps.slice(0, 5));

// Test routing between Kyiv [30.52, 50.45] and Poltava [34.55, 49.58]
const pKyiv: [number, number] = [30.52, 50.45];
const pPoltava: [number, number] = [34.55, 49.58];
const seen = new Int32Array(net.size).fill(-1);
let compId = 0;
for (let i = 0; i < net.size; i++) {
  if (seen[i] >= 0) continue;
  const stack = [i];
  seen[i] = compId;
  while (stack.length) {
    const c = stack.pop()!;
    for (const e of (net as any).adj[c]) {
      if (seen[e.to] < 0) {
        seen[e.to] = compId;
        stack.push(e.to);
      }
    }
  }
  compId++;
}

const cities: [string, [number, number]][] = [
  ['Kyiv', [30.52, 50.45]],
  ['Poltava', [34.55, 49.58]],
  ['Kharkiv', [36.23, 49.99]],
  ['Dnipro', [35.04, 48.46]],
  ['Zaporizhzhia', [35.14, 47.84]],
  ['Lviv', [24.03, 49.84]],
  ['Odesa', [30.73, 46.48]],
  ['Kherson', [32.62, 46.64]],
  ['Nova Kakhovka', [33.36, 46.75]],
  ['Mala Tokmachka', [35.88, 47.53]],
  ['Belgorod', [36.59, 50.60]],
  ['Kursk', [36.19, 51.73]],
  ['Rostov-on-Don', [39.72, 47.23]],
  ['Krasnodar', [38.98, 45.04]],
  ['Voronezh', [39.20, 51.67]],
];

for (const [name, pos] of cities) {
  const node = net.nearest(pos, 40);
  const comp = node >= 0 ? seen[node] : -1;
  let comp0Dist = Infinity;
  for (let i = 0; i < net.size; i++) {
    if (seen[i] === 0) {
      const d = (net as any).nodes ? Math.hypot((net as any).nodes[i][0] - pos[0], (net as any).nodes[i][1] - pos[1]) * 100 : 0;
      if (d < comp0Dist) comp0Dist = d;
    }
  }
  console.log(`${name}: nearest node ${node}, comp ${comp}, comp0 dist: ${comp0Dist.toFixed(1)} km`);
}

const pairs: [[string, [number, number]], [string, [number, number]]][] = [
  [['Kyiv', [30.52, 50.45]], ['Poltava', [34.55, 49.58]]],
  [['Kyiv', [30.52, 50.45]], ['Lviv', [24.03, 49.84]]],
  [['Kherson', [32.62, 46.64]], ['Nova Kakhovka', [33.36, 46.75]]],
  [['Kherson', [32.62, 46.64]], ['Zaporizhzhia', [35.14, 47.84]]],
  [['Zaporizhzhia', [35.14, 47.84]], ['Mala Tokmachka', [35.88, 47.53]]],
  [['Belgorod', [36.59, 50.60]], ['Kursk', [36.19, 51.73]]],
  [['Rostov-on-Don', [39.72, 47.23]], ['Krasnodar', [38.98, 45.04]]],
  [['Voronezh', [39.20, 51.67]], ['Belgorod', [36.59, 50.60]]],
];

for (const [[fromName, fromPos], [toName, toPos]] of pairs) {
  const t0 = Date.now();
  const route = net.route(fromPos, toPos, 1.8);
  const ms = Date.now() - t0;
  console.log(`Route ${fromName} -> ${toName}: ${route.length} waypoints in ${ms}ms`);
}
