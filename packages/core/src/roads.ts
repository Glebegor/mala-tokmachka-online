import { distKm, type LngLat } from './geo';

/** Packed polyline: [major(0|1), lng, lat, lng, lat, ...] */
export type RoadLine = number[];

interface Edge {
  to: number;
  km: number;
}

const CELL = 0.1; // degrees, spatial hash cell

/**
 * Road graph built from map polylines. Vertices closer than ~100 m are merged, long segments are
 * subdivided so that "nearest node" is a good stand-in for "nearest point on a road".
 */
export class RoadNetwork {
  readonly nodes: LngLat[] = [];
  private adj: Edge[][] = [];
  private index = new Map<string, number>();
  private grid = new Map<string, number[]>();

  constructor(lines: RoadLine[], maxSegmentKm = 4) {
    for (const line of lines) {
      let prev = -1;
      let prevPos: LngLat | null = null;
      for (let i = 1; i + 1 < line.length; i += 2) {
        const pos: LngLat = [line[i], line[i + 1]];
        if (prevPos) {
          const steps = Math.max(1, Math.ceil(distKm(prevPos, pos) / maxSegmentKm));
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const p: LngLat = s === steps ? pos : [prevPos[0] + (pos[0] - prevPos[0]) * t, prevPos[1] + (pos[1] - prevPos[1]) * t];
            const id = this.node(p, s === steps);
            if (id !== prev) this.link(prev, id);
            prev = id;
          }
        } else {
          prev = this.node(pos, true);
        }
        prevPos = pos;
      }
    }
    this.bridgeGaps(1.5);
  }

  /** Source data has roads that end a few hundred metres short of the one they meet: join those dead ends. */
  private bridgeGaps(km: number) {
    const ends = this.adj.map((e, i) => (e.length === 1 ? i : -1)).filter((i) => i >= 0);
    const maxD2 = km * km;
    for (const id of ends) {
      const self = this.adj[id][0].to;
      let best = -1;
      let bestD = km;
      const p = this.nodes[id];
      const cosLat = Math.max(0.3, Math.cos((p[1] * Math.PI) / 180));
      const kmPerDegLat = 111.0;
      const kmPerDegLon = 111.0 * cosLat;
      const span = Math.ceil(km / kmPerDegLat / CELL / cosLat) + 1;
      const cx = Math.floor(p[0] / CELL);
      const cy = Math.floor(p[1] / CELL);

      for (let x = cx - span; x <= cx + span; x++) {
        for (let y = cy - span; y <= cy + span; y++) {
          const bucket = this.grid.get(`${x},${y}`);
          if (!bucket) continue;
          for (let bi = 0; bi < bucket.length; bi++) {
            const other = bucket[bi];
            if (other === id || other === self) continue;
            const otherP = this.nodes[other];
            const dx = (otherP[0] - p[0]) * kmPerDegLon;
            const dy = (otherP[1] - p[1]) * kmPerDegLat;
            const d2 = dx * dx + dy * dy;
            if (d2 < maxD2 && d2 < bestD * bestD) {
              const d = Math.sqrt(d2);
              if (d < bestD) {
                bestD = d;
                best = other;
              }
            }
          }
        }
      }
      if (best >= 0) this.link(id, best);
    }
  }

  private around(p: LngLat, km: number, visit: (id: number) => void) {
    const span = Math.ceil(km / 111 / CELL / Math.max(0.3, Math.cos((p[1] * Math.PI) / 180))) + 1;
    const cx = Math.floor(p[0] / CELL);
    const cy = Math.floor(p[1] / CELL);
    for (let x = cx - span; x <= cx + span; x++) {
      for (let y = cy - span; y <= cy + span; y++) this.grid.get(`${x},${y}`)?.forEach(visit);
    }
  }

  /** Size of each connected component, largest first (diagnostics). */
  components(): number[] {
    const seen = new Uint8Array(this.nodes.length);
    const sizes: number[] = [];
    for (let i = 0; i < seen.length; i++) {
      if (seen[i]) continue;
      let n = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const c = stack.pop()!;
        n++;
        for (const e of this.adj[c]) if (!seen[e.to]) (seen[e.to] = 1), stack.push(e.to);
      }
      sizes.push(n);
    }
    return sizes.sort((a, b) => b - a);
  }

  get size() {
    return this.nodes.length;
  }

  private node(p: LngLat, shared: boolean): number {
    // only authored vertices are merged; interpolated ones are unique to their segment
    const key = shared ? `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}` : '';
    if (shared) {
      const hit = this.index.get(key);
      if (hit !== undefined) return hit;
    }
    const id = this.nodes.length;
    this.nodes.push(p);
    this.adj.push([]);
    if (shared) this.index.set(key, id);
    const cell = cellKey(p[0], p[1]);
    const bucket = this.grid.get(cell);
    if (bucket) bucket.push(id);
    else this.grid.set(cell, [id]);
    return id;
  }

  private link(a: number, b: number) {
    if (a < 0 || this.adj[a].some((e) => e.to === b)) return;
    const km = distKm(this.nodes[a], this.nodes[b]);
    this.adj[a].push({ to: b, km });
    this.adj[b].push({ to: a, km });
  }

  /** Nearest road node within maxKm, or -1. */
  nearest(p: LngLat, maxKm: number): number {
    let best = -1;
    let bestD = maxKm;
    this.around(p, maxKm, (id) => {
      const d = distKm(p, this.nodes[id]);
      if (d <= bestD) {
        bestD = d;
        best = id;
      }
    });
    return best;
  }

  nearestCandidates(p: LngLat, maxKm: number, limit = 3): number[] {
    const list: { id: number; d: number }[] = [];
    this.around(p, maxKm, (id) => {
      const d = distKm(p, this.nodes[id]);
      if (d <= maxKm) list.push({ id, d });
    });
    list.sort((x, y) => x.d - y.d);
    return list.slice(0, limit).map((x) => x.id);
  }

  isNear(p: LngLat, km: number): boolean {
    return this.nearest(p, km) >= 0;
  }

  /** A* over the graph. Returns node ids from a to b, or null when not connected. */
  path(a: number, b: number): { nodes: number[]; km: number } | null {
    if (a === b) return { nodes: [a], km: 0 };
    const n = this.nodes.length;
    const g = new Float64Array(n).fill(Infinity);
    const from = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const goal = this.nodes[b];
    const heap = new MinHeap();
    g[a] = 0;
    heap.push(a, distKm(this.nodes[a], goal));
    while (heap.size) {
      const cur = heap.pop();
      if (cur === b) break;
      if (done[cur]) continue;
      done[cur] = 1;
      for (const e of this.adj[cur]) {
        const cost = g[cur] + e.km;
        if (cost < g[e.to]) {
          g[e.to] = cost;
          from[e.to] = cur;
          heap.push(e.to, cost + distKm(this.nodes[e.to], goal));
        }
      }
    }
    if (g[b] === Infinity) return null;
    const nodes: number[] = [];
    for (let c = b; c !== -1; c = from[c]) nodes.push(c);
    nodes.reverse();
    return { nodes, km: g[b] };
  }

  /**
   * Fastest way from `from` to `to` for something that drives `mult` times faster on roads.
   * Returns road waypoints to follow (may be empty when going cross-country is quicker).
   */
  route(from: LngLat, to: LngLat, mult: number, accessKm = 40): LngLat[] {
    const direct = distKm(from, to);
    if (direct < 8 || mult <= 1) return [];
    const fromNodes = this.nearestCandidates(from, accessKm, 3);
    const toNodes = this.nearestCandidates(to, accessKm, 3);
    if (!fromNodes.length || !toNodes.length) return [];

    let bestP: { nodes: number[]; km: number } | null = null;
    let bestCost = direct * 0.98;

    for (const a of fromNodes) {
      for (const b of toNodes) {
        if (a === b) continue;
        const p = this.path(a, b);
        if (!p) continue;
        const cost = distKm(from, this.nodes[a]) + p.km / mult + distKm(this.nodes[b], to);
        if (cost < bestCost) {
          bestCost = cost;
          bestP = p;
        }
      }
    }

    if (!bestP) return [];
    return this.smoothWaypoints(bestP.nodes.map((id) => this.nodes[id]));
  }

  private smoothWaypoints(pts: LngLat[]): LngLat[] {
    if (pts.length <= 2) return pts;
    const res: LngLat[] = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = res[res.length - 1];
      const cur = pts[i];
      const next = pts[i + 1];
      const dDirect = distKm(prev, next);
      const dViaCur = distKm(prev, cur) + distKm(cur, next);
      // Remove hairpin turn / loop if going straight between prev and next is significantly shorter
      if (dDirect < dViaCur * 0.65 && dDirect < 2.5) {
        continue;
      }
      res.push(cur);
    }
    res.push(pts[pts.length - 1]);
    return res;
  }
}

const cellKey = (lng: number, lat: number) => `${Math.floor(lng / CELL)},${Math.floor(lat / CELL)}`;

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const id = ids.pop()!;
    const key = keys.pop()!;
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}
