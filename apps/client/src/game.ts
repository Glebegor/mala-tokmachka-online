import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  DEBUFFS, distKm, distToFrontKm, inPolygon, isReconDrone, isStrikeDrone, offsetKm, pointInRing, RoadIndex, SPECIAL_ZONES, specialZoneAt, TerrainGrid,
  type BuildingDef, type ClientMsg, type Command, type FrontNode, type InitMsg, type LngLat, type ServerMsg, type SnapMsg, type UnitDef, type UnitView,
} from '@sw/core';
import type { Session } from './api';
import { clear, h } from './dom';
import { ShotFx } from './fx';
import { iconHtml, STATUS, statusIconHtml } from './icons';
import { FogOverlay } from './fog';
import { renderUnitHud, type Pickers } from './unitHud';
import { drawNato, echelonFor, natoId, parseNatoId, REL_COLOR, type Relation } from './nato';
import { aircraftSprite } from './sprites';

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
const HINT = 'Click: select · Shift+drag: box · Right click: move (Shift: waypoint, Alt: off-road) · G: group · T: terrain · M: map';

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
  let fog: FogOverlay | null = null;
  /** Click modes for delivery routes and artillery barrages. */
  const pick: Pickers = { route: null, bombard: null, launch: null };
  /** City boundaries per capture point (housing may only go inside a held city). */
  const cityPolys = new Map<string, LngLat[][]>();
  /** Smoothly interpolated unit positions between 5 Hz snapshots. */
  const unitPos = new Map<number, LngLat>();
  const posOf = (u: { id: number; pos: LngLat }): LngLat => unitPos.get(u.id) ?? u.pos;
  const droneBearing = new Map<number, { b: number; v: number }>();
  let terrain: TerrainGrid | null = null;
  let roads: RoadIndex | null = null;
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
  const countEl = h('div', { class: 'countdown' });
  const terrainBtn = h('button', { class: 'ghost', onClick: () => toggleTerrain() }, 'Terrain');
  const basemapBtn = h('button', { class: 'ghost', title: 'Hide or show the real map underneath (M)', onClick: () => toggleBasemap() }, 'Map: ON');
  const unitHud = h('div', { class: 'unit-hud', style: { display: 'none' } });
  /** Ceasefire at the start: a banner with the time left until the war begins. */
  const peaceBanner = h('div', { class: 'peace-banner', style: { display: 'none' } });
  const modeBadge = h('span', { class: 'mode-badge', style: { display: 'none' } }, 'SANDBOX');
  /** Whether teammates may use my buildings. */
  let sharing = true;
  const shareBtn = h('button', { class: 'ghost', style: { display: 'none' }, title: 'Let teammates train at, supply and use your buildings, or keep them to yourself', onClick: () => {
    send({ type: 'share', allow: !sharing });
  } }, 'Buildings: shared');
  const routeBanner = h('div', { class: 'route-banner', style: { display: 'none' } });
  const leave = () => {
    closed = true;
    ws.close();
    fx?.destroy();
    fog?.destroy();
    card.remove();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('mousemove', onBoxMove);
    window.removeEventListener('mouseup', onBoxUp);
    map?.remove();
    onExit(finished);
  };
  app.append(
    h('div', { class: 'game' }, mapEl,
      h('div', { class: 'hud top' }, resBar, modeBadge, scoreBar, shareBtn, terrainBtn, basemapBtn, h('button', { class: 'ghost', onClick: leave }, 'Leave')),
      palette, side, groupBar, terrainChip, toasts, hint, boxEl, countEl, unitHud, routeBanner, peaceBanner),
  );

  const send = (cmd: Command) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'cmd', cmd } satisfies ClientMsg));
  const toast = (text: string, bad = false) => {
    const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, text);
    toasts.append(el);
    setTimeout(() => el.remove(), 4200);
  };

  /** Own units are blue, allies green, the enemy red (markers and aircraft sprites). */
  const relOf = (u: { owner: string; team: number }): Relation => (u.owner === me ? 'own' : u.team === init?.team ? 'ally' : 'enemy');
  /** Mobility indicator under a vehicle's marker ('' for troops on foot and aircraft). */
  const mobilityOf = (d: UnitDef | undefined) => (d && d.kind === 'ground' && d.mobility && d.mobility !== 'foot' ? d.mobility : '');

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
    if (d.defense) f.push(`Defence +${Math.round(d.defense.mult * 100)}% within ${d.defense.radiusKm} km (same kind does not stack)`);
    if (d.levels) f.push(`Upgradable to level ${d.levels.length + 1}: ${d.levels.map((l) => `+${Math.round((l.defenseMult ?? 0) * 100)}%`).join(', ')}`);
    if (d.attack) f.push(`Hits ${d.attack.targets} targets: ${d.attack.damage} dmg/s, ${d.attack.range} km`);
    if (d.crossing) f.push(`River crossing within ${d.crossing.radiusKm} km`);
    if (d.training) f.push(`Courses for ${d.training.minUnits}–${d.training.capacity} units, ${d.training.baseTime + d.training.timePerRank}s and up`);
    if (d.trains?.length) f.push(`Trains ${d.trains.filter((u) => !defU.get(u)?.side || defU.get(u)?.side === (init?.team === 0 ? 'ua' : 'ru')).map((u) => defU.get(u)?.name ?? u).join(', ')}`);
    if (d.storageCap) f.push(`Store ${d.storageCap.toLocaleString('en-US')}`);
    if (!d.fieldWork && d.id !== 'housing') f.push(`Needs ${init?.ruleset.rules.minBuildSpacing ?? 35} km from other sites`);
    if (d.vision) f.push(`Sees ${d.vision} km`);
    if (d.maxPerPlayer) f.push(`Limit ${d.maxPerPlayer} per player`);
    return f;
  }
  function unitFacts(u: UnitDef): string[] {
    const air = u.airDamage ?? init?.ruleset.rules.airDamageDefault ?? 0.25;
    const extra: string[] = [];
    if (u.minRange) extra.push(`Indirect fire ${u.minRange}–${u.range} km, needs a spotter`);
    if (u.cargoCap) extra.push(`${u.fuelOnly ? 'Fuel tank' : 'Cargo'} ${u.cargoCap}${u.passengerCap ? ` · carries ${u.passengerCap} infantry` : ''}`);
    if (u.maxFuel) extra.push(`Fuel tank ${u.maxFuel}${u.droneType === 'strike' ? ' (one way)' : ''}`);
    if (u.missile) extra.push(`${u.missile === 'ballistic' ? 'Ballistic' : 'Cruise'} missile: about ${Math.round((u.maxFuel ?? 0) / 0.08).toLocaleString('en-US')} km range, ${Math.round((u.interceptChance ?? 1) * 100)}% of anti-air shots hit it`);
    if (u.droneType) extra.push(u.droneType === 'strike' ? `Explodes on its target (${u.damage} damage, ${u.blastKm ?? 1.8} km blast)` : 'Circles its area, refuels at an airfield');
    if (u.launchable) extra.push("Small: rides on a pickup's launcher");
    if (u.droneCap) extra.push(`Launcher for ${u.droneCap} small drones`);
    if (u.side) extra.push(`${u.side === 'ua' ? 'Ukraine' : 'Russia'} only`);
    return [
      ...extra,
      `${u.hp} HP · ${u.damage} dmg/s · range ${u.range} km`,
      `Speed ${(u.speed * 60).toFixed(1)} km/min${u.kind === 'air' ? ' (flies)' : ` · ${u.mobility ?? 'foot'}, ×${init?.ruleset.rules.roadSpeedMult ?? 1} on roads`}`,
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
        roads = msg.map.roads?.length ? new RoadIndex(msg.map.roads) : null;
        cityPolys.clear();
        for (const f of msg.map.cities?.features ?? []) {
          const id = f.properties?.cityId ?? f.properties?.id;
          const rings: LngLat[][] = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.map((x: any) => x[0]) : [];
          if (id) for (const r of rings) if (r?.length >= 3) cityPolys.set(id, [...(cityPolys.get(id) ?? []), r]);
        }
        document.getElementById('mod-theme')!.textContent = msg.ruleset.themes.map((t) => t.css).join('\n');
        terrainBtn.style.display = terrain ? '' : 'none';
        modeBadge.style.display = msg.ruleset.rules.sandbox ? '' : 'none';
        modeBadge.title = 'Sandbox: endless resources, stocked stores, building and training ten times faster, no victory or time limit';
        shareBtn.style.display = msg.players.filter((p) => p.team === msg.team).length > 1 ? '' : 'none';
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
      case 'powerLines':
        if (mapReady && msg.building === selBuilding) {
          (map.getSource('power-lines') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: msg.lines.map((l) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: l } })) } as any);
        }
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
    hint.textContent = '';
    app.append(h('div', { class: 'overlay' }, h('div', { class: 'card' },
      h('h2', {}, 'DISCONNECTED'),
      h('p', { class: 'muted' }, init ? 'The connection to the match was lost. You can rejoin from the lobby.' : 'This match is no longer running.'),
      h('button', { class: 'primary', onClick: leave }, 'Back to lobby'))));
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
      if (spec) return void map.addImage(e.id, drawNato(spec), { pixelRatio: 2 });
      // aircraft sprites tinted by relation, and strike smoke
      if (e.id.startsWith('drone|')) {
        const [, def, rel, sel] = e.id.split('|');
        void aircraftSprite(def, REL_COLOR[rel as Relation] ?? REL_COLOR.enemy, sel === '1').then((c) => {
          if (!map.hasImage(e.id)) map.addImage(e.id, c.getContext('2d')!.getImageData(0, 0, c.width, c.height), { pixelRatio: 2 });
        });
        return;
      }
      if (e.id !== 'smoke') return;
      const img = new Image();
      img.onload = () => !map.hasImage(e.id) && map.addImage(e.id, img, { pixelRatio: 2 });
      img.src = '/drones/smoke.png';
    });

    map.on('load', () => {
      for (const id of ['borders', 'cities', 'occupied', 'held', 'grey', 'front', 'pockets', 'units', 'formations', 'sel', 'rings', 'ghost', 'roads', 'smokes', 'zones', 'restricted', 'power-lines', 'orbits', 'fuel-stations']) map.addSource(id, { type: 'geojson', data: empty() });

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
      // city boundaries (OpenStreetMap) under everything else
      if (m.cities) (map.getSource('cities') as GeoJSONSource).setData(m.cities);
      map.addLayer({ id: 'city-fill', type: 'fill', source: 'cities', filter: ['==', ['get', 'type'], 'city-boundary-fill'], paint: { 'fill-color': '#1e293b', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4.5, 0.22, 7.5, 0.42] } });
      map.addLayer({ id: 'city-line', type: 'line', source: 'cities', filter: ['==', ['get', 'type'], 'city-boundary-line'], layout: { 'line-join': 'round' }, paint: { 'line-color': '#64748b', 'line-width': ['interpolate', ['linear'], ['zoom'], 4.5, 0.8, 8, 1.4, 11, 2], 'line-dasharray': [4, 2], 'line-opacity': 0.75 } });
      // roads: the dense local network only appears once zoomed in, highways always
      map.addLayer({
        id: 'roads-minor', type: 'line', source: 'roads', filter: ['!=', ['get', 'major'], 1], minzoom: 6,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#8a7a4a', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.2, 8.5, 0.45], 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 8.5, 0.9, 11, 1.4] },
      });
      map.addLayer({
        id: 'roads', type: 'line', source: 'roads', filter: ['==', ['get', 'major'], 1],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#e8c35a', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 4.5, 0.35, 8, 0.6], 'line-width': ['interpolate', ['linear'], ['zoom'], 4.5, 0.7, 8, 1.6, 11, 2.6] },
      });
      // state borders
      if (m.borders) (map.getSource('borders') as GeoJSONSource).setData(m.borders);
      map.addLayer({ id: 'borders-line', type: 'line', source: 'borders', filter: ['==', ['get', 'type'], 'border'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#8ab5de', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 8, 1.8, 12, 2.6], 'line-dasharray': [4, 3], 'line-opacity': 0.75 } });
      for (const f of m.borders?.features ?? []) {
        if (f.properties?.type !== 'country_label') continue;
        new maplibregl.Marker({ element: h('div', { class: 'country-label' }, f.properties.name) }).setLngLat(f.geometry.coordinates).addTo(map);
      }
      // blue zone: ground held by team 0, the mirror image of the red occupied zone
      map.addLayer({ id: 'held-fill', type: 'fill', source: 'held', paint: { 'fill-color': TEAM_COLOR[0], 'fill-opacity': 0.09, 'fill-antialias': false } });
      // front: flat occupied tint, a hard-edged contact zone, and a crisp cased line with sharp corners (no blur, no rounding)
      map.addLayer({ id: 'occupied-fill', type: 'fill', source: 'occupied', paint: { 'fill-color': '#e5383b', 'fill-opacity': 0.12, 'fill-antialias': false } });
      map.addLayer({ id: 'front-zone', type: 'line', source: 'front', layout: { 'line-join': 'miter', 'line-miter-limit': 4 }, paint: { 'line-color': '#e5383b', 'line-opacity': 0.2, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 5, 5, 8, 16, 11, 70] } });
      map.addLayer({ id: 'front-case', type: 'line', source: 'front', layout: { 'line-join': 'miter', 'line-miter-limit': 4 }, paint: { 'line-color': '#12060a', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3.4, 10, 6] } });
      map.addLayer({ id: 'front-line', type: 'line', source: 'front', layout: { 'line-join': 'miter', 'line-miter-limit': 4 }, paint: { 'line-color': '#ff4d57', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.7, 10, 3] } });
      // grey zone: contested ground behind the line
      map.addLayer({ id: 'grey-fill', type: 'fill', source: 'grey', paint: { 'fill-color': '#b9bfc8', 'fill-opacity': 0.34 } });
      map.addLayer({ id: 'grey-line', type: 'line', source: 'grey', paint: { 'line-color': '#e3e7ec', 'line-width': 1.2, 'line-opacity': 0.7, 'line-dasharray': [2, 2] } });
      // cauldrons: yellow broken ring around the cut-off ground
      map.addLayer({ id: 'pocket-fill', type: 'fill', source: 'pockets', paint: { 'fill-color': '#ffd84a', 'fill-opacity': 0.1 } });
      map.addLayer({ id: 'pocket-line', type: 'line', source: 'pockets', paint: { 'line-color': '#ffd84a', 'line-width': 2.2, 'line-dasharray': [2, 1.5] } });
      // occupied ground also gets fine diagonal hatching, like on printed situation maps
      map.addImage('hatch', hatchImage(), { pixelRatio: 2 });
      map.addLayer({ id: 'occupied-hatch', type: 'fill', source: 'occupied', paint: { 'fill-pattern': 'hatch', 'fill-opacity': 0.5 } }, 'front-zone');
      // build exclusion rings around existing sites and the special production zones (only while placing)
      map.addLayer({ id: 'restricted-fill', type: 'fill', source: 'restricted', paint: { 'fill-color': '#ff3333', 'fill-opacity': 0.08 } });
      map.addLayer({ id: 'restricted-line', type: 'line', source: 'restricted', paint: { 'line-color': '#ff6b6b', 'line-width': 1, 'line-opacity': 0.5, 'line-dasharray': [3, 3] } });
      map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 } });
      map.addLayer({ id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [4, 2] } });
      // friendly filling stations from OpenStreetMap
      map.addLayer({ id: 'fuel-stations', type: 'circle', source: 'fuel-stations', minzoom: 7, paint: { 'circle-radius': 2.5, 'circle-color': '#38bdf8', 'circle-opacity': 0.6, 'circle-stroke-color': '#0b0d10', 'circle-stroke-width': 1 } });
      // power lines along the roads, shown when a power plant (or a building it feeds) is selected
      map.addLayer({ id: 'power-lines', type: 'line', source: 'power-lines', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#38bdf8', 'line-width': 1.2, 'line-dasharray': [4, 3], 'line-opacity': 0.6, 'line-offset': 3 } });
      map.addLayer({ id: 'orbits', type: 'line', source: 'orbits', paint: { 'line-color': '#a7f3d0', 'line-width': 1.4, 'line-dasharray': [4, 2], 'line-opacity': 0.8 } });
      map.addLayer({ id: 'smokes', type: 'symbol', source: 'smokes', layout: { 'icon-image': 'smoke', 'icon-size': ['interpolate', ['exponential', 2], ['zoom'], 4, 0.0125, 8, 0.2, 12, 3.2], 'icon-allow-overlap': true, 'icon-ignore-placement': true }, paint: { 'icon-opacity': ['get', 'opacity'] } });
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
      symbol('units-loose', ['all', ['!', ['get', 'grp']], ['!', ['get', 'air']]], { minzoom: GROUP_ZOOM });
      symbol('units-grouped', ['all', ['get', 'grp'], ['!', ['get', 'air']]], { minzoom: GROUP_ZOOM });
      symbol('formations', ['all'], { maxzoom: GROUP_ZOOM });
      // drones fly as sprites, turned to their heading; strike drones shrink as they dive
      map.addLayer({
        id: 'drones', type: 'symbol', source: 'units', filter: ['get', 'air'],
        layout: {
          'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 4, ['*', ['get', 'scale'], 0.18], 8, ['*', ['get', 'scale'], 0.28], 11, ['*', ['get', 'scale'], 0.4]],
          'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'z'],
        },
      } as any);

      for (const cp of init!.map.capturePoints) {
        const el = h('div', { class: `cp${cp.value >= 3 ? ' cp-major' : ''}` }, h('i', {}), h('span', {}, cp.name), h('div', { class: 'cp-hp' }, h('b', {})));
        new maplibregl.Marker({ element: el }).setLngLat(cp.pos).addTo(map);
        pMarkers.set(cp.id, el);
      }
      fog = new FogOverlay(map);
      map.on('move', () => drawFog());
      fx = new ShotFx(map, mapEl, (def) => defU.get(def) ?? defB.get(def)?.attack, TEAM_COLOR);
      if (import.meta.env.DEV) (window as any).__sw = { map, fx, snap: () => snap, init: () => init, units: () => lastUnitFeatures, fakePockets: [], select: (ids: number[]) => ((selUnits = new Set(ids)), (selBuilding = null), render()) };
      mapReady = true;
      if (snap) render();
      showStart();
      // tell the server the map is drawn: the 3-2-1 countdown waits for every player
      map.once('idle', () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ready' } satisfies ClientMsg)));
      setTimeout(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ready' } satisfies ClientMsg)), 6000);
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
      if (pick.bombard) {
        send({ type: 'bombard', units: pick.bombard.unitIds, target: p });
        toast('Barrage area set');
        pick.bombard = null;
        return render();
      }
      if (pick.launch) {
        send({ type: 'launch', transport: pick.launch.transport, target: p });
        pick.launch = null;
        return render();
      }
      if (pick.route) return toast('Click one of your buildings (Esc cancels)');
      if (placing) {
        send({ type: 'build', def: placing.id, pos: p });
        if (!e.originalEvent.shiftKey) cancelPlacing();
        return;
      }
      const layers = ['units-loose', 'units-grouped', 'drones', 'formations'].filter((l) => map.getLayer(l));
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
      if (pick.bombard) {
        send({ type: 'bombard', units: pick.bombard.unitIds, target: [e.lngLat.lng, e.lngLat.lat] });
        pick.bombard = null;
        return render();
      }
      if (pick.route || pick.launch) return void ((pick.route = pick.launch = null), render());
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
      const p = map.project(posOf(u));
      return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    }).map((u) => u.id));
    selBuilding = null;
    suppressClick = performance.now();
    render();
  }
  let suppressClick = 0;

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.key === 'Escape') {
      if (pick.route || pick.bombard || pick.launch) return void ((pick.route = pick.bombard = pick.launch = null), render());
      return cancelPlacing();
    }
    const k = e.key.toLowerCase();
    if (k === 's' && selUnits.size) return void send({ type: 'stop', units: [...selUnits] });
    if (k === 't') return toggleTerrain();
    if (k === 'm') return toggleBasemap();
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

  // ---------- start: countdown and "you are here" ----------
  let startMarker: maplibregl.Marker | null = null;
  let startShown = false;
  let lastCount = -2;
  /** Fly to the player's headquarters and point a big arrow at it. */
  function showStart() {
    if (startShown || !snap || !mapReady) return;
    const hq = snap.buildings.find((b) => b.owner === me && b.def === 'hq');
    if (!hq) return;
    startShown = true;
    const el = h('div', { class: 'start-arrow' }, h('span', {}, 'YOU START HERE'), h('i', {}));
    startMarker = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -26] }).setLngLat(hq.pos).addTo(map);
    if (snap.countdown !== 0) map.jumpTo({ center: hq.pos, zoom: 8.6 });
    else setTimeout(removeStart, 6000); // rejoining a running match: just a brief pointer
  }
  function removeStart() {
    startMarker?.getElement().classList.add('gone');
    const m = startMarker;
    startMarker = null;
    setTimeout(() => m?.remove(), 600);
  }
  function showCountdown(n: number) {
    if (n === lastCount) return;
    const was = lastCount;
    lastCount = n;
    if (n > 0) {
      countEl.textContent = String(n);
      countEl.className = 'countdown show';
      void countEl.offsetWidth; // restart the pop animation for every number
      countEl.classList.add('pop');
    } else if (n < 0) {
      countEl.textContent = 'Waiting for players…';
      countEl.className = 'countdown show small';
    } else if (was !== -2 && was !== 0) {
      countEl.textContent = 'GO';
      countEl.className = 'countdown show pop go';
      setTimeout(() => (countEl.className = 'countdown'), 900);
      setTimeout(removeStart, 7000);
    } else {
      countEl.className = 'countdown';
    }
  }

  /** Ceasefire banner while it lasts, then a big "war" call once it ends. */
  let peaceWas = -1;
  function showPeace() {
    if (!init || !snap) return;
    const total = init.ruleset.rules.peaceSeconds;
    const left = Math.max(0, total - snap.time);
    const on = total > 0 && left > 0 && snap.countdown === 0;
    peaceBanner.style.display = on ? 'flex' : 'none';
    if (on) {
      clear(peaceBanner);
      peaceBanner.append(
        h('b', {}, `CEASEFIRE ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`),
        h('span', {}, 'Build and deploy: no shooting, and nobody may cross the front until it ends'),
        h('i', { style: { width: `${(left / total) * 100}%` } }),
      );
    }
    if (peaceWas > 0 && left === 0) {
      countEl.textContent = 'THE WAR BEGINS';
      countEl.className = 'countdown show pop go war';
      setTimeout(() => (countEl.className = 'countdown'), 2600);
      toast('The ceasefire is over: the front is open');
    }
    peaceWas = total > 0 ? left : 0;
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
  /** Hide the real map (basemap and relief) for a clean tactical display; the fog gets darker to match. */
  function toggleBasemap() {
    if (!mapReady) return;
    const off = map.getLayoutProperty('osm', 'visibility') !== 'none';
    for (const id of ['osm', 'relief']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', off ? 'none' : 'visible');
    basemapBtn.textContent = off ? 'Map: OFF' : 'Map: ON';
    basemapBtn.classList.toggle('on', off);
    drawFog();
  }
  function drawFog() {
    if (!fog || !mapReady) return;
    fog.render(snap, init, defU, defB, map.getLayoutProperty('osm', 'visibility') === 'none', (id, fallback) => unitPos.get(id) ?? fallback);
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
  /** While placing: red exclusion rings around existing sites, and the special zones this building could use. */
  function showPlacementAids() {
    if (!mapReady || !init || !snap) return;
    const zones = placing ? SPECIAL_ZONES.filter((z) => z.side === (init!.team === 0 ? 'ua' : 'ru') && z.buildingDef === placing!.id) : [];
    (map.getSource('zones') as GeoJSONSource).setData({ type: 'FeatureCollection', features: zones.map((z) => ({ type: 'Feature', properties: { color: z.color, name: z.name }, geometry: { type: 'Polygon', coordinates: [z.polygon] } })) } as any);
    const r = init.ruleset.rules;
    const rings = placing && placing.id !== 'housing'
      ? snap.buildings.filter((b) => b.def !== 'housing').map((b) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circle(b.pos, placing!.fieldWork || defB.get(b.def)?.fieldWork ? r.fieldWorkSpacing : specialZoneAt(b.pos) ? 0.5 : r.minBuildSpacing, 64)] } }))
      : [];
    (map.getSource('restricted') as GeoJSONSource).setData({ type: 'FeatureCollection', features: rings } as any);
  }

  function cancelPlacing() {
    if (!placing) return;
    placing = null;
    showPlacementAids();
    hint.textContent = HINT;
    mapEl.classList.remove('placing');
    (map.getSource('ghost') as GeoJSONSource | undefined)?.setData(empty());
    buildPalette();
  }

  function circle(c: LngLat, km: number, n = 48): LngLat[] {
    return Array.from({ length: n + 1 }, (_, i) => offsetKm(c, Math.cos((i / n) * 6.2832) * km, Math.sin((i / n) * 6.2832) * km));
  }

  /** The city whose boundary holds this point. */
  function cityAt(p: LngLat) {
    return init!.map.capturePoints.find((cp) => {
      const polys = cityPolys.get(cp.id);
      if (polys?.length) return Math.abs(p[1] - cp.pos[1]) < 0.5 && polys.some((r) => inPolygon(p, r));
      return distKm(p, cp.pos) <= [0, 2.5, 3.5, 5, 8, 12][Math.max(1, Math.min(5, cp.value))];
    });
  }

  function placementProblem(def: BuildingDef, p: LngLat): string | null {
    if (!init || !snap) return 'not ready';
    const r = init.ruleset.rules;
    const zone = specialZoneAt(p);
    const mySide = init.team === 0 ? 'ua' : 'ru';
    if (zone && zone.side !== mySide) return `${zone.name} belongs to the other side`;
    if (!zone) {
      const d = distToFrontKm(snap.front, p) * (init.team === 0 ? 1 : -1);
      const pocket = snap.pockets.find((k) => pointInRing(k.nodes, p));
      if (pocket) return pocket.team === init.team ? 'this ground is encircled' : 'not your territory';
      if (snap.grey.some((z) => distKm(z.pos, p) <= z.r)) return 'contested ground (grey zone)';
      if (d < 0) return 'not your territory';
      if (def.id !== 'housing' && d < r.minBuildDistanceFromFront * (def.category === 'civil' ? 2 : 1)) return 'too close to the front';
    }
    if (terrain?.at(p) === 'water') return 'cannot build on water';
    if (def.needsWaterWithinKm && !nearRiver(p, def.needsWaterWithinKm)) return 'must be on a river bank';
    if (def.id === 'housing') {
      const city = cityAt(p);
      if (!city) return 'housing only inside a city';
      if (snap.points[init.map.capturePoints.indexOf(city)]?.owner !== init.team) return 'your side must hold the city';
      if (snap.buildings.filter((b) => b.def === 'housing' && cityAt(b.pos) === city).length >= r.cityHousingLimit) return `${city.name} already has ${r.cityHousingLimit} housing blocks`;
    } else {
      const spacing = zone ? 0.5 : def.fieldWork ? r.fieldWorkSpacing : r.minBuildSpacing;
      const clash = snap.buildings.some((b) => b.def !== 'housing' && distKm(b.pos, p) < (def.fieldWork || defB.get(b.def)?.fieldWork ? r.fieldWorkSpacing : spacing));
      if (clash) return def.fieldWork ? 'space occupied' : `too close to another site (${spacing} km apart)`;
    }
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
            showPlacementAids();
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
    // an unlimited match ("until victory") shows the time played instead of the time left
    const { matchSeconds, peaceSeconds } = init.ruleset.rules;
    const unlimited = matchSeconds <= 0;
    // the match clock starts when the ceasefire ends
    const left = unlimited ? Math.max(0, snap.time - peaceSeconds) : Math.max(0, peaceSeconds + matchSeconds - Math.max(snap.time, peaceSeconds));
    const held = [0, 1].map((t) => snap!.points.filter((p) => p.owner === t).length);
    clear(scoreBar);
    scoreBar.append(
      h('div', { class: 'teams' },
        h('span', { style: { color: TEAM_COLOR[0] } }, `${TEAM_NAME[0]} ${held[0]}`),
        h('b', { title: unlimited ? 'No time limit: played so far' : 'Time left' }, `${unlimited ? '∞ ' : ''}${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`),
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
      const b = snap.buildings.find((x) => x.id === selBuilding && x.team === init!.team);
      if (!b) selBuilding = null;
      else {
        const d = defB.get(b.def)!;
        side.append(
          h('h3', {}, `${d.icon} ${d.name}`),
          h('div', { class: 'muted' }, d.description ?? ''),
          h('div', { class: 'stat' }, `HP ${b.hp}/${d.levels?.[b.level - 2]?.hp ?? d.hp}`),
        );
        // a teammate may keep their buildings to themselves
        const locked = b.owner !== me && snap.closed.includes(b.owner);
        const ownerName = init.players.find((p) => p.id === b.owner)?.name ?? 'a teammate';
        if (b.owner !== me) side.append(h('div', { class: locked ? 'stat warn' : 'muted' }, locked ? `Built by ${ownerName}, who keeps it private: you cannot use it` : `Built by ${ownerName}: shared with your side`));
        if (d.produces) side.append(h('div', { class: 'stat' }, b.road ? `Road access: +${Math.round((init.ruleset.rules.roadOutputMult - 1) * 100)}% output` : 'No road access'));
        const rules = init.ruleset.rules;
        if (b.def !== 'power_plant') {
          const grid = snap.buildings.some((o) => o.team === b.team && o.progress >= 1 && o.def === 'power_plant' && distKm(o.pos, b.pos) <= rules.powerGridKm);
          side.append(h('div', { class: 'stat', style: { color: grid ? '#38bdf8' : 'var(--muted)' } }, grid ? `On the power grid: +${Math.round(((b.def === 'housing' ? rules.housingGridMult : rules.powerGridMult) - 1) * 100)}%` : `Off the grid (no power plant within ${rules.powerGridKm} km)`));
        }
        if (b.def === 'housing') {
          const city = cityAt(b.pos);
          if (city) side.append(h('div', { class: 'stat' }, `${city.name}: ${snap.buildings.filter((x) => x.def === 'housing' && cityAt(x.pos) === city).length}/${rules.cityHousingLimit} housing blocks`));
        }
        const zone = specialZoneAt(b.pos);
        if (zone && zone.buildingDef === b.def) side.append(h('div', { class: 'stat', style: { color: zone.color } }, `★ ${zone.bonusTitle}`));
        // the building's own store of goods
        if (b.storage && Object.keys(b.storage).length) {
          const cap = d.storageCap ?? rules.storageCap;
          side.append(h('div', { class: 'storage-box' }, h('b', {}, `Store (up to ${cap.toLocaleString('en-US')} each)`),
            h('div', { class: 'storage-grid' }, ...Object.entries(b.storage).map(([k, v]) => {
              const res = init!.ruleset.resources.find((x) => x.id === k);
              const ico = h('span', {});
              ico.innerHTML = iconHtml(res?.icon, res?.color ?? '#888');
              return h('div', { class: 'storage-item' }, ico, h('span', {}, res?.name ?? k), h('b', {}, Math.floor(v).toLocaleString('en-US')));
            }))));
        }
        if (b.def === 'aircraft_plant') side.append(h('div', { class: 'muted' }, 'Production starts with a coming update.'));
        if (d.training && b.progress >= 1 && !locked) {
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
        const next = d.levels?.[b.level - 1];
        if (d.levels && b.progress >= 1 && !locked) {
          const maxLevel = d.levels.length + 1;
          const cur = d.levels[b.level - 2]?.defenseMult ?? d.defense?.mult ?? 0;
          side.append(h('div', { class: 'stat' }, `Level ${b.level}/${maxLevel}${d.defense ? ` · defence +${Math.round(cur * 100)}%` : ''}`));
          if (b.upgrade) {
            side.append(h('div', { class: 'stat' }, `Upgrading: ${b.upgrade.remaining}s left`), h('div', { class: 'bar' }, h('i', { style: { width: `${Math.round((1 - b.upgrade.remaining / b.upgrade.total) * 100)}%`, background: 'var(--accent)' } })));
          } else if (next) {
            side.append(h('button', { class: 'bld', onClick: () => send({ type: 'upgrade', building: b.id }) },
              h('span', { class: 'ico' }, '⇧'),
              h('span', { class: 'meta' }, h('b', {}, `Upgrade to level ${b.level + 1} · ${next.time}s`), costHtml(next.cost, snap.res),
                h('small', {}, `${next.defenseMult ? `defence +${Math.round(next.defenseMult * 100)}%` : ''}${next.hp ? ` · ${next.hp} HP` : ''}`))));
          }
          if (d.defense) side.append(h('div', { class: 'muted' }, `Only the best ${d.name.toLowerCase()} in range counts; different kinds of fortification add up.`));
        }
        if (d.attack) side.append(h('div', { class: 'stat' }, `Engages ${d.attack.targets} targets within ${d.attack.range} km`));
        if (d.crossing) side.append(h('div', { class: 'stat' }, `River crossing radius ${d.crossing.radiusKm} km`));
        if (b.progress < 1) side.append(h('div', { class: 'stat' }, `Under construction ${Math.round(b.progress * 100)}%`));
        if (b.progress >= 1 && !locked) {
          const mySide = init.team === 0 ? 'ua' : 'ru';
          for (const uid of d.trains ?? []) {
            const u = defU.get(uid)!;
            if (u.side && u.side !== mySide) continue;
            // money and people from the treasury, materials from this building's own store
            const have: Record<string, number> = { ...(b.storage ?? {}), money: snap.res.money ?? 0, people: snap.res.people ?? 0 };
            const short = Object.entries(u.cost).find(([k, v]) => (have[k] ?? 0) < v);
            const btn = h('button', { class: 'bld' + (short ? ' short' : ''), onClick: () => send({ type: 'train', building: b.id, unit: uid }) },
              unitIcon(u, 0), h('span', { class: 'meta' }, h('b', {}, `Train ${u.name} · ${u.trainTime}s`), costHtml(u.cost, have),
                short && short[0] !== 'money' && short[0] !== 'people' ? h('small', { class: 'warn' }, `Not enough ${short[0]} on site: deliver it by truck`) : null));
            describe(btn, u.name, u.description, unitFacts(u), 'left');
            side.append(btn);
          }
          const q = snap.queue.filter((x) => x.building === b.id);
          if (q.length) side.append(h('div', { class: 'stat' }, 'Queue: ' + q.map((x) => `${defU.get(x.unit)?.name} (${x.remaining}s)`).join(', ')));
        }
        if (b.def === 'power_plant' || b.progress >= 1) ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'powerLines', building: b.id } satisfies ClientMsg));
        if (b.def !== 'hq' && b.owner === me) side.append(h('button', { class: 'ghost', onClick: () => (send({ type: 'demolish', building: b.id }), (selBuilding = null)) }, 'Demolish (40% refund)'));
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
        side.append(statusList(u.status.map(([id, v]) => ({ id, v, n: 1 })), true));
      } else {
        const by = new Map<string, UnitView[]>();
        mine.forEach((u) => by.set(u.def, [...(by.get(u.def) ?? []), u]));
        for (const [k, us] of by) {
          const d = defU.get(k)!;
          const top = Math.max(...us.map((u) => u.rank));
          side.append(h('div', { class: 'row' }, unitIcon(d, top), h('span', { class: 'stat' }, `${us.length} × ${d.name}`, us.some((u) => u.rank > 0) ? h('small', { class: 'muted' }, ` · ${rk[top]?.name}`) : null)));
        }
      }

      if (mine.length > 1) {
        // how many of the selected units are under each effect
        const agg = new Map<string, { id: string; v: number; n: number }>();
        for (const u of mine) for (const [id, v] of u.status) agg.set(id, { id, v, n: (agg.get(id)?.n ?? 0) + 1 });
        side.append(statusList([...agg.values()], false));
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

  /** Buffs and debuffs spelled out: icon, name and (for a single unit) exactly what each one does. */
  function statusList(items: { id: string; v: number; n: number }[], detailed: boolean) {
    const box = h('div', { class: 'status-list' });
    if (!items.length) {
      box.append(h('div', { class: 'muted' }, 'No buffs or debuffs.'));
      return box;
    }
    items.sort((a, b) => Number(DEBUFFS.has(a.id)) - Number(DEBUFFS.has(b.id)));
    for (const it of items) {
      const good = !DEBUFFS.has(it.id);
      const def = STATUS[it.id];
      const ico = h('span', { class: 'st' });
      ico.innerHTML = statusIconHtml(it.id, good);
      box.append(
        h('div', { class: 'status ' + (good ? 'good' : 'bad') }, ico,
          h('div', {}, h('b', {}, `${def?.name ?? it.id}${it.n > 1 || !detailed ? ` ×${it.n}` : ''}`), detailed || it.n ? h('small', {}, def?.text(it.v) ?? '') : null)),
      );
    }
    return box;
  }

  function unitIcon(d: UnitDef, rank: number) {
    if (d.kind === 'air') {
      const c = h('canvas', { class: 'nato-ico drone-ico', width: 128, height: 128, title: d.name });
      void aircraftSprite(d.id, REL_COLOR.own, false).then((img) => c.getContext('2d')!.drawImage(img, 0, 0, 128, 128));
      return c;
    }
    const c = h('canvas', { class: 'nato-ico', width: 128, height: 128 });
    c.getContext('2d')!.putImageData(drawNato({ hostile: false, color: REL_COLOR.own, symbol: d.symbol ?? 'infantry', mobility: mobilityOf(d), echelon: '', rank, selected: false, own: true, transport: false }), 0, 0);
    return c;
  }

  // ---------- snapshot → view ----------
  let lastPalette = 0;
  function onSnapshot(s: SnapMsg) {
    if (import.meta.env.DEV) s.pockets.push(...((window as any).__sw?.fakePockets ?? [])), s.grey.push(...((window as any).__sw?.fakeGrey ?? [])); // browser tests draw cauldrons this way
    snap = s;
    if (shown.length !== s.front.length) shown = s.front.map((n) => ({ ...n }));
    pruneGroups();
    for (const id of selUnits) if (!s.units.some((u) => u.id === id)) selUnits.delete(id);
    showCountdown(s.countdown);
    showStart();
    showPeace();
    sharing = !s.closed.includes(me);
    shareBtn.textContent = sharing ? 'Buildings: shared' : 'Buildings: private';
    shareBtn.classList.toggle('on', !sharing);
    fx?.add(s.shots);
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
    renderHud();
    if (mapReady) renderMap();
  }

  function renderHud() {
    if (!init || !snap) return;
    renderUnitHud(unitHud, {
      snap, me, myTeam: init.team, sel: selUnits, defU, defB, roadMult: init.ruleset.rules.roadSpeedMult, pick, send, toast, rerender: render, icon: unitIcon, pos: posOf,
    });
    routeBanner.style.display = pick.route ? 'block' : 'none';
    routeBanner.textContent = pick.route
      ? pick.route.fromBuilding ? 'Delivery route — step 2: click the building to unload at (Esc cancels)' : 'Delivery route — step 1: click the building to load at (Esc cancels)'
      : '';
    mapEl.classList.toggle('picking', !!(pick.route || pick.bombard || pick.launch));
  }

  /** Full refresh after a local change (selection, grouping). */
  function render() {
    renderSide();
    renderGroups();
    renderHud();
    if (mapReady) renderMap();
    if (selBuilding === null && mapReady) (map.getSource('power-lines') as GeoJSONSource | undefined)?.setData(empty());
  }

  function renderMap() {
    if (!init || !snap) return;
    const myTeam = init.team;
    const grouped = new Map<number, number>();
    for (const g of groups.values()) for (const id of g.ids) grouped.set(id, g.id);

    renderUnits();

    // one formation marker per group (shown when zoomed out)
    const formations: any[] = [];
    for (const g of groups.values()) {
      const us = snap.units.filter((u) => g.ids.has(u.id) && defU.get(u.def)?.kind !== 'air');
      const c = centroid(us);
      if (!c) continue;
      const kinds = new Set(us.map((u) => defU.get(u.def)?.symbol ?? 'infantry'));
      const symbol = kinds.size === 1 ? [...kinds][0] : kinds.has('armor') && kinds.has('infantry') ? 'mechanized' : [...kinds].sort((a, b) => us.filter((u) => defU.get(u.def)?.symbol === b).length - us.filter((u) => defU.get(u.def)?.symbol === a).length)[0];
      const sel = us.every((u) => selUnits.has(u.id)) && selUnits.size === us.length;
      const rank = Math.round(us.reduce((a, u) => a + u.rank, 0) / us.length);
      formations.push({ type: 'Feature', properties: { gid: g.id, own: true, z: sel ? 3 : 2, icon: natoId({ hostile: false, color: REL_COLOR.own, symbol, mobility: sharedMobility(us), echelon: echelonFor(us.length), rank, selected: sel, own: true, transport: us.filter((u) => u.transport).length * 2 > us.length }) }, geometry: { type: 'Point', coordinates: c } });
    }
    // zoomed out, everything else is merged into formation markers per ~30 km cell (mine / allied / hostile kept apart)
    const cells = new Map<string, UnitView[]>();
    for (const u of snap.units) {
      if (grouped.has(u.id) || defU.get(u.def)?.kind === 'air') continue;
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
        properties: { own, ids: own ? JSON.stringify(us.map((u) => u.id)) : '', z: sel ? 3 : own ? 2 : 1, icon: natoId({ hostile: us[0].team !== myTeam, color: REL_COLOR[relOf(us[0])], symbol, mobility: sharedMobility(us), echelon: us.length > 1 ? echelonFor(us.length) : '', rank: Math.round(us.reduce((a, u) => a + u.rank, 0) / us.length), selected: sel, own, transport: us.filter((u) => u.transport).length * 2 > us.length }) },
        geometry: { type: 'Point', coordinates: centroid(us) },
      });
    }
    (map.getSource('formations') as GeoJSONSource).setData({ type: 'FeatureCollection', features: formations });

    renderSelLines();

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
    // artillery reach for selected guns: outer = max range, inner = minimum range
    for (const u of snap.units) {
      const d = defU.get(u.def);
      if (!selUnits.has(u.id) || !d?.minRange) continue;
      rings.push({ type: 'Feature', properties: { color: '#f59e0b' }, geometry: { type: 'LineString', coordinates: circle(posOf(u), d.range, 64) } });
      rings.push({ type: 'Feature', properties: { color: '#ef4444' }, geometry: { type: 'LineString', coordinates: circle(posOf(u), d.minRange, 48) } });
      if (u.bombardTarget) rings.push({ type: 'Feature', properties: { color: '#ef4444' }, geometry: { type: 'LineString', coordinates: circle(u.bombardTarget, 1, 32) } });
    }
    // recon drones' patrol circles
    (map.getSource('orbits') as GeoJSONSource).setData({ type: 'FeatureCollection', features: snap.units.filter((u) => selUnits.has(u.id) && u.loiterCenter && u.loiterRadius).map((u) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: circle(u.loiterCenter!, u.loiterRadius!, 48) } })) } as any);
    // strike smoke, fading over ten minutes
    (map.getSource('smokes') as GeoJSONSource).setData({ type: 'FeatureCollection', features: snap.smokes.map((x) => ({ type: 'Feature', properties: { opacity: Math.max(0.18, Math.min(0.85, (x.expiresAt - snap!.time) / 600)) }, geometry: { type: 'Point', coordinates: x.pos } })) } as any);
    // OpenStreetMap filling stations on our side only
    if (init.map.fuel?.features && snap.time - lastFuel > 5) {
      lastFuel = snap.time;
      const s = snap;
      (map.getSource('fuel-stations') as GeoJSONSource).setData({ type: 'FeatureCollection', features: init.map.fuel.features.filter((f: any) => distToFrontKm(s.front, f.geometry.coordinates) * (myTeam === 0 ? 1 : -1) > 0) } as any);
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
          if (placing || b.team !== myTeam) return;
          ev.stopPropagation();
          if (pick.route) {
            // delivery route picking: first the loading site, then the unloading site
            if (!pick.route.fromBuilding) {
              pick.route.fromBuilding = b.id;
              toast(`Loading at ${d.name}. Now click where to unload.`);
            } else if (pick.route.fromBuilding === b.id) {
              toast('Pick a different building to unload at', true);
            } else {
              send({ type: 'setRoute', unit: pick.route.unitId, fromBuilding: pick.route.fromBuilding, toBuilding: b.id, resType: pick.route.resType });
              toast(`Delivery route set: → ${d.name}`);
              pick.route = null;
            }
            return render();
          }
          selBuilding = b.id;
          selUnits.clear();
          render();
        });
        el.addEventListener('contextmenu', (ev) => {
          // right click on your own training centre with units selected sends them inside
          if (b.team !== myTeam || !d.training || !selUnits.size) return;
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
      m.el.classList.toggle('mine', b.team === myTeam);
      m.el.classList.toggle('route-candidate', !!pick.route && pick.route.fromBuilding !== b.id);
      m.el.classList.toggle('route-from', pick.route?.fromBuilding === b.id);
      m.el.classList.toggle('selected', selBuilding === b.id);
      m.el.style.setProperty('--p', String(b.progress));
      m.el.dataset.n = b.inside?.length ? String(b.inside.length) : '';
      m.el.dataset.lv = b.level > 1 ? 'I'.repeat(b.level) : '';
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

    const greyKey = snap.grey.map((z) => `${z.pos[0]},${z.pos[1]}`).join('|');
    if (greyKey !== lastGrey) {
      lastGrey = greyKey;
      (map.getSource('grey') as GeoJSONSource).setData({ type: 'FeatureCollection', features: snap.grey.map((z) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circle(z.pos, z.r, 40)] } })) });
    }

    snap.points.forEach((p) => {
      const el = pMarkers.get(p.id);
      if (!el) return;
      el.style.setProperty('--c', TEAM_COLOR[p.owner]);
      // city structure: a bar appears once a city has been hit
      const hurt = p.hp !== undefined && p.maxHp !== undefined && p.hp < p.maxHp;
      el.classList.toggle('hurt', hurt);
      if (hurt) {
        const pct = (p.hp! / p.maxHp!) * 100;
        const bar = el.querySelector('.cp-hp b') as HTMLElement;
        bar.style.width = `${pct}%`;
        bar.style.background = pct < 35 ? '#ef4444' : pct < 70 ? '#eab308' : '#22c55e';
        el.title = `${Math.round(p.hp!)} / ${p.maxHp} structure`;
      }
    });
    drawFog();
  }

  /** A formation shows wheels or tracks only when all of it drives the same way. */
  function sharedMobility(us: UnitView[]): string {
    const kinds = new Set(us.map((u) => mobilityOf(defU.get(u.def))));
    return kinds.size === 1 ? [...kinds][0] : '';
  }

  /** Units: NATO markers on the ground, side-specific drone sprites in the air, all at interpolated positions. */
  function renderUnits() {
    if (!init || !snap || !mapReady) return;
    const myTeam = init.team;
    const grouped = new Set<number>();
    for (const g of groups.values()) for (const id of g.ids) grouped.add(id);
    lastUnitFeatures = snap.units.map((u) => {
        const d = defU.get(u.def);
        const own = u.owner === me;
        const sel = selUnits.has(u.id);
        const air = d?.kind === 'air';
        const pos = posOf(u);
        let icon: string;
        let bearing = 0;
        let scale = 1;
        if (air) {
          icon = `drone|${u.def}|${relOf(u)}|${sel ? 1 : 0}`;
          bearing = droneBearing.get(u.id)?.b ?? u.bearing ?? 0;
          // a strike drone shrinks as it dives on the last 18 km
          if (isStrikeDrone(d) && u.target) scale = Math.min(1, 0.45 + 0.55 * (distKm(pos, u.target) / 18));
        } else {
          icon = natoId({ hostile: u.team !== myTeam, color: REL_COLOR[relOf(u)], symbol: d?.symbol ?? 'infantry', mobility: mobilityOf(d), echelon: '', rank: u.rank, selected: sel, own, transport: u.transport, encircled: u.encircled, buffs: u.status.filter((x) => !DEBUFFS.has(x[0])).length, debuffs: u.status.filter((x) => DEBUFFS.has(x[0])).length });
        }
        return { type: 'Feature', properties: { id: u.id, own, grp: grouped.has(u.id), air, icon, bearing, scale, z: sel ? 4 : air ? 3 : own ? 2 : 1 }, geometry: { type: 'Point', coordinates: pos } };
    });
    (map.getSource('units') as GeoJSONSource).setData({ type: 'FeatureCollection', features: lastUnitFeatures } as any);
  }
  let lastUnitFeatures: any[] = [];

  /** Route lines for the selection: the planned path (along the roads), plus each queued stop. */
  function renderSelLines() {
    if (!snap || !mapReady) return;
    const features: any[] = [];
    for (const u of snap.units) {
      if (!selUnits.has(u.id) || !u.target || u.isLoitering) continue;
      const p = posOf(u);
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [p, ...(u.path?.length ? u.path : [u.target])] } });
      for (const s of u.route ?? [u.target]) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: s } });
      if (features.length > 120) break;
    }
    (map.getSource('sel') as GeoJSONSource).setData({ type: 'FeatureCollection', features } as any);
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
    // units glide between snapshots (60 fps instead of 5 Hz steps); drones bank smoothly into turns
    let unitsMoved = false;
    const alive = new Set<number>();
    for (const u of snap.units) {
      alive.add(u.id);
      const p = unitPos.get(u.id);
      if (!p) {
        unitPos.set(u.id, [u.pos[0], u.pos[1]]);
        unitsMoved = true;
      } else {
        const dx = u.pos[0] - p[0], dy = u.pos[1] - p[1];
        if (dx * dx + dy * dy > 0.05) (p[0] = u.pos[0]), (p[1] = u.pos[1]), (unitsMoved = true);
        else if (Math.abs(dx) + Math.abs(dy) > 1e-7) (p[0] += dx * 0.28), (p[1] += dy * 0.28), (unitsMoved = true);
      }
      if (u.bearing !== undefined && defU.get(u.def)?.kind === 'air') {
        const st = droneBearing.get(u.id) ?? { b: u.bearing, v: 0 };
        const diff = ((u.bearing - st.b + 540) % 360) - 180;
        st.v = Math.max(-2.8, Math.min(2.8, st.v * 0.82 + diff * 0.08));
        st.b = (st.b + st.v + 360) % 360;
        droneBearing.set(u.id, st);
        if (Math.abs(st.v) > 0.03) unitsMoved = true;
      }
    }
    for (const id of unitPos.keys()) if (!alive.has(id)) unitPos.delete(id), droneBearing.delete(id);
    if (unitsMoved) {
      renderUnits();
      if (selUnits.size) renderSelLines();
      drawFog();
    }

    const pocketKey = snap.pockets.map((k) => `${k.id}:${k.nodes.length}:${k.nodes[0].lng}`).join(',');
    if (pocketKey !== lastPockets) (lastPockets = pocketKey), (moved = true);
    if (!moved && frontDrawn) return;
    frontDrawn = true;
    const line: LngLat[] = shown.map((n) => [n.lng, n.lat]);
    // cauldrons: rings of team 0 ground inside the occupied area are holes in it; rings of team 1 ground are extra patches
    const ring = (k: SnapMsg['pockets'][number]): LngLat[] => [...k.nodes.map((n): LngLat => [n.lng, n.lat]), [k.nodes[0].lng, k.nodes[0].lat]];
    const holes = snap.pockets.filter((k) => k.team === 0).map(ring);
    const mapHoles = init.map.occupiedHoles ?? []; // e.g. the Sea of Azov: not occupied, but not a front either
    const patches = snap.pockets.filter((k) => k.team === 1).map(ring);
    (map.getSource('front') as GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [line, ...holes, ...patches] } } as any);
    (map.getSource('occupied') as GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[[...line, ...init.map.occupiedClosure, line[0]], ...holes, ...mapHoles], ...patches.map((p) => [p])] } } as any);
    // everything outside the occupied area (inside a box well beyond the map) is the blue zone
    const world: LngLat[] = [[5, 30], [65, 30], [65, 65], [5, 65], [5, 30]];
    (map.getSource('held') as GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[world, [...line, ...init.map.occupiedClosure, line[0]], ...patches], ...holes.map((p) => [p])] } } as any);
    (map.getSource('pockets') as GeoJSONSource).setData({ type: 'FeatureCollection', features: snap.pockets.map((k) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(k)] } })) } as any);
  }
  let frontDrawn = false;
  let lastGrey = '-';
  let lastFuel = -10;
  let lastPockets = '';

  const ping = setInterval(() => (closed ? clearInterval(ping) : ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ping' } satisfies ClientMsg))), 15000);
}
