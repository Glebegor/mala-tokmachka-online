// Builds a terrain grid (field / forest / hill / mountain / city / water) for a map.
//  - forest and water are classified from OpenStreetMap standard tiles at zoom 8 (© OpenStreetMap contributors, ODbL)
//  - cities come from Natural Earth 1:10m urban areas (public domain)
//  - hills and mountains come from elevation (Mapzen/AWS Terrain Tiles, terrarium encoding, open data)
// The grid is uniform in longitude and in Web-Mercator Y so it lines up exactly with the basemap.
//  - major rivers are drawn in from Natural Earth river centrelines so that they form unbroken barriers
// usage: node tools/build-terrain.mjs <west,south,east,north> <ne_10m_urban_areas.geojson> <tile-cache-dir> <out.json> [ne_10m_rivers_lake_centerlines.geojson]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [bboxArg, urbanFile, cache, out, riversFile] = process.argv.slice(2);
const [W, S, E, N] = bboxArg.split(',').map(Number);
const Z = 8, TILE = 256, BLOCK = 2; // one cell = 2×2 tile pixels ≈ 0.8 km
const HILL_RELIEF = 90, MOUNTAIN_RELIEF = 230, MOUNTAIN_ELEV = 900; // metres; relief is measured over ~4 km
const WORLD = TILE * 2 ** Z;
const px = (lng) => ((lng + 180) / 360) * WORLD;
const py = (lat) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * WORLD;
const lngOf = (x) => (x / WORLD) * 360 - 180;
const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD))) * 180) / Math.PI;

const x0 = Math.floor(px(W) / BLOCK) * BLOCK, x1 = Math.ceil(px(E) / BLOCK) * BLOCK;
const y0 = Math.floor(py(N) / BLOCK) * BLOCK, y1 = Math.ceil(py(S) / BLOCK) * BLOCK;
const cols = (x1 - x0) / BLOCK, rows = (y1 - y0) / BLOCK;

mkdirSync(cache, { recursive: true });
const tiles = new Map();
async function tile(tx, ty, kind = 'osm') {
  const key = `${kind === 'osm' ? '' : kind + '_'}${tx}_${ty}`;
  if (tiles.has(key)) return tiles.get(key);
  const file = `${cache}/${Z}_${key}.png`;
  if (!existsSync(file)) {
    const url = kind === 'osm' ? `https://tile.openstreetmap.org/${Z}/${tx}/${ty}.png` : `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`;
    const r = await fetch(url, { headers: { 'user-agent': 'mala-tokmachka-terrain-build/0.1 (one-off map preprocessing)' } });
    if (!r.ok) throw new Error(`tile ${key}: ${r.status}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    await new Promise((res) => setTimeout(res, 150)); // be polite to the tile server
  }
  const png = PNG.sync.read(readFileSync(file));
  tiles.set(key, png);
  return png;
}

const FIELD = 0, FOREST = 1, CITY = 2, WATER = 3, HILL = 4, MOUNTAIN = 5;
const grid = new Uint8Array(cols * rows);
const elev = new Float32Array(cols * rows);
for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y1 - 1) / TILE); ty++) {
  for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1) / TILE); tx++) {
    const png = await tile(tx, ty);
    const dem = await tile(tx, ty, 'dem');
    for (let by = 0; by < TILE; by += BLOCK) {
      for (let bx = 0; bx < TILE; bx += BLOCK) {
        const gx = (tx * TILE + bx - x0) / BLOCK, gy = (ty * TILE + by - y0) / BLOCK;
        if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
        let water = 0, forest = 0, sum = 0;
        for (let j = 0; j < BLOCK; j++) {
          for (let i = 0; i < BLOCK; i++) {
            const o = ((by + j) * TILE + bx + i) * 4;
            const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
            if (b > r + 25 && g > r + 18 && b > 150) water++;
            else if (g > r + 20 && g > b + 25 && r < 200) forest++;
            sum += dem.data[o] * 256 + dem.data[o + 1] + dem.data[o + 2] / 256 - 32768;
          }
        }
        const n = BLOCK * BLOCK;
        elev[gy * cols + gx] = sum / n;
        grid[gy * cols + gx] = water * 4 >= n ? WATER : forest * 2 > n ? FOREST : FIELD;
      }
    }
  }
}

// relief: height range within ~4 km decides hill / mountain. Mountains override forest; hills only replace open field.
const RADIUS = 3;
const colMin = new Float32Array(cols * rows), colMax = new Float32Array(cols * rows);
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    let lo = Infinity, hi = -Infinity;
    for (let d = -RADIUS; d <= RADIUS; d++) {
      const xx = Math.min(cols - 1, Math.max(0, x + d));
      lo = Math.min(lo, elev[y * cols + xx]);
      hi = Math.max(hi, elev[y * cols + xx]);
    }
    colMin[y * cols + x] = lo;
    colMax[y * cols + x] = hi;
  }
}
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    const i = y * cols + x;
    if (grid[i] === WATER) continue;
    let lo = Infinity, hi = -Infinity;
    for (let d = -RADIUS; d <= RADIUS; d++) {
      const yy = Math.min(rows - 1, Math.max(0, y + d));
      lo = Math.min(lo, colMin[yy * cols + x]);
      hi = Math.max(hi, colMax[yy * cols + x]);
    }
    const relief = hi - lo;
    if (relief >= MOUNTAIN_RELIEF || elev[i] >= MOUNTAIN_ELEV) grid[i] = MOUNTAIN;
    else if (relief >= HILL_RELIEF && grid[i] === FIELD) grid[i] = HILL;
  }
}

// cities: rasterise Natural Earth urban polygons (never overwrite water)
const urban = JSON.parse(readFileSync(urbanFile, 'utf8'));
let cityCells = 0;
for (const f of urban.features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) {
    const ring = poly[0];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of ring) (minX = Math.min(minX, x)), (maxX = Math.max(maxX, x)), (minY = Math.min(minY, y)), (maxY = Math.max(maxY, y));
    if (maxX < W || minX > E || maxY < S || minY > N) continue;
    const gx0 = Math.max(0, Math.floor((px(minX) - x0) / BLOCK)), gx1 = Math.min(cols - 1, Math.floor((px(maxX) - x0) / BLOCK));
    const gy0 = Math.max(0, Math.floor((py(maxY) - y0) / BLOCK)), gy1 = Math.min(rows - 1, Math.floor((py(minY) - y0) / BLOCK));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const lng = lngOf(x0 + (gx + 0.5) * BLOCK), lat = latOf(y0 + (gy + 0.5) * BLOCK);
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside && grid[gy * cols + gx] !== WATER) (grid[gy * cols + gx] = CITY), cityCells++;
      }
    }
  }
}

// major rivers: stamp every centreline into the grid as a continuous run of water cells
let riverCells = 0;
if (riversFile) {
  const rivers = JSON.parse(readFileSync(riversFile, 'utf8'));
  const stamp = (gx, gy) => {
    if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) return;
    if (grid[gy * cols + gx] !== WATER) (grid[gy * cols + gx] = WATER), riverCells++;
  };
  for (const f of rivers.features) {
    if (!f.geometry) continue;
    const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const part of parts) {
      for (let i = 1; i < part.length; i++) {
        const ax = (px(part[i - 1][0]) - x0) / BLOCK, ay = (py(part[i - 1][1]) - y0) / BLOCK;
        const bx = (px(part[i][0]) - x0) / BLOCK, by = (py(part[i][1]) - y0) / BLOCK;
        if (Math.max(ax, bx) < 0 || Math.min(ax, bx) > cols || Math.max(ay, by) < 0 || Math.min(ay, by) > rows) continue;
        const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2) + 1;
        let lastX = null, lastY = null;
        for (let k = 0; k <= steps; k++) {
          const gx = Math.floor(ax + ((bx - ax) * k) / steps), gy = Math.floor(ay + ((by - ay) * k) / steps);
          // close diagonal steps so the river cannot be slipped through corner to corner
          if (lastX !== null && gx !== lastX && gy !== lastY) stamp(gx, lastY);
          stamp(gx, gy);
          lastX = gx;
          lastY = gy;
        }
      }
    }
  }
}

// run-length encode: "<count><letter>" with letters . f c w
const LETTER = '.fcwhm';
let rle = '';
for (let i = 0; i < grid.length; ) {
  let j = i;
  while (j < grid.length && grid[j] === grid[i]) j++;
  rle += (j - i > 1 ? j - i : '') + LETTER[grid[i]];
  i = j;
}
const count = [0, 0, 0, 0, 0, 0];
grid.forEach((v) => count[v]++);
writeFileSync(out, JSON.stringify({ west: lngOf(x0), east: lngOf(x1), north: latOf(y0), south: latOf(y1), cols, rows, legend: { '.': 'field', f: 'forest', c: 'city', w: 'water', h: 'hill', m: 'mountain' }, rle }));
console.log(`${riverCells} river cells added; ${cols}x${rows} cells, field ${count[0]} forest ${count[1]} city ${count[2]} water ${count[3]} hill ${count[4]} mountain ${count[5]}, rle ${(rle.length / 1024).toFixed(0)} KB -> ${out}`);
