// Builds a real OpenStreetMap & AWS Elevation terrain grid covering the entire theater:
// 19.6875°E to 56.25°E, 41.51°N to 62.43°N (Ukraine + European Russia).
// Zoom 7: 13 x 11 = 143 tiles. Resolution: 3328 x 2816 cells (~800 m / cell).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const Z = 7, TILE = 256;
const tx0 = 71, tx1 = 83; // 13 tiles: 19.6875° to 56.25° E
const ty0 = 36, ty1 = 46; // 11 tiles: 41.51° to 62.43° N

const cols = (tx1 - tx0 + 1) * TILE; // 3328
const rows = (ty1 - ty0 + 1) * TILE; // 2816

const WORLD = TILE * 2 ** Z;
const lngOf = (x) => (x / WORLD) * 360 - 180;
const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD))) * 180) / Math.PI;

const west = lngOf(tx0 * TILE);
const east = lngOf((tx1 + 1) * TILE);
const north = latOf(ty0 * TILE);
const south = latOf((ty1 + 1) * TILE);

const CACHE = 'tools/tile-cache-z7';
mkdirSync(CACHE, { recursive: true });

async function getTile(tx, ty, kind = 'osm') {
  const file = `${CACHE}/${kind}_${tx}_${ty}.png`;
  if (existsSync(file)) {
    return PNG.sync.read(readFileSync(file));
  }
  const url = kind === 'osm'
    ? `https://tile.openstreetmap.org/${Z}/${tx}/${ty}.png`
    : `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`;

  const res = await fetch(url, { headers: { 'user-agent': 'mala-tokmachka-terrain-builder/1.0' } });
  if (!res.ok) throw new Error(`Tile ${kind} ${tx}/${ty} failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return PNG.sync.read(buf);
}

console.log(`Building terrain grid: ${cols}x${rows} (${(cols * rows / 1e6).toFixed(1)}M cells)...`);
console.log(`Bounds: W=${west.toFixed(3)}, E=${east.toFixed(3)}, N=${north.toFixed(3)}, S=${south.toFixed(3)}`);

// Download in controlled batches
const tilesToFetch = [];
for (let ty = ty0; ty <= ty1; ty++) {
  for (let tx = tx0; tx <= tx1; tx++) {
    tilesToFetch.push({ tx, ty });
  }
}

console.log(`Fetching ${tilesToFetch.length} OSM & DEM tiles...`);
const osmTiles = new Map();
const demTiles = new Map();

const BATCH = 8;
for (let i = 0; i < tilesToFetch.length; i += BATCH) {
  const batch = tilesToFetch.slice(i, i + BATCH);
  await Promise.all(batch.map(async ({ tx, ty }) => {
    const key = `${tx}_${ty}`;
    const osm = await getTile(tx, ty, 'osm');
    const dem = await getTile(tx, ty, 'dem');
    osmTiles.set(key, osm);
    demTiles.set(key, dem);
  }));
  if ((i + BATCH) % 32 === 0 || i + BATCH >= tilesToFetch.length) {
    console.log(`Progress: ${Math.min(tilesToFetch.length, i + BATCH)} / ${tilesToFetch.length} tiles ready`);
  }
}

const FIELD = 0, FOREST = 1, CITY = 2, WATER = 3, HILL = 4, MOUNTAIN = 5;
const grid = new Uint8Array(cols * rows);
const elev = new Float32Array(cols * rows);

console.log('Classifying landuse and water from OpenStreetMap standard tiles...');
for (let ty = ty0; ty <= ty1; ty++) {
  for (let tx = tx0; tx <= tx1; tx++) {
    const key = `${tx}_${ty}`;
    const osm = osmTiles.get(key);
    const dem = demTiles.get(key);
    const ox = (tx - tx0) * TILE;
    const oy = (ty - ty0) * TILE;

    for (let py = 0; py < TILE; py++) {
      for (let px = 0; px < TILE; px++) {
        const off = (py * TILE + px) * 4;
        const r = osm.data[off], g = osm.data[off + 1], b = osm.data[off + 2];
        const demVal = (dem.data[off] * 256 + dem.data[off + 1] + dem.data[off + 2] / 256) - 32768;

        const gx = ox + px;
        const gy = oy + py;
        const idx = gy * cols + gx;
        elev[idx] = demVal;

        // OpenStreetMap Water: blue tone (#aad3df or similar)
        const isWater = (b > r + 20 && g > r + 15 && b > 140) || (b > 180 && r < 190 && g < 220);
        // OpenStreetMap Forest: green tone (#add19e, #c8d7ab, #b5e3b5)
        const isForest = (g > r + 15 && g > b + 20 && r < 210) || (g > 190 && r < 185 && b < 175);
        // Urban built-up from OSM: pinkish/grey #d9d0c9 / #e0dfdf
        const isUrban = (Math.abs(r - g) < 12 && Math.abs(g - b) < 14 && r > 195 && r < 235);

        if (isWater) {
          grid[idx] = WATER;
        } else if (isForest) {
          grid[idx] = FOREST;
        } else if (isUrban) {
          grid[idx] = CITY;
        } else {
          grid[idx] = FIELD;
        }
      }
    }
  }
}

console.log('Calculating topographic relief for hills and mountains...');
const RADIUS = 5; // ~4 km radius
const colMin = new Float32Array(cols * rows);
const colMax = new Float32Array(cols * rows);

for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    let lo = Infinity, hi = -Infinity;
    for (let d = -RADIUS; d <= RADIUS; d++) {
      const xx = Math.min(cols - 1, Math.max(0, x + d));
      const val = elev[y * cols + xx];
      if (val < lo) lo = val;
      if (val > hi) hi = val;
    }
    colMin[y * cols + x] = lo;
    colMax[y * cols + x] = hi;
  }
}

for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    const idx = y * cols + x;
    if (grid[idx] === WATER) continue;
    let lo = Infinity, hi = -Infinity;
    for (let d = -RADIUS; d <= RADIUS; d++) {
      const yy = Math.min(rows - 1, Math.max(0, y + d));
      const l = colMin[yy * cols + x];
      const h = colMax[yy * cols + x];
      if (l < lo) lo = l;
      if (h > hi) hi = h;
    }
    const relief = hi - lo;
    const altitude = elev[idx];

    if (relief >= 220 || altitude >= 850) {
      grid[idx] = MOUNTAIN;
    } else if (relief >= 85 && grid[idx] === FIELD) {
      grid[idx] = HILL;
    }
  }
}

// Mark major cities from ukraine.json
try {
  const mapData = JSON.parse(readFileSync('mods/base/maps/ukraine.json', 'utf8'));
  console.log(`Rasterizing ${mapData.capturePoints.length} cities...`);
  for (const cp of mapData.capturePoints) {
    const [cLng, cLat] = cp.pos;
    if (cLng < west || cLng > east || cLat < south || cLat > north) continue;
    const cx = Math.floor(((cLng - west) / (east - west)) * cols);
    const my = (1 - Math.asinh(Math.tan((cLat * Math.PI) / 180)) / Math.PI) / 2 * WORLD;
    const cy = Math.floor(my - ty0 * TILE);
    const cr = (cp.value ?? 1) >= 4 ? 4 : (cp.value ?? 1) >= 2 ? 3 : 2;
    for (let dy = -cr; dy <= cr; dy++) {
      for (let dx = -cr; dx <= cr; dx++) {
        if (dx * dx + dy * dy <= cr * cr) {
          const gx = cx + dx, gy = cy + dy;
          if (gx >= 0 && gx < cols && gy >= 0 && gy < rows) {
            const i = gy * cols + gx;
            if (grid[i] !== WATER) grid[i] = CITY;
          }
        }
      }
    }
  }
} catch (e) {
  console.warn('City rasterization note:', e.message);
}

console.log('Encoding Run-Length Encoding (RLE)...');
const legendChars = ['.', 'f', 'c', 'w', 'h', 'm'];
let rle = '';
let cur = grid[0];
let run = 1;

for (let i = 1; i < grid.length; i++) {
  const v = grid[i];
  if (v === cur) {
    run++;
  } else {
    rle += (run > 1 ? String(run) : '') + legendChars[cur];
    cur = v;
    run = 1;
  }
}
rle += (run > 1 ? String(run) : '') + legendChars[cur];

const result = {
  west,
  east,
  north,
  south,
  cols,
  rows,
  legend: {
    '.': 'field',
    'f': 'forest',
    'c': 'city',
    'w': 'water',
    'h': 'hill',
    'm': 'mountain',
  },
  rle,
};

const outFile = 'mods/base/maps/ukraine.terrain.json';
writeFileSync(outFile, JSON.stringify(result));
console.log(`Saved ${outFile} (size: ${(rle.length / 1024).toFixed(1)} KB, RLE length: ${rle.length})`);
console.log('Done!');
