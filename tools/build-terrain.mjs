// Builds a terrain grid (field / forest / city / water) for a map.
//  - forest and water are classified from OpenStreetMap standard tiles at zoom 8 (© OpenStreetMap contributors, ODbL)
//  - cities come from Natural Earth 1:10m urban areas (public domain)
// The grid is uniform in longitude and in Web-Mercator Y so it lines up exactly with the basemap.
// usage: node tools/build-terrain.mjs <west,south,east,north> <ne_10m_urban_areas.geojson> <tile-cache-dir> <out.json>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [bboxArg, urbanFile, cache, out] = process.argv.slice(2);
const [W, S, E, N] = bboxArg.split(',').map(Number);
const Z = 8, TILE = 256, BLOCK = 4; // one cell = 4×4 tile pixels ≈ 1.6 km
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
async function tile(tx, ty) {
  const key = `${tx}_${ty}`;
  if (tiles.has(key)) return tiles.get(key);
  const file = `${cache}/${Z}_${key}.png`;
  if (!existsSync(file)) {
    const r = await fetch(`https://tile.openstreetmap.org/${Z}/${tx}/${ty}.png`, { headers: { 'user-agent': 'mala-tokmachka-terrain-build/0.1 (one-off map preprocessing)' } });
    if (!r.ok) throw new Error(`tile ${key}: ${r.status}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    await new Promise((res) => setTimeout(res, 150)); // be polite to the tile server
  }
  const png = PNG.sync.read(readFileSync(file));
  tiles.set(key, png);
  return png;
}

const FIELD = 0, FOREST = 1, CITY = 2, WATER = 3;
const grid = new Uint8Array(cols * rows);
for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y1 - 1) / TILE); ty++) {
  for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1) / TILE); tx++) {
    const png = await tile(tx, ty);
    for (let by = 0; by < TILE; by += BLOCK) {
      for (let bx = 0; bx < TILE; bx += BLOCK) {
        const gx = (tx * TILE + bx - x0) / BLOCK, gy = (ty * TILE + by - y0) / BLOCK;
        if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
        let water = 0, forest = 0;
        for (let j = 0; j < BLOCK; j++) {
          for (let i = 0; i < BLOCK; i++) {
            const o = ((by + j) * TILE + bx + i) * 4;
            const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
            if (b > r + 25 && g > r + 18 && b > 150) water++;
            else if (g > r + 20 && g > b + 25 && r < 200) forest++;
          }
        }
        grid[gy * cols + gx] = water >= 4 ? WATER : forest >= 7 ? FOREST : FIELD;
      }
    }
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

// run-length encode: "<count><letter>" with letters . f c w
const LETTER = '.fcw';
let rle = '';
for (let i = 0; i < grid.length; ) {
  let j = i;
  while (j < grid.length && grid[j] === grid[i]) j++;
  rle += (j - i > 1 ? j - i : '') + LETTER[grid[i]];
  i = j;
}
const count = [0, 0, 0, 0];
grid.forEach((v) => count[v]++);
writeFileSync(out, JSON.stringify({ west: lngOf(x0), east: lngOf(x1), north: latOf(y0), south: latOf(y1), cols, rows, legend: { '.': 'field', f: 'forest', c: 'city', w: 'water' }, rle }));
console.log(`${cols}x${rows} cells, field ${count[0]} forest ${count[1]} city ${count[2]} water ${count[3]}, rle ${(rle.length / 1024).toFixed(0)} KB -> ${out}`);
