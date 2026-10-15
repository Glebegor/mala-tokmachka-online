import type maplibregl from 'maplibre-gl';
import { offsetKm, type BuildingDef, type InitMsg, type LngLat, type SnapMsg, type UnitDef } from '@sw/core';

/**
 * Visible fog of war (from the akira branch): a dark veil over the map with soft holes wherever your side can see.
 * It sits between the map and the markers. With the basemap switched off the veil is darker, like a tactical display.
 */
export class FogOverlay {
  readonly canvas: HTMLCanvasElement;
  enabled = true;

  constructor(private map: maplibregl.Map) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fog';
    const host = map.getCanvasContainer();
    host.insertBefore(this.canvas, map.getCanvas().nextSibling);
  }

  destroy() {
    this.canvas.remove();
  }

  render(snap: SnapMsg | null, init: InitMsg | null, defU: Map<string, UnitDef>, defB: Map<string, BuildingDef>, mapOff: boolean, positions: (id: number, fallback: LngLat) => LngLat) {
    const c = this.canvas;
    const g = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== w * dpr || c.height !== h * dpr) (c.width = w * dpr), (c.height = h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!this.enabled || !snap || !init || !init.ruleset.rules.fogOfWar) return;
    const team = init.team;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = mapOff ? 'rgba(3, 7, 18, 0.78)' : 'rgba(6, 12, 24, 0.38)';
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-out';
    const punch = (pos: LngLat, km: number) => {
      const a = this.map.project(pos);
      const b = this.map.project(offsetKm(pos, km, 0));
      const r = Math.hypot(b.x - a.x, b.y - a.y);
      if (r <= 0 || a.x < -r || a.x > w + r || a.y < -r || a.y > h + r) return;
      const grad = g.createRadialGradient(a.x, a.y, r * 0.7, a.x, a.y, r);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(a.x, a.y, r, 0, Math.PI * 2);
      g.fill();
    };
    for (const u of snap.units) if (u.team === team) punch(positions(u.id, u.pos), defU.get(u.def)?.vision ?? 6);
    for (const b of snap.buildings) if (b.team === team && b.progress >= 1) punch(b.pos, defB.get(b.def)?.vision ?? 8);
    init.map.capturePoints.forEach((cp, i) => snap.points[i]?.owner === team && punch(cp.pos, 7.5));
    g.globalCompositeOperation = 'source-over';
  }
}
