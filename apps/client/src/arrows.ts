import type maplibregl from 'maplibre-gl';
import { kmPerDegLng, normalAt, type FrontNode, type LngLat } from '@sw/core';

interface Arrow {
  tail: LngLat;
  bend: LngLat;
  tip: LngLat;
  team: 0 | 1;
  power: number; // 0..1
  seed: number;
}

/**
 * Attack arrows in the style of situation maps: one bold tapered arrow per stretch of front that is being pushed,
 * drawn from the attacker's rear across the line, with highlights racing towards the head.
 */
export class FrontArrows {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private arrows: Arrow[] = [];
  private raf = 0;

  constructor(private map: maplibregl.Map, parent: HTMLElement, private colors: string[]) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fx arrows';
    parent.append(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  /** Rebuild the arrows from the current front. `maxV` is the fastest the front can move. */
  update(front: FrontNode[], maxV: number) {
    const minV = maxV * 0.03;
    const out: Arrow[] = [];
    const flush = (from: number, to: number) => {
      // long pushes get several arrows, roughly one per 60 km
      const parts = Math.max(1, Math.round((to - from + 1) / 7));
      for (let k = 0; k < parts; k++) {
        const a = from + Math.floor(((to - from + 1) * k) / parts);
        const b = from + Math.floor(((to - from + 1) * (k + 1)) / parts) - 1;
        if (b < a) continue;
        const mid = Math.round((a + b) / 2);
        let v = 0;
        for (let i = a; i <= b; i++) v += front[i].v;
        v /= b - a + 1;
        const team: 0 | 1 = v > 0 ? 0 : 1;
        const s = v > 0 ? 1 : -1;
        const [nx, ny] = normalAt(front, mid); // unit vector towards team 1's side, km space
        const power = Math.min(1, Math.abs(v) / (maxV * 0.5));
        const node = front[mid];
        const at = (alongKm: number, sideKm: number): LngLat => [
          node.lng + (nx * s * alongKm - ny * s * sideKm) / kmPerDegLng(node.lat),
          node.lat + (ny * s * alongKm + nx * s * sideKm) / 111.32,
        ];
        const length = 16 + 26 * power;
        const curve = (mid % 2 ? 1 : -1) * (3 + 5 * power);
        out.push({ tail: at(-length, curve), bend: at(-length * 0.45, -curve * 0.6), tip: at(5 + 9 * power, 0), team, power, seed: mid * 0.37 });
      }
    };
    let start = -1;
    for (let i = 1; i < front.length - 1; i++) {
      const on = Math.abs(front[i].v) >= minV;
      const same = start >= 0 && Math.sign(front[i].v) === Math.sign(front[start].v);
      if (on && start < 0) start = i;
      else if (start >= 0 && (!on || !same)) {
        if (i - start >= 2) flush(start, i - 1);
        start = on ? i : -1;
      }
    }
    if (start >= 0 && front.length - 1 - start >= 2) flush(start, front.length - 2);
    this.arrows = out;
  }

  private draw() {
    const { canvas, g, map } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) (canvas.width = w * dpr), (canvas.height = h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!this.arrows.length) return;
    const now = performance.now() / 1000;

    for (const a of this.arrows) {
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
      g.globalAlpha = 0.9;
      g.strokeStyle = '#0b0d10';
      g.lineWidth = 3;
      g.stroke(shape);
      g.fillStyle = color;
      g.fill(shape);

      // light streaks running up the shaft towards the head (fast)
      g.save();
      g.clip(shape);
      g.globalAlpha = 0.55;
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
