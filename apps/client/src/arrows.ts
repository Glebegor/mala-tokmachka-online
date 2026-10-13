import type maplibregl from 'maplibre-gl';
import { distKm, kmPerDegLng, nearestNode, type FrontNode, type LngLat, type Shot } from '@sw/core';

interface Arrow {
  tail: LngLat;
  bend: LngLat;
  tip: LngLat;
  team: 0 | 1;
  power: number; // 0..1
  seed: number;
  alpha: number; // fades in and out with the fighting
  live: boolean;
}

const WINDOW_MS = 5000; // how long a shot keeps a battle "hot"
const CELL_LNG = 0.3, CELL_LAT = 0.2; // battles are grouped per ~22 km cell

/**
 * Attack arrows in the style of situation maps. An arrow appears only where units are actually fighting, and only for
 * fights the player can see: it is built from the shots the server reports, which are already filtered by fog of war.
 */
export class FrontArrows {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private arrows = new Map<string, Arrow>();
  private shots: { t: number; s: Shot }[] = [];
  private raf = 0;
  private lastBuild = 0;
  private lastDraw = 0;

  constructor(private map: maplibregl.Map, parent: HTMLElement, private colors: string[], private front: () => FrontNode[]) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fx arrows';
    parent.append(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    const loop = () => {
      const now = performance.now();
      if (now - this.lastBuild > 400) (this.lastBuild = now), this.rebuild(now);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  /** Shots from the latest snapshot (visible ones only). */
  feed(shots: Shot[]) {
    const t = performance.now();
    for (const s of shots) this.shots.push({ t, s });
    if (this.shots.length > 3000) this.shots.splice(0, this.shots.length - 3000);
  }

  /** Group recent fire into battles and aim one arrow per battle from the attackers at what they are shooting at. */
  private rebuild(now: number) {
    this.shots = this.shots.filter((x) => now - x.t < WINDOW_MS);
    interface Side { n: number; fx: number; fy: number; tx: number; ty: number }
    const cells = new Map<string, [Side, Side]>();
    for (const { s } of this.shots) {
      const mx = (s.from[0] + s.to[0]) / 2, my = (s.from[1] + s.to[1]) / 2;
      const key = `${Math.floor(mx / CELL_LNG)}|${Math.floor(my / CELL_LAT)}`;
      let c = cells.get(key);
      if (!c) cells.set(key, (c = [{ n: 0, fx: 0, fy: 0, tx: 0, ty: 0 }, { n: 0, fx: 0, fy: 0, tx: 0, ty: 0 }]));
      const side = c[s.team];
      side.n++;
      side.fx += s.from[0];
      side.fy += s.from[1];
      side.tx += s.to[0];
      side.ty += s.to[1];
    }
    for (const a of this.arrows.values()) a.live = false;
    const front = this.front();
    for (const [key, c] of cells) {
      if (c[0].n + c[1].n < 4) continue; // a stray shot is not a battle
      // the attacker is whoever the front is yielding to here; with a static front, whoever is firing more
      let team: 0 | 1 = c[0].n >= c[1].n ? 0 : 1;
      const any = c[team];
      const mid: LngLat = [(any.fx + any.tx) / (2 * any.n), (any.fy + any.ty) / (2 * any.n)];
      if (front.length) {
        const v = front[nearestNode(front, mid)].v;
        if (v > 0 && c[0].n) team = 0;
        else if (v < 0 && c[1].n) team = 1;
      }
      const side = c[team];
      if (side.n < 2) continue;
      let from: LngLat = [side.fx / side.n, side.fy / side.n];
      const to: LngLat = [side.tx / side.n, side.ty / side.n];
      const kx = kmPerDegLng(to[1]);
      let dx = (to[0] - from[0]) * kx, dy = (to[1] - from[1]) * 111.32;
      const len = Math.hypot(dx, dy);
      if (len < 0.05) continue;
      dx /= len;
      dy /= len;
      const power = Math.min(1, (c[0].n + c[1].n) / 40);
      // start a little behind the attackers and never draw a stub
      const back = Math.max(5, 12 + 10 * power - len);
      from = [from[0] - (dx * back) / kx, from[1] - (dy * back) / 111.32];
      const total = distKm(from, to);
      const hand = (parseInt(key.replace(/\D/g, '').slice(-3) || '0', 10) % 2 ? 1 : -1) * total * 0.16;
      const bend: LngLat = [(from[0] + to[0]) / 2 + (-dy * hand) / kx, (from[1] + to[1]) / 2 + (dx * hand) / 111.32];
      const id = `${key}|${team}`;
      const old = this.arrows.get(id);
      if (old) {
        // ease towards the new position so the arrow does not jitter with every volley
        const mix = (a: LngLat, b: LngLat): LngLat => [a[0] + (b[0] - a[0]) * 0.35, a[1] + (b[1] - a[1]) * 0.35];
        old.tail = mix(old.tail, from);
        old.bend = mix(old.bend, bend);
        old.tip = mix(old.tip, to);
        old.power += (power - old.power) * 0.35;
        old.live = true;
      } else {
        this.arrows.set(id, { tail: from, bend, tip: to, team, power, seed: Math.random() * 6, alpha: 0, live: true });
      }
    }
  }

  private draw() {
    const { canvas, g, map } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) (canvas.width = w * dpr), (canvas.height = h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const now = performance.now() / 1000;
    const dt = Math.min(0.5, now - (this.lastDraw || now));
    this.lastDraw = now;
    if (!this.arrows.size) return;

    for (const [id, a] of this.arrows) {
      // fade in over ~0.4 s and out over ~1 s, whatever the frame rate
      a.alpha = a.live ? Math.min(1, a.alpha + dt * 2.5) : Math.max(0, a.alpha - dt);
      if (!a.live && a.alpha <= 0) {
        this.arrows.delete(id);
        continue;
      }
      let p0 = map.project(a.tail), p1 = map.project(a.bend), p2 = map.project(a.tip);
      // keep arrows readable when zoomed far out: stretch short ones about their tip
      const len = Math.hypot(p2.x - p0.x, p2.y - p0.y);
      const minLen = 34 + 22 * a.power;
      if (len < minLen && len > 0.01) {
        const k = minLen / len;
        p0 = { x: p2.x + (p0.x - p2.x) * k, y: p2.y + (p0.y - p2.y) * k } as any;
        p1 = { x: p2.x + (p1.x - p2.x) * k, y: p2.y + (p1.y - p2.y) * k } as any;
      }
      if (Math.max(p0.x, p2.x) < -80 || Math.min(p0.x, p2.x) > w + 80 || Math.max(p0.y, p2.y) < -80 || Math.min(p0.y, p2.y) > h + 80) continue;
      const L = Math.max(len, minLen);
      const headLen = Math.min(L * 0.34, 12 + L * 0.16);
      const bodyW = Math.min(15, 3.5 + L * 0.07) * (0.75 + 0.5 * a.power);
      const headW = bodyW * 2.1;
      // a gentle surge forward and back makes the push feel alive
      const surge = Math.sin(now * 5 + a.seed) * 1.6;

      // centreline: quadratic Bézier tail → bend → base of the head
      const N = 22;
      const pts: { x: number; y: number; nx: number; ny: number }[] = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const x = (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x;
        const y = (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y;
        const dx = 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x);
        const dy = 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y);
        const dl = Math.hypot(dx, dy) || 1;
        pts.push({ x: x + (dx / dl) * surge, y: y + (dy / dl) * surge, nx: -dy / dl, ny: dx / dl });
      }
      // where the head starts along the curve
      let acc = 0, cut = N;
      for (let i = N; i > 0; i--) {
        acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        if (acc >= headLen) {
          cut = i - 1;
          break;
        }
      }
      cut = Math.max(2, cut);
      const width = (i: number) => bodyW * (0.12 + 0.88 * Math.pow(i / cut, 0.8)); // thin tail swelling to the neck
      const shape = new Path2D();
      shape.moveTo(pts[0].x + pts[0].nx * width(0) * 0.5, pts[0].y + pts[0].ny * width(0) * 0.5);
      for (let i = 1; i <= cut; i++) shape.lineTo(pts[i].x + pts[i].nx * width(i) * 0.5, pts[i].y + pts[i].ny * width(i) * 0.5);
      shape.lineTo(pts[cut].x + pts[cut].nx * headW * 0.5, pts[cut].y + pts[cut].ny * headW * 0.5);
      shape.lineTo(pts[N].x, pts[N].y);
      shape.lineTo(pts[cut].x - pts[cut].nx * headW * 0.5, pts[cut].y - pts[cut].ny * headW * 0.5);
      for (let i = cut; i >= 0; i--) shape.lineTo(pts[i].x - pts[i].nx * width(i) * 0.5, pts[i].y - pts[i].ny * width(i) * 0.5);
      shape.closePath();

      const color = this.colors[a.team];
      g.lineJoin = 'round';
      g.globalAlpha = 0.9 * a.alpha;
      g.strokeStyle = '#0b0d10';
      g.lineWidth = 3;
      g.stroke(shape);
      g.fillStyle = color;
      g.fill(shape);

      // light streaks running up the shaft towards the head (fast)
      g.save();
      g.clip(shape);
      g.globalAlpha = 0.55 * a.alpha;
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2.2;
      const speed = 1.6 + 1.4 * a.power; // cycles per second
      for (let sIdx = 0; sIdx < 3; sIdx++) {
        const t = (now * speed + sIdx / 3 + a.seed) % 1;
        const i = Math.min(N - 1, Math.floor(t * N));
        const q = pts[i];
        const half = headW * 0.6;
        // chevron pointing along the direction of travel
        const fx = pts[Math.min(N, i + 1)].x - q.x, fy = pts[Math.min(N, i + 1)].y - q.y;
        const fl = Math.hypot(fx, fy) || 1;
        g.beginPath();
        g.moveTo(q.x + q.nx * half - (fx / fl) * 5, q.y + q.ny * half - (fy / fl) * 5);
        g.lineTo(q.x + (fx / fl) * 3, q.y + (fy / fl) * 3);
        g.lineTo(q.x - q.nx * half - (fx / fl) * 5, q.y - q.ny * half - (fy / fl) * 5);
        g.stroke();
      }
      g.restore();
      g.globalAlpha = 1;
    }
  }
}
