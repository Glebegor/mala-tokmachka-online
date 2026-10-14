import { readFileSync, writeFileSync } from 'node:fs';

const mapPath = 'mods/base/maps/ukraine.json';
const currentMap = JSON.parse(readFileSync(mapPath, 'utf8'));

// 1. DeepState authoritative frontline GeoJSON (1,038 nodes around occupied territory)
const ds = JSON.parse(readFileSync('C:/Users/AKIRA/.gemini/antigravity/scratch/deepstate_latest.geojson', 'utf8'));
const dsPts = ds.features[0].geometry.coordinates[0][0];

// 2. Active combat frontline from Kinburn spit [31.55, 46.52] to Senkivka tri-point [31.764, 52.101]
const ACTIVE_FRONT = [
  [31.55, 46.52],
  [31.65, 46.5], [31.85, 46.52], [32.1, 46.52], [32.35, 46.5],
  [32.6, 46.56], [32.72, 46.64], [32.88, 46.72], [33.15, 46.82],
  [33.37, 46.84], [33.65, 47.05], [34.0, 47.28], [34.45, 47.52],
  [35.05, 47.52], [35.25, 47.54], [35.5, 47.52], [35.75, 47.5],
  [36.1, 47.55], [36.4, 47.62], [36.75, 47.7],
  [37.05, 47.78], [37.22, 47.78], [37.38, 47.88], [37.45, 47.96],
  [37.4, 48.02], [37.35, 48.1], [37.34, 48.18], [37.35, 48.26],
  [37.42, 48.33], [37.55, 48.36], [37.7, 48.38], [37.82, 48.42],
  [37.88, 48.52], [37.88, 48.6], [37.95, 48.72], [38.08, 48.82],
  [38.15, 48.9], [38.1, 49.02], [38.02, 49.12], [37.98, 49.25],
  [37.95, 49.38], [37.92, 49.52], [37.82, 49.62], [37.72, 49.7],
  [37.74, 49.8], [37.82, 49.92],
  [38.05, 50.04], [38.18, 50.08],
  [37.85, 50.15], [37.5, 50.32], [36.93, 50.28], [36.43, 50.28], [36.15, 50.32],
  [35.7, 50.37], [35.4, 50.6], [35.3, 51.05],
  [34.4, 51.25], [34.15, 51.65], [34.1, 52.0], [33.8, 52.35], [33.0, 52.3], [32.3, 52.25], [31.764, 52.101]
];

function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  function recurse(start, end) {
    let maxD = 0, maxIdx = -1;
    const [ax, ay] = points[start], [bx, by] = points[end];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    for (let i = start + 1; i < end; i++) {
      const d = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / len;
      if (d > maxD) { maxD = d; maxIdx = i; }
    }
    if (maxD > tol && maxIdx > 0) {
      keep[maxIdx] = 1;
      recurse(start, maxIdx);
      recurse(maxIdx, end);
    }
  }
  recurse(0, points.length - 1);
  return points.filter((_, i) => keep[i]);
}

// 3. Belarus-Russia border: from Senkivka northwards towards off-screen
const borders = JSON.parse(readFileSync('mods/base/maps/borders.geojson', 'utf8'));
const belarusRussia = borders.features.find((f) => (f.properties?.name || f.properties?.label) === 'Belarus — Russia');
const brPts = simplify(belarusRussia.geometry.coordinates, 0.005).map((p) => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]);

// 4. Crimea: Kerch strait (pt 66) along southern/western coast to Kinburn spit (pt 625)
const crimea = simplify(dsPts.slice(66, 626), 0.003).map((p) => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]);

// Combine: Kerch -> Crimea coastline -> Kinburn spit -> Active combat line -> Senkivka
const newFront = [
  ...crimea,
  ...ACTIVE_FRONT.slice(1)
];

// 5. Krasnodar Krai Black Sea coast (from Kerch Strait / Taman to Sochi [40.0, 43.38])
const cleanKrasnodar = JSON.parse(readFileSync('C:/Users/AKIRA/.gemini/antigravity/scratch/clean_krasnodar_coast.json', 'utf8'));
// 6. Sea of Azov closed coastline hole ring
const cleanAzov = JSON.parse(readFileSync('C:/Users/AKIRA/.gemini/antigravity/scratch/clean_azov_ring.json', 'utf8'));

// Occupied closure:
// Starts from Senkivka [31.764, 52.101],
// follows Belarus-Russia border northwards,
// routes off-screen east across Russia to 48.0 (balanced map size),
// then down to Sochi [40.0, 43.38] and traces the Krasnodar Black Sea coast back to Kerch [36.6, 45.4]
const EAST_BOUND = 48.0;
const occupiedClosure = [
  ...brPts.slice(1),
  [brPts[brPts.length - 1][0], 56.0],
  [EAST_BOUND, 56.0],
  [EAST_BOUND, 43.38],
  [cleanKrasnodar[cleanKrasnodar.length - 1][0], cleanKrasnodar[cleanKrasnodar.length - 1][1]],
  ...cleanKrasnodar.slice().reverse()
];

const frontStr = '[\n' + newFront.map((p) => '    [' + p[0] + ', ' + p[1] + ']').join(',\n') + '\n  ]';
const closureStr = JSON.stringify(occupiedClosure);
const holesStr = JSON.stringify([cleanAzov]);
const cpStr = '[\n' + currentMap.capturePoints.map((c) => '    ' + JSON.stringify(c)).join(',\n') + '\n  ]';
const spawnsStr = '[\n    ' + JSON.stringify(currentMap.spawns[0]) + ',\n    ' + JSON.stringify(currentMap.spawns[1]) + '\n  ]';

const out = `{
  "id": "${currentMap.id}",
  "name": "${currentMap.name}",
  "bounds": [22, 43.8, ${EAST_BOUND}, 53.2],
  "center": [35.0, 48.5],
  "zoom": 5.5,
  "roadsFile": "${currentMap.roadsFile}",
  "terrainFile": "${currentMap.terrainFile}",
  "bordersFile": "${currentMap.bordersFile}",
  "front": ${frontStr},
  "occupiedClosure": ${closureStr},
  "occupiedHoles": ${holesStr},
  "capturePoints": ${cpStr},
  "spawns": ${spawnsStr}
}\n`;

writeFileSync(mapPath, out);
console.log(`Updated ${mapPath}: ${newFront.length} front nodes, ${cleanAzov.length} Azov hole nodes, bounds east: ${EAST_BOUND}`);
