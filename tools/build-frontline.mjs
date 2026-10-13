import { readFileSync, writeFileSync } from 'node:fs';

const mapPath = 'mods/base/maps/ukraine.json';
const currentMap = JSON.parse(readFileSync(mapPath, 'utf8'));

// 1. Crimea coastline from DeepState (Kerch -> Feodosia -> Yalta -> Sevastopol -> Tarkhankut -> Kinburn)
const ds = JSON.parse(readFileSync('C:/Users/AKIRA/.gemini/antigravity/scratch/deepstate_latest.geojson', 'utf8'));
const dsPts = ds.features[0].geometry.coordinates[0][0];

// 2. Active combat frontline from Kinburn spit [31.55, 46.52] to Senkivka [31.78, 52.1]
const ACTIVE_FRONT = [
  [31.55, 46.52],
  [31.65, 46.5], [31.85, 46.52], [32.1, 46.52], [32.35, 46.5],
  [32.55, 46.57], [32.72, 46.67], [32.95, 46.74], [33.18, 46.82], [33.37, 46.8],
  [33.55, 46.95], [33.75, 47.12], [34.05, 47.32], [34.35, 47.48], [34.6, 47.58],
  [34.9, 47.58], [35.15, 47.52],
  [35.28, 47.48], [35.45, 47.52], [35.65, 47.48], [35.8, 47.38], [35.95, 47.45], [36.05, 47.5],
  [36.2, 47.55], [36.32, 47.6], [36.5, 47.7], [36.65, 47.78],
  [36.85, 47.85], [37.05, 47.78], [37.22, 47.78], [37.38, 47.88], [37.45, 47.96],
  [37.4, 48.02], [37.35, 48.1],
  [37.34, 48.18], [37.35, 48.26], [37.42, 48.33], [37.55, 48.36], [37.7, 48.38], [37.82, 48.42],
  [37.88, 48.52], [37.88, 48.6], [37.95, 48.72], [38.08, 48.82],
  [38.15, 48.9], [38.1, 49.02], [38.02, 49.12], [37.98, 49.25],
  [37.95, 49.38], [37.92, 49.52], [37.82, 49.62], [37.72, 49.7], [37.74, 49.8], [37.82, 49.92],
  [38.05, 50.04], [38.18, 50.08],
  [37.85, 50.15], [37.5, 50.32], [36.93, 50.28], [36.43, 50.28], [36.15, 50.32],
  [35.7, 50.37], [35.4, 50.6], [35.3, 51.05],
  [34.4, 51.25], [34.15, 51.65], [34.1, 52.0], [33.8, 52.35], [33.0, 52.3], [32.3, 52.25], [31.78, 52.1]
];

// 3. Northern Belarus border from borders.geojson (Senkivka -> Kyiv/Chernobyl north -> Poland tripoint)
const borders = JSON.parse(readFileSync('mods/base/maps/borders.geojson', 'utf8'));
const belarus = borders.features.find((f) => (f.properties?.name || f.properties?.label) === 'Ukraine — Belarus');
const belarusPts = [...belarus.geometry.coordinates].reverse();

function simplify(points, tol) {
  if (points.length < 3) return points;
  let worst = 0, idx = -1;
  const [ax, ay] = points[0], [bx, by] = points[points.length - 1];
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / len;
    if (d > worst) { worst = d; idx = i; }
  }
  if (worst > tol) {
    const left = simplify(points.slice(0, idx + 1), tol);
    const right = simplify(points.slice(idx), tol);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

// Crimea: Kerch strait (pt 66) along southern/western coast to Kinburn spit (pt 625)
const crimea = simplify(dsPts.slice(66, 626), 0.02).map((p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]);

// Belarus: from Senkivka westwards to Poland
const belarusClean = simplify(belarusPts, 0.02).map((p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]);

// Combine: Kerch -> Crimea coastline -> Kinburn spit -> Active combat line -> Senkivka -> Belarus border -> Poland
const newFront = [
  ...crimea,
  ...ACTIVE_FRONT.slice(1),
  ...belarusClean.slice(1)
];

// Occupied closure: around Belarus/Russia back to Kerch
const occupiedClosure = [
  [newFront[newFront.length - 1][0], 56.0],
  [45.0, 56.0],
  [45.0, newFront[0][1]]
];

const frontStr = '[\n' + newFront.map((p) => '    [' + p[0] + ', ' + p[1] + ']').join(',\n') + '\n  ]';
const closureStr = JSON.stringify(occupiedClosure);
const cpStr = '[\n' + currentMap.capturePoints.map((c) => '    ' + JSON.stringify(c)).join(',\n') + '\n  ]';
const spawnsStr = '[\n    ' + JSON.stringify(currentMap.spawns[0]) + ',\n    ' + JSON.stringify(currentMap.spawns[1]) + '\n  ]';

const out = `{
  "id": "${currentMap.id}",
  "name": "${currentMap.name}",
  "bounds": ${JSON.stringify(currentMap.bounds)},
  "center": ${JSON.stringify(currentMap.center)},
  "zoom": ${currentMap.zoom},
  "roadsFile": "${currentMap.roadsFile}",
  "terrainFile": "${currentMap.terrainFile}",
  "bordersFile": "${currentMap.bordersFile}",
  "front": ${frontStr},
  "occupiedClosure": ${closureStr},
  "capturePoints": ${cpStr},
  "spawns": ${spawnsStr}
}\n`;

writeFileSync(mapPath, out);
console.log(`Updated ${mapPath}: ${newFront.length} front nodes, occupiedClosure:`, occupiedClosure);
