/**
 * Outline a set of grid cells as smooth polygons (for the grey and liberated areas). The boundary of the union of cells is
 * traced into closed rings (filled cells on the left: outer rings run counter-clockwise, holes clockwise) and rounded off
 * with Chaikin's corner cutting, so the result reads like a drawn map rather than a staircase of squares.
 */
type Pt = [number, number];

const K = 1 << 16; // key packing for grid vertices (offset keeps negatives positive)
const OFF = 1 << 15;
const vkey = (x: number, y: number) => (x + OFF) * K + (y + OFF);

export function cellsToMultiPolygon(cells: Iterable<[number, number]>, cw: number, ch: number, smooth = 2): Pt[][][] {
  const filled = new Set<number>();
  for (const [x, y] of cells) filled.add(vkey(x, y));
  if (!filled.size) return [];
  const has = (x: number, y: number) => filled.has(vkey(x, y));

  // directed boundary edges, keyed by their start vertex
  const out = new Map<number, Pt[]>();
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const k = vkey(ax, ay);
    const list = out.get(k);
    list ? list.push([bx, by]) : out.set(k, [[bx, by]]);
  };
  for (const k of filled) {
    const x = Math.floor(k / K) - OFF, y = (k % K) - OFF;
    if (!has(x, y - 1)) add(x, y, x + 1, y);
    if (!has(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!has(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!has(x - 1, y)) add(x, y + 1, x, y);
  }

  // follow edges into rings; at a vertex with two ways on (cells touching corner to corner) turn left, keeping them apart
  const rings: Pt[][] = [];
  for (const [startKey, ends] of out) {
    while (ends.length) {
      const sx = Math.floor(startKey / K) - OFF, sy = (startKey % K) - OFF;
      const ring: Pt[] = [[sx, sy]];
      let [px, py] = [sx, sy];
      let [nx, ny] = ends.pop()!;
      for (let guard = 0; guard < 1e6; guard++) {
        ring.push([nx, ny]);
        if (nx === sx && ny === sy) break;
        const cand = out.get(vkey(nx, ny));
        if (!cand?.length) break;
        let pick = 0;
        if (cand.length > 1) {
          const dx = nx - px, dy = ny - py;
          // filled cells lie on the left: turning left stays on the same cell (left of (dx, dy) is (-dy, dx))
          const left = cand.findIndex(([cx, cy]) => cx - nx === -dy && cy - ny === dx);
          pick = left >= 0 ? left : 0;
        }
        const [qx, qy] = cand.splice(pick, 1)[0];
        [px, py, nx, ny] = [nx, ny, qx, qy];
      }
      ring.pop(); // closing point
      // every cell-sized step is kept: corner cutting then only rounds the corners and turns staircases into smooth slopes
      if (ring.length >= 4) rings.push(ring);
    }
  }

  // outer rings and their holes (a hole goes to the smallest outer ring around it)
  const outers: { ring: Pt[]; area: number; holes: Pt[][] }[] = [];
  const holes: Pt[][] = [];
  for (const r of rings) (area(r) > 0 ? outers.push({ ring: r, area: area(r), holes: [] }) : holes.push(r));
  outers.sort((a, b) => a.area - b.area);
  for (const h of holes) {
    outers.find((o) => inside(midOfEdge(h), o.ring))?.holes.push(h);
  }
  const toGeo = (r: Pt[]): Pt[] => {
    let s = r;
    for (let i = 0; i < smooth; i++) s = chaikin(s);
    const g = s.map(([x, y]): Pt => [x * cw, y * ch]);
    g.push(g[0]);
    return g;
  };
  return outers.map((o) => [toGeo(o.ring), ...o.holes.map(toGeo)]);
}

function chaikin(r: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  return out;
}

function area(r: Pt[]): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** A point just beside the first edge of a hole, inside the hole's surrounding filled area. */
function midOfEdge(h: Pt[]): Pt {
  return [(h[0][0] + h[1][0]) / 2, (h[0][1] + h[1][1]) / 2];
}

function inside(p: Pt, r: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (r[i][1] > p[1] !== r[j][1] > p[1] && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return c;
}
