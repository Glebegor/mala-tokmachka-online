import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  distKm, distToFrontKm, offsetKm, sideOf,
  type BuildingDef, type ClientMsg, type Command, type FrontNode, type InitMsg, type LngLat, type ServerMsg, type SnapMsg, type UnitDef,
} from '@sw/core';
import type { Session } from './api';
import { clear, h } from './dom';
import { iconHtml } from './icons';

/** OpenStreetMap raster basemap, toned down so the front and units stay readable. */
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0b0d10' } },
    { id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.55, 'raster-brightness-max': 0.6, 'raster-contrast': 0.1 } },
  ],
};
const TEAM_COLOR = ['#3d8bff', '#ff4d4d'];
const TEAM_NAME = ['UKRAINE', 'RUSSIA'];
const UNIT_GLYPH: Record<string, string> = { infantry: '•', tank: '■', artillery: '▲', drone: '◇' };

const HINT = 'Left click: select · Shift+drag: box select · Right click: move · Scroll: zoom';
type Fc = { type: 'FeatureCollection'; features: any[] };
const empty = (): Fc => ({ type: 'FeatureCollection', features: [] });

export function startGame(app: HTMLElement, session: Session, matchId: string, onExit: () => void) {
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(session.token)}&match=${encodeURIComponent(matchId)}`;
  const ws = new WebSocket(wsUrl);

  let init: InitMsg | null = null;
  let snap: SnapMsg | null = null;
  let map: maplibregl.Map;
  let mapReady = false;

  // ---------- DOM shell ----------
  const mapEl = h('div', { class: 'map' });
  const resBar = h('div', { class: 'res' });
  const scoreBar = h('div', { class: 'score' });
  const palette = h('div', { class: 'palette' });
  const side = h('div', { class: 'side' });
  const toasts = h('div', { class: 'toasts' });
  const hint = h('div', { class: 'hint' }, 'Connecting…');
  const boxEl = h('div', { class: 'selbox' });
  app.append(
    h('div', { class: 'game' }, mapEl,
      h('div', { class: 'hud top' }, resBar, scoreBar, h('button', { class: 'ghost', onClick: () => (ws.close(), map?.remove(), onExit()) }, 'Leave')),
      palette, side, toasts, hint, boxEl),
  );

  const send = (cmd: Command) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'cmd', cmd } satisfies ClientMsg));
  const toast = (text: string, bad = false) => {
    const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, text);
    toasts.append(el);
    setTimeout(() => el.remove(), 4200);
  };

  // ---------- state ----------
  let placing: BuildingDef | null = null;
  let selUnits = new Set<number>();
  let selBuilding: number | null = null;
  const bMarkers = new Map<number, { el: HTMLElement; marker: maplibregl.Marker; done: boolean }>();
  const pMarkers = new Map<string, HTMLElement>();
  let shown: FrontNode[] = [];
  const defB = () => new Map(init!.ruleset.buildings.map((b) => [b.id, b]));
  const defU = (): Map<string, UnitDef> => new Map(init!.ruleset.units.map((u) => [u.id, u]));

  // ---------- network ----------
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMsg;
    switch (msg.t) {
      case 'init':
        init = msg;
        document.getElementById('mod-theme')!.textContent = msg.ruleset.themes.map((t) => t.css).join('\n');
        buildMap();
        buildPalette();
        hint.textContent = HINT;
        break;
      case 'snap':
        onSnapshot(msg);
        break;
      case 'toast':
        toast(msg.text);
        break;
      case 'error':
        toast(msg.reason, true);
        break;
      case 'end': {
        const mine = init?.team === msg.winner;
        app.append(
          h('div', { class: 'overlay' },
            h('div', { class: 'card' },
              h('h2', {}, msg.winner === null ? 'DRAW' : mine ? 'VICTORY' : 'DEFEAT'),
              h('p', { class: 'muted' }, msg.reason),
              h('button', { class: 'primary', onClick: () => (ws.close(), map?.remove(), onExit()) }, 'Back to lobby'),
            ),
          ),
        );
        break;
      }
    }
  };
  ws.onclose = () => {
    hint.textContent = 'Disconnected from server.';
  };

  // ---------- map ----------
  function buildMap() {
    const m = init!.map;
    map = new maplibregl.Map({
      container: mapEl,
      style: STYLE,
      center: m.center,
      zoom: m.zoom,
      minZoom: 5.5,
      maxZoom: 13,
      boxZoom: false,
      dragRotate: false,
      attributionControl: { compact: true },
      maxBounds: [m.bounds[0] - 2, m.bounds[1] - 1.5, m.bounds[2] + 2, m.bounds[3] + 1.5],
    });
    map.doubleClickZoom.disable();

    map.on('load', () => {
      map.addSource('occupied', { type: 'geojson', data: empty() });
      map.addSource('front', { type: 'geojson', data: empty() });
      map.addSource('pressure', { type: 'geojson', data: empty() });
      map.addSource('units', { type: 'geojson', data: empty() });
      map.addSource('rings', { type: 'geojson', data: empty() });
      map.addSource('ghost', { type: 'geojson', data: empty() });

      map.addLayer({ id: 'occupied-fill', type: 'fill', source: 'occupied', paint: { 'fill-color': '#ff3b3b', 'fill-opacity': 0.14 } });
      map.addLayer({ id: 'front-glow', type: 'line', source: 'front', paint: { 'line-color': '#ff4d4d', 'line-width': 10, 'line-blur': 8, 'line-opacity': 0.55 } });
      map.addLayer({ id: 'front-line', type: 'line', source: 'front', paint: { 'line-color': '#ff7b7b', 'line-width': 1.6 } });
      map.addLayer({
        id: 'pressure', type: 'circle', source: 'pressure',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 0, 0, 1, 9],
          'circle-color': ['case', ['>', ['get', 'v'], 0], TEAM_COLOR[0], TEAM_COLOR[1]],
          'circle-opacity': 0.35, 'circle-blur': 0.6,
        },
      });
      map.addLayer({ id: 'rings', type: 'line', source: 'rings', paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.4, 'line-dasharray': [2, 3] } });
      map.addLayer({ id: 'ghost-fill', type: 'fill', source: 'ghost', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'ghost-line', type: 'line', source: 'ghost', paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [3, 2] } });
      map.addLayer({
        id: 'units-ground', type: 'circle', source: 'units', filter: ['!=', ['get', 'kind'], 'air'],
        paint: {
          'circle-radius': ['+', ['case', ['==', ['get', 'def'], 'tank'], 5, ['==', ['get', 'def'], 'artillery'], 5, 3.5], ['case', ['get', 'sel'], 1.5, 0]],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': ['case', ['get', 'sel'], '#ffffff', ['get', 'own'], '#0b0d10', '#0b0d10'],
          'circle-stroke-width': ['case', ['get', 'sel'], 2, 1],
        },
      });
      map.addLayer({
        id: 'units-air', type: 'circle', source: 'units', filter: ['==', ['get', 'kind'], 'air'],
        paint: {
          'circle-radius': 5, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': ['case', ['get', 'sel'], '#ffffff', ['get', 'color']], 'circle-stroke-width': 2,
        },
      });
      for (const cp of init!.map.capturePoints) {
        const el = h('div', { class: 'cp' }, h('i', {}), h('span', {}, cp.name));
        new maplibregl.Marker({ element: el }).setLngLat(cp.pos).addTo(map);
        pMarkers.set(cp.id, el);
      }
      mapReady = true;
      if (snap) render();
      requestAnimationFrame(animate);
    });

    map.on('zoom', () => mapEl.style.setProperty('--s', String(Math.min(1.5, Math.max(0.55, (map.getZoom() - 5) / 3.6)))));
    mapEl.style.setProperty('--s', String(Math.min(1.5, Math.max(0.55, (init!.map.zoom - 5) / 3.6))));

    map.on('mousemove', (e) => placing && drawGhost([e.lngLat.lng, e.lngLat.lat]));
    map.on('click', (e) => {
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (placing) {
        send({ type: 'build', def: placing.id, pos: p });
        if (!e.originalEvent.shiftKey) cancelPlacing();
        return;
      }
      const hit = map.queryRenderedFeatures(e.point, { layers: ['units-ground', 'units-air'] }).find((f) => f.properties?.own);
      selBuilding = null;
      selUnits = new Set(hit ? [Number(hit.properties!.id)] : []);
      render();
    });
    map.on('contextmenu', (e) => {
      if (placing) return cancelPlacing();
      if (selUnits.size) send({ type: 'move', units: [...selUnits], to: [e.lngLat.lng, e.lngLat.lat] });
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cancelPlacing();
      if (e.key === 's' && selUnits.size) send({ type: 'stop', units: [...selUnits] });
    });

    // shift+drag box selection
    let start: { x: number; y: number } | null = null;
    mapEl.addEventListener('mousedown', (e) => {
      if (!e.shiftKey || e.button !== 0 || placing) return;
      e.stopPropagation();
      start = { x: e.clientX, y: e.clientY };
      boxEl.style.display = 'block';
    }, true);
    window.addEventListener('mousemove', (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
      Object.assign(boxEl.style, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(e.clientX - start.x)}px`, height: `${Math.abs(e.clientY - start.y)}px` });
    });
    window.addEventListener('mouseup', (e) => {
      if (!start || !snap) return;
      const r = mapEl.getBoundingClientRect();
      const x0 = Math.min(start.x, e.clientX) - r.left, x1 = Math.max(start.x, e.clientX) - r.left;
      const y0 = Math.min(start.y, e.clientY) - r.top, y1 = Math.max(start.y, e.clientY) - r.top;
      start = null;
      boxEl.style.display = 'none';
      selUnits = new Set(snap.units.filter((u) => u.owner === session.user.id).filter((u) => {
        const p = map.project(u.pos);
        return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
      }).map((u) => u.id));
      selBuilding = null;
      render();
    });
  }

  // ---------- placement ----------
  function cancelPlacing() {
    placing = null;
    hint.textContent = HINT;
    mapEl.classList.remove('placing');
    (map.getSource('ghost') as GeoJSONSource | undefined)?.setData(empty());
    buildPalette();
  }

  function circle(c: LngLat, km: number, n = 48): LngLat[] {
    return Array.from({ length: n + 1 }, (_, i) => offsetKm(c, Math.cos((i / n) * 6.2832) * km, Math.sin((i / n) * 6.2832) * km));
  }

  function validPlacement(def: BuildingDef, p: LngLat): boolean {
    if (!init || !snap) return false;
    const r = init.ruleset.rules;
    if (sideOf(snap.front, p) !== init.team) return false;
    const d = Math.abs(distToFrontKm(snap.front, p));
    if (d < r.minBuildDistanceFromFront * (def.category === 'civil' ? 2 : 1)) return false;
    if (snap.buildings.some((b) => distKm(b.pos, p) < r.minBuildSpacing)) return false;
    return Object.entries(def.cost).every(([k, v]) => (snap!.res[k] ?? 0) >= v);
  }

  function drawGhost(p: LngLat) {
    if (!placing) return;
    const ok = validPlacement(placing, p);
    const color = ok ? '#5ae88a' : '#ff5a5a';
    const radius = placing.defense?.radiusKm ?? placing.aura?.radiusKm ?? (placing.vision && placing.vision > 8 ? placing.vision : 1.2);
    (map.getSource('ghost') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { color }, geometry: { type: 'Polygon', coordinates: [circle(p, radius)] } }],
    });
  }

  // ---------- UI ----------
  function costHtml(cost: Record<string, number>, have?: Record<string, number>) {
    const wrap = h('span', { class: 'cost' });
    for (const [k, v] of Object.entries(cost)) {
      const r = init!.ruleset.resources.find((x) => x.id === k);
      const short = have && (have[k] ?? 0) < v;
      const chip = h('span', { class: 'c' + (short ? ' short' : ''), title: r?.name ?? k });
      chip.innerHTML = `${iconHtml(r?.icon, r?.color ?? '#888')}<em>${v}</em>`;
      wrap.append(chip);
    }
    return wrap;
  }

  function buildPalette() {
    if (!init) return;
    clear(palette);
    for (const cat of ['civil', 'military'] as const) {
      palette.append(h('div', { class: 'cat' }, cat === 'civil' ? 'Civil infrastructure' : 'War infrastructure'));
      for (const b of init.ruleset.buildings.filter((x) => x.category === cat)) {
        palette.append(
          h('button', { class: 'bld' + (placing?.id === b.id ? ' active' : ''), title: b.description ?? '', onClick: () => {
            placing = b;
            mapEl.classList.add('placing');
            hint.textContent = `Placing ${b.name} — click on your territory (Shift keeps placing, Esc cancels)`;
            buildPalette();
          } },
            h('span', { class: 'ico' }, b.icon),
            h('span', { class: 'meta' }, h('b', {}, b.name), costHtml(b.cost, snap?.res)),
          ),
        );
      }
    }
  }

  function renderRes() {
    if (!init || !snap) return;
    clear(resBar);
    for (const r of init.ruleset.resources) {
      const v = snap.res[r.id] ?? 0;
      const d = snap.rates[r.id] ?? 0;
      const ico = h('span', { class: 'rico' });
      ico.innerHTML = iconHtml(r.icon, r.color);
      resBar.append(
        h('div', { class: 'chip', title: r.name },
          ico,
          h('b', {}, Math.floor(v)),
          h('small', { class: d < -0.01 ? 'neg' : d > 0.01 ? 'pos' : '' }, `${d >= 0 ? '+' : ''}${d.toFixed(1)}/s`),
        ),
      );
    }
  }

  function renderScore() {
    if (!init || !snap) return;
    const total = Math.max(1, snap.scores[0] + snap.scores[1]);
    const left = Math.max(0, init.ruleset.rules.matchSeconds - snap.time);
    const held = [0, 1].map((t) => snap!.points.filter((p) => p.owner === t).length);
    clear(scoreBar);
    scoreBar.append(
      h('div', { class: 'teams' },
        h('span', { style: { color: TEAM_COLOR[0] } }, `${TEAM_NAME[0]} ${held[0]}`),
        h('b', {}, `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`),
        h('span', { style: { color: TEAM_COLOR[1] } }, `${held[1]} ${TEAM_NAME[1]}`),
      ),
      h('div', { class: 'bar' }, h('i', { style: { width: `${(snap.scores[0] / total) * 100}%`, background: TEAM_COLOR[0] } }), h('i', { style: { width: `${(snap.scores[1] / total) * 100}%`, background: TEAM_COLOR[1] } })),
    );
  }

  function renderSide() {
    if (!init || !snap) return;
    clear(side);
    const dB = defB(), dU = defU();
    if (selBuilding !== null) {
      const b = snap.buildings.find((x) => x.id === selBuilding && x.owner === session.user.id);
      if (!b) return void (selBuilding = null);
      const d = dB.get(b.def)!;
      side.append(
        h('h3', {}, `${d.icon} ${d.name}`),
        h('div', { class: 'muted' }, d.description ?? ''),
        h('div', { class: 'stat' }, `HP ${b.hp}/${d.hp}`),
      );
      if (b.progress < 1) side.append(h('div', { class: 'stat' }, `Under construction ${Math.round(b.progress * 100)}%`));
      if (b.progress >= 1) {
        for (const uid of d.trains ?? []) {
          const u = dU.get(uid)!;
          side.append(h('button', { class: 'bld', onClick: () => send({ type: 'train', building: b.id, unit: uid }) },
            h('span', { class: 'ico' }, UNIT_GLYPH[uid] ?? '•'), h('span', { class: 'meta' }, h('b', {}, `Train ${u.name} · ${u.trainTime}s`), costHtml(u.cost, snap!.res))));
        }
        const q = snap.queue.filter((x) => x.building === b.id);
        if (q.length) side.append(h('div', { class: 'stat' }, 'Queue: ' + q.map((x) => `${dU.get(x.unit)?.name} (${x.remaining}s)`).join(', ')));
      }
      if (b.def !== 'hq') side.append(h('button', { class: 'ghost', onClick: () => (send({ type: 'demolish', building: b.id }), (selBuilding = null)) }, 'Demolish (40% refund)'));
    } else if (selUnits.size) {
      const mine = snap.units.filter((u) => selUnits.has(u.id));
      const by = new Map<string, number>();
      mine.forEach((u) => by.set(u.def, (by.get(u.def) ?? 0) + 1));
      side.append(
        h('h3', {}, `${mine.length} unit${mine.length === 1 ? '' : 's'} selected`),
        ...[...by].map(([k, n]) => h('div', { class: 'stat' }, `${n} × ${dU.get(k)?.name ?? k}`)),
        h('div', { class: 'muted' }, 'Right click on the map to move. Idle units engage enemies automatically.'),
        h('button', { class: 'ghost', onClick: () => send({ type: 'stop', units: [...selUnits] }) }, 'Stop (S)'),
      );
    }
    side.classList.toggle('open', side.childElementCount > 0);
  }

  // ---------- snapshot → view ----------
  function onSnapshot(s: SnapMsg) {
    snap = s;
    if (!shown.length) shown = s.front.map((n) => ({ ...n }));
    renderRes();
    renderScore();
    renderSide();
    if (!placing) buildPalette();
    if (mapReady) render();
  }

  function render() {
    if (!init || !snap || !map || !mapReady) return;
    renderRes();
    renderScore();
    renderSide();
    const dB = defB();

    // units
    const me = session.user.id;
    const uSrc = map.getSource('units') as GeoJSONSource | undefined;
    uSrc?.setData({
      type: 'FeatureCollection',
      features: snap.units.map((u) => {
        const kind = init!.ruleset.units.find((d) => d.id === u.def)?.kind;
        return { type: 'Feature', properties: { id: u.id, def: u.def, kind, own: u.owner === me, sel: selUnits.has(u.id), color: TEAM_COLOR[u.team] }, geometry: { type: 'Point', coordinates: u.pos } };
      }),
    });

    // vision / aura rings for own long-range assets
    const rings: any[] = [];
    for (const b of snap.buildings) {
      const d = dB.get(b.def)!;
      if (b.owner === me && b.progress >= 1 && (d.vision ?? 0) >= 20) {
        rings.push({ type: 'Feature', properties: { color: TEAM_COLOR[b.team] }, geometry: { type: 'LineString', coordinates: circle(b.pos, d.vision!, 64) } });
      }
    }
    (map.getSource('rings') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: rings });

    // buildings → DOM markers with construction animation
    const alive = new Set<number>();
    for (const b of snap.buildings) {
      alive.add(b.id);
      const d = dB.get(b.def)!;
      let m = bMarkers.get(b.id);
      if (!m) {
        const el = h('div', { class: `bm t${b.team}` });
        el.innerHTML = `<div class="blueprint"></div><svg class="ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" /></svg><div class="glyph">${d.icon}</div>`;
        el.addEventListener('click', (ev) => {
          if (placing || b.owner !== me) return;
          ev.stopPropagation();
          selBuilding = b.id;
          selUnits.clear();
          render();
        });
        const marker = new maplibregl.Marker({ element: el }).setLngLat(b.pos).addTo(map);
        m = { el, marker, done: false };
        bMarkers.set(b.id, m);
        m.el.classList.add('spawn');
      }
      const done = b.progress >= 1;
      m.el.classList.toggle('building', !done);
      m.el.classList.toggle('mine', b.owner === me);
      m.el.classList.toggle('selected', selBuilding === b.id);
      m.el.style.setProperty('--p', String(b.progress));
      if (done && !m.done) {
        m.done = true;
        m.el.classList.add('complete');
        setTimeout(() => m!.el.classList.remove('complete'), 1200);
      }
    }
    for (const [id, m] of bMarkers) {
      if (!alive.has(id)) {
        m.el.classList.add('gone');
        setTimeout(() => m.marker.remove(), 400);
        bMarkers.delete(id);
      }
    }

    // capture point owners
    snap.points.forEach((p) => pMarkers.get(p.id)?.style.setProperty('--c', TEAM_COLOR[p.owner]));
  }

  // ---------- front animation (smooth between 5 Hz snapshots) ----------
  function animate() {
    if (!snap || !init) return void requestAnimationFrame(animate);
    if (shown.length !== snap.front.length) shown = snap.front.map((n) => ({ ...n }));
    shown.forEach((n, i) => {
      const t = snap!.front[i];
      n.lng += (t.lng - n.lng) * 0.18;
      n.v = t.v;
    });
    const b = init.map.bounds;
    const line: LngLat[] = shown.map((n) => [n.lng, n.lat]);
    const poly: LngLat[] = [...line, [b[2] + 3, line[line.length - 1][1]], [b[2] + 3, line[0][1]], line[0]];
    (map.getSource('front') as GeoJSONSource | undefined)?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
    (map.getSource('occupied') as GeoJSONSource | undefined)?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [poly] } });
    (map.getSource('pressure') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: shown.map((n) => ({ type: 'Feature', properties: { v: n.v, mag: Math.min(1, Math.abs(n.v) / 0.02) }, geometry: { type: 'Point', coordinates: [n.lng, n.lat] } })),
    });
    requestAnimationFrame(animate);
  }

  setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ping' } satisfies ClientMsg)), 15000);
}
