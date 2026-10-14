import { readFileSync, writeFileSync } from 'node:fs';

const mapPath = 'mods/base/maps/ukraine.json';

// 1. DeepState authoritative frontline GeoJSON
const ds = JSON.parse(readFileSync('C:/Users/AKIRA/.gemini/antigravity/scratch/deepstate_latest.geojson', 'utf8'));
const dsPts = ds.features[0].geometry.coordinates[0][0];

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

// 2. Active combat frontline from Kinburn spit to Senkivka tri-point [31.764, 52.101]
const ACTIVE_FRONT = [
  [31.547, 46.539],
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

// Active combat line is ONLY where forces fight:
const newFront = ACTIVE_FRONT;

// 3. Belarus-Russia border: from Senkivka northwards towards off-screen
const borders = JSON.parse(readFileSync('mods/base/maps/borders.geojson', 'utf8'));
const belarusRussia = borders.features.find((f) => (f.properties?.name || f.properties?.label) === 'Belarus — Russia');
const brPts = simplify(belarusRussia.geometry.coordinates, 0.005).map((p) => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]);

// 4. Crimea coastline: from Kerch Strait [36.6, 45.4] around southern/western coast to Kinburn spit [31.55, 46.52]
const crimea = simplify(dsPts.slice(66, 626), 0.003).map((p) => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]);

// 5. Krasnodar Krai Black Sea coast (from Kerch Strait / Taman to Sochi [40.0, 43.38])
const cleanKrasnodar = JSON.parse(readFileSync('C:/Users/AKIRA/.gemini/antigravity/scratch/clean_krasnodar_coast.json', 'utf8'));
// 6. Sea of Azov closed coastline hole ring
const cleanAzov = JSON.parse(readFileSync('C:/Users/AKIRA/.gemini/antigravity/scratch/clean_azov_ring.json', 'utf8'));

// 7. Occupied boundary closure:
// Starts from Senkivka [31.764, 52.101] (end of active front),
// follows Belarus-Russia border northwards,
// routes offscreen around Northwestern (Saint Petersburg 61°N),
// east across to Volga/Tatarstan/Ulyanovsk (54°E),
// south to Sochi [40.0, 43.38],
// traces Krasnodar Black Sea coast to Kerch Strait,
// crosses into Crimea and traces the Black Sea coast of Crimea to Kinburn Spit [31.55, 46.52] (start of active front)!
const EAST_BOUND = 54.0;
const NORTH_BOUND = 61.0;
const SOUTH_BOUND = 43.3;

const occupiedClosure = [
  ...brPts.slice(1),
  [brPts[brPts.length - 1][0], NORTH_BOUND],
  [EAST_BOUND, NORTH_BOUND],
  [EAST_BOUND, SOUTH_BOUND],
  [cleanKrasnodar[cleanKrasnodar.length - 1][0], SOUTH_BOUND],
  ...cleanKrasnodar.slice().reverse(),
  ...crimea
];

const CAPTURE_POINTS = [
  { id: 'kyiv', name: 'Kyiv', pos: [30.52, 50.45], value: 5 },
  { id: 'kharkiv', name: 'Kharkiv', pos: [36.23, 49.99], value: 4 },
  { id: 'dnipro', name: 'Dnipro', pos: [35.04, 48.46], value: 3 },
  { id: 'odesa', name: 'Odesa', pos: [30.73, 46.48], value: 3 },
  { id: 'zaporizhzhia', name: 'Zaporizhzhia', pos: [35.14, 47.84], value: 3 },
  { id: 'kherson', name: 'Kherson', pos: [32.62, 46.64], value: 2 },
  { id: 'kryvyi_rih', name: 'Kryvyi Rih', pos: [33.39, 47.91], value: 2 },
  { id: 'poltava', name: 'Poltava', pos: [34.55, 49.58], value: 2 },
  { id: 'sumy', name: 'Sumy', pos: [34.8, 50.91], value: 2 },
  { id: 'orikhiv', name: 'Orikhiv', pos: [35.78, 47.57], value: 1 },
  { id: 'mala_tokmachka', name: 'Mala Tokmachka', pos: [35.88, 47.53], value: 2 },
  { id: 'huliaipole', name: 'Huliaipole', pos: [36.26, 47.66], value: 1 },
  { id: 'pokrovsk', name: 'Pokrovsk', pos: [37.18, 48.28], value: 2 },
  { id: 'kramatorsk', name: 'Kramatorsk', pos: [37.56, 48.74], value: 3 },
  { id: 'kupiansk', name: 'Kupiansk', pos: [37.62, 49.71], value: 2 },
  { id: 'nova_kakhovka', name: 'Nova Kakhovka', pos: [33.37, 46.76], value: 1 },
  { id: 'enerhodar', name: 'Enerhodar', pos: [34.65, 47.5], value: 2 },
  { id: 'tokmak', name: 'Tokmak', pos: [35.71, 47.25], value: 2 },
  { id: 'polohy', name: 'Polohy', pos: [36.26, 47.48], value: 1 },
  { id: 'melitopol', name: 'Melitopol', pos: [35.37, 46.84], value: 3 },
  { id: 'mariupol', name: 'Mariupol', pos: [37.55, 47.1], value: 3 },
  { id: 'donetsk', name: 'Donetsk', pos: [37.8, 48.0], value: 4 },
  { id: 'bakhmut', name: 'Bakhmut', pos: [38.0, 48.6], value: 1 },
  { id: 'luhansk', name: 'Luhansk', pos: [39.3, 48.57], value: 3 },
  { id: 'simferopol', name: 'Simferopol', pos: [34.1, 44.95], value: 3 },
  { id: 'sevastopol', name: 'Sevastopol', pos: [33.52, 44.61], value: 3 },
  { id: 'belgorod', name: 'Belgorod', pos: [36.59, 50.6], value: 2 },
  { id: 'kursk', name: 'Kursk', pos: [36.19, 51.73], value: 2 },
  { id: 'voronezh', name: 'Voronezh', pos: [39.2, 51.67], value: 3 },
  { id: 'rostov', name: 'Rostov-on-Don', pos: [39.72, 47.23], value: 3 },
  { id: 'bryansk', name: 'Bryansk', pos: [34.37, 53.25], value: 2 },
  { id: 'smolensk', name: 'Smolensk', pos: [32.05, 54.78], value: 2 },
  { id: 'moscow', name: 'Moscow', pos: [37.62, 55.75], value: 5 },
  { id: 'saint_petersburg', name: 'Saint Petersburg', pos: [30.33, 59.93], value: 5 },
  { id: 'nizhny_novgorod', name: 'Nizhny Novgorod', pos: [44.0, 56.32], value: 3 },
  { id: 'kazan', name: 'Kazan', pos: [49.12, 55.79], value: 3 },
  { id: 'ulyanovsk', name: 'Ulyanovsk', pos: [48.4, 54.32], value: 2 },
  { id: 'samara', name: 'Samara', pos: [50.15, 53.2], value: 3 }
];

const SPAWNS = [
  // Team 0: Ukraine deep & operational bases
  [[30.52, 50.45], [35.04, 48.46], [32.0, 46.97], [33.39, 47.91], [35.3, 47.92], [35.87, 48.53], [37.05, 48.95], [36.1, 49.85]],
  // Team 1: Russia operational & strategic command centers (Moscow, SPb, Kazan, Ulyanovsk, Voronezh, Rostov, Simferopol)
  [[37.62, 55.75], [30.33, 59.93], [49.12, 55.79], [48.4, 54.32], [39.2, 51.67], [39.72, 47.23], [36.7, 50.7], [34.1, 45.2]]
];

const frontStr = '[\n' + newFront.map((p) => '    [' + p[0] + ', ' + p[1] + ']').join(',\n') + '\n  ]';
const closureStr = JSON.stringify(occupiedClosure);
const holesStr = JSON.stringify([cleanAzov]);
const cpStr = '[\n' + CAPTURE_POINTS.map((c) => '    ' + JSON.stringify(c)).join(',\n') + '\n  ]';
const spawnsStr = '[\n    ' + JSON.stringify(SPAWNS[0]) + ',\n    ' + JSON.stringify(SPAWNS[1]) + '\n  ]';

const out = `{
  "id": "ukraine",
  "name": "Eastern Europe — Expanded Theater",
  "bounds": [21.0, ${SOUTH_BOUND}, ${EAST_BOUND}, ${NORTH_BOUND}],
  "center": [37.5, 52.0],
  "zoom": 4.9,
  "roadsFile": "ukraine.roads.json",
  "terrainFile": "ukraine.terrain.json",
  "bordersFile": "borders.geojson",
  "front": ${frontStr},
  "occupiedClosure": ${closureStr},
  "occupiedHoles": ${holesStr},
  "capturePoints": ${cpStr},
  "spawns": ${spawnsStr}
}\n`;

writeFileSync(mapPath, out);
console.log(`Updated ${mapPath}: ${newFront.length} active front nodes, ${occupiedClosure.length} closure nodes, ${cleanAzov.length} Azov hole nodes, bounds: [21.0, ${SOUTH_BOUND}, ${EAST_BOUND}, ${NORTH_BOUND}]`);
