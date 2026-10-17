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

export function isAdjacentCell(a: [number, number], b: [number, number], allowDiagonal = true): boolean {
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
    return this.tiles.get(cellKey(ix, iy));
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
  return out;
}

/**
 * Advances the tile-boundary front line past a captured cell, wrapping around its far edges.
 */
export function advanceFrontOverCell(front: FrontNode[], cell: [number, number], team: 0 | 1): FrontNode[] {
  const cw = TILE_CW;
  const ch = TILE_CH;
  const [ix, iy] = cell;
  const x0 = ix * cw, x1 = (ix + 1) * cw;
  const y0 = iy * ch, y1 = (iy + 1) * ch;
  const center = cellCenter(ix, iy);

  // Find the segment i -> i+1 of the front line closest to the captured cell center
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < front.length - 1; i++) {
    const midLng = (front[i].lng + front[i + 1].lng) / 2;
    const midLat = (front[i].lat + front[i + 1].lat) / 2;
    const d = distKm(center, [midLng, midLat]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestDist > 8.0) return front;

  // The replacement edges wrapping around this cell:
  // For Ukraine (team 0): the front line wraps along the East and South edges of the cell
  // so the cell is firmly inside Ukrainian territory.
  // For Russia (team 1): the front line wraps along the West and North edges of the cell.
  const newNodes: FrontNode[] = [];
  if (team === 0) {
    newNodes.push({ lng: x0, lat: y0, v: 0 });
    newNodes.push({ lng: x1, lat: y0, v: 0 });
    newNodes.push({ lng: x1, lat: y1, v: 0 });
    newNodes.push({ lng: x0, lat: y1, v: 0 });
  } else {
    newNodes.push({ lng: x1, lat: y1, v: 0 });
    newNodes.push({ lng: x0, lat: y1, v: 0 });
    newNodes.push({ lng: x0, lat: y0, v: 0 });
    newNodes.push({ lng: x1, lat: y0, v: 0 });
  }

  const out: FrontNode[] = [
    ...front.slice(0, bestIdx + 1),
    ...newNodes,
    ...front.slice(bestIdx + 1),
  ];

  return out;
}
