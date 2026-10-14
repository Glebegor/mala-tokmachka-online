import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  distKm, distToFrontKm, offsetKm, RoadNetwork, sideOfWithPockets, TerrainGrid,
  type BuildingDef, type ClientMsg, type Command, type FrontNode, type InitMsg, type LngLat, type ServerMsg, type SnapMsg, type UnitDef, type UnitView,
  SPECIAL_ZONES, isInSpecialZone, isKremenchukRefinery, isAlabugaDroneZone,
} from '@sw/core';
import { api, type Session } from './api';
import { clear, h } from './dom';
import { ShotFx } from './fx';
import { iconHtml } from './icons';
import { drawNato, echelonFor, natoId, parseNatoId } from './nato';
import { buildCitySchematicsGeoJSON } from './citySchematic';

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
const GROUP_ZOOM = 8; // below this zoom a group is drawn as one formation marker
const HINT = 'Click: select · Shift+drag: box · Right click: move · G: group · 1-9: select group · T: terrain · M: map';

type Fc = { type: 'FeatureCollection'; features: any[] };
const empty = (): Fc => ({ type: 'FeatureCollection', features: [] });

interface Group {
  id: number;
  ids: Set<number>;
}

function makeCircleCoords(center: LngLat, radiusKm: number, numPoints = 40): LngLat[] {
  const coords: LngLat[] = [];
  for (let i = 0; i <= numPoints; i++) {
    const angle = (i * 2 * Math.PI) / numPoints;
    coords.push(offsetKm(center, radiusKm * Math.cos(angle), radiusKm * Math.sin(angle)));
  }
  return coords;
}

export function startGame(app: HTMLElement, session: Session, matchId: string, onExit: () => void) {
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(session.token)}&match=${encodeURIComponent(matchId)}`;
  const ws = new WebSocket(wsUrl);
  const me = session.user.id;

  let init: InitMsg | null = null;
  let snap: SnapMsg | null = null;
  let map: maplibregl.Map;
  let mapReady = false;
  let fx: ShotFx | null = null;
  let terrain: TerrainGrid | null = null;
  let roads: RoadNetwork | null = null;
  let defB = new Map<string, BuildingDef>();
  let defU = new Map<string, UnitDef>();
  let closed = false;
  let lastPowerLineKey = '';

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
  const unitHud = h('div', { class: 'unit-hud', style: { display: 'none' } });
  const routeBanner = h('div', { class: 'route-banner', style: { display: 'none' } });
  const terrainBtn = h('button', { class: 'ghost', onClick: () => toggleTerrain() }, 'Terrain');
  const basemapBtn = h('button', { class: 'ghost', onClick: () => toggleBasemap(), title: 'Toggle real map filter (M)' }, 'Map: ON');
  const leave = () => {
    closed = true;
    try { ws.close(); } catch {}
    fx?.destroy();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('mousemove', onBoxMove);
    window.removeEventListener('mouseup', onBoxUp);
    try { map?.remove(); } catch {}
    void api.leaveAll().catch(() => {}).finally(() => onExit());
  };
  app.append(
    h('div', { class: 'game' }, mapEl,
      h('div', { class: 'hud top' }, resBar, scoreBar, terrainBtn, basemapBtn, h('button', { class: 'ghost', onClick: leave }, 'Leave')),
      palette, side, groupBar, terrainChip, toasts, hint, boxEl, unitHud, routeBanner),
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
  let routePicker: { unitId: number; fromBuilding?: number; resType?: string } | null = null;
  let bombardPicker: { unitIds: number[] } | null = null;
  let formation = true; // move selected units at the pace of the slowest
  const groups = new Map<number, Group>();
  const bMarkers = new Map<number, { el: HTMLElement; marker: maplibregl.Marker; done: boolean }>();
  const pMarkers = new Map<string, HTMLElement>();
  let shown: FrontNode[] = [];
  const unitPos = new Map<number, { lng: number; lat: number }>();
  const curPos = (u: UnitView): LngLat => {
    const p = unitPos.get(u.id);
    return p ? [p.lng, p.lat] : u.pos;
  };

  // ---------- network ----------
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMsg;
    switch (msg.t) {
      case 'init':
        init = msg;
        defB = new Map(msg.ruleset.buildings.map((b) => [b.id, b]));
        defU = new Map(msg.ruleset.units.map((u) => [u.id, u]));
        terrain = msg.map.terrain ? new TerrainGrid(msg.map.terrain) : null;
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
    if (!closed) {
      hint.textContent = '';
      app.append(
        h('div', { class: 'overlay' },
          h('div', { class: 'card', style: { textAlign: 'center' } },
            h('h2', {}, 'DISCONNECTED'),
            h('p', { class: 'muted' }, 'Матч завершён или сервер был обновлён.'),
            h('button', { class: 'primary', onClick: leave }, 'Вернуться в лобби'),
          ),
        ),
      );
    }
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

    // NATO markers and drone icons are registered on demand or on load
    map.on('styleimagemissing', (e) => {
      const spec = parseNatoId(e.id);
      if (spec && !map.hasImage(e.id)) {
        map.addImage(e.id, drawNato(spec), { pixelRatio: 2 });
        return;
      }
      if (e.id.startsWith('drone|')) {
        const [, def, side, sel] = e.id.split('|');
        const img = new Image();
        img.src = `/drones/${def}_${side}${sel === '1' ? '_sel' : ''}.png`;
        img.onload = () => {
          if (!map.hasImage(e.id)) map.addImage(e.id, img, { pixelRatio: 2 });
        };
        return;
      }
      if (e.id === 'smoke') {
        const img = new Image();
        img.src = '/drones/smoke.png';
        img.onload = () => {
          if (!map.hasImage('smoke')) map.addImage('smoke', img, { pixelRatio: 2 });
        };
        return;
      }
    });

    map.on('load', () => {
      for (const id of ['occupied', 'front', 'pressure', 'units', 'formations', 'sel', 'rings', 'ghost', 'roads', 'borders', 'fuel-stations', 'build-restricted', 'pockets', 'city-schematics', 'smokes', 'special-zones', 'power-lines', 'recon-orbits']) map.addSource(id, { type: 'geojson', data: empty() });

      // Preload custom drone icons and smoke into MapLibre
      const droneDefs = ['drone_shahed', 'drone_orion', 'drone_liutyi', 'drone_pd2', 'drone_mini_shark', 'drone_fire_point'];
      for (const dId of droneDefs) {
        for (const s of ['ua', 'ru']) {
          for (const sel of [0, 1]) {
            const key = `drone|${dId}|${s}|${sel}`;
            const img = new Image();
            img.src = `/drones/${dId}_${s}${sel === 1 ? '_sel' : ''}.png`;
            img.onload = () => {
              if (!map.hasImage(key)) map.addImage(key, img, { pixelRatio: 2 });
            };
          }
        }
      }
      const smokeImg = new Image();
      smokeImg.src = '/drones/smoke.png';
      smokeImg.onload = () => {
        if (!map.hasImage('smoke')) map.addImage('smoke', smokeImg, { pixelRatio: 2 });
      };

      if (m.borders) {
        (map.getSource('borders') as GeoJSONSource).setData(m.borders);
      }
      // Note: fuel-stations are populated dynamically in renderMap() to filter out enemy-held stations
      map.addLayer({
        id: 'fuel-stations-glow', type: 'circle', source: 'fuel-stations',
        paint: {
          'circle-radius': 9,
          'circle-color': '#0284c7',
          'circle-opacity': 0.25,
          'circle-blur': 1.0,
        },
      });
      map.addLayer({
        id: 'fuel-stations-circle', type: 'circle', source: 'fuel-stations',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3.5, 7, 5, 11, 7],
          'circle-color': '#0284c7',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      });
      map.addLayer({
        id: 'fuel-stations-label', type: 'symbol', source: 'fuel-stations',
        minzoom: 7.5,
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 10,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: {
          'text-color': '#7dd3fc',
          'text-halo-color': '#030712',
          'text-halo-width': 1.5,
        },
      });
      map.on('mouseenter', 'fuel-stations-circle', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const f = e.features?.[0];
        if (f?.properties) toast(`АЗС: ${f.properties.name} (${f.properties.city ?? ''})`);
      });
      map.on('mouseleave', 'fuel-stations-circle', () => {
        map.getCanvas().style.cursor = '';
      });

      map.addLayer({
        id: 'borders-glow', type: 'line', source: 'borders',
        filter: ['==', ['get', 'type'], 'border'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#5a8cb8',
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3, 8, 5, 12, 7],
          'line-blur': 2.5,
          'line-opacity': 0.35,
        },
      });
      map.addLayer({
        id: 'borders-line', type: 'line', source: 'borders',
        filter: ['==', ['get', 'type'], 'border'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#8ab5de',
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.2, 8, 2.0, 12, 2.8],
          'line-dasharray': [4, 3],
          'line-opacity': 0.85,
        },
      });

      if (terrain) {
        map.addSource('terrain', { type: 'image', url: terrainImage(), coordinates: [[terrain.data.west, terrain.data.north], [terrain.data.east, terrain.data.north], [terrain.data.east, terrain.data.south], [terrain.data.west, terrain.data.south]] });
        map.addLayer({ id: 'terrain', type: 'raster', source: 'terrain', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.5, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } });
      }

      if (m.cities) {
        (map.getSource('city-schematics') as GeoJSONSource).setData(m.cities);
      } else if (m.capturePoints) {
        (map.getSource('city-schematics') as GeoJSONSource).setData(buildCitySchematicsGeoJSON(m.capturePoints));
      }

      // Real OpenStreetMap city boundaries (municipal borders)
      map.addLayer({
        id: 'city-boundary-fill', type: 'fill', source: 'city-schematics',
        filter: ['==', ['get', 'type'], 'city-boundary-fill'],
        paint: {
          'fill-color': '#1e293b',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4.5, 0.22, 7.5, 0.42],
        },
      });
      map.addLayer({
        id: 'city-boundary-line', type: 'line', source: 'city-schematics',
        filter: ['==', ['get', 'type'], 'city-boundary-line'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#64748b',
          'line-width': ['interpolate', ['linear'], ['zoom'], 4.5, 1.2, 8, 1.8, 11, 2.4],
          'line-dasharray': [4, 2],
          'line-opacity': 0.8,
        },
      });

      (map.getSource('roads') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: (m.roads ?? []).map((l) => {
          const coords: LngLat[] = [];
          for (let i = 1; i + 1 < l.length; i += 2) coords.push([l[i], l[i + 1]]);
          return { type: 'Feature', properties: { major: l[0] }, geometry: { type: 'LineString', coordinates: coords } };
        }),
      });
      map.addLayer({
        id: 'roads-minor', type: 'line', source: 'roads',
        filter: ['!=', ['get', 'major'], 1],
        minzoom: 6.0,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#334155',
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 6.0, 0.25, 8.5, 0.55],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6.0, 0.5, 8.5, 0.9, 11, 1.4],
        },
      });
      map.addLayer({
        id: 'roads-major', type: 'line', source: 'roads',
        filter: ['==', ['get', 'major'], 1],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#475569',
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 4.5, 0.45, 8, 0.7, 11, 0.85],
          'line-width': ['interpolate', ['linear'], ['zoom'], 4.5, 0.75, 8, 1.35, 11, 2.2],
        },
      });
      map.addLayer({ id: 'occupied-fill', type: 'fill', source: 'occupied', paint: { 'fill-color': '#ff3b3b', 'fill-opacity': 0.13 } });
      map.addLayer({ id: 'pockets-fill', type: 'fill', source: 'pockets', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.2 } });
      map.addLayer({ id: 'pockets-glow', type: 'line', source: 'pockets', layout: { 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 8, 'line-blur': 6, 'line-opacity': 0.5 } });
      map.addLayer({
        id: 'pockets-line', type: 'line', source: 'pockets', layout: { 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 2.2, 'line-dasharray': [4, 2] },
      });
      map.addLayer({ id: 'front-glow', type: 'line', source: 'front', layout: { 'line-join': 'round' }, paint: { 'line-color': '#ff4d4d', 'line-width': 10, 'line-blur': 8, 'line-opacity': 0.55 } });
      map.addLayer({ id: 'front-line', type: 'line', source: 'front', layout: { 'line-join': 'round' }, paint: { 'line-color': '#ff7b7b', 'line-width': 1.8 } });
      map.addLayer({ id: 'build-restricted-fill', type: 'fill', source: 'build-restricted', paint: { 'fill-color': '#ff3333', 'fill-opacity': 0.11 } });
      map.addLayer({
        id: 'build-restricted-line', type: 'line', source: 'build-restricted',
        paint: { 'line-color': '#ff4444', 'line-width': 1.6, 'line-opacity': 0.75, 'line-dasharray': [3, 2] },
      });
      map.addLayer({
        id: 'pressure', type: 'circle', source: 'pressure',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 0, 0, 1, 10],
          'circle-color': ['case', ['>', ['get', 'v'], 0], TEAM_COLOR[0], TEAM_COLOR[1]],
          'circle-opacity': 0.4, 'circle-blur': 0.6,
        },
      });
      map.addLayer({ id: 'rings', type: 'line', source: 'rings', paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.4, 'line-dasharray': [2, 3] } });
      map.addLayer({ id: 'ghost-fill', type: 'fill', source: 'ghost', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } });
      map.addLayer({
        id: 'sel-line-glow', type: 'line', source: 'sel',
        paint: { 'line-color': '#42d7f5', 'line-width': 3.5, 'line-blur': 2.5, 'line-opacity': 0.45 },
      });
      map.addLayer({
        id: 'sel-line', type: 'line', source: 'sel',
        paint: { 'line-color': '#ffffff', 'line-width': 1.6, 'line-opacity': 0.85, 'line-dasharray': [3, 2] },
      });

      const iconSize: any = ['interpolate', ['linear'], ['zoom'], 5, 0.4, 8, 0.58, 11, 0.85];
      const symbol = (id: string, filter: any, extra: Record<string, unknown> = {}) =>
        map.addLayer({
          id, type: 'symbol', source: id === 'formations' ? 'formations' : 'units', filter, ...extra,
          layout: { 'icon-image': ['get', 'icon'], 'icon-size': id === 'formations' ? ['interpolate', ['linear'], ['zoom'], 5, 0.62, 8, 0.8] : iconSize, 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'z'] },
        } as any);
      symbol('units-loose', ['all', ['!', ['get', 'grp']], ['!=', ['get', 'air'], true]], { minzoom: GROUP_ZOOM });
      symbol('units-grouped', ['all', ['get', 'grp'], ['!=', ['get', 'air'], true]], { minzoom: GROUP_ZOOM });
      symbol('formations', ['all'], { maxzoom: GROUP_ZOOM });

      map.addLayer({
        id: 'drones',
        type: 'symbol',
        source: 'units',
        filter: ['==', ['get', 'air'], true],
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-size': [
            'interpolate', ['linear'], ['zoom'],
            4, ['*', ['coalesce', ['get', 'scale'], 1], 0.18],
            8, ['*', ['coalesce', ['get', 'scale'], 1], 0.28],
            11, ['*', ['coalesce', ['get', 'scale'], 1], 0.40]
          ],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'symbol-sort-key': ['get', 'z']
        }
      } as any);

      map.addLayer({
        id: 'smokes',
        type: 'symbol',
        source: 'smokes',
        layout: {
          'icon-image': 'smoke',
          'icon-size': ['interpolate', ['exponential', 2], ['zoom'], 4, 0.0125, 8, 0.2, 12, 3.2],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': ['coalesce', ['get', 'opacity'], 0.75],
        },
      });

      // Special production zones (Kremenchuk Oil Refinery & Alabuga Drone Factory)
      map.addLayer({
        id: 'special-zones-fill',
        type: 'fill',
        source: 'special-zones',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.16,
        },
      });
      map.addLayer({
        id: 'special-zones-glow',
        type: 'line',
        source: 'special-zones',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 6,
          'line-blur': 4,
          'line-opacity': 0.45,
        },
      });
      map.addLayer({
        id: 'special-zones-line',
        type: 'line',
        source: 'special-zones',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-dasharray': [4, 2],
          'line-opacity': 0.85,
        },
      });
      map.addLayer({
        id: 'special-zones-label',
        type: 'symbol',
        source: 'special-zones',
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, 0],
          'text-anchor': 'center',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#f8fafc',
          'text-halo-color': '#0f172a',
          'text-halo-width': 2,
        },
      });

      (map.getSource('special-zones') as GeoJSONSource)?.setData(empty());

      let zonePopup: maplibregl.Popup | null = null;
      map.on('mouseenter', 'special-zones-fill', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const f = e.features?.[0];
        if (!f?.properties) return;
        const name = f.properties.name;
        const title = f.properties.bonusTitle;
        const desc = f.properties.bonusDesc;
        if (!zonePopup) {
          zonePopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
        }
        zonePopup
          .setLngLat(e.lngLat)
          .setHTML(`<div style="font-family:sans-serif;max-width:240px;line-height:1.3;padding:2px 4px;">
            <div style="font-weight:bold;color:#38bdf8;font-size:13px;margin-bottom:3px;">${name}</div>
            <div style="font-weight:600;color:#facc15;font-size:11px;margin-bottom:4px;">${title}</div>
            <div style="font-size:11px;color:#cbd5e1;">${desc}</div>
          </div>`)
          .addTo(map);
      });
      map.on('mousemove', 'special-zones-fill', (e) => {
        if (zonePopup) zonePopup.setLngLat(e.lngLat);
      });
      map.on('mouseleave', 'special-zones-fill', () => {
        map.getCanvas().style.cursor = '';
        if (zonePopup) {
          zonePopup.remove();
          zonePopup = null;
        }
      });

      // Power lines along roads (offset alongside road with soft subtle opacity)
      map.addLayer({
        id: 'power-lines-glow',
        type: 'line',
        source: 'power-lines',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#0284c7',
          'line-width': 2.0,
          'line-blur': 1.5,
          'line-opacity': 0.16,
          'line-offset': 3.5,
        },
      });
      map.addLayer({
        id: 'power-lines-line',
        type: 'line',
        source: 'power-lines',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#38bdf8',
          'line-width': 1.0,
          'line-dasharray': [4, 3],
          'line-opacity': 0.35,
          'line-offset': 3.5,
        },
      });

      // Recon drone loitering orbits
      map.addLayer({
        id: 'recon-orbits-glow',
        type: 'line',
        source: 'recon-orbits',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#10b981',
          'line-width': 5,
          'line-blur': 4,
          'line-opacity': 0.45,
        },
      });
      map.addLayer({
        id: 'recon-orbits-line',
        type: 'line',
        source: 'recon-orbits',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#a7f3d0',
          'line-width': 1.8,
          'line-dasharray': [4, 2],
          'line-opacity': 0.9,
        },
      });

      for (const cp of init!.map.capturePoints) {
        const el = h('div', { class: `cp val-${cp.value}` + (cp.value >= 3 ? ' cp-major' : ' cp-minor') },
          h('i', {}),
          h('div', { class: 'cp-label' },
            h('span', {}, cp.name),
            h('div', { class: 'cp-hp', style: { display: 'none' } },
              h('div', { class: 'cp-hp-ghost' }),
              h('div', { class: 'cp-hp-fill' })
            )
          )
        );
        new maplibregl.Marker({ element: el }).setLngLat(cp.pos).addTo(map);
        pMarkers.set(cp.id, el);
      }
      if (m.borders?.features) {
        for (const f of m.borders.features) {
          if (f.properties?.type === 'country_label') {
            const el = h('div', { class: 'country-label' }, f.properties.name);
            new maplibregl.Marker({ element: el }).setLngLat(f.geometry.coordinates).addTo(map);
          }
        }
      }
      fx = new ShotFx(map, mapEl, defU, TEAM_COLOR);
      if (import.meta.env.DEV) (window as any).__sw = { map, fx, snap: () => snap };
      mapReady = true;
      if (snap) render();
      requestAnimationFrame(animate);
    });

    const setScale = () => mapEl.style.setProperty('--s', String(Math.min(1.4, Math.max(0.42, (map.getZoom() - 3.6) / 4.6))));
    const updateZoomClasses = () => {
      const z = map.getZoom();
      mapEl.classList.toggle('far', z < 6.6);
      mapEl.classList.toggle('zoom-overview', z < 5.3);
      mapEl.classList.toggle('zoom-very-far', z < 6.0);
      mapEl.classList.toggle('zoom-far', z < 6.8);
    };
    map.on('zoom', setScale);
    map.on('zoom', updateZoomClasses);
    setScale();
    updateZoomClasses();

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
      if (bombardPicker) {
        send({ type: 'bombard', units: bombardPicker.unitIds, target: p });
        toast('🎯 Задан сектор артиллерийского удара');
        bombardPicker = null;
        render();
        return;
      }
      if (routePicker) {
        toast('Кликните по зданию на карте (или Esc для отмены)');
        return;
      }
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
      if (bombardPicker) {
        send({ type: 'bombard', units: bombardPicker.unitIds, target: [e.lngLat.lng, e.lngLat.lat] });
        toast('🎯 Задан сектор артиллерийского удара');
        bombardPicker = null;
        render();
        return;
      }
      if (routePicker) {
        routePicker = null;
        toast('Выбор маршрута отменен');
        render();
        return;
      }
      if (placing) return cancelPlacing();
      const isShift = !!e.originalEvent?.shiftKey;
      if (selUnits.size) send({ type: 'move', units: [...selUnits], to: [e.lngLat.lng, e.lngLat.lat], cohesion: formation && selUnits.size > 1, append: isShift });
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
      const p = map.project(curPos(u));
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
      if (bombardPicker) {
        bombardPicker = null;
        toast('Выбор сектора удара отменен');
        render();
        return;
      }
      if (routePicker) {
        routePicker = null;
        toast('Выбор маршрута отменен');
        render();
        return;
      }
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
  const centroid = (us: UnitView[]): LngLat | null => (us.length ? [us.reduce((a, u) => a + curPos(u)[0], 0) / us.length, us.reduce((a, u) => a + curPos(u)[1], 0) / us.length] : null);

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
  function terrainImage(): string {
    const t = terrain!;
    const c = document.createElement('canvas');
    c.width = t.data.cols;
    c.height = t.data.rows;
    const g = c.getContext('2d')!;
    const img = g.createImageData(c.width, c.height);
    const palette = t.ids.map((id) => {
      const col = init!.ruleset.terrain.find((d) => d.id === id)?.color ?? '#000000';
      return [parseInt(col.slice(1, 3), 16), parseInt(col.slice(3, 5), 16), parseInt(col.slice(5, 7), 16), id === t.ids[0] ? 0 : 255];
    });
    for (let i = 0; i < t.cells.length; i++) img.data.set(palette[t.cells[i]], i * 4);
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }
  function toggleTerrain() {
    if (!mapReady || !map.getLayer('terrain')) return;
    const on = map.getLayoutProperty('terrain', 'visibility') !== 'visible';
    map.setLayoutProperty('terrain', 'visibility', on ? 'visible' : 'none');
    terrainBtn.classList.toggle('on', on);
  }
  function toggleBasemap() {
    if (!mapReady || !map.getLayer('osm')) return;
    const isVisible = map.getLayoutProperty('osm', 'visibility') !== 'none';
    const next = isVisible ? 'none' : 'visible';
    map.setLayoutProperty('osm', 'visibility', next);
    basemapBtn.classList.toggle('on', next === 'none');
    basemapBtn.textContent = next === 'none' ? 'Map: OFF' : 'Map: ON';
  }
  function showTerrain(p: LngLat) {
    if (!terrain || !init) return;
    const t = init.ruleset.terrain.find((d) => d.id === terrain!.at(p));
    if (!t) return void (terrainChip.style.display = 'none');
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const classes = [...new Set(init.ruleset.units.filter((u) => u.kind !== 'air').map((u) => u.mobility ?? 'foot'))];
    clear(terrainChip);
    terrainChip.style.display = 'flex';
    terrainChip.append(h('i', { style: { background: t.color } }), h('b', {}, t.name), ...classes.map((c) => h('span', {}, `${c} ${pct(t.speed[c] ?? t.speed.default ?? 1)}`)));
    if (t.cover) terrainChip.append(h('span', { class: t.cover > 0 ? 'pos' : 'neg' }, `cover ${t.cover > 0 ? '+' : ''}${pct(t.cover)}`));
    if (t.concealment < 1) terrainChip.append(h('span', { class: 'pos' }, 'concealed'));
    if (roads?.isNear(p, 2)) terrainChip.append(h('span', { class: 'road' }, `road ×${init.ruleset.rules.roadSpeedMult}`));
  }

  // ---------- placement ----------
  function updateSpecialZones() {
    const src = map.getSource('special-zones') as GeoJSONSource | undefined;
    if (!src || !init) return;
    if (!placing) {
      src.setData(empty());
      return;
    }
    const mySide = init.team === 0 ? 'ua' : 'ru';
    // Ukraine only sees Kremenchuk when placing oil_refinery
    // Russia only sees Alabuga when placing drone_factory
    const allowed = SPECIAL_ZONES.filter((z) => {
      if (z.side !== mySide) return false;
      if (z.buildingDef !== placing?.id) return false;
      return true;
    });

    const features = allowed.map((z) => ({
      type: 'Feature',
      properties: {
        id: z.id,
        name: z.name,
        side: z.side,
        color: z.color,
        bonusTitle: z.bonusTitle,
        bonusDesc: z.bonusDesc,
        label: `${z.name}\n(${z.side === 'ua' ? 'Бонус x1.5 топлива' : 'Бонус x1.5 БПЛА'})`,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [z.polygon],
      },
    }));

    src.setData({
      type: 'FeatureCollection',
      features,
    });
  }

  function updateRestrictedZones() {
    updateSpecialZones();
    if (!placing || !init || !snap) {
      (map.getSource('build-restricted') as GeoJSONSource | undefined)?.setData(empty());
      return;
    }
    const r = init.ruleset.rules.minBuildSpacing; // 35 km
    const features = snap.buildings.map((b) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [circle(b.pos, r, 64)] },
    }));
    (map.getSource('build-restricted') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features,
    });
  }

  function cancelPlacing() {
    if (!placing) return;
    placing = null;
    hint.textContent = HINT;
    mapEl.classList.remove('placing');
    (map.getSource('ghost') as GeoJSONSource | undefined)?.setData(empty());
    updateRestrictedZones();
    updateSpecialZones();
    buildPalette();
  }

  function circle(c: LngLat, km: number, n = 48): LngLat[] {
    return Array.from({ length: n + 1 }, (_, i) => offsetKm(c, Math.cos((i / n) * 6.2832) * km, Math.sin((i / n) * 6.2832) * km));
  }

  function placementProblem(def: BuildingDef, p: LngLat): string | null {
    if (!init || !snap) return 'not ready';
    const r = init.ruleset.rules;
    const d = distToFrontKm(snap.front, p) * (init.team === 0 ? 1 : -1);
    if (d < 0) return 'not your territory';
    if (d < r.minBuildDistanceFromFront * (def.category === 'civil' ? 2 : 1)) return 'too close to the front';
    if (terrain?.at(p) === 'water') return 'cannot build on water';
    if (snap.buildings.some((b) => distKm(b.pos, p) < r.minBuildSpacing)) return `too close to another building (min ${r.minBuildSpacing}km)`;
    if (!Object.entries(def.cost).every(([k, v]) => (snap!.res[k] ?? 0) >= v)) return 'not enough resources';
    return null;
  }

  function drawGhost(p: LngLat) {
    if (!placing || !init) return;
    const problem = placementProblem(placing, p);
    const color = problem ? '#ff5a5a' : '#5ae88a';
    const radius = placing.defense?.radiusKm ?? placing.aura?.radiusKm ?? (placing.vision && placing.vision > 8 ? placing.vision : 1.2);
    (map.getSource('ghost') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { color }, geometry: { type: 'Polygon', coordinates: [circle(p, radius)] } }],
    });
    const road = roads?.isNear(p, init.ruleset.rules.roadAccessKm);
    const bonus = Math.round((init.ruleset.rules.roadOutputMult - 1) * 100);
    let specialBonus = '';
    if (placing.id === 'oil_refinery' && isKremenchukRefinery(p)) {
      specialBonus = ' · ★ БОНУС КРЕМЕНЧУГА: x1.5 к производству топлива!';
    } else if (placing.id === 'drone_factory' && isAlabugaDroneZone(p)) {
      specialBonus = ' · ★ БОНУС ОЭЗ «АЛАБУГА»: x1.5 к скорости производства дронов!';
    }
    hint.textContent = problem ? `${placing.name}: ${problem}` : `${placing.name}: click to build${placing.produces ? (road ? ` · road access +${bonus}% output` : ' · no road nearby') : ''}${specialBonus} (Shift keeps placing, Esc cancels)`;
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
            updateRestrictedZones();
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
    const isUnlimited = (init.ruleset.rules.matchSeconds ?? 0) <= 0;
    const timeText = isUnlimited
      ? `${Math.floor(snap.time / 60)}:${String(Math.floor(snap.time % 60)).padStart(2, '0')}`
      : (() => {
          const left = Math.max(0, init.ruleset.rules.matchSeconds - snap.time);
          return `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
        })();
    const held = [0, 1].map((t) => snap!.points.filter((p) => p.owner === t).length);
    clear(scoreBar);
    scoreBar.append(
      h('div', { class: 'teams' },
        h('span', { style: { color: TEAM_COLOR[0] } }, `${TEAM_NAME[0]} ${held[0]}`),
        h('b', { title: isUnlimited ? 'Режим: До победного (без ограничения времени)' : 'Время матча' }, `${isUnlimited ? '∞ ' : ''}${timeText}`),
        h('span', { style: { color: TEAM_COLOR[1] } }, `${held[1]} ${TEAM_NAME[1]}`),
      ),
      h('div', { class: 'bar' }, h('i', { style: { width: `${(snap.scores[0] / total) * 100}%`, background: TEAM_COLOR[0] } }), h('i', { style: { width: `${(snap.scores[1] / total) * 100}%`, background: TEAM_COLOR[1] } })),
    );
  }

  const ranks = () => init!.ruleset.ranks;
  const maxHp = (u: UnitView) => (defU.get(u.def)?.hp ?? 1) * (ranks()[u.rank]?.hp ?? 1);

  function computeEtaSeconds(u: UnitView, d: UnitDef): number | null {
    if (!u.path || u.path.length === 0) return null;
    const sprintMult = u.sprint && u.def !== 'drone' ? 2.0 : 1.0;
    const baseSpeed = d.speed * sprintMult;
    if (baseSpeed <= 0) return null;
    const roadMult = d.kind === 'air' ? 1.0 : (init?.ruleset.rules.roadSpeedMult || 2.0);

    let totalSec = 0;
    let prevPos: LngLat = curPos(u);
    for (const p of u.path) {
      const dist = distKm(prevPos, p);
      const isRoad = roads ? roads.isNear(p, 1.5) : false;
      const speed = baseSpeed * (isRoad ? roadMult : 1.0);
      totalSec += dist / speed;
      prevPos = p;
    }
    return totalSec;
  }

  function formatEta(sec: number): string {
    const s = Math.round(sec);
    if (s < 60) return `${s}с`;
    const m = Math.floor(s / 60);
    const remS = s % 60;
    if (m < 60) return remS > 0 ? `${m}м ${remS}с` : `${m}м`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${h}ч ${remM}м`;
  }

  function allowedStorageResources(d: BuildingDef): string[] {
    if (d.id === 'gas_station') return ['fuel'];
    if (d.id === 'oil_refinery') return ['fuel'];
    if (d.id === 'mine') return ['ore'];
    if (d.id === 'warehouse') return ['metal', 'fuel', 'ore'];

    const res = new Set<string>();
    if (d.produces) {
      for (const k of Object.keys(d.produces)) {
        if (k !== 'money' && k !== 'people' && k !== 'energy') res.add(k);
      }
    }
    if (d.consumes) {
      for (const k of Object.keys(d.consumes)) {
        if (k !== 'money' && k !== 'people' && k !== 'energy') res.add(k);
      }
    }
    if (d.trains) {
      for (const uid of d.trains) {
        const u = defU.get(uid);
        if (u?.cost) {
          for (const k of Object.keys(u.cost)) {
            if (k !== 'money' && k !== 'people' && k !== 'energy') res.add(k);
          }
        }
      }
    }
    return [...res];
  }

  function renderSide() {
    if (!init || !snap) return;
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
        const hasPower = snap.buildings.some((o) => o.team === b.team && o.progress >= 1 && o.def === 'power_plant' && distKm(o.pos, b.pos) <= 100);
        if (hasPower) {
          side.append(h('div', { class: 'stat', style: { color: '#38bdf8' } }, '⚡ Электросеть: +25% к скорости производства'));
        }
        if (b.def === 'oil_refinery' && isKremenchukRefinery(b.pos)) {
          side.append(h('div', { class: 'stat', style: { color: '#06b6d4', fontWeight: 'bold' } }, '★ Бонус Кременчугского НПЗ: x1.5 к производству топлива!'));
        }
        if (b.def === 'drone_factory' && isAlabugaDroneZone(b.pos)) {
          side.append(h('div', { class: 'stat', style: { color: '#f59e0b', fontWeight: 'bold' } }, '★ Бонус ОЭЗ «Алабуга»: x1.5 к скорости производства БПЛА!'));
        }
        if (b.progress < 1) side.append(h('div', { class: 'stat' }, `Under construction ${Math.round(b.progress * 100)}%`));

        // Building local storage (only relevant goods for this building)
        const stor = b.storage ?? {};
        const allowedRes = allowedStorageResources(d);
        if (allowedRes.length > 0) {
          const isGasStation = b.def === 'gas_station';
          const title = isGasStation
            ? 'Резервуар АЗС (до 20,000 л топлива):'
            : d.id === 'mine'
            ? 'Склад руды (до 30,000):'
            : d.id === 'oil_refinery'
            ? 'Резервуар топлива (до 30,000 л):'
            : 'Склад сырья (до 30,000 на ресурс):';

          const resMeta: Record<string, { name: string; icon: string }> = {
            metal: { name: 'Металл', icon: '🔩' },
            fuel: { name: 'Топливо', icon: '⛽' },
            ore: { name: 'Руда', icon: '⛏' },
          };

          const items: HTMLElement[] = [];
          for (const k of allowedRes) {
            const meta = resMeta[k] ?? { name: k, icon: '📦' };
            const isFuelOnGasStation = isGasStation && k === 'fuel';
            const valText = `${Math.floor(stor[k] ?? 0)}${isFuelOnGasStation ? ' / 20k' : ''}`;
            items.push(h('div', { class: 'storage-item' }, h('span', {}, `${meta.icon} ${meta.name}`), h('b', {}, valText)));
          }

          const storBox = h('div', { class: 'storage-box' },
            h('b', { style: { fontSize: '11px', color: '#94a3b8' } }, title),
            h('div', { class: 'storage-grid' }, ...items)
          );
          side.append(storBox);
        }

        if (b.def === 'aircraft_plant' && b.progress >= 1) {
          side.append(h('div', { class: 'muted', style: { fontStyle: 'italic', padding: '6px 8px', background: 'rgba(255,255,255,0.04)', borderRadius: '4px', marginTop: '6px' } }, '🛩 Завод готов к переоборудованию. Производство пилотируемой авиации и вертолётов будет доступно в ближайшем обновлении.'));
        }

        if (b.progress >= 1) {
          const mySide = init!.team === 0 ? 'ua' : 'ru';
          for (const uid of d.trains ?? []) {
            const u = defU.get(uid);
            if (!u) continue;
            if (u.side && u.side !== mySide) continue;
            const globalCost: Record<string, number> = {};
            const storageCost: Record<string, number> = {};
            for (const [k, v] of Object.entries(u.cost)) {
              if (k === 'money' || k === 'people') globalCost[k] = v;
              else storageCost[k] = v;
            }
            const canAffordGlobal = Object.entries(globalCost).every(([k, v]) => (snap!.res[k] ?? 0) >= v);
            const canAffordStorage = Object.entries(storageCost).every(([k, v]) => (stor[k] ?? 0) >= v);
            const canTrain = canAffordGlobal && canAffordStorage;

            const effectiveHave: Record<string, number> = {
              ...stor,
              money: snap.res.money ?? 0,
              people: snap.res.people ?? 0,
            };

            const trainBtn = h('button', {
              class: 'bld' + (!canTrain ? ' cant-afford-storage' : ''),
              onClick: () => {
                if (!canAffordGlobal) {
                  toast(`Недостаточно средств (деньги / рекруты) в казне!`, true);
                  return;
                }
                if (!canAffordStorage) {
                  toast(`Недостаточно сырья (металл / топливо) на складе здания! Доставьте припасы грузовиком.`, true);
                  return;
                }
                send({ type: 'train', building: b.id, unit: uid });
              }
            },
              unitIcon(u, 0),
              h('span', { class: 'meta' },
                h('b', {}, `Train ${u.name} · ${u.trainTime}s`),
                costHtml(u.cost, effectiveHave),
                !canAffordStorage ? h('div', { class: 'warn-storage' }, '⚠ Требуется доставка сырья на склад') : (!canAffordGlobal ? h('div', { class: 'warn-storage' }, '⚠ Недостаточно денег / рекрутов') : null)
              )
            );
            side.append(trainBtn);
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
        const eta = computeEtaSeconds(u, d);
        let routeEtaStr: string | null = null;
        if (u.route) {
          const resLabel = u.route.resType === 'ore' ? ' [Руда]' :
                           u.route.resType === 'metal' ? ' [Металл]' :
                           u.route.resType === 'fuel' ? ' [Топливо]' : '';
          if (u.route.state === 'loading') {
            routeEtaStr = `⏳ Погрузка${resLabel} (${Math.ceil(u.route.timer ?? 5)}с)`;
          } else if (u.route.state === 'unloading') {
            routeEtaStr = `⏳ Разгрузка${resLabel} (${Math.ceil(u.route.timer ?? 4)}с)`;
          } else if (eta !== null) {
            const destName = u.route.state === 'to_to' ? 'разгрузки' : 'погрузки';
            routeEtaStr = `⏱ В пути до ${destName}${resLabel}: ~${formatEta(eta)}`;
          }
        } else if (eta !== null) {
          routeEtaStr = `⏱ В пути до цели: ~${formatEta(eta)}`;
        }
        side.append(
          h('div', { class: 'row' }, unitIcon(d, u.rank), h('div', {}, h('b', {}, d.name), h('div', { class: 'muted' }, rk[u.rank]?.name ?? ''))),
          h('div', { class: 'stat' }, `HP ${u.hp}/${Math.round(maxHp(u))}`),
          h('div', { class: 'stat' }, next ? `XP ${u.xp}/${next.xp} → ${next.name}` : `XP ${u.xp} · top rank`),
          h('div', { class: 'stat muted' }, `damage ×${rk[u.rank]?.damage ?? 1} · range ×${rk[u.rank]?.range ?? 1}`),
        );
        if (routeEtaStr) side.append(h('div', { class: 'stat', style: { color: '#38bdf8', fontWeight: 'bold' } }, routeEtaStr));
      } else {
        const by = new Map<string, UnitView[]>();
        mine.forEach((u) => by.set(u.def, [...(by.get(u.def) ?? []), u]));
        for (const [k, us] of by) {
          const d = defU.get(k)!;
          const top = Math.max(...us.map((u) => u.rank));
          side.append(h('div', { class: 'row' }, unitIcon(d, top), h('span', { class: 'stat' }, `${us.length} × ${d.name}`, us.some((u) => u.rank > 0) ? h('small', { class: 'muted' }, ` · ${rk[top]?.name}`) : null)));
        }
        const moving = mine.filter((u) => u.path?.length);
        if (moving.length > 0) {
          const maxEta = Math.max(...moving.map((u) => computeEtaSeconds(u, defU.get(u.def)!) ?? 0));
          if (maxEta > 0) side.append(h('div', { class: 'stat', style: { color: '#38bdf8', fontWeight: 'bold' } }, `⏱ В пути: ~${formatEta(maxEta)}`));
        }
      }

      // promotion: buy the next rank for everything selected that can still climb
      const cost: Record<string, number> = {};
      let n = 0;
      for (const u of mine) {
        const next = rk[u.rank + 1];
        if (!next) continue;
        n++;
        for (const [k, v] of Object.entries(next.cost)) cost[k] = (cost[k] ?? 0) + v;
      }
      if (n) side.append(h('button', { class: 'bld', title: 'Units also gain experience by fighting', onClick: () => send({ type: 'promote', units: [...selUnits] }) },
        h('span', { class: 'ico' }, '︽'), h('span', { class: 'meta' }, h('b', {}, `Promote ${n === 1 ? 'unit' : `${n} units`}`), costHtml(cost, snap.res))));

      const formationBox = h('input', { type: 'checkbox', checked: formation || undefined });
      formationBox.addEventListener('change', () => (formation = formationBox.checked));
      if (mine.length > 1) side.append(h('label', { class: 'field check' }, formationBox, h('span', {}, 'Move in formation (slowest sets the pace)')));
      side.append(
        h('div', { class: 'row' },
          h('button', { onClick: () => makeGroup() }, 'Group (G)'),
          group ? h('button', { onClick: () => ungroup() }, 'Ungroup (U)') : null,
          h('button', { class: 'ghost', onClick: () => send({ type: 'stop', units: [...selUnits] }) }, 'Stop (S)'),
        ),
        h('div', { class: 'muted' }, 'Right click to move: ground units take roads when faster. Ctrl+1-9 assigns a numbered group.'),
      );
    }
    side.classList.toggle('open', side.childElementCount > 0);
  }

  function renderUnitHud() {
    if (!init || !snap) return;
    clear(unitHud);
    if (!selUnits.size) {
      unitHud.style.display = 'none';
      return;
    }
    unitHud.style.display = 'flex';

    const selectedList = snap.units.filter((u) => selUnits.has(u.id));
    if (!selectedList.length) {
      unitHud.style.display = 'none';
      return;
    }

    const first = selectedList[0];
    const isSingle = selectedList.length === 1;
    const dFirst = defU.get(first.def);
    const titleText = isSingle
      ? `${dFirst?.name ?? first.def}`
      : `Выбрано: ${selectedList.length} ед.`;

    const etaSec = isSingle && dFirst ? computeEtaSeconds(first, dFirst) : null;
    let etaBadgeText: string | null = null;
    if (first.route) {
      const resLabel = first.route.resType === 'ore' ? ' [Руда]' :
                       first.route.resType === 'metal' ? ' [Металл]' :
                       first.route.resType === 'fuel' ? ' [Топливо]' : '';
      if (first.route.state === 'loading') {
        etaBadgeText = `⏳ Погрузка${resLabel} (${Math.ceil(first.route.timer ?? 5)}с)`;
      } else if (first.route.state === 'unloading') {
        etaBadgeText = `⏳ Разгрузка${resLabel} (${Math.ceil(first.route.timer ?? 4)}с)`;
      } else if (etaSec !== null) {
        const destPrefix = first.route.state === 'to_to' ? 'До разгрузки: ~' : 'До погрузки: ~';
        etaBadgeText = `⏱ ${destPrefix}${formatEta(etaSec)}${resLabel}`;
      }
    } else if (etaSec !== null) {
      etaBadgeText = `⏱ Прибытие: ~${formatEta(etaSec)}`;
    }

    // Fuel operating time calculation (e.g. "Топливо: 40м 30с")
    const unitsWithFuel = selectedList.filter((u) => u.fuel !== undefined);
    let fuelTimeText = '';
    if (unitsWithFuel.length > 0) {
      const isSprinting = selectedList.some((u) => u.sprint);
      const avgFuel = unitsWithFuel.reduce((acc, u) => acc + (u.fuel ?? 0), 0) / unitsWithFuel.length;
      const refDef = defU.get(unitsWithFuel[0].def);
      const speed = refDef?.speed || 0.25;
      const burnPerSec = (refDef?.kind === 'air' ? 0.08 : 0.04) * speed * (isSprinting ? 1.5 : 1.0);
      const totalSec = Math.max(0, Math.round(avgFuel / (burnPerSec > 0 ? burnPerSec : 0.035)));
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      fuelTimeText = `Топливо: ${m}м ${s}с`;
    }

    // 1. Info / Title
    const titleEl = h('div', { class: 'hud-sec' },
      isSingle && dFirst ? unitIcon(dFirst, first.rank) : null,
      h('div', {},
        h('div', { class: 'hud-title' }, titleText),
        fuelTimeText ? h('div', { style: { fontSize: '11px', color: '#f59e0b', fontWeight: 'bold', marginTop: '2px' } }, fuelTimeText) : null,
        etaBadgeText ? h('div', { style: { fontSize: '11px', color: '#38bdf8', fontWeight: 'bold', marginTop: '2px' } }, etaBadgeText) : null,
      ),
    );

    // 2. Stop Button ("Стоп")
    const stopBtn = h('button', {
      class: 'hud-btn',
      title: 'Остановить все действия юнита (S)',
      onClick: () => {
        send({ type: 'stop', units: [...selUnits] });
        send({ type: 'bombard', units: [...selUnits], target: null });
        routePicker = null;
        bombardPicker = null;
      }
    }, '🛑 Стоп');

    // 3. Fire Mode ("Режим ведения огня")
    const currentMode = first.fireMode ?? 'auto';
    const fireGroup = h('div', { class: 'btn-group', title: 'Режим ведения огня' },
      h('button', {
        class: currentMode === 'auto' ? 'active' : '',
        title: 'Автоматический режим: атаковать любого врага в радиусе поражения',
        onClick: () => send({ type: 'fireMode', units: [...selUnits], mode: 'auto' })
      }, 'Авто'),
      h('button', {
        class: currentMode === 'return' ? 'active' : '',
        title: 'Ответный огонь: стрелять только в ответ при атаке',
        onClick: () => send({ type: 'fireMode', units: [...selUnits], mode: 'return' })
      }, 'Ответный'),
      h('button', {
        class: currentMode === 'hold' ? 'active' : '',
        title: 'Не стрелять: скрытный режим без стрельбы',
        onClick: () => send({ type: 'fireMode', units: [...selUnits], mode: 'hold' })
      }, 'Не стрелять'),
    );

    // 4. "Быстрее" (Sprint / Turbo) + Stamina (исключаем дроны и авиацию)
    const hasNonDrones = selectedList.some((u) => u.def !== 'drone' && defU.get(u.def)?.kind !== 'air');
    let sprintBtn: HTMLElement | null = null;
    let staminaMeter: HTMLElement | null = null;

    if (hasNonDrones) {
      const isSprinting = selectedList.some((u) => u.sprint);
      const staminaUnits = selectedList.filter((u) => u.stamina !== undefined);
      const hasStamina = staminaUnits.length > 0;
      const isAllVehicles = selectedList.every((u) => u.stamina === undefined && u.fuel !== undefined);

      sprintBtn = h('button', {
        class: 'hud-btn sprint-btn' + (isSprinting ? ' active' : ''),
        title: isAllVehicles
          ? 'Ускорение x2 (расход топлива x1.5, действует пока не выключите)'
          : 'Ускорение x2 (для пехоты тратит стамину, для техники расход топлива x1.5)',
        onClick: () => send({ type: 'sprint', units: [...selUnits], active: !isSprinting })
      }, `⚡ Быстрее (${isSprinting ? 'ВКЛ' : 'ВЫКЛ'})`);

      if (hasStamina) {
        const avgStamina = staminaUnits.reduce((acc, u) => acc + (u.stamina ?? 100), 0) / (staminaUnits.length || 1);
        staminaMeter = h('div', { class: 'meter-wrap', title: 'Запас стамины пехоты: 60с бега, 180с восстановления' },
          h('div', { class: 'meter-label' }, h('span', {}, 'Стамина'), h('span', {}, `${Math.round(avgStamina)}%`)),
          h('div', { class: 'meter-bar' },
            h('div', { class: 'meter-fill stamina', style: { width: `${Math.max(0, Math.min(100, avgStamina))}%` } })
          )
        );
      }
    }

    // 5. Fuel meter & Refuel button for vehicles
    const hasVehicles = selectedList.some((u) => u.fuel !== undefined);
    let fuelSec: HTMLElement | null = null;
    if (hasVehicles) {
      const avgFuel = selectedList.filter((u) => u.fuel !== undefined).reduce((acc, u) => acc + (u.fuel ?? 0), 0);
      const avgMaxFuel = selectedList.filter((u) => u.maxFuel !== undefined).reduce((acc, u) => acc + (u.maxFuel ?? 100), 0) || 100;
      const fuelPct = Math.round((avgFuel / avgMaxFuel) * 100);
      fuelSec = h('div', { class: 'hud-sec' },
        h('div', { class: 'meter-wrap', title: 'Запас топлива техники (пополняется на АЗС)' },
          h('div', { class: 'meter-label' }, h('span', {}, '⛽ Топливо'), h('span', {}, fuelTimeText ? `${fuelTimeText} (${fuelPct}%)` : `${fuelPct}%`)),
          h('div', { class: 'meter-bar' },
            h('div', { class: 'meter-fill fuel', style: { width: `${Math.max(0, Math.min(100, fuelPct))}%` } })
          )
        ),
        h('button', {
          class: 'hud-btn sm',
          title: 'Поехать на ближайшую АЗС или топливозаправщик',
          onClick: () => send({ type: 'refuel', units: [...selUnits] })
        }, 'Заправиться')
      );
    }

    // 6. Transports & Logistics Routes
    let transportSec: HTMLElement | null = null;
    if (isSingle && dFirst?.cargoCap) {
      const curCargo = first.cargo?.res ?? {};
      const cargoSum = Object.values(curCargo).reduce((a, b) => a + b, 0);
      const isRouteActive = !!first.route;

      let routeControl: HTMLElement;
      if (routePicker && routePicker.unitId === first.id) {
        const step = routePicker.fromBuilding ? 2 : 1;
        const fromB = routePicker.fromBuilding ? snap.buildings.find((b) => b.id === routePicker!.fromBuilding) : null;
        const fromDef = fromB ? defB.get(fromB.def) : null;

        let resSelector: HTMLElement | null = null;
        if (fromB && !dFirst.fuelOnly) {
          const resOptions: { id: string; label: string }[] = [];
          if (fromDef?.produces?.ore || fromB.storage?.ore) resOptions.push({ id: 'ore', label: '⛏ Руда' });
          if (fromDef?.produces?.metal || fromB.storage?.metal) resOptions.push({ id: 'metal', label: '🔩 Металл' });
          resOptions.push({ id: 'any', label: '📦 Любой груз' });

          if (!routePicker.resType) {
            routePicker.resType = resOptions[0]?.id ?? 'ore';
          }

          resSelector = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '4px', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '11px', color: '#94a3b8' } }, 'Возить:'),
            ...resOptions.map((opt) => h('button', {
              class: 'hud-btn sm' + (routePicker!.resType === opt.id ? ' active' : ''),
              style: { padding: '2px 8px', fontSize: '11px' },
              onClick: (e: MouseEvent) => {
                e.stopPropagation();
                routePicker!.resType = opt.id;
                render();
              }
            }, opt.label))
          );
        }

        const resDesc = routePicker.resType === 'ore' ? ' [Груз: Руда]' :
                        routePicker.resType === 'metal' ? ' [Груз: Металл]' : '';

        routeControl = h('div', { class: 'route-wizard-box' },
          h('div', { class: 'route-wizard-header' },
            h('span', { class: 'badge step' }, `Шаг ${step} из 2`),
            h('span', { class: 'route-wizard-title' },
              step === 1 ? 'Кликните склад ЗАГРУЗКИ на карте' : 'Кликните склад РАЗГРУЗКИ на карте'
            )
          ),
          h('div', { class: 'route-wizard-desc' },
            step === 1
              ? 'Выберите ваше здание (шахта, завод, склад), откуда забирать продукцию'
              : `Загрузка: ${fromDef?.name ?? 'Склад'}${resDesc} ✅. Теперь кликните куда везти`
          ),
          resSelector,
          h('button', {
            class: 'hud-btn sm warn',
            title: 'Отменить выбор маршрута (Esc)',
            onClick: () => {
              routePicker = null;
              toast('Выбор маршрута отменен');
              render();
            }
          }, '✖ Отмена (Esc)')
        );
      } else if (isRouteActive) {
        const fromB = snap.buildings.find((b) => b.id === first.route?.fromBuilding);
        const toB = snap.buildings.find((b) => b.id === first.route?.toBuilding);
        const fromName = fromB ? (defB.get(fromB.def)?.name ?? 'Склад') : 'Склад';
        const toName = toB ? (defB.get(toB.def)?.name ?? 'Склад') : 'Склад';
        const resLabel = first.route?.resType === 'ore' ? ' (Руда)' :
                         first.route?.resType === 'metal' ? ' (Металл)' :
                         first.route?.resType === 'fuel' ? ' (Топливо)' :
                         first.route?.resType ? ` (${first.route.resType})` : '';

        routeControl = h('div', { class: 'route-active-box' },
          h('div', { style: { fontSize: '12px', color: '#38bdf8', fontWeight: 'bold' } },
            `🔁 Маршрут: ${fromName} ➔ ${toName}${resLabel}`
          ),
          h('button', {
            class: 'hud-btn sm warn',
            onClick: () => {
              send({ type: 'stop', units: [first.id] });
              toast('Маршрут доставки остановлен');
            }
          }, '🛑 Остановить маршрут')
        );
      } else {
        routeControl = h('button', {
          class: 'hud-btn',
          title: 'Настроить регулярный маршрут доставки между двумя складами',
          onClick: () => {
            routePicker = { unitId: first.id };
            toast('🚚 Режим маршрута: кликните склад ЗАГРУЗКИ на карте');
            render();
          }
        }, '🗺 Задать маршрут');
      }

      let cargoDetail = '';
      if (dFirst.fuelOnly) {
        cargoDetail = `Цистерна: ${Math.round(curCargo.fuel ?? 0)} / ${dFirst.cargoCap} л`;
      } else {
        const parts = Object.entries(curCargo).filter(([_, v]) => v > 0).map(([k, v]) => `${k}: ${Math.round(v)}`);
        cargoDetail = `Груз: ${Math.round(cargoSum)} / ${dFirst.cargoCap} (${parts.length ? parts.join(', ') : 'пусто'})`;
      }

      const passCount = first.cargo?.passengers?.length ?? 0;
      let passDetail = '';
      if (dFirst.passengerCap && dFirst.passengerCap > 0) {
        passDetail = ` | Десант: ${passCount} / ${dFirst.passengerCap}`;
      }

      let disembarkBtn: HTMLElement | null = null;
      if (passCount > 0) {
        disembarkBtn = h('button', {
          class: 'hud-btn sm',
          title: 'Высадить десант рядом с машиной',
          onClick: () => {
            send({ type: 'disembark', transport: first.id });
            toast(`Десант (${passCount}) высаживается`);
          }
        }, `🚪 Высадить (${passCount})`);
      }

      transportSec = h('div', { class: 'hud-sec', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        routeControl,
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '11px', color: '#cbd5e1' } }, cargoDetail + passDetail),
          disembarkBtn
        )
      );
    }

    // 7. Infantry boarding pickup or truck
    let boardSec: HTMLElement | null = null;
    const selInfantry = snap.units.filter(
      (u) => selUnits.has(u.id) && u.owner === me && u.def === 'infantry' && !u.embarkedIn
    );

    if (selInfantry.length > 0) {
      const refPos = curPos(selInfantry[0]);
      const transports = snap.units
        .filter((t) => {
          if (t.owner !== me) return false;
          const td = defU.get(t.def);
          if (!td || !td.passengerCap) return false;
          const curPass = t.cargo?.passengers?.length ?? 0;
          return curPass < td.passengerCap && distKm(refPos, curPos(t)) <= 10;
        })
        .map((t) => {
          const td = defU.get(t.def)!;
          const free = (td.passengerCap ?? 0) - (t.cargo?.passengers?.length ?? 0);
          const dist = distKm(refPos, curPos(t));
          return { t, td, free, dist };
        })
        .sort((a, b) => a.dist - b.dist);

      if (transports.length > 0) {
        const best = transports[0];
        const countToBoard = Math.min(selInfantry.length, best.free);
        const vehicleName = best.td.name;
        const curCount = best.t.cargo?.passengers?.length ?? 0;
        const maxCap = best.td.passengerCap ?? 0;

        boardSec = h('button', {
          class: 'hud-btn sm',
          title: `Посадить пехоту (${countToBoard}) в ${vehicleName} (свободно ${best.free}/${maxCap})`,
          onClick: () => {
            for (let i = 0; i < countToBoard; i++) {
              send({ type: 'board', unit: selInfantry[i].id, transport: best.t.id });
            }
            toast(`Пехота (${countToBoard}) садится в ${vehicleName}`);
          }
        }, `🚗 Сесть в ${vehicleName} (${curCount + countToBoard}/${maxCap})`);
      }
    }

    // 8. Artillery bombardment controls
    const artilleryUnits = selectedList.filter((u) => {
      const d = defU.get(u.def);
      return d?.symbol === 'artillery' || d?.minRange;
    });
    let artySec: HTMLElement | null = null;
    if (artilleryUnits.length > 0) {
      const isTargeting = artilleryUnits.some((u) => u.bombardTarget);
      const isPicking = bombardPicker !== null && bombardPicker.unitIds.some((id) => selUnits.has(id));
      const d = defU.get(artilleryUnits[0].def);
      const minR = d?.minRange ?? 4.0;
      const maxR = d?.range ?? 28.0;

      artySec = h('div', { class: 'hud-sec', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: { fontSize: '11px', color: '#f59e0b', fontWeight: 'bold' } },
          `🎯 Артиллерия: дальность ${minR}–${maxR} км`
        ),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          h('button', {
            class: 'hud-btn sm' + (isPicking ? ' active' : ''),
            title: 'Указать точку на карте для непрерывного артудара (мин 4 км, макс 28 км)',
            onClick: () => {
              if (isPicking) {
                bombardPicker = null;
                toast('Выбор цели отменен');
              } else {
                bombardPicker = { unitIds: artilleryUnits.map((u) => u.id) };
                toast('🎯 Кликните на карте место для артиллерийского удара (или ПКМ / Esc для отмены)');
              }
              render();
            }
          }, isPicking ? '❌ Отмена выбора' : '🎯 Задать сектор удара'),
          isTargeting ? h('button', {
            class: 'hud-btn sm warn',
            title: 'Прекратить огонь по сектору',
            onClick: () => {
              send({ type: 'bombard', units: artilleryUnits.map((u) => u.id), target: null });
              toast('Огонь по сектору прекращен');
            }
          }, '🛑 Прекратить огонь') : null
        )
      );
    }

    const elementsToAppend: Node[] = [titleEl, stopBtn, fireGroup];
    if (sprintBtn) elementsToAppend.push(sprintBtn);
    if (staminaMeter) elementsToAppend.push(staminaMeter);
    if (fuelSec) elementsToAppend.push(fuelSec);
    if (transportSec) elementsToAppend.push(transportSec);
    if (boardSec) elementsToAppend.push(boardSec);
    if (artySec) elementsToAppend.push(artySec);
    unitHud.append(...elementsToAppend);
  }

  function unitIcon(d: UnitDef, rank: number) {
    if (d.kind === 'air' && (d.id.startsWith('drone_') || d.id === 'drone')) {
      const mySide = init!.team === 0 ? 'ua' : 'ru';
      const droneDef = d.id === 'drone' ? (init!.team === 0 ? 'drone_pd2' : 'drone_orion') : d.id;
      return h('img', { class: 'nato-ico', src: `/drones/${droneDef}_${mySide}.png`, alt: d.name, title: d.name });
    }
    const c = h('canvas', { class: 'nato-ico', width: 128, height: 128 });
    c.getContext('2d')!.putImageData(drawNato({ hostile: false, color: TEAM_COLOR[init!.team], symbol: d.symbol ?? 'infantry', echelon: '', rank, selected: false, own: true }), 0, 0);
    return c;
  }

  // ---------- snapshot → view ----------
  let lastPalette = 0;
  function onSnapshot(s: SnapMsg) {
    snap = s;
    if (shown.length !== s.front.length) shown = s.front.map((n) => ({ ...n }));
    for (const u of s.units) {
      if (!unitPos.has(u.id)) unitPos.set(u.id, { lng: u.pos[0], lat: u.pos[1] });
    }
    pruneGroups();
    for (const id of selUnits) if (!s.units.some((u) => u.id === id)) selUnits.delete(id);
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
    renderUnitHud();
    renderGroups();
    renderRouteBanner();
    renderBuildingHighlights();
    if (mapReady) renderMap();
  }

  function renderBuildingHighlights() {
    if (!snap) return;
    for (const b of snap.buildings) {
      const m = bMarkers.get(b.id);
      if (!m) continue;
      m.el.classList.toggle('route-candidate', !!routePicker && b.owner === me && routePicker.fromBuilding !== b.id);
      m.el.classList.toggle('route-from', routePicker?.fromBuilding === b.id);
    }
  }

  function renderRouteBanner() {
    if (routePicker) {
      if (!routePicker.fromBuilding) {
        routeBanner.textContent = '🚚 ВЫБОР МАРШРУТА: [Шаг 1] Кликните склад ЗАГРУЗКИ на карте (Esc — отмена)';
      } else {
        const fromB = snap?.buildings.find((b) => b.id === routePicker!.fromBuilding);
        const fromName = fromB ? (defB.get(fromB.def)?.name ?? 'Склад') : 'Склад';
        const resLabel = routePicker.resType === 'ore' ? ' [Руда]' :
                         routePicker.resType === 'metal' ? ' [Металл]' :
                         routePicker.resType === 'fuel' ? ' [Топливо]' : '';
        routeBanner.textContent = `🚚 ВЫБОР МАРШРУТА: [Шаг 2] Загрузка: ${fromName}${resLabel} ➔ Кликните склад РАЗГРУЗКИ (Esc — отмена)`;
      }
      routeBanner.style.display = 'block';
    } else {
      routeBanner.style.display = 'none';
    }
  }

  /** Full refresh after a local change (selection, grouping). */
  function render() {
    renderSide();
    renderUnitHud();
    renderGroups();
    renderRouteBanner();
    renderBuildingHighlights();
    if (mapReady) renderMap();
  }

  const droneBearings = new Map<number, number>();
  const droneTurnVelocity = new Map<number, number>();

  function renderUnitsLayer() {
    if (!init || !snap || !mapReady) return;
    const myTeam = init.team;
    const grouped = new Map<number, number>();
    for (const g of groups.values()) for (const id of g.ids) grouped.set(id, g.id);

    (map.getSource('units') as GeoJSONSource)?.setData({
      type: 'FeatureCollection',
      features: snap.units.map((u) => {
        const d = defU.get(u.def);
        const own = u.owner === me;
        const sel = selUnits.has(u.id);
        const isAir = d?.kind === 'air';
        const pos = curPos(u);

        let icon: string;
        let bearing = 0;
        let scale = 1.0;

        if (isAir && (u.def.startsWith('drone_') || u.def === 'drone')) {
          const side = u.team === 0 ? 'ua' : 'ru';
          const droneDef = u.def === 'drone' ? (u.team === 0 ? 'drone_pd2' : 'drone_orion') : u.def;
          icon = `drone|${droneDef}|${side}|${sel ? 1 : 0}`;

          let targetBearing: number | null = null;
          if (u.bearing !== undefined) {
            targetBearing = u.bearing;
          } else {
            const targetPos = u.path?.[0] || u.target;
            if (targetPos) {
              const dx = (targetPos[0] - pos[0]) * Math.cos((pos[1] * Math.PI) / 180);
              const dy = targetPos[1] - pos[1];
              if (Math.abs(dx) + Math.abs(dy) > 1e-6) {
                targetBearing = (Math.atan2(dx, dy) * 180) / Math.PI;
              }
            }
          }

          if (targetBearing !== null) {
            let prev = droneBearings.get(u.id);
            if (prev === undefined) prev = targetBearing;
            let diff = (targetBearing - prev) % 360;
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;

            let vel = droneTurnVelocity.get(u.id) ?? 0;
            // Aerodynamic inertia spring-damper: smooth acceleration and deceleration into turns
            const spring = 0.08;
            const damping = 0.82;
            vel = vel * damping + diff * spring;
            const maxTurnVel = 2.8; // deg per frame (~168 deg/s realistic max turn speed)
            if (vel > maxTurnVel) vel = maxTurnVel;
            if (vel < -maxTurnVel) vel = -maxTurnVel;
            if (Math.abs(diff) < 0.2 && Math.abs(vel) < 0.04) {
              vel = 0;
              prev = targetBearing;
            }
            droneTurnVelocity.set(u.id, vel);
            const currentBearing = (prev + vel + 360) % 360;
            droneBearings.set(u.id, currentBearing);
            bearing = currentBearing;
          } else {
            bearing = droneBearings.get(u.id) ?? 0;
          }

          if (d?.droneType === 'strike' && (u.target || u.path?.[0])) {
            const diveTarget = (u.path && u.path.length > 0) ? u.path[u.path.length - 1] : u.target!;
            const dToTarget = distKm(pos, diveTarget);
            const diveDist = 18;
            if (dToTarget < diveDist) {
              scale = 0.45 + 0.55 * (dToTarget / diveDist);
            }
          }
        } else {
          icon = natoId({ hostile: u.team !== myTeam, color: TEAM_COLOR[u.team], symbol: d?.symbol ?? 'infantry', echelon: '', rank: u.rank, selected: sel, own });
        }

        return {
          type: 'Feature',
          properties: {
            id: u.id,
            own,
            grp: grouped.has(u.id),
            air: isAir,
            icon,
            bearing,
            scale,
            z: sel ? 4 : isAir ? 3 : own ? 2 : 1,
          },
          geometry: { type: 'Point', coordinates: pos },
        };
      }),
    });
  }

  function renderSelLines() {
    if (!init || !snap || !mapReady) return;
    const features: any[] = [];
    for (const u of snap.units) {
      if (!selUnits.has(u.id)) continue;
      const p = curPos(u);
      if (u.loiterCenter && u.loiterRadius) {
        features.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: makeCircleCoords(u.loiterCenter, u.loiterRadius) },
        });
      }
      if (u.bombardTarget) {
        features.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [p, u.bombardTarget] },
        });
        features.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: makeCircleCoords(u.bombardTarget, 1.0) },
        });
      }
      if (!u.target || u.isLoitering) continue;
      let coords: LngLat[];
      if (u.path && u.path.length > 0) {
        coords = [p, ...u.path];
      } else if (roads && defU.get(u.def)?.kind !== 'air') {
        const r = roads.route(p, u.target, init.ruleset.rules.roadSpeedMult);
        coords = r.length > 0 ? [p, ...r, u.target] : [p, u.target];
      } else {
        coords = [p, u.target];
      }
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords },
      });
      if (features.length >= 60) break;
    }
    (map.getSource('sel') as GeoJSONSource)?.setData({
      type: 'FeatureCollection',
      features,
    });
  }

  function renderMap() {
    if (!init || !snap) return;
    const myTeam = init.team;
    const grouped = new Map<number, number>();
    for (const g of groups.values()) for (const id of g.ids) grouped.set(id, g.id);

    renderUnitsLayer();
    renderSelLines();

    // one formation marker per group (shown when zoomed out)
    const formations: any[] = [];
    for (const g of groups.values()) {
      const us = snap.units.filter((u) => g.ids.has(u.id) && defU.get(u.def)?.kind !== 'air');
      const c = centroid(us);
      if (!c || !us.length) continue;
      const kinds = new Set(us.map((u) => defU.get(u.def)?.symbol ?? 'infantry'));
      const symbol = kinds.size === 1 ? [...kinds][0] : kinds.has('armor') && kinds.has('infantry') ? 'mechanized' : [...kinds].sort((a, b) => us.filter((u) => defU.get(u.def)?.symbol === b).length - us.filter((u) => defU.get(u.def)?.symbol === a).length)[0];
      const sel = us.every((u) => selUnits.has(u.id)) && selUnits.size === us.length;
      const rank = Math.round(us.reduce((a, u) => a + u.rank, 0) / us.length);
      formations.push({ type: 'Feature', properties: { gid: g.id, own: true, z: sel ? 3 : 2, icon: natoId({ hostile: false, color: TEAM_COLOR[myTeam], symbol, echelon: echelonFor(us.length), rank, selected: sel, own: true }) }, geometry: { type: 'Point', coordinates: c } });
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
        properties: { own, ids: own ? JSON.stringify(us.map((u) => u.id)) : '', z: sel ? 3 : own ? 2 : 1, icon: natoId({ hostile: us[0].team !== myTeam, color: TEAM_COLOR[us[0].team], symbol, echelon: us.length > 1 ? echelonFor(us.length) : '', rank: Math.round(us.reduce((a, u) => a + u.rank, 0) / us.length), selected: sel, own }) },
        geometry: { type: 'Point', coordinates: centroid(us) },
      });
    }
    (map.getSource('formations') as GeoJSONSource).setData({ type: 'FeatureCollection', features: formations });

    // vision rings for own long-range assets and artillery firing ranges
    const rings: any[] = [];
    for (const b of snap.buildings) {
      const d = defB.get(b.def)!;
      if (b.owner === me && b.progress >= 1 && (d.vision ?? 0) >= 20) rings.push({ type: 'Feature', properties: { color: TEAM_COLOR[b.team] }, geometry: { type: 'LineString', coordinates: circle(b.pos, d.vision!, 64) } });
    }
    for (const u of snap.units) {
      if (!selUnits.has(u.id)) continue;
      const d = defU.get(u.def);
      if (!d) continue;
      if (d.symbol === 'artillery' || d.minRange) {
        const pos = curPos(u);
        const maxR = d.range;
        const minR = d.minRange ?? 4.0;
        rings.push({
          type: 'Feature',
          properties: { color: '#f59e0b' },
          geometry: { type: 'LineString', coordinates: circle(pos, maxR, 64) },
        });
        rings.push({
          type: 'Feature',
          properties: { color: '#ef4444' },
          geometry: { type: 'LineString', coordinates: circle(pos, minR, 48) },
        });
      }
    }
    (map.getSource('rings') as GeoJSONSource).setData({ type: 'FeatureCollection', features: rings });

    // friendly fuel stations only (hide enemy fuel stations)
    if (init.map.fuel?.features && map.getSource('fuel-stations')) {
      const s = snap;
      const friendlyStations = init.map.fuel.features.filter((f: any) => {
        const coords = f.geometry.coordinates as LngLat;
        return sideOfWithPockets(s.front, s.pockets, coords) === myTeam;
      });
      (map.getSource('fuel-stations') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: friendlyStations,
      });
    }

    // persistent smokes
    if (map.getSource('smokes')) {
      const smokeFeatures = (snap.smokes ?? []).map((s) => {
        const rem = Math.max(0, s.expiresAt - snap!.time);
        const opacity = Math.max(0.18, Math.min(0.85, rem / 600));
        return {
          type: 'Feature',
          properties: { opacity },
          geometry: { type: 'Point', coordinates: s.pos },
        };
      });
      (map.getSource('smokes') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: smokeFeatures,
      });
    }

    // Recon drone circular orbits
    if (map.getSource('recon-orbits')) {
      const orbitFeatures: any[] = [];
      for (const u of snap.units) {
        if (u.team === myTeam && u.loiterCenter && u.loiterRadius) {
          orbitFeatures.push({
            type: 'Feature',
            properties: { id: u.id },
            geometry: {
              type: 'LineString',
              coordinates: makeCircleCoords(u.loiterCenter, u.loiterRadius),
            },
          });
        }
      }
      (map.getSource('recon-orbits') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: orbitFeatures,
      });
    }

    // Power lines along roads connecting power plants to buildings <= 100km (visible ONLY when a power plant is selected)
    if (map.getSource('power-lines')) {
      const selectedPowerPlant = selBuilding !== null ? snap.buildings.find((b) => b.id === selBuilding && b.owner === me && b.progress >= 1 && b.def === 'power_plant') : null;
      if (!selectedPowerPlant) {
        if (lastPowerLineKey !== 'none') {
          lastPowerLineKey = 'none';
          (map.getSource('power-lines') as GeoJSONSource).setData(empty());
        }
      } else {
        const pp = selectedPowerPlant;
        const pKey = `${pp.id}|` + snap.buildings.filter((b) => b.team === myTeam && b.progress >= 1).map((b) => `${b.id}:${b.pos[0].toFixed(3)},${b.pos[1].toFixed(3)}`).sort().join(';');
        if (pKey !== lastPowerLineKey) {
          lastPowerLineKey = pKey;
          const powerLineFeatures: any[] = [];
          const friendlyBuildings = snap.buildings.filter((b) => b.team === myTeam && b.progress >= 1 && b.def !== 'power_plant');
          for (const b of friendlyBuildings) {
            const d = distKm(pp.pos, b.pos);
            if (d <= 100) {
              let coords: LngLat[] = [];
              if (roads) {
                coords = roads.powerRoute(pp.pos, b.pos, 35);
              }
              if (coords.length >= 2) {
                powerLineFeatures.push({
                  type: 'Feature',
                  properties: { from: pp.id, to: b.id },
                  geometry: { type: 'LineString', coordinates: coords },
                });
              }
            }
          }
          (map.getSource('power-lines') as GeoJSONSource).setData({
            type: 'FeatureCollection',
            features: powerLineFeatures,
          });
        }
      }
    }

    // buildings → DOM markers with construction animation
    const alive = new Set<number>();
    for (const b of snap.buildings) {
      if (b.def === 'gas_station' && b.team !== myTeam) continue;
      alive.add(b.id);
      const d = defB.get(b.def)!;
      let m = bMarkers.get(b.id);
      if (!m) {
        const el = h('div', { class: `bm t${b.team}` });
        el.innerHTML = `<div class="blueprint"></div><svg class="ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" /></svg><div class="glyph"></div>`;
        el.querySelector('.glyph')!.textContent = d.icon;
        el.addEventListener('click', (ev) => {
          if (placing) return;
          if (routePicker) {
            ev.stopPropagation();
            if (b.owner !== me) {
              toast('Маршрут можно задавать только между вашими зданиями!', true);
              return;
            }
            if (!routePicker.fromBuilding) {
              routePicker.fromBuilding = b.id;
              toast(`Точка 1 (Загрузка): ${d.name}. Теперь кликните склад РАЗГРУЗКИ.`);
              render();
            } else if (routePicker.fromBuilding === b.id) {
              toast('Точка разгрузки не может совпадать с точкой загрузки! Выберите другое здание.', true);
            } else {
              const fromId = routePicker.fromBuilding;
              const unitId = routePicker.unitId;
              const fromB = snap ? snap.buildings.find((x) => x.id === fromId) : null;
              const fromName = fromB ? (defB.get(fromB.def)?.name ?? 'Склад') : 'Склад';
              send({ type: 'setRoute', unit: unitId, fromBuilding: fromId, toBuilding: b.id, resType: routePicker.resType });
              toast(`Маршрут настроен: ${fromName} ➔ ${d.name}! Машина отправляется.`);
              routePicker = null;
              render();
            }
            return;
          }
          if (b.owner !== me) return;
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
      m.el.classList.toggle('route-candidate', !!routePicker && b.owner === me && routePicker.fromBuilding !== b.id);
      m.el.classList.toggle('route-from', routePicker?.fromBuilding === b.id);
      m.el.style.setProperty('--p', String(b.progress));
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

    snap.points.forEach((p) => {
      const el = pMarkers.get(p.id);
      if (!el) return;
      el.style.setProperty('--c', TEAM_COLOR[p.owner]);
      if (p.hp !== undefined && p.maxHp !== undefined) {
        const hpBar = el.querySelector('.cp-hp') as HTMLElement | null;
        if (hpBar) {
          if (p.hp < p.maxHp) {
            hpBar.style.display = 'block';
            const fill = hpBar.querySelector('.cp-hp-fill') as HTMLElement | null;
            const ghost = hpBar.querySelector('.cp-hp-ghost') as HTMLElement | null;
            const pct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));
            if (fill) {
              fill.style.width = `${pct}%`;
              if (pct < 35) fill.style.background = '#ef4444';
              else if (pct < 70) fill.style.background = '#eab308';
              else fill.style.background = '#22c55e';
            }
            if (ghost) {
              ghost.style.width = `${pct}%`;
            }
          } else {
            hpBar.style.display = 'none';
          }
        }
        const nameSpan = el.querySelector('span');
        el.title = `${nameSpan?.textContent ?? p.id} · ${Math.round(p.hp)} / ${p.maxHp} HP`;
      }
    });
  }

  // ---------- animation loop (60 FPS interpolation between 5 Hz snapshots) ----------
  let frontDrawn = false;
  function animate() {
    if (closed) return;
    requestAnimationFrame(animate);
    if (!snap || !init || !mapReady) return;

    // 1. Frontline smooth lerp
    if (shown.length !== snap.front.length) shown = snap.front.map((n) => ({ ...n }));
    let frontMoved = false;
    shown.forEach((n, i) => {
      const t = snap!.front[i];
      const dx = t.lng - n.lng, dy = t.lat - n.lat;
      if (Math.abs(dx) + Math.abs(dy) > 1e-6 || n.v !== t.v) frontMoved = true;
      n.lng += dx * 0.28;
      n.lat += dy * 0.28;
      n.v = t.v;
    });
    if (frontMoved || !frontDrawn) {
      frontDrawn = true;
      const line: LngLat[] = shown.map((n) => [n.lng, n.lat]);
      (map.getSource('front') as GeoJSONSource)?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } } as any);
      const occupiedCoords = [
        [...line, ...init.map.occupiedClosure, line[0]],
        ...(init.map.occupiedHoles ?? [])
      ];
      (map.getSource('occupied') as GeoJSONSource)?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: occupiedCoords } } as any);
      if (snap.pockets && snap.pockets.length > 0) {
        (map.getSource('pockets') as GeoJSONSource)?.setData({
          type: 'FeatureCollection',
          features: snap.pockets.map((pkt) => ({
            type: 'Feature',
            properties: { team: pkt.team, color: pkt.team === 0 ? '#4fa3ff' : '#ff4d4d' },
            geometry: { type: 'Polygon', coordinates: [[...pkt.nodes.map((n) => [n.lng, n.lat]), [pkt.nodes[0].lng, pkt.nodes[0].lat]]] }
          }))
        } as any);
      } else {
        (map.getSource('pockets') as GeoJSONSource)?.setData(empty());
      }
      const maxV = init.ruleset.rules.frontMaxSpeed;
      (map.getSource('pressure') as GeoJSONSource)?.setData({
        type: 'FeatureCollection',
        features: shown.filter((n) => n.v !== 0).map((n) => ({ type: 'Feature', properties: { v: n.v, mag: Math.min(1, Math.abs(n.v) / (maxV * 0.4)) }, geometry: { type: 'Point', coordinates: [n.lng, n.lat] } })),
      });
    }

    // 2. Units smooth 60 FPS interpolation (eliminates 5 Hz stutter)
    let unitsMoved = false;
    const aliveUnits = new Set<number>();
    for (const u of snap.units) {
      aliveUnits.add(u.id);
      let p = unitPos.get(u.id);
      if (!p) {
        p = { lng: u.pos[0], lat: u.pos[1] };
        unitPos.set(u.id, p);
      }
      const dx = u.pos[0] - p.lng;
      const dy = u.pos[1] - p.lat;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > 0.05) {
        p.lng = u.pos[0];
        p.lat = u.pos[1];
        unitsMoved = true;
      } else if (dist2 > 1e-9) {
        p.lng += dx * 0.28;
        p.lat += dy * 0.28;
        unitsMoved = true;
      }
    }
    let dronesRotating = false;
    for (const vel of droneTurnVelocity.values()) {
      if (Math.abs(vel) > 0.03) {
        dronesRotating = true;
        break;
      }
    }
    for (const id of unitPos.keys()) {
      if (!aliveUnits.has(id)) unitPos.delete(id);
    }
    for (const id of droneBearings.keys()) {
      if (!aliveUnits.has(id)) {
        droneBearings.delete(id);
        droneTurnVelocity.delete(id);
      }
    }
    if (unitsMoved || dronesRotating) {
      renderUnitsLayer();
      if (selUnits.size > 0) renderSelLines();
    }
  }

  const ping = setInterval(() => (closed ? clearInterval(ping) : ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ping' } satisfies ClientMsg))), 15000);
}
