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
  private yN: number;
  private yS: number;

  constructor(readonly data: TerrainGridData) {
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
  }

  /** Terrain id at a position; outside the grid everything is the first legend entry. */
  at(p: LngLat): string {
    const d = this.data;
    const x = Math.floor(((p[0] - d.west) / (d.east - d.west)) * d.cols);
    const y = Math.floor(((this.yN - mercY(p[1])) / (this.yN - this.yS)) * d.rows);
    if (x < 0 || y < 0 || x >= d.cols || y >= d.rows) return this.ids[0];
    return this.ids[this.cells[y * d.cols + x]];
  }
}
