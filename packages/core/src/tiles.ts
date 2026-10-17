import { LIBERATED_CELL, type FrontNode, type Team } from './state';
import { distKm, type LngLat } from './geo';
import { OccupiedIndex } from './frontline';

export const TILE_CW = LIBERATED_CELL.lng; // 0.02° ≈ 1.5 km
export const TILE_CH = LIBERATED_CELL.lat; // 0.0135° ≈ 1.5 km

export function cellOf(p: LngLat): [number, number] {
  return [Math.floor(p[0] / TILE_CW), Math.floor(p[1] / TILE_CH)];
}

export function cellCenter(ix: number, iy: number): LngLat {
  return [(ix + 0.5) * TILE_CW, (iy + 0.5) * TILE_CH];
}

export function cellKey(ix: number, iy: number): number {
  return ix * 100000 + iy;
}

export function keyToCell(key: number): [number, number] {
  const ix = Math.floor(key / 100000);
  const iy = key % 100000;
  return [ix, iy];
}

export function isAdjacentCell(a: [number, number], b: [number, number], allowDiagonal = false): boolean {
  const dx = Math.abs(a[0] - b[0]);
  const dy = Math.abs(a[1] - b[1]);
  if (dx === 0 && dy === 0) return false;
  return allowDiagonal ? dx <= 1 && dy <= 1 : dx + dy === 1;
}

export class TileMap {
  readonly tiles = new Map<number, Team>();
  private occIndex: OccupiedIndex | null = null;
  minIx = 0;
  maxIx = 0;
  minIy = 0;
  maxIy = 0;

  constructor() {}

  initFromMap(bounds: [number, number, number, number], initialFront: FrontNode[], closure: LngLat[]) {
    this.tiles.clear();
    const [minLng, minLat, maxLng, maxLat] = bounds;
    this.minIx = Math.floor(minLng / TILE_CW);
    this.maxIx = Math.ceil(maxLng / TILE_CW);
    this.minIy = Math.floor(minLat / TILE_CH);
    this.maxIy = Math.ceil(maxLat / TILE_CH);

    this.occIndex = closure.length > 0 && initialFront.length > 0 ? new OccupiedIndex(initialFront, closure) : null;
  }

  ownerOf(ix: number, iy: number): Team | undefined {
    let t = this.tiles.get(cellKey(ix, iy));
    if (t !== undefined) return t;
    if (this.occIndex) {
      if (
        (this.minIx !== 0 || this.maxIx !== 0) &&
        (ix < this.minIx || ix > this.maxIx || iy < this.minIy || iy > this.maxIy)
      ) {
        return undefined;
      }
      t = this.occIndex.contains(cellCenter(ix, iy)) ? 1 : 0;
      this.tiles.set(cellKey(ix, iy), t);
    }
    return t;
  }

  ownerAt(p: LngLat): Team | undefined {
    const [ix, iy] = cellOf(p);
    return this.ownerOf(ix, iy);
  }

  setOwner(ix: number, iy: number, team: Team) {
    this.tiles.set(cellKey(ix, iy), team);
    // Also cache adjacent cells so border tracing stays continuous
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        this.ownerOf(ix + dx, iy + dy);
      }
    }
  }

  /**
   * Returns all border tiles for a team:
   * A tile owned by `team` that has at least one 4-neighbor owned by `1 - team`.
   */
  getBorderTiles(team: Team): [number, number][] {
    const borders: [number, number][] = [];
    const oppTeam = (1 - team) as Team;
    for (const [key, owner] of this.tiles) {
      if (owner !== team) continue;
      const [ix, iy] = keyToCell(key);
      const isBorder =
        this.ownerOf(ix, iy - 1) === oppTeam ||
        this.ownerOf(ix + 1, iy) === oppTeam ||
        this.ownerOf(ix, iy + 1) === oppTeam ||
        this.ownerOf(ix - 1, iy) === oppTeam;
      if (isBorder) borders.push([ix, iy]);
    }
    return borders;
  }

  /**
   * Trace the front line along the boundaries of tiles between Team 0 and Team 1.
   * Directed so Team 0 is on the left and Team 1 is on the right.
   */
  extractFrontline(): FrontNode[] {
    type Pt = [number, number];
    const vkey = (gx: number, gy: number) => gx * 100000 + gy;
    const edges = new Map<number, Pt[]>();

    const addEdge = (ax: number, ay: number, bx: number, by: number) => {
      const k = vkey(ax, ay);
      const list = edges.get(k);
      if (list) list.push([bx, by]);
      else edges.set(k, [[bx, by]]);
    };

    // Directed edges of Team 1 cells adjacent to Team 0 cells:
    for (const [k, owner] of this.tiles) {
      if (owner !== 1) continue;
      const [ix, iy] = keyToCell(k);
      // South
      if (this.ownerOf(ix, iy - 1) === 0) addEdge(ix, iy, ix + 1, iy);
      // East
      if (this.ownerOf(ix + 1, iy) === 0) addEdge(ix + 1, iy, ix + 1, iy + 1);
      // North
      if (this.ownerOf(ix, iy + 1) === 0) addEdge(ix + 1, iy + 1, ix, iy + 1);
      // West
      if (this.ownerOf(ix - 1, iy) === 0) addEdge(ix, iy + 1, ix, iy);
    }

    if (edges.size === 0) return [];

    // Find westernmost vertex (lowest x) to start polyline
    let startNode: Pt | null = null;
    let minX = Infinity;
    for (const [k] of edges) {
      const gx = Math.floor(k / 100000);
      const gy = k % 100000;
      if (gx < minX) {
        minX = gx;
        startNode = [gx, gy];
      }
    }

    if (!startNode) return [];

    const polyline: Pt[] = [startNode];
    let cur = startNode;
    const visited = new Set<string>();

    for (let step = 0; step < 4000; step++) {
      const k = vkey(cur[0], cur[1]);
      const outgoing = edges.get(k);
      if (!outgoing || !outgoing.length) break;

      let next: Pt | null = null;
      for (const cand of outgoing) {
        const eKey = `${cur[0]},${cur[1]}->${cand[0]},${cand[1]}`;
        if (!visited.has(eKey)) {
          visited.add(eKey);
          next = cand;
          break;
        }
      }
      if (!next) break;
      polyline.push(next);
      cur = next;
    }

    // Convert grid vertices to geographic FrontNode coordinates
    return polyline.map((pt) => ({
      lng: pt[0] * TILE_CW,
      lat: pt[1] * TILE_CH,
      v: 0,
    }));
  }
}

/**
 * Removes dead-end spurs (backtracking edges A -> B -> A), self-intersections, and duplicate points.
 */
export function removeSpurs(nodes: FrontNode[]): FrontNode[] {
  let changed = true;
  let pts = nodes;
  let passes = 0;
  while (changed && passes < 200) {
    passes++;
    changed = false;
    const next: FrontNode[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      // Consecutive duplicate point check (A -> A)
      if (next.length >= 1) {
        const last = next[next.length - 1];
        if (Math.abs(p.lng - last.lng) < 1e-5 && Math.abs(p.lat - last.lat) < 1e-5) {
          changed = true;
          continue;
        }
      }
      // Dead-end spur check (A -> B -> A)
      if (next.length >= 2) {
        const prevPrev = next[next.length - 2];
        if (Math.abs(p.lng - prevPrev.lng) < 1e-5 && Math.abs(p.lat - prevPrev.lat) < 1e-5) {
          next.pop(); // Remove B
          changed = true;
          continue; // p matches prevPrev, which is already at the end of next
        }
      }
      next.push(p);
    }
    pts = next;
  }
  return pts;
}

/**
 * Subdivides multi-tile straight segments into discrete 1-tile orthogonal edges.
 * Ensures every segment along the front line is exactly 1 tile edge long (TILE_CW or TILE_CH).
 */
export function subdivideTileEdges(nodes: FrontNode[]): FrontNode[] {
  if (nodes.length <= 1) return nodes;
  const cw = TILE_CW;
  const ch = TILE_CH;
  const out: FrontNode[] = [nodes[0]];

  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const dxSteps = Math.round((b.lng - a.lng) / cw);
    const dySteps = Math.round((b.lat - a.lat) / ch);

    if (dxSteps !== 0 && dySteps !== 0) {
      // Diagonal segment: split into orthogonal steps
      const cornerLng = a.lng + dxSteps * cw;
      const cornerLat = a.lat;
      const xSteps = Math.abs(dxSteps);
      const xDir = Math.sign(dxSteps);
      for (let s = 1; s <= xSteps; s++) {
        out.push({
          lng: a.lng + s * xDir * cw,
          lat: a.lat,
          v: a.v,
        });
      }
      const ySteps = Math.abs(dySteps);
      const yDir = Math.sign(dySteps);
      for (let s = 1; s <= ySteps; s++) {
        out.push({
          lng: cornerLng,
          lat: cornerLat + s * yDir * ch,
          v: b.v,
        });
      }
    } else if (dxSteps !== 0) {
      const xSteps = Math.abs(dxSteps);
      const xDir = Math.sign(dxSteps);
      for (let s = 1; s <= xSteps; s++) {
        const t = s / xSteps;
        out.push({
          lng: a.lng + s * xDir * cw,
          lat: a.lat,
          v: a.v + (b.v - a.v) * t,
        });
      }
    } else if (dySteps !== 0) {
      const ySteps = Math.abs(dySteps);
      const yDir = Math.sign(dySteps);
      for (let s = 1; s <= ySteps; s++) {
        const t = s / ySteps;
        out.push({
          lng: a.lng,
          lat: a.lat + s * yDir * ch,
          v: a.v + (b.v - a.v) * t,
        });
      }
    }
  }
  return out;
}

/**
 * Snaps an authored continuous front line to follow exact orthogonal tile boundaries.
 */
export function snapFrontToTileEdges(nodes: FrontNode[]): FrontNode[] {
  const cw = TILE_CW;
  const ch = TILE_CH;
  const out: FrontNode[] = [];
  for (const p of nodes) {
    const gx = Math.round(p.lng / cw) * cw;
    const gy = Math.round(p.lat / ch) * ch;
    if (!out.length) {
      out.push({ lng: gx, lat: gy, v: p.v });
    } else {
      const last = out[out.length - 1];
      if (Math.abs(last.lng - gx) > 1e-6 || Math.abs(last.lat - gy) > 1e-6) {
        if (Math.abs(last.lng - gx) > 1e-6 && Math.abs(last.lat - gy) > 1e-6) {
          out.push({ lng: gx, lat: last.lat, v: p.v });
        }
        out.push({ lng: gx, lat: gy, v: p.v });
      }
    }
  }
  return subdivideTileEdges(removeSpurs(out));
}

/**
 * Advances the tile-boundary front line past a captured cell, wrapping around its far edges.
 * Replaces the shared boundary segment with the perimeter path on the opposite side of the cell.
 */
export function advanceFrontOverCell(front: FrontNode[], cell: [number, number], team: 0 | 1): FrontNode[] {
  const cleanFront = subdivideTileEdges(removeSpurs(front));
  const cw = TILE_CW;
  const ch = TILE_CH;
  const [ix, iy] = cell;
  const x0 = ix * cw, x1 = (ix + 1) * cw;
  const y0 = iy * ch, y1 = (iy + 1) * ch;

  // Cell vertices in counter-clockwise order:
  // 0: SW [x0, y0]
  // 1: SE [x1, y0]
  // 2: NE [x1, y1]
  // 3: NW [x0, y1]
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];

  const cornerIdx = (p: { lng: number; lat: number }) => {
    return corners.findIndex(([cx, cy]) => Math.abs(p.lng - cx) < 1e-4 && Math.abs(p.lat - cy) < 1e-4);
  };

  const isAdjacentCorners = (cA: number, cB: number) => {
    const diff = Math.abs(cA - cB);
    return diff === 1 || diff === 3;
  };

  // Find longest contiguous run of shared perimeter edges in front
  let bestStart = -1;
  let bestEnd = -1;
  for (let i = 0; i < cleanFront.length - 1; i++) {
    const cA = cornerIdx(cleanFront[i]);
    const cB = cornerIdx(cleanFront[i + 1]);
    if (cA !== -1 && cB !== -1 && isAdjacentCorners(cA, cB)) {
      let j = i + 1;
      while (j < cleanFront.length - 1) {
        const cNext = cornerIdx(cleanFront[j + 1]);
        if (cNext !== -1 && isAdjacentCorners(cornerIdx(cleanFront[j]), cNext)) {
          j++;
        } else {
          break;
        }
      }
      if (j - i > bestEnd - bestStart) {
        bestStart = i;
        bestEnd = j;
      }
    }
  }

  if (bestStart !== -1 && bestEnd !== -1 && bestEnd > bestStart) {
    const inC = cornerIdx(cleanFront[bestStart]);
    const outC = cornerIdx(cleanFront[bestEnd]);

    if (inC !== -1 && outC !== -1) {
      if (inC === outC) {
        // Enclosed loop completely absorbed
        const newFront = [
          ...cleanFront.slice(0, bestStart),
          ...cleanFront.slice(bestEnd),
        ];
        return subdivideTileEdges(removeSpurs(newFront));
      }

      // Path CCW: (c + 1) % 4
      const ccw: [number, number][] = [];
      for (let c = inC; ; c = (c + 1) % 4) {
        ccw.push(corners[c]);
        if (c === outC) break;
      }
      // Path CW: (c + 3) % 4
      const cwP: [number, number][] = [];
      for (let c = inC; ; c = (c + 3) % 4) {
        cwP.push(corners[c]);
        if (c === outC) break;
      }

      const oldEdgeCount = bestEnd - bestStart;
      let replacement: [number, number][];

      if (ccw.length - 1 === oldEdgeCount && cwP.length - 1 !== oldEdgeCount) {
        replacement = cwP;
      } else if (cwP.length - 1 === oldEdgeCount && ccw.length - 1 !== oldEdgeCount) {
        replacement = ccw;
      } else {
        // Compare intermediate vertices
        const oldMid = cleanFront[bestStart + 1];
        const ccwHasOldMid = ccw.some(([x, y]) => Math.abs(x - oldMid.lng) < 1e-4 && Math.abs(y - oldMid.lat) < 1e-4);
        replacement = ccwHasOldMid ? cwP : ccw;
      }

      const repNodes: FrontNode[] = replacement.map(([lng, lat]) => ({
        lng,
        lat,
        v: 0,
      }));

      const newFront = [
        ...cleanFront.slice(0, bestStart),
        ...repNodes,
        ...cleanFront.slice(bestEnd + 1),
      ];

      return subdivideTileEdges(removeSpurs(newFront));
    }
  }

  // Fallback: replace nearest front segment
  const center = cellCenter(ix, iy);
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < cleanFront.length - 1; i++) {
    const midLng = (cleanFront[i].lng + cleanFront[i + 1].lng) / 2;
    const midLat = (cleanFront[i].lat + cleanFront[i + 1].lat) / 2;
    const d = distKm(center, [midLng, midLat]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0 && bestDist <= 4.0) {
    const pA = cleanFront[bestIdx];
    const pB = cleanFront[bestIdx + 1];
    const cA = cornerIdx(pA);
    const cB = cornerIdx(pB);

    let replacement: [number, number][];
    if (cA !== -1 && cB !== -1 && cA !== cB) {
      const ccw: [number, number][] = [];
      for (let c = cA; ; c = (c + 1) % 4) { ccw.push(corners[c]); if (c === cB) break; }
      const cwP: [number, number][] = [];
      for (let c = cA; ; c = (c + 3) % 4) { cwP.push(corners[c]); if (c === cB) break; }
      replacement = ccw.length === 2 ? cwP : ccw;
    } else {
      replacement = team === 0
        ? [[x0, y1], [x1, y1], [x1, y0], [x0, y0]]
        : [[x1, y0], [x0, y0], [x0, y1], [x1, y1]];
    }

    const repNodes: FrontNode[] = replacement.map(([lng, lat]) => ({ lng, lat, v: 0 }));
    const newFront = [...cleanFront.slice(0, bestIdx), ...repNodes, ...cleanFront.slice(bestIdx + 2)];
    return subdivideTileEdges(removeSpurs(newFront));
  }

  return cleanFront;
}

/**
 * Traces the perimeter of a set of 4-connected grid cells into a closed polygon ring.
 * The resulting ring traverses the outer boundary counter-clockwise.
 */
export function cellsToRing(cells: [number, number][]): FrontNode[] {
  if (!cells.length) return [];
  const cw = TILE_CW;
  const ch = TILE_CH;
  const set = new Set<number>();
  for (const [ix, iy] of cells) set.add(cellKey(ix, iy));

  type Pt = [number, number];
  const edges = new Map<string, Pt[]>();
  const addEdge = (ax: number, ay: number, bx: number, by: number) => {
    const k = `${ax.toFixed(6)},${ay.toFixed(6)}`;
    const list = edges.get(k);
    if (list) list.push([bx, by]);
    else edges.set(k, [[bx, by]]);
  };

  for (const [ix, iy] of cells) {
    const x0 = ix * cw, x1 = (ix + 1) * cw;
    const y0 = iy * ch, y1 = (iy + 1) * ch;

    // South (bottom) edge: goes West -> East
    if (!set.has(cellKey(ix, iy - 1))) addEdge(x0, y0, x1, y0);
    // East (right) edge: goes South -> North
    if (!set.has(cellKey(ix + 1, iy))) addEdge(x1, y0, x1, y1);
    // North (top) edge: goes East -> West
    if (!set.has(cellKey(ix, iy + 1))) addEdge(x1, y1, x0, y1);
    // West (left) edge: goes North -> South
    if (!set.has(cellKey(ix - 1, iy))) addEdge(x0, y1, x0, y0);
  }

  if (edges.size === 0) return [];

  // Pick lowest x (westernmost) as start point
  let startPt: Pt | null = null;
  let minX = Infinity;
  for (const k of edges.keys()) {
    const [sx, sy] = k.split(',').map(Number);
    if (sx < minX) {
      minX = sx;
      startPt = [sx, sy];
    }
  }

  if (!startPt) return [];

  const ring: FrontNode[] = [{ lng: startPt[0], lat: startPt[1], v: 0 }];
  let cur = startPt;
  const visited = new Set<string>();

  for (let step = 0; step < 2000; step++) {
    const k = `${cur[0].toFixed(6)},${cur[1].toFixed(6)}`;
    const outgoing = edges.get(k);
    if (!outgoing || !outgoing.length) break;

    let next: Pt | null = null;
    for (const cand of outgoing) {
      const eKey = `${cur[0].toFixed(6)},${cur[1].toFixed(6)}->${cand[0].toFixed(6)},${cand[1].toFixed(6)}`;
      if (!visited.has(eKey)) {
        visited.add(eKey);
        next = cand;
        break;
      }
    }
    if (!next) break;

    ring.push({ lng: next[0], lat: next[1], v: 0 });
    cur = next;
    if (Math.abs(cur[0] - startPt[0]) < 1e-4 && Math.abs(cur[1] - startPt[1]) < 1e-4) {
      break;
    }
  }

  return subdivideTileEdges(removeSpurs(ring));
}

/**
 * Checks if a grid cell of a team is encircled in a cauldron.
 * Explores 4-orthogonal friendly neighbors (NO DIAGONALS).
 * If all paths are blocked by enemy/water tiles and cannot reach deep friendly rear (>= 8 tiles)
 * or a friendly base, it returns all cells in the enclosed cauldron.
 */
export function findEncircledCauldron(
  startCell: [number, number],
  team: Team,
  tileMap: TileMap,
  isBaseOrDeepRear: (cell: [number, number], team: Team) => boolean,
  maxCells = 30
): [number, number][] | null {
  const dirs: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  const visited = new Set<number>();
  const queue: [number, number][] = [startCell];
  visited.add(cellKey(startCell[0], startCell[1]));

  let head = 0;
  while (head < queue.length) {
    const [cx, cy] = queue[head++];

    // If we reached a friendly base or deep rear corridor, we are NOT encircled!
    if (isBaseOrDeepRear([cx, cy], team)) {
      return null;
    }

    // If the component is too large (> maxCells), it's part of the main territory
    if (visited.size > maxCells) {
      return null;
    }

    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      const nk = cellKey(nx, ny);
      if (visited.has(nk)) continue;

      if (tileMap.ownerOf(nx, ny) === team) {
        visited.add(nk);
        queue.push([nx, ny]);
      }
    }
  }

  // The queue emptied and we visited <= maxCells: all 4 outer directions lead to non-friendly tiles!
  // This group of cells is an encircled cauldron!
  return queue;
}

/**
 * Detects encircled cauldrons (pockets) on the tile map.
 * Any group of cells of team T that cannot reach home territory / HQ / rear edge
 * via 4-orthogonal friendly neighbors (NO DIAGONALS) is considered a cauldron.
 */
export function detectTileCauldrons(
  tileMap: TileMap,
  garrisons: { team: Team; pos: LngLat }[],
  bases: { team: Team; pos: LngLat }[] = []
): { team: Team; cells: [number, number][]; nodes: FrontNode[] }[] {
  const cauldrons: { team: Team; cells: [number, number][]; nodes: FrontNode[] }[] = [];
  const processedCells = new Set<number>();

  const baseCellsByTeam = new Map<Team, Set<number>>();
  baseCellsByTeam.set(0, new Set<number>());
  baseCellsByTeam.set(1, new Set<number>());
  if (bases) {
    for (const b of bases) {
      baseCellsByTeam.get(b.team)?.add(cellKey(cellOf(b.pos)[0], cellOf(b.pos)[1]));
    }
  }

  for (const g of garrisons) {
    const startCell = cellOf(g.pos);
    const sk = cellKey(startCell[0], startCell[1]);
    if (processedCells.has(sk)) continue;

    // Check if tileMap owner matches garrison team
    if (tileMap.ownerOf(startCell[0], startCell[1]) !== g.team) continue;

    const pocketCells = findEncircledCauldron(
      startCell,
      g.team,
      tileMap,
      (c, team) => {
        if (baseCellsByTeam.get(team)?.has(cellKey(c[0], c[1]))) return true;
        if (tileMap.maxIy && tileMap.minIy) {
          if (team === 0 && c[1] >= tileMap.maxIy - 1) return true;
          if (team === 1 && c[1] <= tileMap.minIy + 1) return true;
        }
        return false;
      },
      30
    );

    if (pocketCells && pocketCells.length > 0) {
      for (const c of pocketCells) {
        processedCells.add(cellKey(c[0], c[1]));
      }
      const ring = cellsToRing(pocketCells);
      if (ring.length >= 4) {
        cauldrons.push({
          team: g.team,
          cells: pocketCells,
          nodes: ring,
        });
      }
    }
  }

  return cauldrons;
}

