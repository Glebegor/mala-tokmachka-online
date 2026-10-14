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
  // search scratch space, reused between queries: an entry is only valid when its stamp equals the current epoch
  private g = new Float64Array(0);
  private prev = new Int32Array(0);
  private stamp = new Uint32Array(0);
  private closed = new Uint32Array(0);
  private epoch = 0;

  /** Start a new search without clearing (or reallocating) arrays the size of the whole graph. */
  private begin() {
    const n = this.nodes.length;
    if (this.g.length !== n) {
      this.g = new Float64Array(n);
      this.prev = new Int32Array(n);
      this.stamp = new Uint32Array(n);
      this.closed = new Uint32Array(n);
      this.epoch = 0;
    }
    this.epoch++;
    return this.epoch;
  }
  private cost(i: number) {
    return this.stamp[i] === this.epoch ? this.g[i] : Infinity;
  }
  private setCost(i: number, c: number, from: number) {
    this.stamp[i] = this.epoch;
    this.g[i] = c;
    this.prev[i] = from;
  }

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
    for (const id of ends) {
      const self = this.adj[id][0].to;
      let best = -1;
      let bestD = km;
      this.around(this.nodes[id], km, (other) => {
        if (other === id || other === self) return;
        const d = distKm(this.nodes[id], this.nodes[other]);
        if (d < bestD) {
          bestD = d;
          best = other;
        }
      });
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

  isNear(p: LngLat, km: number): boolean {
    return this.nearest(p, km) >= 0;
  }

  /** A* over the graph. Returns node ids from a to b, or null when not connected. */
  path(a: number, b: number): { nodes: number[]; km: number } | null {
    if (a === b) return { nodes: [a], km: 0 };
    const epoch = this.begin();
    const goal = this.nodes[b];
    const heap = new MinHeap();
    this.setCost(a, 0, -1);
    heap.push(a, distKm(this.nodes[a], goal));
    while (heap.size) {
      const cur = heap.pop();
      if (cur === b) break;
      if (this.closed[cur] === epoch) continue;
      this.closed[cur] = epoch;
      const gc = this.g[cur];
      for (const e of this.adj[cur]) {
        const c = gc + e.km;
        if (c < this.cost(e.to)) {
          this.setCost(e.to, c, cur);
          heap.push(e.to, c + distKm(this.nodes[e.to], goal));
        }
      }
    }
    if (this.cost(b) === Infinity) return null;
    const nodes: number[] = [];
    for (let c = b; c !== -1; c = this.prev[c]) nodes.push(c);
    nodes.reverse();
    return { nodes, km: this.g[b] };
  }

  /** Up to `k` road nodes around p, nearest first, that `accept` (e.g. reachable without crossing a river). */
  private candidates(p: LngLat, maxKm: number, k: number, accept: (node: LngLat) => boolean): { id: number; km: number }[] {
    // widen the search only when nothing usable is close: the national network is dense, a 45 km disc holds thousands of nodes
    for (const radius of [Math.min(6, maxKm), Math.min(18, maxKm), maxKm]) {
      const near: { id: number; km: number }[] = [];
      this.around(p, radius, (id) => {
        const km = distKm(p, this.nodes[id]);
        if (km <= radius) near.push({ id, km });
      });
      near.sort((a, b) => a.km - b.km);
      const out: { id: number; km: number }[] = [];
      // spread the picks out: neighbours on the same road add nothing, a node on another road might
      for (const c of near) {
        if (out.length >= k) break;
        if (out.some((o) => distKm(this.nodes[o.id], this.nodes[c.id]) < 3)) continue;
        if (accept(this.nodes[c.id])) out.push(c);
      }
      if (out.length >= Math.min(k, 3) || radius >= maxKm) return out;
    }
    return [];
  }

  /**
   * Quickest road trip from `from` to `to`, in seconds: leave the start cross-country to one of several nearby road
   * nodes, drive, then leave the road towards the target. `clear(a, b)` says whether the cross-country hop a→b is allowed.
   */
  routeTimed(
    from: LngLat,
    to: LngLat,
    o: { roadSpeed: number; offSpeed: number; clear: (a: LngLat, b: LngLat) => boolean; usable?: (node: LngLat) => boolean; accessKm?: number; k?: number },
  ): { points: LngLat[]; seconds: number } | null {
    const accessKm = o.accessKm ?? 45;
    const k = o.k ?? 6;
    const usable = o.usable ?? (() => true);
    const entries = this.candidates(from, accessKm, k, (n) => usable(n) && o.clear(from, n));
    const exits = this.candidates(to, accessKm, k, (n) => usable(n) && o.clear(n, to));
    if (!entries.length || !exits.length) return null;
    const exitCost = new Map(exits.map((e) => [e.id, e.km / o.offSpeed]));

    const epoch = this.begin();
    const heap = new MinHeap();
    const h = (id: number) => distKm(this.nodes[id], to) / o.roadSpeed;
    for (const e of entries) {
      const c = e.km / o.offSpeed;
      if (c < this.cost(e.id)) {
        this.setCost(e.id, c, -1);
        heap.push(e.id, c + h(e.id));
      }
    }
    let best = Infinity;
    let bestNode = -1;
    while (heap.size) {
      const cur = heap.pop();
      if (this.closed[cur] === epoch) continue;
      this.closed[cur] = epoch;
      const gc = this.g[cur];
      if (gc + h(cur) >= best) break; // nothing left can beat the best finished trip
      const out = exitCost.get(cur);
      if (out !== undefined && gc + out < best) {
        best = gc + out;
        bestNode = cur;
      }
      for (const e of this.adj[cur]) {
        const c = gc + e.km / o.roadSpeed;
        if (c < this.cost(e.to)) {
          this.setCost(e.to, c, cur);
          heap.push(e.to, c + h(e.to));
        }
      }
    }
    if (bestNode < 0) return null;
    const points: LngLat[] = [];
    for (let c = bestNode; c !== -1; c = this.prev[c]) points.push(this.nodes[c]);
    points.reverse();
    return { points, seconds: best };
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

/**
 * Light "is there a road near here" lookup for clients: a grid of road vertices (long segments subdivided),
 * without the routing graph, so it stays small even for a dense national network.
 */
export class RoadIndex {
  private grid = new Map<string, number[]>(); // flat lng,lat pairs per cell

  constructor(lines: RoadLine[], stepKm = 2) {
    for (const line of lines) {
      for (let i = 1; i + 1 < line.length; i += 2) {
        const p: LngLat = [line[i], line[i + 1]];
        this.add(p);
        if (i + 3 < line.length) {
          const q: LngLat = [line[i + 2], line[i + 3]];
          const steps = Math.floor(distKm(p, q) / stepKm);
          for (let k = 1; k <= steps; k++) this.add([p[0] + ((q[0] - p[0]) * k) / (steps + 1), p[1] + ((q[1] - p[1]) * k) / (steps + 1)]);
        }
      }
    }
  }

  private add(p: LngLat) {
    const key = cellKey(p[0], p[1]);
    const b = this.grid.get(key);
    b ? b.push(p[0], p[1]) : this.grid.set(key, [p[0], p[1]]);
  }

  isNear(p: LngLat, km: number): boolean {
    const span = Math.ceil(km / 111 / CELL / Math.max(0.3, Math.cos((p[1] * Math.PI) / 180))) + 1;
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    for (let x = cx - span; x <= cx + span; x++) {
      for (let y = cy - span; y <= cy + span; y++) {
        const b = this.grid.get(`${x},${y}`);
        if (!b) continue;
        for (let i = 0; i < b.length; i += 2) if (distKm(p, [b[i], b[i + 1]]) <= km) return true;
      }
    }
    return false;
  }
}
