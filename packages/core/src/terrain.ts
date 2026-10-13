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

/** Terrain lookup. The grid is uniform in longitude and Web-Mercator Y, matching the basemap. */
export class TerrainGrid {
  readonly ids: string[];
  readonly cells: Uint8Array;
  /** 1 where the cell belongs to a body of barrier terrain big enough to block movement (a real river, not a pond). */
  readonly barrier: Uint8Array;
  private yN: number;
  private yS: number;

  /** `barrierMinCells`: terrain id → smallest connected area (in cells) that counts as a barrier. */
  constructor(readonly data: TerrainGridData, barrierMinCells: Record<string, number> = {}) {
    const letters = Object.keys(data.legend);
    this.ids = letters.map((l) => data.legend[l]);
    this.cells = new Uint8Array(data.cols * data.rows);
    let i = 0;
    let count = 0;
    for (let k = 0; k < data.rle.length; k++) {
      const c = data.rle.charCodeAt(k);
      if (c >= 48 && c <= 57) {
        count = count * 10 + (c - 48);
      } else {
        const v = Math.max(0, letters.indexOf(data.rle[k]));
        const n = count || 1;
        this.cells.fill(v, i, i + n);
        i += n;
        count = 0;
      }
    }
    this.yN = mercY(data.north);
    this.yS = mercY(data.south);
    this.barrier = new Uint8Array(this.cells.length);
    this.ids.forEach((id, v) => {
      if (barrierMinCells[id] !== undefined) this.markBarrier(v, barrierMinCells[id]);
    });
  }

  /** Flood-fill connected areas (8-neighbour) of one terrain value and flag the large ones. */
  private markBarrier(value: number, minCells: number) {
    const { cols, rows } = this.data;
    const seen = new Uint8Array(this.cells.length);
    for (let start = 0; start < this.cells.length; start++) {
      if (seen[start] || this.cells[start] !== value) continue;
      const members: number[] = [start];
      seen[start] = 1;
      for (let k = 0; k < members.length; k++) {
        const c = members[k];
        const x = c % cols;
        const y = (c - x) / cols;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const n = ny * cols + nx;
            if (!seen[n] && this.cells[n] === value) {
              seen[n] = 1;
              members.push(n);
            }
          }
        }
      }
      if (members.length >= minCells) for (const c of members) this.barrier[c] = 1;
    }
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
    return i >= 0 && this.barrier[i] === 1;
  }

  /** Terrain id at a position; outside the grid everything is the first legend entry. */
  at(p: LngLat): string {
    const i = this.index(p);
    return this.ids[i < 0 ? 0 : this.cells[i]];
  }
}
