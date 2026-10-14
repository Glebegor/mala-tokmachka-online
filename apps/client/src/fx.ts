import type maplibregl from 'maplibre-gl';
import { offsetKm, type LngLat, type Shot, type UnitDef } from '@sw/core';

interface Effect {
  kind: string;
  color: string;
  from: LngLat;
  to: LngLat;
  hit: boolean;
  start: number;
  dur: number;
  seed: number;
}

const DUR: Record<string, number> = { burst: 420, shell: 520, arc: 1500, beam: 380 };

/** Canvas overlay that animates weapon fire. Misses are cosmetic: the server has already resolved damage. */
export class ShotFx {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private effects: Effect[] = [];
  private raf = 0;

  constructor(private map: maplibregl.Map, parent: HTMLElement, private units: Map<string, UnitDef>, private teamColor: string[]) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fx';
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

  add(shots: Shot[]) {
    const now = performance.now();
    for (const s of shots) {
      if (this.effects.length > 500) break;
      const d = this.units.get(s.def);
      if (s.from[0] === s.to[0] && s.from[1] === s.to[1]) {
        this.effects.push({
          kind: 'blast',
          color: this.teamColor[s.team],
          from: s.from,
          to: s.to,
          hit: true,
          start: now,
          dur: 800,
          seed: Math.random(),
        });
        continue;
      }
      const kind = d?.fx ?? 'burst';
      const miss = Math.random() < (d?.missRate ?? 0.3);
      // a miss lands 0.3–1.5 km off (more for indirect fire)
      const spread = (kind === 'arc' ? 2.2 : 1) * (0.3 + Math.random() * 1.2);
      const ang = Math.random() * Math.PI * 2;
      const to = miss ? offsetKm(s.to, Math.cos(ang) * spread, Math.sin(ang) * spread) : s.to;
      this.effects.push({ kind, color: this.teamColor[s.team], from: s.from, to, hit: !miss, start: now + Math.random() * 180, dur: DUR[kind] ?? 450, seed: Math.random() });
    }
  }

  private draw() {
    const { canvas, g, map } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) (canvas.width = w * dpr), (canvas.height = h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!this.effects.length) return;
    const now = performance.now();
    const k = Math.min(1.6, Math.max(0.45, (map.getZoom() - 4) / 4)); // scale effects with zoom
    this.effects = this.effects.filter((e) => now < e.start + e.dur + 500);
    g.lineCap = 'round';

    for (const e of this.effects) {
      const t = (now - e.start) / e.dur;
      if (t < 0) continue;
      const a = map.project(e.from), b = map.project(e.to);
      if ((a.x < -50 && b.x < -50) || (a.x > w + 50 && b.x > w + 50) || (a.y < -50 && b.y < -50) || (a.y > h + 50 && b.y > h + 50)) continue;
      const at = (u: number) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
      const impactT = Math.max(0, (now - e.start - e.dur) / 500); // 0..1 after arrival

      if (e.kind === 'blast') {
        const radius = (8 + 14 * Math.min(1, t * 1.5)) * k;
        const alpha = Math.max(0, 1 - t);
        this.ring(a.x, a.y, radius, '#ffaa44', alpha);
        this.ring(a.x, a.y, radius * 0.7, '#ffffff', alpha * 0.9);
        this.flash(a.x, a.y, radius * 0.55, '#ff5522', alpha * 0.75);
        this.flash(a.x, a.y, radius * 0.28, '#fff6c0', alpha);
      } else if (e.kind === 'burst') {
        // three quick tracers, slightly fanned
        for (let i = 0; i < 3; i++) {
          const u = t * 1.5 - i * 0.22;
          if (u < 0 || u > 1) continue;
          const off = (i - 1) * 2.5 * k * (e.hit ? 0.4 : 1);
          const p = at(u), q = at(Math.max(0, u - 0.16));
          g.strokeStyle = '#ffe9a3';
          g.globalAlpha = 0.9;
          g.lineWidth = 1.1 * k;
          g.beginPath();
          g.moveTo(q.x + off, q.y + off);
          g.lineTo(p.x + off, p.y + off);
          g.stroke();
        }
        if (t < 0.25) this.flash(a.x, a.y, 3 * k, '#fff3c4', 1 - t * 4);
        if (impactT > 0 && impactT < 1) e.hit ? this.flash(b.x, b.y, 3.5 * k, '#ffd27a', 1 - impactT) : this.puff(b.x, b.y, 4 * k * impactT, 0.5 * (1 - impactT));
      } else if (e.kind === 'shell') {
        // one heavy flat shot with a big muzzle flash
        if (t <= 1) {
          const p = at(t), q = at(Math.max(0, t - 0.28));
          g.strokeStyle = '#ffffff';
          g.globalAlpha = 1;
          g.lineWidth = 2.4 * k;
          g.beginPath();
          g.moveTo(q.x, q.y);
          g.lineTo(p.x, p.y);
          g.stroke();
        }
        if (t < 0.3) this.flash(a.x, a.y, 8 * k, '#ffcf70', 1 - t / 0.3);
        if (impactT > 0 && impactT < 1) {
          if (e.hit) {
            this.flash(b.x, b.y, 9 * k * (0.6 + impactT), '#ff9a3c', 1 - impactT);
            this.ring(b.x, b.y, 12 * k * impactT, e.color, 1 - impactT);
          } else {
            this.puff(b.x, b.y, 9 * k * impactT, 0.6 * (1 - impactT));
          }
        }
      } else if (e.kind === 'arc') {
        // lobbed shell: rises off the straight line and falls on the target
        const lift = Math.min(90, Math.hypot(b.x - a.x, b.y - a.y) * 0.35);
        const arc = (u: number) => {
          const p = at(u);
          return { x: p.x, y: p.y - Math.sin(u * Math.PI) * lift };
        };
        if (t <= 1) {
          g.strokeStyle = '#ffb347';
          g.globalAlpha = 0.85;
          g.lineWidth = 1.6 * k;
          g.beginPath();
          for (let i = 0; i <= 6; i++) {
            const p = arc(Math.max(0, t - 0.12 + (i / 6) * 0.12));
            i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y);
          }
          g.stroke();
          const head = arc(t);
          this.flash(head.x, head.y, 2.2 * k, '#fff', 1);
        }
        if (t < 0.12) this.flash(a.x, a.y, 7 * k, '#ffe2a0', 1 - t / 0.12);
        if (impactT > 0 && impactT < 1) {
          this.flash(b.x, b.y, (e.hit ? 14 : 9) * k * (0.5 + impactT), e.hit ? '#ff7a2f' : '#8a8f98', (1 - impactT) * (e.hit ? 1 : 0.6));
          this.ring(b.x, b.y, 20 * k * impactT, e.hit ? '#ffd27a' : '#9aa0a8', 1 - impactT);
        }
      } else {
        // drone strike: thin dashed line snapping onto the target
        if (t <= 1) {
          g.strokeStyle = '#7fe7ff';
          g.globalAlpha = 0.9 * (1 - t * 0.5);
          g.lineWidth = 1 * k;
          g.setLineDash([3 * k, 4 * k]);
          g.lineDashOffset = -t * 40;
          g.beginPath();
          g.moveTo(a.x, a.y);
          const p = at(Math.min(1, t * 1.6));
          g.lineTo(p.x, p.y);
          g.stroke();
          g.setLineDash([]);
        }
        if (impactT > 0 && impactT < 1) e.hit ? this.ring(b.x, b.y, 7 * k * impactT, '#7fe7ff', 1 - impactT) : this.puff(b.x, b.y, 4 * k * impactT, 0.4 * (1 - impactT));
      }
    }
    g.globalAlpha = 1;
  }

  private flash(x: number, y: number, r: number, color: string, alpha: number) {
    const g = this.g;
    g.globalAlpha = Math.max(0, alpha);
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
    g.fill();
  }

  private ring(x: number, y: number, r: number, color: string, alpha: number) {
    const g = this.g;
    g.globalAlpha = Math.max(0, alpha);
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
    g.stroke();
  }

  private puff(x: number, y: number, r: number, alpha: number) {
    this.flash(x, y, r, '#9aa0a8', alpha);
  }
}
