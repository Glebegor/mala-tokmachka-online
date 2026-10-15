import type { LngLat } from './geo';

export interface TerrainGridData {
  west: number;
  east: number;
  north: number;
  south: number;
  cols: number;
  rows: number;
  /** grid letter → terrain id */
  legend: Record<string, string>;
  /** run-length encoded rows, north to south: "<count><letter>..." */
  rle: string;
}

const mercY = (lat: number) => Math.asinh(Math.tan((lat * Math.PI) / 180));

const BARRIER = 0x80; // flag bit: cell belongs to a body of barrier terrain
const VISITED = 0x40; // scratch bit used while flood-filling
const KIND = 0x3f;

/** Fallback terrain for positions outside the high-res terrain grid. */
export function proceduralTerrain(lng: number, lat: number): string {
  // Major water bodies outside the grid:
  if (lat < 43.5 || (lat < 44.5 && lng < 37.0) || (lng > 47.5 && lat < 46.5)) return 'water';
  if (lng > 30.5 && lng < 33.2 && lat > 59.8 && lat < 61.6) return 'water'; // Lake Ladoga
  if (lng > 34.5 && lng < 36.5 && lat > 61.3 && lat < 63.0) return 'water'; // Lake Onega
  if (lat > 60) return 'forest';
  return 'field';
}

/** Terrain lookup. The grid is uniform in longitude and Web-Mercator Y, matching the basemap. */
export class TerrainGrid {
  readonly ids: string[];
  /** One byte per cell: terrain index in the low bits, barrier flag in the top bit (use `kindAt` / `isBarrier`). */
  readonly cells: Uint8Array;
  private yN: number;
  private yS: number;

  /** `barrierMinCells`: terrain id → smallest connected area (in cells) that counts as a barrier. */
  constructor(readonly data: TerrainGridData, barrierMinCells: Record<string, number> = {}) {
    const letters = Object.keys(data.legend);
    this.ids = letters.map((l) => data.legend[l]);
    this.cells = new Uint8Array(data.cols * data.rows);
    const value = new Uint8Array(128);
    letters.forEach((l, i) => (value[l.charCodeAt(0)] = i));
    let i = 0;
    let count = 0;
    for (let k = 0; k < data.rle.length; k++) {
      const c = data.rle.charCodeAt(k);
      if (c >= 48 && c <= 57) {
        count = count * 10 + (c - 48);
      } else {
        const n = count || 1;
        this.cells.fill(value[c], i, i + n);
        i += n;
        count = 0;
      }
    }
    this.yN = mercY(data.north);
    this.yS = mercY(data.south);
    this.ids.forEach((id, v) => {
      if (barrierMinCells[id] !== undefined) this.markBarrier(v, barrierMinCells[id]);
    });
  }

  /**
   * Flag every connected area (8-neighbour) of one terrain value that is at least `minCells` big: a real river or the
   * sea, not a pond. Works in place with two flag bits so it stays cheap on grids with tens of millions of cells.
   */
  private markBarrier(value: number, minCells: number) {
    const { cols, rows } = this.data;
    const cells = this.cells;
    const stack: number[] = [];
    const flood = (start: number, from: number, to: number): number => {
      let n = 0;
      stack.length = 0;
      stack.push(start);
      cells[start] = to;
      while (stack.length) {
        const c = stack.pop()!;
        n++;
        const x = c % cols;
        const y = (c - x) / cols;
        const x0 = x > 0 ? x - 1 : x, x1 = x < cols - 1 ? x + 1 : x;
        const y0 = y > 0 ? y - 1 : y, y1 = y < rows - 1 ? y + 1 : y;
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const k = yy * cols + xx;
            if (cells[k] === from) {
              cells[k] = to;
              stack.push(k);
            }
          }
        }
      }
      return n;
    };
    for (let start = 0; start < cells.length; start++) {
      if (cells[start] !== value) continue;
      // first pass counts the area (marking it visited); big ones get a second pass that turns the mark into the flag
      if (flood(start, value, value | VISITED) >= minCells) flood(start, value | VISITED, value | BARRIER);
    }
    for (let k = 0; k < cells.length; k++) if (cells[k] & VISITED) cells[k] &= ~VISITED;
  }

  private index(p: LngLat): number {
    const d = this.data;
    const x = Math.floor(((p[0] - d.west) / (d.east - d.west)) * d.cols);
    const y = Math.floor(((this.yN - mercY(p[1])) / (this.yN - this.yS)) * d.rows);
    return x < 0 || y < 0 || x >= d.cols || y >= d.rows ? -1 : y * d.cols + x;
  }

  /** True when this position is inside a river/sea that ground units cannot enter on their own. */
  isBarrier(p: LngLat): boolean {
    const i = this.index(p);
    if (i >= 0) return (this.cells[i] & BARRIER) !== 0;
    const pt = proceduralTerrain(p[0], p[1]);
    return pt === 'water' && (p[1] < 44.5 || (p[0] > 47.5 && p[1] < 46.5) || (p[0] > 30.5 && p[0] < 33.2 && p[1] > 59.8));
  }

  /** Terrain index (into `ids`) of a cell. */
  kindAt(cell: number): number {
    return this.cells[cell] & KIND;
  }

  /** Terrain id at a position; outside the grid procedural terrain is computed seamlessly. */
  at(p: LngLat): string {
    const i = this.index(p);
    if (i >= 0) return this.ids[this.cells[i] & KIND];
    return proceduralTerrain(p[0], p[1]);
  }
}

