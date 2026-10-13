import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  distKm, distToFrontKm, offsetKm, pointInRing, RoadNetwork, TerrainGrid,
  type BuildingDef, type ClientMsg, type Command, type FrontNode, type InitMsg, type LngLat, type ServerMsg, type SnapMsg, type UnitDef, type UnitView,
} from '@sw/core';
import type { Session } from './api';
import { clear, h } from './dom';
import { ShotFx } from './fx';
import { iconHtml } from './icons';
import { FrontArrows } from './arrows';
import { drawNato, echelonFor, natoId, parseNatoId } from './nato';

/**
 * Basemap: OpenStreetMap rendered almost monochrome and dark, with real relief shading on top, so that the game layers
 * (front, roads, terrain, markers) are the only strong colours on screen.
 */
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
    dem: {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 12,
      encoding: 'terrarium',
      attribution: 'Elevation: Mapzen / AWS Terrain Tiles',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0b0d10' } },
    { id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.82, 'raster-brightness-min': 0.03, 'raster-brightness-max': 0.5, 'raster-contrast': 0.22 } },
    { id: 'relief', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#cfd6df', 'hillshade-accent-color': '#000000' } },
  ],
};
const TEAM_COLOR = ['#3d8bff', '#ff4d4d'];
const TEAM_NAME = ['UKRAINE', 'RUSSIA'];
const GROUP_ZOOM = 8; // below this zoom a group is drawn as one formation marker
const HINT = 'Click: select · Shift+drag: box · Right click: move (Shift: add waypoint, Alt: off-road) · G: group · T: terrain';

type Fc = { type: 'FeatureCollection'; features: any[] };
const empty = (): Fc => ({ type: 'FeatureCollection', features: [] });

interface Group {
  id: number;
  ids: Set<number>;
}

/** `onExit(finished)`: finished is true when the match is over, false when the player stepped out and may come back. */
export function startGame(app: HTMLElement, session: Session, matchId: string, onExit: (finished: boolean) => void) {
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(session.token)}&match=${encodeURIComponent(matchId)}`;
  const ws = new WebSocket(wsUrl);
  const me = session.user.id;

  let init: InitMsg | null = null;
  let snap: SnapMsg | null = null;
  let map: maplibregl.Map;
  let mapReady = false;
  let fx: ShotFx | null = null;
  let arrows: FrontArrows | null = null;
  let terrain: TerrainGrid | null = null;
  let roads: RoadNetwork | null = null;
  let defB = new Map<string, BuildingDef>();
  let defU = new Map<string, UnitDef>();
  let closed = false;
  let finished = false;

  // ---------- DOM shell ----------
  const mapEl = h('div', { class: 'map' });
  const resBar = h('div', { class: 'res' });
  const scoreBar = h('div', { class: 'score' });
  const palette = h('div', { class: 'palette' });
  const side = h('div', { class: 'side' });
  const groupBar = h('div', { class: 'groups' });
  const terrainChip = h('div', { class: 'terrain-chip' });
  const toasts = h('div', { class: 'toasts' });
  const hint = h('div', { class: 'hint' }, 'Connecting…');
  const boxEl = h('div', { class: 'selbox' });
  const terrainBtn = h('button', { class: 'ghost', onClick: () => toggleTerrain() }, 'Terrain');
  const leave = () => {
    closed = true;
    ws.close();
    fx?.destroy();
    arrows?.destroy();
    card.remove();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('mousemove', onBoxMove);
    window.removeEventListener('mouseup', onBoxUp);
    map?.remove();
    onExit(finished);
  };
  app.append(
    h('div', { class: 'game' }, mapEl,
      h('div', { class: 'hud top' }, resBar, scoreBar, terrainBtn, h('button', { class: 'ghost', onClick: leave }, 'Leave')),
      palette, side, groupBar, terrainChip, toasts, hint, boxEl),
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
  let formation = true; // move selected units at the pace of the slowest
  const groups = new Map<number, Group>();
  const bMarkers = new Map<number, { el: HTMLElement; marker: maplibregl.Marker; done: boolean }>();
  const pMarkers = new Map<string, HTMLElement>();
  let shown: FrontNode[] = [];

  function hatchImage(): ImageData {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const x = c.getContext('2d')!;
    x.strokeStyle = 'rgba(229,56,59,0.55)';
    x.lineWidth = 1.2;
    for (const o of [-16, 0, 16]) {
      x.beginPath();
      x.moveTo(o, 16);
      x.lineTo(o + 16, 0);
      x.stroke();
    }
    return x.getImageData(0, 0, 16, 16);
  }

  // ---------- description cards ----------
  const card = h('div', { class: 'info-card' });
  document.body.append(card);
  const amounts = (m?: Record<string, number>, perSec = false) =>
    Object.entries(m ?? {}).map(([k, v]) => `${v}${perSec ? '/s' : ''} ${init?.ruleset.resources.find((r) => r.id === k)?.name.toLowerCase() ?? k}`).join(', ');
  function buildingFacts(d: BuildingDef): string[] {
    const f: string[] = [`Build time ${d.buildTime}s · ${d.hp} HP`];
    if (d.produces) f.push(`Produces ${amounts(d.produces, true)}`);
    if (d.consumes) f.push(`Uses ${amounts(d.consumes, true)}`);
    if (d.aura) f.push(`+${Math.round((d.aura.outputMult - 1) * 100)}% output within ${d.aura.radiusKm} km`);
    if (d.defense) f.push(`Defence +${Math.round(d.defense.mult * 100)}% within ${d.defense.radiusKm} km`);
    if (d.attack) f.push(`Hits ${d.attack.targets} targets: ${d.attack.damage} dmg/s, ${d.attack.range} km`);
    if (d.crossing) f.push(`River crossing within ${d.crossing.radiusKm} km`);
    if (d.training) f.push(`Courses for ${d.training.minUnits}–${d.training.capacity} units, ${d.training.baseTime + d.training.timePerRank}s and up`);
    if (d.trains?.length) f.push(`Trains ${d.trains.map((u) => defU.get(u)?.name ?? u).join(', ')}`);
    if (d.vision) f.push(`Sees ${d.vision} km`);
    if (d.maxPerPlayer) f.push(`Limit ${d.maxPerPlayer} per player`);
    return f;
  }
  function unitFacts(u: UnitDef): string[] {
    const air = u.airDamage ?? init?.ruleset.rules.airDamageDefault ?? 0.25;
    return [
      `${u.hp} HP · ${u.damage} dmg/s · range ${u.range} km`,
      `Speed ${Math.round(u.speed * 3600)} km/h game time${u.kind === 'air' ? ' (flies)' : ` · ${u.mobility ?? 'foot'}`}`,
      `Sees ${u.vision} km · ${air ? `${Math.round(air * 100)}% damage vs aircraft` : 'cannot hit aircraft'}`,
      `Training ${u.trainTime}s`,
    ];
  }
  /** Show a description card beside `el` while the pointer is over it. */
  function describe(el: HTMLElement, title: string, text: string | undefined, facts: string[], side: 'right' | 'left') {
    el.addEventListener('mouseenter', () => {
      clear(card);
      card.append(h('b', {}, title), h('p', {}, text ?? ''), ...facts.map((f) => h('div', { class: 'fact' }, f)));
      const r = el.getBoundingClientRect();
      card.style.display = 'block';
      card.style.top = `${Math.max(8, Math.min(window.innerHeight - card.offsetHeight - 8, r.top))}px`;
      card.style.left = side === 'right' ? `${r.right + 10}px` : `${r.left - card.offsetWidth - 10}px`;
    });
    el.addEventListener('mouseleave', () => (card.style.display = 'none'));
  }

  // ---------- network ----------
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMsg;
    switch (msg.t) {
      case 'init':
        init = msg;
        defB = new Map(msg.ruleset.buildings.map((b) => [b.id, b]));
        defU = new Map(msg.ruleset.units.map((u) => [u.id, u]));
        const barriers: Record<string, number> = {};
        for (const t of msg.ruleset.terrain) if (t.barrier) barriers[t.id] = t.barrier.minCells;
        terrain = msg.map.terrain ? new TerrainGrid(msg.map.terrain, barriers) : null;
        roads = msg.map.roads?.length ? new RoadNetwork(msg.map.roads) : null;
        document.getElementById('mod-theme')!.textContent = msg.ruleset.themes.map((t) => t.css).join('\n');
        terrainBtn.style.display = terrain ? '' : 'none';
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
        finished = true;
        const mine = init?.team === msg.winner;
        app.append(
          h('div', { class: 'overlay' },
            h('div', { class: 'card' },
              h('h2', {}, msg.winner === null ? 'DRAW' : mine ? 'VICTORY' : 'DEFEAT'),
              h('p', { class: 'muted' }, msg.reason),
              h('button', { class: 'primary', onClick: leave }, 'Back to lobby'),
            ),
          ),
        );
        break;
      }
    }
  };
  ws.onclose = () => {
    if (closed) return;
    // the match no longer exists on the server (finished or restarted): leaving must not offer a rejoin
    if (!init) finished = true;
    hint.textContent = init ? 'Disconnected from server.' : 'This match is no longer running. Press Leave.';
  };

  // ---------- map ----------
  function buildMap() {
    const m = init!.map;
    map = new maplibregl.Map({
      container: mapEl,
      style: STYLE,
      center: m.center,
      zoom: m.zoom,
      minZoom: 4.5,
      maxZoom: 13,
      boxZoom: false,
      dragRotate: false,
      attributionControl: { compact: true },
      maxBounds: [m.bounds[0] - 4, m.bounds[1] - 3, m.bounds[2] + 4, m.bounds[3] + 3],
    });
    map.doubleClickZoom.disable();
    map.touchZoomRotate.disableRotation();

    // NATO markers are drawn the first time the style asks for them
    map.on('styleimagemissing', (e) => {
      if (map.hasImage(e.id)) return;
      const spec = parseNatoId(e.id);
      if (spec) map.addImage(e.id, drawNato(spec), { pixelRatio: 2 });
    });

    map.on('load', () => {
      for (const id of ['occupied', 'front', 'pockets', 'units', 'formations', 'sel', 'rings', 'ghost', 'roads']) map.addSource(id, { type: 'geojson', data: empty() });

      if (terrain) {
        map.addSource('terrain', { type: 'image', url: terrainImage(), coordinates: [[terrain.data.west, terrain.data.north], [terrain.data.east, terrain.data.north], [terrain.data.east, terrain.data.south], [terrain.data.west, terrain.data.south]] });
        map.addLayer({ id: 'terrain', type: 'raster', source: 'terrain', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.72, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } });
      }
      (map.getSource('roads') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: (m.roads ?? []).map((l) => {
          const coords: LngLat[] = [];
          for (let i = 1; i + 1 < l.length; i += 2) coords.push([l[i], l[i + 1]]);
          return { type: 'Feature', properties: { major: l[0] }, geometry: { type: 'LineString', coordinates: coords } };
        }),
      });
      map.addLayer({
        id: 'roads', type: 'line', source: 'roads',
        paint: {
          'line-color': '#e8c35a',
          'line-opacity': ['case', ['==', ['get', 'major'], 1], 0.5, 0.26],
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['==', ['get', 'major'], 1], 0.9, 0.4], 10, ['case', ['==', ['get', 'major'], 1], 2.6, 1.4]],
        },
      });
      // front: flat occupied tint, a hard-edged contact zone, and a crisp cased line with sharp corners (no blur, no rounding)
      map.addLayer({ id: 'occupied-fill', type: 'fill', source: 'occupied', paint: { 'fill-color': '#e5383b', 'fill-opacity': 0.12, 'fill-antialias': false } });
      map.addLayer({ id: 'front-zone', type: 'line', source: 'front', layout: { 'line-join': 'miter', 'line-miter-limit': 4 }, paint: { 'line-color': '#e5383b', 'line-opacity': 0.2, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 5, 5, 8, 16, 11, 70] } });
      map.addLayer({ id: 'front-case', type: 'line', source: 'front', layout: { 'line-join': 'miter', 'line-miter-limit': 4 }, paint: { 'line-color': '#12060a', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3.4, 10, 6] } });
      map.addLayer({ id: 'front-line', type: 'line', source: 'front', layout: { 'line-join': 'miter', 'line-miter-limit': 4 }, paint: { 'line-color': '#ff4d57', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.7, 10, 3] } });
      // cauldrons: yellow broken ring around the cut-off ground
      map.addLayer({ id: 'pocket-fill', type: 'fill', source: 'pockets', paint: { 'fill-color': '#ffd84a', 'fill-opacity': 0.1 } });
      map.addLayer({ id: 'pocket-line', type: 'line', source: 'pockets', paint: { 'line-color': '#ffd84a', 'line-width': 2.2, 'line-dasharray': [2, 1.5] } });
      // occupied ground also gets fine diagonal hatching, like on printed situation maps
      map.addImage('hatch', hatchImage(), { pixelRatio: 2 });
      map.addLayer({ id: 'occupied-hatch', type: 'fill', source: 'occupied', paint: { 'fill-pattern': 'hatch', 'fill-opacity': 0.5 } }, 'front-zone');
      map.addLayer({ id: 'rings', type: 'line', source: 'rings', paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.4, 'line-dasharray': [2, 3] } });
      map.addLayer({ id: 'ghost-fill', type: 'fill', source: 'ghost', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'ghost-line', type: 'line', source: 'ghost', paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [3, 2] } });
      map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#ffffff', 'line-width': 1, 'line-opacity': 0.55, 'line-dasharray': [1, 3] } });
      map.addLayer({ id: 'sel-pts', type: 'circle', source: 'sel', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 3.5, 'circle-color': '#0b0d10', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } });

      const iconSize: any = ['interpolate', ['linear'], ['zoom'], 5, 0.4, 8, 0.58, 11, 0.85];
      const symbol = (id: string, filter: any, extra: Record<string, unknown> = {}) =>
        map.addLayer({
          id, type: 'symbol', source: id === 'formations' ? 'formations' : 'units', filter, ...extra,
          layout: { 'icon-image': ['get', 'icon'], 'icon-size': id === 'formations' ? ['interpolate', ['linear'], ['zoom'], 5, 0.62, 8, 0.8] : iconSize, 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'z'] },
        } as any);
      symbol('units-loose', ['!', ['get', 'grp']], { minzoom: GROUP_ZOOM });
      symbol('units-grouped', ['get', 'grp'], { minzoom: GROUP_ZOOM });
      symbol('formations', ['all'], { maxzoom: GROUP_ZOOM });

      for (const cp of init!.map.capturePoints) {
        const el = h('div', { class: 'cp' }, h('i', {}), h('span', {}, cp.name));
        new maplibregl.Marker({ element: el }).setLngLat(cp.pos).addTo(map);
        pMarkers.set(cp.id, el);
      }
      arrows = new FrontArrows(map, mapEl, TEAM_COLOR, () => snap?.front ?? []);
      fx = new ShotFx(map, mapEl, (def) => defU.get(def) ?? defB.get(def)?.attack, TEAM_COLOR);
      if (import.meta.env.DEV) (window as any).__sw = { map, fx, arrows, snap: () => snap, fakePockets: [] };
      mapReady = true;
      if (snap) render();
      requestAnimationFrame(animate);
    });

    const setScale = () => mapEl.style.setProperty('--s', String(Math.min(1.4, Math.max(0.42, (map.getZoom() - 3.6) / 4.6))));
    map.on('zoom', setScale);
    map.on('zoom', () => mapEl.classList.toggle('far', map.getZoom() < 6.6));
    mapEl.classList.toggle('far', m.zoom < 6.6);
    setScale();

    let lastHover = 0;
    map.on('mousemove', (e) => {
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (placing) drawGhost(p);
      const now = performance.now();
      if (now - lastHover > 80) (lastHover = now), showTerrain(p);
    });
    map.on('mouseout', () => (terrainChip.style.display = 'none'));
    map.on('click', (e) => {
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (performance.now() - suppressClick < 250) return; // the click that ends a box selection
      if (placing) {
        send({ type: 'build', def: placing.id, pos: p });
        if (!e.originalEvent.shiftKey) cancelPlacing();
        return;
      }
      const layers = ['units-loose', 'units-grouped', 'formations'].filter((l) => map.getLayer(l));
      const hit = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers }).find((f) => f.properties?.own);
      selBuilding = null;
      if (hit?.properties?.gid) selUnits = new Set(groups.get(Number(hit.properties.gid))?.ids ?? []);
      else if (hit?.properties?.ids) selUnits = new Set(JSON.parse(hit.properties.ids) as number[]);
      else if (hit) {
        const id = Number(hit.properties!.id);
        if (e.originalEvent.shiftKey) selUnits.has(id) ? selUnits.delete(id) : selUnits.add(id);
        else selUnits = new Set([id]);
      } else if (!e.originalEvent.shiftKey) selUnits = new Set();
      render();
    });
    map.on('contextmenu', (e) => {
      if (placing) return cancelPlacing();
      if (!selUnits.size) return;
      const ev = e.originalEvent;
      // Shift queues another waypoint, Alt goes straight across country (no roads, stays combat-ready)
      send({ type: 'move', units: [...selUnits], to: [e.lngLat.lng, e.lngLat.lat], cohesion: formation && selUnits.size > 1, queue: ev.shiftKey, mode: ev.altKey ? 'direct' : 'fast' });
    });
    window.addEventListener('keydown', onKey);

    // shift+drag box selection
    mapEl.addEventListener('mousedown', (e) => {
      if (!e.shiftKey || e.button !== 0 || placing) return;
      e.stopPropagation();
      boxStart = { x: e.clientX, y: e.clientY };
    }, true);
    window.addEventListener('mousemove', onBoxMove);
    window.addEventListener('mouseup', onBoxUp);
  }

  let boxStart: { x: number; y: number } | null = null;
  function onBoxMove(e: MouseEvent) {
    if (!boxStart) return;
    if (Math.abs(e.clientX - boxStart.x) + Math.abs(e.clientY - boxStart.y) < 6) return;
    const x = Math.min(boxStart.x, e.clientX), y = Math.min(boxStart.y, e.clientY);
    Object.assign(boxEl.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${Math.abs(e.clientX - boxStart.x)}px`, height: `${Math.abs(e.clientY - boxStart.y)}px` });
  }
  function onBoxUp(e: MouseEvent) {
    if (!boxStart) return;
    const start = boxStart;
    boxStart = null;
    const dragged = boxEl.style.display === 'block';
    boxEl.style.display = 'none';
    if (!dragged || !snap) return; // a plain shift+click is handled by the map click
    const r = mapEl.getBoundingClientRect();
    const x0 = Math.min(start.x, e.clientX) - r.left, x1 = Math.max(start.x, e.clientX) - r.left;
    const y0 = Math.min(start.y, e.clientY) - r.top, y1 = Math.max(start.y, e.clientY) - r.top;
    selUnits = new Set(snap.units.filter((u) => u.owner === me).filter((u) => {
      const p = map.project(u.pos);
      return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    }).map((u) => u.id));
    selBuilding = null;
    suppressClick = performance.now();
    render();
  }
  let suppressClick = 0;

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.key === 'Escape') return cancelPlacing();
    const k = e.key.toLowerCase();
    if (k === 's' && selUnits.size) return void send({ type: 'stop', units: [...selUnits] });
    if (k === 't') return toggleTerrain();
    if (k === 'g' && selUnits.size) return makeGroup();
    if (k === 'u' && selUnits.size) return ungroup();
    if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key);
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        if (selUnits.size) makeGroup(n);
      } else selectGroup(n, true);
    }
  }

  // ---------- groups ----------
  function makeGroup(id?: number) {
    if (!selUnits.size) return;
    const n = id ?? [1, 2, 3, 4, 5, 6, 7, 8, 9].find((i) => !groups.has(i));
    if (!n) return toast('All 9 group slots are used (Ctrl+number overwrites one)', true);
    for (const g of groups.values()) for (const u of selUnits) g.ids.delete(u);
    groups.set(n, { id: n, ids: new Set(selUnits) });
    pruneGroups();
    toast(`Group ${n}: ${selUnits.size} units`);
    render();
  }
  function ungroup() {
    for (const g of groups.values()) for (const u of selUnits) g.ids.delete(u);
    pruneGroups();
    render();
  }
  function pruneGroups() {
    const alive = new Set(snap?.units.filter((u) => u.owner === me).map((u) => u.id));
    for (const [id, g] of groups) {
      for (const u of g.ids) if (!alive.has(u)) g.ids.delete(u);
      if (!g.ids.size) groups.delete(id);
    }
  }
  function selectGroup(n: number, fly = false) {
    const g = groups.get(n);
    if (!g || !snap) return;
    const again = fly && selUnits.size === g.ids.size && [...g.ids].every((i) => selUnits.has(i));
    selUnits = new Set(g.ids);
    selBuilding = null;
    if (again) {
      const c = centroid(snap.units.filter((u) => g.ids.has(u.id)));
      if (c) map.easeTo({ center: c, zoom: Math.max(map.getZoom(), 8.5) });
    }
    render();
  }
  const centroid = (us: UnitView[]): LngLat | null => (us.length ? [us.reduce((a, u) => a + u.pos[0], 0) / us.length, us.reduce((a, u) => a + u.pos[1], 0) / us.length] : null);

  function renderGroups() {
    clear(groupBar);
    if (!snap || !init) return;
    for (const g of [...groups.values()].sort((a, b) => a.id - b.id)) {
      const us = snap.units.filter((u) => g.ids.has(u.id));
      const active = selUnits.size === g.ids.size && us.every((u) => selUnits.has(u.id));
      const hp = us.reduce((a, u) => a + u.hp, 0) / Math.max(1, us.reduce((a, u) => a + maxHp(u), 0));
      const chip = h('button', { class: 'grp' + (active ? ' active' : ''), title: 'Click: select · click again: jump to group', onClick: () => selectGroup(g.id, true) },
        h('b', {}, g.id), h('span', {}, `${echelonFor(us.length)} ×${us.length}`), h('i', { style: { width: `${Math.round(hp * 100)}%` } }));
      groupBar.append(chip);
    }
  }

  // ---------- terrain ----------
  /**
   * Terrain overlay as one image. The grid can be far wider than a GPU texture, so it is drawn at up to 4096 px across:
   * each pixel shows the most significant terrain of the cells it covers (water and towns win over fields).
   */
  function terrainImage(): string {
    const t = terrain!;
    const { cols, rows } = t.data;
    const f = Math.max(1, Math.ceil(cols / 4096));
    const c = document.createElement('canvas');
    c.width = Math.floor(cols / f);
    c.height = Math.floor(rows / f);
    const g = c.getContext('2d')!;
    const img = g.createImageData(c.width, c.height);
    const weight: Record<string, number> = { water: 6, city: 5, mountain: 4, forest: 3, hill: 2 };
    const alpha: Record<string, number> = { water: 150, city: 200, mountain: 185, forest: 175, hill: 125 };
    const look = t.ids.map((id, i) => {
      const col = init!.ruleset.terrain.find((d) => d.id === id)?.color ?? '#000000';
      return { rgba: [parseInt(col.slice(1, 3), 16), parseInt(col.slice(3, 5), 16), parseInt(col.slice(5, 7), 16), i === 0 ? 0 : alpha[id] ?? 160], w: i === 0 ? 0 : weight[id] ?? 1 };
    });
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        let best = 0;
        for (let dy = 0; dy < f; dy++) {
          for (let dx = 0; dx < f; dx++) {
            const k = t.kindAt((y * f + dy) * cols + x * f + dx);
            if (look[k].w > look[best].w) best = k;
          }
        }
        img.data.set(look[best].rgba, (y * c.width + x) * 4);
      }
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }
  function toggleTerrain() {
    if (!mapReady || !map.getLayer('terrain')) return;
    const on = map.getLayoutProperty('terrain', 'visibility') !== 'visible';
    map.setLayoutProperty('terrain', 'visibility', on ? 'visible' : 'none');
    terrainBtn.classList.toggle('on', on);
  }
  function showTerrain(p: LngLat) {
    if (!terrain || !init) return;
    const t = init.ruleset.terrain.find((d) => d.id === terrain!.at(p));
    if (!t) return void (terrainChip.style.display = 'none');
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const classes = [...new Set(init.ruleset.units.filter((u) => u.kind !== 'air').map((u) => u.mobility ?? 'foot'))];
    clear(terrainChip);
    terrainChip.style.display = 'flex';
    const barrier = terrain.isBarrier(p);
    terrainChip.append(h('i', { style: { background: t.color } }), h('b', {}, barrier ? 'River' : t.barrier ? 'Stream (fordable)' : t.name));
    if (barrier) terrainChip.append(h('span', { class: 'neg' }, 'ground units cross only on a road bridge or at a pontoon crossing'));
    else terrainChip.append(...classes.map((c) => h('span', {}, `${c} ${pct(t.speed[c] ?? t.speed.default ?? 1)}`)));
    if (t.cover) terrainChip.append(h('span', { class: t.cover > 0 ? 'pos' : 'neg' }, `cover ${t.cover > 0 ? '+' : ''}${pct(t.cover)}`));
    if (t.concealment < 1) terrainChip.append(h('span', { class: 'pos' }, 'concealed'));
    if (!barrier && (t.vision ?? 1) !== 1) terrainChip.append(h('span', { class: (t.vision ?? 1) > 1 ? 'pos' : 'neg' }, `sight ${(t.vision ?? 1) > 1 ? '+' : ''}${Math.round(((t.vision ?? 1) - 1) * 100)}%`));
    if (roads?.isNear(p, 2)) terrainChip.append(h('span', { class: 'road' }, `road ×${init.ruleset.rules.roadSpeedMult}`));
  }

  // ---------- placement ----------
  function cancelPlacing() {
    if (!placing) return;
    placing = null;
    hint.textContent = HINT;
    mapEl.classList.remove('placing');
    (map.getSource('ghost') as GeoJSONSource | undefined)?.setData(empty());
    buildPalette();
  }

  function circle(c: LngLat, km: number, n = 48): LngLat[] {
    return Array.from({ length: n + 1 }, (_, i) => offsetKm(c, Math.cos((i / n) * 6.2832) * km, Math.sin((i / n) * 6.2832) * km));
  }

  function placementProblem(def: BuildingDef, p: LngLat): string | null {
    if (!init || !snap) return 'not ready';
    const r = init.ruleset.rules;
    const d = distToFrontKm(snap.front, p) * (init.team === 0 ? 1 : -1);
    const pocket = snap.pockets.find((k) => pointInRing(k.nodes, p));
    if (pocket) return pocket.team === init.team ? 'this ground is encircled' : 'not your territory';
    if (d < 0) return 'not your territory';
    if (d < r.minBuildDistanceFromFront * (def.category === 'civil' ? 2 : 1)) return 'too close to the front';
    if (terrain?.at(p) === 'water') return 'cannot build on water';
    if (def.needsWaterWithinKm && !nearRiver(p, def.needsWaterWithinKm)) return 'must be on a river bank';
    if (snap.buildings.some((b) => distKm(b.pos, p) < r.minBuildSpacing)) return 'space occupied';
    if (!Object.entries(def.cost).every(([k, v]) => (snap!.res[k] ?? 0) >= v)) return 'not enough resources';
    return null;
  }

  function nearRiver(p: LngLat, km: number): boolean {
    if (!terrain) return false;
    for (let a = 0; a < 16; a++) for (const r of [km * 0.5, km]) if (terrain.isBarrier(offsetKm(p, Math.cos((a / 16) * 6.2832) * r, Math.sin((a / 16) * 6.2832) * r))) return true;
    return false;
  }

  function drawGhost(p: LngLat) {
    if (!placing || !init) return;
    const problem = placementProblem(placing, p);
    const color = problem ? '#ff5a5a' : '#5ae88a';
    const radius = placing.attack?.range ?? placing.crossing?.radiusKm ?? placing.defense?.radiusKm ?? placing.aura?.radiusKm ?? (placing.vision && placing.vision > 8 ? placing.vision : 1.2);
    (map.getSource('ghost') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { color }, geometry: { type: 'Polygon', coordinates: [circle(p, radius)] } }],
    });
    const road = roads?.isNear(p, init.ruleset.rules.roadAccessKm);
    const bonus = Math.round((init.ruleset.rules.roadOutputMult - 1) * 100);
    hint.textContent = problem ? `${placing.name}: ${problem}` : `${placing.name}: click to build${placing.produces ? (road ? ` · road access +${bonus}% output` : ' · no road nearby') : ''} (Shift keeps placing, Esc cancels)`;
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
    card.style.display = 'none'; // its button is about to be replaced
    clear(palette);
    for (const cat of ['civil', 'military'] as const) {
      palette.append(h('div', { class: 'cat' }, cat === 'civil' ? 'Civil infrastructure' : 'War infrastructure'));
      for (const b of init.ruleset.buildings.filter((x) => x.category === cat)) {
        const btn =
          h('button', { class: 'bld' + (placing?.id === b.id ? ' active' : ''), onClick: () => {
            placing = b;
            mapEl.classList.add('placing');
            hint.textContent = `Placing ${b.name} — click on your territory (Shift keeps placing, Esc cancels)`;
            buildPalette();
          } },
            h('span', { class: 'ico' }, b.icon),
            h('span', { class: 'meta' }, h('b', {}, b.name), costHtml(b.cost, snap?.res)),
          );
        describe(btn, b.name, b.description, buildingFacts(b), 'right');
        palette.append(btn);
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

  const ranks = () => init!.ruleset.ranks;
  const maxHp = (u: UnitView) => (defU.get(u.def)?.hp ?? 1) * (ranks()[u.rank]?.hp ?? 1);

  function renderSide() {
    if (!init || !snap) return;
    if (!palette.matches(':hover')) card.style.display = 'none';
    clear(side);
    if (selBuilding !== null) {
      const b = snap.buildings.find((x) => x.id === selBuilding && x.owner === me);
      if (!b) selBuilding = null;
      else {
        const d = defB.get(b.def)!;
        side.append(
          h('h3', {}, `${d.icon} ${d.name}`),
          h('div', { class: 'muted' }, d.description ?? ''),
          h('div', { class: 'stat' }, `HP ${b.hp}/${d.hp}`),
        );
        if (d.produces) side.append(h('div', { class: 'stat' }, b.road ? `Road access: +${Math.round((init.ruleset.rules.roadOutputMult - 1) * 100)}% output` : 'No road access'));
        if (d.training && b.progress >= 1) {
          const t = d.training;
          const inside = b.inside ?? [];
          const rk = ranks();
          const coming = snap.units.filter((u) => u.entering === b.id).length;
          side.append(h('div', { class: 'stat' }, `Inside: ${inside.length}/${t.capacity}${coming ? ` · ${coming} on the way` : ''}`));
          if (inside.length) side.append(h('div', { class: 'row pupils' }, ...inside.map((u) => unitIcon(defU.get(u.def)!, u.rank))));
          if (b.course) {
            const done = 1 - b.course.remaining / b.course.total;
            side.append(h('div', { class: 'stat' }, `Course in progress: ${b.course.remaining}s left · paid as it runs, pauses if money runs out`), h('div', { class: 'bar' }, h('i', { style: { width: `${Math.round(done * 100)}%`, background: 'var(--accent)' } })));
          } else {
            const rules = init.ruleset.rules;
            let top = 0;
            let perSec = 0;
            for (const u of inside) {
              if (!rk[u.rank + 1]) continue;
              top = Math.max(top, u.rank + 1);
              perSec += (rules.courseCostPerTick + rules.courseCostPerRank * u.rank) * rules.tickRate;
            }
            const ready = inside.length >= t.minUnits;
            const secs = t.baseTime + t.timePerRank * top;
            side.append(
              h('button', { class: 'bld', disabled: !ready || undefined, onClick: () => send({ type: 'course', building: b.id }) },
                h('span', { class: 'ico' }, '⚑'),
                h('span', { class: 'meta' },
                  h('b', {}, ready ? `Start course · ${secs}s` : `Needs ${t.minUnits - inside.length} more unit${t.minUnits - inside.length === 1 ? '' : 's'}`),
                  h('small', {}, ready ? `${perSec.toFixed(1)} money/s while it runs (about ${Math.round(perSec * secs)} in total)` : `at least ${t.minUnits} to run a course`))),
            );
            if (inside.length) side.append(h('button', { onClick: () => send({ type: 'release', building: b.id }) }, 'Send everyone out'));
            side.append(h('div', { class: 'muted' }, 'Select ground units and right click this building to send them in. Graduates come out one rank higher at full strength.'));
          }
        }
        if (d.attack) side.append(h('div', { class: 'stat' }, `Engages ${d.attack.targets} targets within ${d.attack.range} km`));
        if (d.crossing) side.append(h('div', { class: 'stat' }, `River crossing radius ${d.crossing.radiusKm} km`));
        if (b.progress < 1) side.append(h('div', { class: 'stat' }, `Under construction ${Math.round(b.progress * 100)}%`));
        if (b.progress >= 1) {
          for (const uid of d.trains ?? []) {
            const u = defU.get(uid)!;
            const btn = h('button', { class: 'bld', onClick: () => send({ type: 'train', building: b.id, unit: uid }) },
              unitIcon(u, 0), h('span', { class: 'meta' }, h('b', {}, `Train ${u.name} · ${u.trainTime}s`), costHtml(u.cost, snap!.res)));
            describe(btn, u.name, u.description, unitFacts(u), 'left');
            side.append(btn);
          }
          const q = snap.queue.filter((x) => x.building === b.id);
          if (q.length) side.append(h('div', { class: 'stat' }, 'Queue: ' + q.map((x) => `${defU.get(x.unit)?.name} (${x.remaining}s)`).join(', ')));
        }
        if (b.def !== 'hq') side.append(h('button', { class: 'ghost', onClick: () => (send({ type: 'demolish', building: b.id }), (selBuilding = null)) }, 'Demolish (40% refund)'));
      }
    } else if (selUnits.size) {
      const mine = snap.units.filter((u) => selUnits.has(u.id));
      const rk = ranks();
      const group = [...groups.values()].find((g) => g.ids.size === mine.length && mine.every((u) => g.ids.has(u.id)));
      side.append(h('h3', {}, group ? `Group ${group.id} · ${mine.length} units` : `${mine.length} unit${mine.length === 1 ? '' : 's'} selected`));

      if (mine.length === 1) {
        const u = mine[0];
        const d = defU.get(u.def)!;
        const next = rk[u.rank + 1];
        side.append(
          h('div', { class: 'row' }, unitIcon(d, u.rank), h('div', {}, h('b', {}, d.name), h('div', { class: 'muted' }, rk[u.rank]?.name ?? ''))),
          h('div', { class: 'stat' }, `HP ${u.hp}/${Math.round(maxHp(u))}`),
          h('div', { class: 'stat' }, next ? `XP ${u.xp}/${next.xp} → ${next.name}` : `XP ${u.xp} · top rank`),
          h('div', { class: 'stat muted' }, `damage ×${rk[u.rank]?.damage ?? 1} · range ×${rk[u.rank]?.range ?? 1}`),
          h('div', { class: 'muted' }, d.description ?? ''),
          ...unitFacts(d).map((f) => h('div', { class: 'fact' }, f)),
        );
        if (u.entering) side.append(h('div', { class: 'stat', style: { color: 'var(--accent)' } }, 'Heading to the training centre'));
        if (u.encircled) side.append(h('div', { class: 'stat', style: { color: '#ffd84a' } }, 'Encircled: cut off from supply, losing strength. Break out or be relieved.'));
        if (u.transport) side.append(h('div', { class: 'stat', style: { color: 'var(--accent)' } }, 'Transport mode: on the road, cannot fire'));
      } else {
        const by = new Map<string, UnitView[]>();
        mine.forEach((u) => by.set(u.def, [...(by.get(u.def) ?? []), u]));
        for (const [k, us] of by) {
          const d = defU.get(k)!;
          const top = Math.max(...us.map((u) => u.rank));
          side.append(h('div', { class: 'row' }, unitIcon(d, top), h('span', { class: 'stat' }, `${us.length} × ${d.name}`, us.some((u) => u.rank > 0) ? h('small', { class: 'muted' }, ` · ${rk[top]?.name}`) : null)));
        }
      }

      if (mine.some((u) => rk[u.rank + 1] && defU.get(u.def)?.kind !== 'air')) {
        side.append(h('div', { class: 'muted' }, `Ranks are earned in combat (${init.ruleset.rules.xpPerKill} XP per kill) or in a Training Centre: right click one with these units selected.`));
      }

      const formationBox = h('input', { type: 'checkbox', checked: formation || undefined });
      formationBox.addEventListener('change', () => (formation = formationBox.checked));
      if (mine.length > 1) side.append(h('label', { class: 'field check' }, formationBox, h('span', {}, 'Move in formation (slowest sets the pace)')));
      side.append(
        h('div', { class: 'row' },
          h('button', { onClick: () => makeGroup() }, 'Group (G)'),
          group ? h('button', { onClick: () => ungroup() }, 'Ungroup (U)') : null,
          h('button', { class: 'ghost', onClick: () => send({ type: 'stop', units: [...selUnits] }) }, 'Stop (S)'),
        ),
        h('div', { class: 'muted' }, 'Right click: fastest route (roads in transport mode, bridges over rivers). Shift+right click: add a waypoint. Alt+right click: straight across country.'),
      );
    }
    side.classList.toggle('open', side.childElementCount > 0);
  }

  function unitIcon(d: UnitDef, rank: number) {
    const c = h('canvas', { class: 'nato-ico', width: 128, height: 128 });
    c.getContext('2d')!.putImageData(drawNato({ hostile: false, color: TEAM_COLOR[init!.team], symbol: d.symbol ?? 'infantry', echelon: '', rank, selected: false, own: true, transport: false }), 0, 0);
    return c;
  }

  // ---------- snapshot → view ----------
  let lastPalette = 0;
  function onSnapshot(s: SnapMsg) {
    if (import.meta.env.DEV) s.pockets.push(...((window as any).__sw?.fakePockets ?? [])); // browser tests draw cauldrons this way
    snap = s;
    if (shown.length !== s.front.length) shown = s.front.map((n) => ({ ...n }));
    pruneGroups();
    for (const id of selUnits) if (!s.units.some((u) => u.id === id)) selUnits.delete(id);
    fx?.add(s.shots);
    arrows?.feed(s.shots);
    renderRes();
    renderScore();
    // side panel and palette hold buttons: rebuild them at most once a second so clicks are never lost
    const now = performance.now();
    if (now - lastPalette > 1000 && !side.matches(':hover') && !palette.matches(':hover')) {
      lastPalette = now;
      renderSide();
      if (!placing) buildPalette();
    }
    renderGroups();
    if (mapReady) renderMap();
  }

  /** Full refresh after a local change (selection, grouping). */
  function render() {
    renderSide();
    renderGroups();
    if (mapReady) renderMap();
  }

  function renderMap() {
    if (!init || !snap) return;
    const myTeam = init.team;
    const grouped = new Map<number, number>();
    for (const g of groups.values()) for (const id of g.ids) grouped.set(id, g.id);

    (map.getSource('units') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: snap.units.map((u) => {
        const d = defU.get(u.def);
        const own = u.owner === me;
        const sel = selUnits.has(u.id);
        const icon = natoId({ hostile: u.team !== myTeam, color: TEAM_COLOR[u.team], symbol: d?.symbol ?? 'infantry', echelon: '', rank: u.rank, selected: sel, own, transport: u.transport, encircled: u.encircled });
        return { type: 'Feature', properties: { id: u.id, own, grp: grouped.has(u.id), icon, z: sel ? 3 : own ? 2 : 1 }, geometry: { type: 'Point', coordinates: u.pos } };
      }),
    });

    // one formation marker per group (shown when zoomed out)
    const formations: any[] = [];
    for (const g of groups.values()) {
      const us = snap.units.filter((u) => g.ids.has(u.id));
      const c = centroid(us);
      if (!c) continue;
      const kinds = new Set(us.map((u) => defU.get(u.def)?.symbol ?? 'infantry'));
      const symbol = kinds.size === 1 ? [...kinds][0] : kinds.has('armor') && kinds.has('infantry') ? 'mechanized' : [...kinds].sort((a, b) => us.filter((u) => defU.get(u.def)?.symbol === b).length - us.filter((u) => defU.get(u.def)?.symbol === a).length)[0];
      const sel = us.every((u) => selUnits.has(u.id)) && selUnits.size === us.length;
      const rank = Math.round(us.reduce((a, u) => a + u.rank, 0) / us.length);
      formations.push({ type: 'Feature', properties: { gid: g.id, own: true, z: sel ? 3 : 2, icon: natoId({ hostile: false, color: TEAM_COLOR[myTeam], symbol, echelon: echelonFor(us.length), rank, selected: sel, own: true, transport: us.filter((u) => u.transport).length * 2 > us.length }) }, geometry: { type: 'Point', coordinates: c } });
    }
    // zoomed out, everything else is merged into formation markers per ~30 km cell (mine / allied / hostile kept apart)
    const cells = new Map<string, UnitView[]>();
    for (const u of snap.units) {
      if (grouped.has(u.id)) continue;
      const key = `${u.team}|${u.owner === me ? 1 : 0}|${Math.floor(u.pos[0] / 0.36)}|${Math.floor(u.pos[1] / 0.24)}`;
      const list = cells.get(key);
      list ? list.push(u) : cells.set(key, [u]);
    }
    for (const us of cells.values()) {
      const own = us[0].owner === me;
      const count = new Map<string, number>();
      us.forEach((u) => count.set(defU.get(u.def)?.symbol ?? 'infantry', (count.get(defU.get(u.def)?.symbol ?? 'infantry') ?? 0) + 1));
      const symbol = count.has('armor') && count.has('infantry') ? 'mechanized' : [...count].sort((a, b) => b[1] - a[1])[0][0];
      const sel = own && us.every((u) => selUnits.has(u.id));
      formations.push({
        type: 'Feature',
        properties: { own, ids: own ? JSON.stringify(us.map((u) => u.id)) : '', z: sel ? 3 : own ? 2 : 1, icon: natoId({ hostile: us[0].team !== myTeam, color: TEAM_COLOR[us[0].team], symbol, echelon: us.length > 1 ? echelonFor(us.length) : '', rank: Math.round(us.reduce((a, u) => a + u.rank, 0) / us.length), selected: sel, own, transport: us.filter((u) => u.transport).length * 2 > us.length }) },
        geometry: { type: 'Point', coordinates: centroid(us) },
      });
    }
    (map.getSource('formations') as GeoJSONSource).setData({ type: 'FeatureCollection', features: formations });

    // destination lines for the selection
    (map.getSource('sel') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: snap.units.filter((u) => selUnits.has(u.id) && u.target).slice(0, 60).flatMap((u) => {
        const stops = u.route?.length ? u.route : [u.target!];
        return [
          { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [u.pos, ...stops] } },
          ...stops.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } })),
        ];
      }),
    });

    // vision rings for own long-range assets
    const rings: any[] = [];
    for (const b of snap.buildings) {
      const d = defB.get(b.def)!;
      if (b.team !== myTeam || b.progress < 1) continue;
      const ring = (km: number, color: string) => rings.push({ type: 'Feature', properties: { color }, geometry: { type: 'LineString', coordinates: circle(b.pos, km, 64) } });
      if (b.owner === me && (d.vision ?? 0) >= 20) ring(d.vision!, TEAM_COLOR[b.team]);
      if (d.attack) ring(d.attack.range, '#ffd84a');
      if (d.crossing) ring(d.crossing.radiusKm, '#7fe7ff');
    }
    (map.getSource('rings') as GeoJSONSource).setData({ type: 'FeatureCollection', features: rings });

    // buildings → DOM markers with construction animation
    const alive = new Set<number>();
    for (const b of snap.buildings) {
      alive.add(b.id);
      const d = defB.get(b.def)!;
      let m = bMarkers.get(b.id);
      if (!m) {
        const el = h('div', { class: `bm t${b.team}` });
        el.innerHTML = `<div class="blueprint"></div><svg class="ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" /></svg><div class="glyph"></div>`;
        el.querySelector('.glyph')!.textContent = d.icon;
        el.addEventListener('click', (ev) => {
          if (placing || b.owner !== me) return;
          ev.stopPropagation();
          selBuilding = b.id;
          selUnits.clear();
          render();
        });
        el.addEventListener('contextmenu', (ev) => {
          // right click on your own training centre with units selected sends them inside
          if (b.owner !== me || !d.training || !selUnits.size) return;
          ev.preventDefault();
          ev.stopPropagation();
          send({ type: 'enter', units: [...selUnits], building: b.id });
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
      m.el.dataset.n = b.inside?.length ? String(b.inside.length) : '';
      m.el.classList.toggle('busy', !!b.course);
      if (done && !m.done) {
        m.done = true;
        m.el.classList.add('complete');
        const el = m.el;
        setTimeout(() => el.classList.remove('complete'), 1200);
      }
    }
    for (const [id, m] of bMarkers) {
      if (!alive.has(id)) {
        m.el.classList.add('gone');
        setTimeout(() => m.marker.remove(), 400);
        bMarkers.delete(id);
      }
    }

    snap.points.forEach((p) => pMarkers.get(p.id)?.style.setProperty('--c', TEAM_COLOR[p.owner]));
  }

  // ---------- front animation (smooth between 5 Hz snapshots) ----------
  function animate() {
    if (closed) return;
    requestAnimationFrame(animate);
    if (!snap || !init || !mapReady) return;
    // nodes are added/removed as the line stretches: restart from the exact line rather than blending mismatched nodes
    if (shown.length !== snap.front.length) (shown = snap.front.map((n) => ({ ...n }))), (frontDrawn = false);
    let moved = false;
    shown.forEach((n, i) => {
      const t = snap!.front[i];
      const dx = t.lng - n.lng, dy = t.lat - n.lat;
      if (Math.abs(dx) + Math.abs(dy) > 1e-6 || n.v !== t.v) moved = true;
      n.lng += dx * 0.18;
      n.lat += dy * 0.18;
      n.v = t.v;
    });
    const pocketKey = snap.pockets.map((k) => `${k.id}:${k.nodes.length}:${k.nodes[0].lng}`).join(',');
    if (pocketKey !== lastPockets) (lastPockets = pocketKey), (moved = true);
    if (!moved && frontDrawn) return;
    frontDrawn = true;
    const line: LngLat[] = shown.map((n) => [n.lng, n.lat]);
    // cauldrons: rings of team 0 ground inside the occupied area are holes in it; rings of team 1 ground are extra patches
    const ring = (k: SnapMsg['pockets'][number]): LngLat[] => [...k.nodes.map((n): LngLat => [n.lng, n.lat]), [k.nodes[0].lng, k.nodes[0].lat]];
    const holes = snap.pockets.filter((k) => k.team === 0).map(ring);
    const patches = snap.pockets.filter((k) => k.team === 1).map(ring);
    (map.getSource('front') as GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [line, ...holes, ...patches] } } as any);
    (map.getSource('occupied') as GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[[...line, ...init.map.occupiedClosure, line[0]], ...holes], ...patches.map((p) => [p])] } } as any);
    (map.getSource('pockets') as GeoJSONSource).setData({ type: 'FeatureCollection', features: snap.pockets.map((k) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(k)] } })) } as any);
  }
  let frontDrawn = false;
  let lastPockets = '';

  const ping = setInterval(() => (closed ? clearInterval(ping) : ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ping' } satisfies ClientMsg))), 15000);
}
