import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  DEBUFFS, DEPOSITS, depositsGeoJSON, distKm, distToFrontKm, forbiddenRings, formationSpot, inDeposit, inOccupied, inPolygon, isReconDrone, isStrikeDrone, kmPerDegLng, LIBERATED_CELL, offsetKm, pointInRing, proceduralTerrain, RoadIndex, SPECIAL_ZONES, specialZoneAt, TerrainGrid,
  type BuildingDef, type BuildingView, type ClientMsg, type MarkKind, type Command, type FrontNode, type InitMsg, type LngLat, type ResourceDeposit, type ServerMsg, type SnapMsg, type UnitDef, type UnitView,
} from '@sw/core';

import type { Session } from './api';
import { clear, h } from './dom';
import { ShotFx } from './fx';
import { iconHtml, STATUS, statusIconHtml } from './icons';
import { FogOverlay } from './fog';
import { renderUnitHud, type OrderStyle, type Pickers } from './unitHud';
import { ALLY_COLOR, drawNato, drawNatoImage, echelonFor, NATION_COLOR, natoLayers, type Relation } from './nato';
import { aircraftSprite } from './sprites';
import { cellsToMultiPolygon } from './contours';
import { statsView } from './stats';
import { openGuide } from './guide';
import { uiScale, uiScaleControl } from './uiScale';
import { langControl, tr } from './i18n';
import { ProductionDock, QueueList, type QueueContext } from './queue';

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
const HINT = 'Click: select (Shift: add) · Shift+drag: box · Right click: move (drag: face that way; Shift: waypoint, Alt: off-road) · P / Alt+click: ping · G: group · T: terrain · M: map';

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
  const pick: Pickers = { route: null, bombard: null, launch: null, fuel: null, launchFrom: null, rally: null };
  let garrisonPlan: { unitId: number; mode: 'advance' | 'retreat' } | null = null;
  let stored: UnitView[] = [];
  /** Attack-move or plain move, and the formation for group moves (set in the command panel, A / F). */
  const orders: OrderStyle = { attack: false, formation: 'spread' };
  /** A right press with units selected: where they go, and (once dragged) which way the formation faces. */
  let faceDrag: { to: LngLat; x: number; y: number; facing?: number } | null = null;
  let faceDone = 0;
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
  const idleHint = () => hint.textContent === HINT || hint.textContent === tr(HINT);
  // with messages off the standing help line is hidden too (placement hints still show)
  new MutationObserver(() => hint.classList.toggle('idle', quiet && idleHint())).observe(hint, { childList: true, characterData: true, subtree: true });
  const boxEl = h('div', { class: 'selbox' });
  const countEl = h('div', { class: 'countdown' });
  const terrainBtn = h('button', { class: 'ghost', onClick: () => toggleTerrain() }, 'Terrain');
  const basemapBtn = h('button', { class: 'ghost', title: 'Hide or show the real map underneath (M)', onClick: () => toggleBasemap() }, 'Map: ON');
  const unitHud = h('div', { class: 'unit-hud', style: { display: 'none' } });

  /** Generates authentic, varied OpenStreetMap architectural building footprints (L-shapes, U-shapes, stepped residential blocks). */
  function generateCityHousePolygons(pos: LngLat, seed: number): LngLat[][][] {
    const city = cityAt(pos);
    const poly = city ? cityPolys.get(city.id)?.[0] : null;
    const footprints: LngLat[][][] = [];

    let s = (seed * 9301 + 49297) % 233280;
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };

    const count = 14;
    const kmPerLat = 111.32;
    const kmPerLng = 111.32 * Math.cos((pos[1] * Math.PI) / 180);

    const nearbyRoads: { p: LngLat; ang: number }[] = [];
    if (init?.map.roads) {
      for (const line of init.map.roads) {
        for (let i = 1; i + 3 < line.length; i += 2) {
          const a: LngLat = [line[i], line[i + 1]];
          const b: LngLat = [line[i + 2], line[i + 3]];
          const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (distKm(pos, mid) <= 0.8) {
            const dx = (b[0] - a[0]) * kmPerLng;
            const dy = (b[1] - a[1]) * kmPerLat;
            nearbyRoads.push({ p: mid, ang: Math.atan2(dy, dx) });
          }
        }
      }
    }

    const baseAngle = nearbyRoads.length ? nearbyRoads[0].ang : rnd() * Math.PI;

    for (let i = 0; i < count; i++) {
      let cx: number;
      let cy: number;
      let angle = baseAngle;

      if (nearbyRoads.length && i < nearbyRoads.length * 2) {
        const seg = nearbyRoads[i % nearbyRoads.length];
        angle = seg.ang;
        const side = i % 2 === 0 ? 1 : -1;
        const setbackKm = 0.016 + rnd() * 0.010;
        const alongKm = ((Math.floor(i / 2) % 3) - 1) * 0.038 + (rnd() - 0.5) * 0.008;
        const offX = alongKm * Math.cos(angle) - side * setbackKm * Math.sin(angle);
        const offY = alongKm * Math.sin(angle) + side * setbackKm * Math.cos(angle);
        cx = seg.p[0] + offX / kmPerLng;
        cy = seg.p[1] + offY / kmPerLat;
      } else {
        const col = (i % 4) - 1.5;
        const row = Math.floor(i / 4) - 1.5;
        const bxKm = col * 0.052 + (rnd() - 0.5) * 0.012;
        const byKm = row * 0.042 + (rnd() - 0.5) * 0.012;
        const rxKm = bxKm * Math.cos(angle) - byKm * Math.sin(angle);
        const ryKm = bxKm * Math.sin(angle) + byKm * Math.cos(angle);
        cx = pos[0] + rxKm / kmPerLng;
        cy = pos[1] + ryKm / kmPerLat;
      }

      if (poly && !inPolygon([cx, cy], poly)) {
        cx = pos[0] + ((rnd() - 0.5) * 0.08) / kmPerLng;
        cy = pos[1] + ((rnd() - 0.5) * 0.08) / kmPerLat;
        if (poly && !inPolygon([cx, cy], poly)) continue;
      }

      const lenKm = (0.028 + rnd() * 0.024) * 1.5 * 1.3;
      const widKm = (0.014 + rnd() * 0.008) * 1.5 * 1.3;
      const hx = lenKm / 2;
      const hy = widKm / 2;
      const bType = Math.floor(rnd() * 4);

      let localPoly: [number, number][];
      if (bType === 0) {
        localPoly = [
          [-hx, -hy],
          [hx, -hy],
          [hx, hy * 0.25],
          [hx * 0.2, hy * 0.25],
          [hx * 0.2, hy * 2.1],
          [-hx, hy * 2.1],
          [-hx, -hy],
        ];
      } else if (bType === 1) {
        localPoly = [
          [-hx, -hy],
          [hx * 0.15, -hy],
          [hx * 0.15, -hy * 0.3],
          [hx, -hy * 0.3],
          [hx, hy],
          [-hx * 0.15, hy],
          [-hx * 0.15, hy * 0.3],
          [-hx, hy * 0.3],
          [-hx, -hy],
        ];
      } else if (bType === 2) {
        localPoly = [
          [-hx, -hy],
          [hx, -hy],
          [hx, hy * 1.5],
          [hx * 0.45, hy * 1.5],
          [hx * 0.45, hy * 0.15],
          [-hx * 0.45, hy * 0.15],
          [-hx * 0.45, hy * 1.5],
          [-hx, hy * 1.5],
          [-hx, -hy],
        ];
      } else {
        localPoly = [
          [-hx, -hy],
          [hx, -hy],
          [hx, hy],
          [hx * 0.25, hy],
          [hx * 0.25, hy * 1.35],
          [-hx * 0.25, hy * 1.35],
          [-hx * 0.25, hy],
          [-hx, hy],
          [-hx, -hy],
        ];
      }

      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const ringCoords: LngLat[] = localPoly.map(([lx, ly]) => {
        const rx = lx * cosA - ly * sinA;
        const ry = lx * sinA + ly * cosA;
        return [cx + rx / kmPerLng, cy + ry / kmPerLat];
      });

      footprints.push([ringCoords]);
    }

    return footprints;
  }

  // ---------- map marks (pings) for the team ----------

  const MARKS: Record<MarkKind, { label: string; icon: string; tone: number }> = {
    go: { label: 'Going here', icon: '➤', tone: 660 },
    defend: { label: 'Defend here', icon: '⛨', tone: 520 },
    danger: { label: 'Danger here', icon: '⚠', tone: 330 },
    look: { label: 'Look here', icon: '◉', tone: 880 },
  };
  /** The mark the next map click places (chosen from the menu). */
  let marking: MarkKind | null = null;
  const markMenu = h('div', { class: 'mark-menu', style: { display: 'none' } },
    ...(Object.keys(MARKS) as MarkKind[]).map((k, i) => h('button', { class: `mk mk-${k}`, title: `${MARKS[k].label} (${i + 1})`, onClick: () => chooseMark(k) }, h('i', {}, MARKS[k].icon), h('span', {}, MARKS[k].label), h('em', {}, String(i + 1)))));
  /** Messages on or off (remembered): off hides the info messages and team ping messages; refused orders still show. */
  let quiet = (() => { try { return localStorage.getItem('mto.msgs') === 'off'; } catch { return false; } })();
  const msgBtn = h('button', { class: 'ghost', title: 'Show or hide the messages on the right (errors still show)', onClick: () => {
    quiet = !quiet;
    try { localStorage.setItem('mto.msgs', quiet ? 'off' : 'on'); } catch { /* private mode */ }
    msgBtn.textContent = `Msgs: ${quiet ? 'OFF' : 'ON'}`;
    if (quiet) toasts.querySelectorAll('.toast:not(.bad)').forEach((t) => t.remove());
    hint.classList.toggle('idle', quiet && idleHint());
  } }, `Msgs: ${quiet ? 'OFF' : 'ON'}`);
  const markBtn = h('button', { class: 'ghost', title: 'Mark a spot for your team (P). Alt+click on the map: quick "look here".', onClick: () => toggleMarkMenu() }, 'Ping (P)');
  function toggleMarkMenu(open = markMenu.style.display === 'none') {
    markMenu.style.display = open ? 'flex' : 'none';
    if (!open) marking = null;
    markBtn.classList.toggle('on', open);
  }
  function chooseMark(k: MarkKind) {
    marking = k;
    markMenu.querySelectorAll('.mk').forEach((b) => b.classList.toggle('active', b.classList.contains(`mk-${k}`)));
    hint.textContent = `${MARKS[k].label}: click the map (Esc cancels)`;
    mapEl.classList.add('picking');
  }
  function sendMark(kind: MarkKind, pos: LngLat) {
    ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'mark', kind, pos } satisfies ClientMsg));
    marking = null;
    toggleMarkMenu(false);
    hint.textContent = HINT;
    mapEl.classList.remove('picking');
  }
  let audio: AudioContext | null = null;
  function beep(freq: number) {
    try {
      audio ??= new AudioContext();
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.08, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
      o.connect(g).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + 0.36);
    } catch { /* no sound available */ }
  }
  /** A teammate's (or your own) mark: pulsing marker with a label for 8 s, a short tone, and a message that flies there. */
  function showMark(m: { from: string; name: string; pos: LngLat; kind: MarkKind }) {
    if (!mapReady) return;
    const def = MARKS[m.kind];
    const who = m.from === me ? 'You' : m.name;
    const el = h('div', { class: `map-mark mk-${m.kind}` }, h('b', {}, def.icon), h('span', {}, `${who}: ${def.label}`), h('i', {}), h('i', { class: 'r2' }));
    const marker = new maplibregl.Marker({ element: el }).setLngLat(m.pos).addTo(map);
    setTimeout(() => el.classList.add('gone'), 7400);
    setTimeout(() => marker.remove(), 8000);
    beep(def.tone);
    if (m.from !== me && !quiet) {
      const t = h('div', { class: `toast mark-toast mk-${m.kind}`, title: 'Click to look' }, `${def.icon} ${who}: ${def.label}`);
      t.addEventListener('click', () => map.easeTo({ center: m.pos, zoom: Math.max(map.getZoom(), 7.5) }));
      toasts.append(t);
      setTimeout(() => t.remove(), 6000);
    }
  }
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
  // ---------- training queue: per-building list in the side panel, and a production strip over the map ----------
  const cancelled = new Set<number>();
  const queueCtx: QueueContext = {
    me,
    get defU() { return defU; },
    playerName: (id) => init?.players.find((p) => p.id === id)?.name ?? 'a teammate',
    icon: (d) => unitIcon(d, 0),
    cancel: (item) => (cancelled.add(item), send({ type: 'cancelTrain', item })),
  };
  const dock = new ProductionDock(queueCtx, (id) => {
    const b = snap?.buildings.find((x) => x.id === id);
    if (!b) return;
    selBuilding = id;
    selUnits.clear();
    if (mapReady) map.easeTo({ center: b.pos, zoom: Math.max(map.getZoom(), 7.5) });
    render();
  });
  let sideQueue: { list: QueueList; building: number } | null = null;
  /** The queue panel sits to the left of the building's description window. */
  const queueSlot = h('div', { class: 'queue-slot' });
  /** Buffs and debuffs of the selected units, beside the description window. */
  const effectsSlot = h('div', { class: 'effects-slot' });
  /** Orders seen in the last snapshot, to announce units as they are ready. */
  let lastQueue = new Map<number, SnapMsg['queue'][number]>();
  function updateQueues(s: SnapMsg) {
    dock.update(s.queue);
    if (sideQueue && selBuilding !== sideQueue.building) (sideQueue = null), queueSlot.replaceChildren();
    if (sideQueue) sideQueue.list.update(s.queue.filter((q) => q.building === sideQueue!.building));
    const now = new Set(s.queue.map((q) => q.id));
    for (const [id, q] of lastQueue) {
      if (now.has(id) || cancelled.has(id) || q.owner !== me || q.remaining > 3) continue;
      const b = s.buildings.find((x) => x.id === q.building);
      if (b) toast(`${defU.get(q.unit)?.name ?? q.unit} ready at ${defB.get(b.def)?.name ?? 'base'}`);
    }
    lastQueue = new Map(s.queue.map((q) => [q.id, q]));
  }

  let topBar!: HTMLElement;
  app.append(
    h('div', { class: 'game' }, mapEl, dock.el, queueSlot, effectsSlot,
      topBar = h('div', { class: 'hud top' }, resBar, modeBadge, scoreBar, langControl('ghost'), uiScaleControl('ghost'), h('button', { class: 'ghost', title: 'Guidebook (H)', onClick: () => showGuide() }, 'Guide'), msgBtn, markBtn, shareBtn, terrainBtn, basemapBtn, h('button', { class: 'ghost', onClick: leave }, 'Leave')),
      palette, side, groupBar, terrainChip, toasts, hint, boxEl, countEl, unitHud, routeBanner, peaceBanner, markMenu),
  );

  // the side panels start below the top bar, however many rows it wraps into (resources, UI size, language)
  const fitTop = () => topBar.parentElement?.style.setProperty('--top', `${Math.ceil(topBar.offsetHeight) + 6}px`);
  new ResizeObserver(fitTop).observe(topBar);
  fitTop();

  const send = (cmd: Command) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'cmd', cmd } satisfies ClientMsg));
  const toast = (text: string, bad = false) => {
    if (quiet && !bad) return;
    const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, text);
    toasts.append(el);
    setTimeout(() => el.remove(), 4200);
  };

  /** Your own units in your nation's colour (Ukraine blue, Russia red), allies green, the enemy in theirs. */
  const relColor = (rel: Relation): string => (rel === 'ally' ? ALLY_COLOR : NATION_COLOR[rel === 'own' ? init?.team ?? 0 : 1 - (init?.team ?? 0)]);
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
  const postMarkers = new Map<number, { el: HTMLElement; marker: maplibregl.Marker }>();
  /** Enemy buildings seen before, kept where they were last seen (see rememberBuildings). */
  const lastKnown = new Map<number, { b: BuildingView; at: number }>();
  let staleBuildings: { b: BuildingView; at: number }[] = [];
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
    if (d.line) f.push(`Drawn by dragging on the map: ${d.line.minKm}–${d.line.maxKm} km; cost and digging time per km`);
    if (d.supply) f.push(`Refills ammunition of your units within ${d.supply.radiusKm} km (${d.supply.rounds} rounds a second each)`);
    if (d.heals) f.push(`Heals ${d.heals.targets === 'foot' ? 'troops on foot' : 'vehicles'} within ${d.heals.radiusKm} km: ${Math.round(d.heals.perSecond * 100)}% a second, once out of the fight for 10 s`);
    if (d.buildInGrey) f.push('Can be built inside your grey zones, even behind the enemy line');
    if (d.training) f.push(`Courses for ${d.training.minUnits}–${d.training.capacity} units, ${d.training.baseTime + d.training.timePerRank}s and up`);
    if (d.trains?.length) f.push(`Trains ${d.trains.filter((u) => !defU.get(u)?.side || defU.get(u)?.side === (init?.team === 0 ? 'ua' : 'ru')).map((u) => defU.get(u)?.name ?? u).join(', ')}`);
    if (d.storageCap) f.push(`Store ${d.storageCap.toLocaleString('en-US')}`);
    const partners = init ? init.ruleset.buildings.filter((o) => chained(d, o)).map((o) => o.name) : [];
    if (partners.length) f.push(`Keep ${init?.ruleset.rules.minBuildSpacing ?? 17.5} km from: ${partners.join(', ')}`);
    if (d.sameKindKm) f.push(`Keep ${d.sameKindKm} km from another ${d.name}`);
    if (d.category === 'civil' && !d.line && d.id !== 'housing') f.push(`Keep ${init?.ruleset.rules.civilSpacing ?? 5} km from other civil sites`);
    if (d.vision) f.push(`Sees ${d.vision} km`);
    if (d.maxPerPlayer) f.push(`Limit ${d.maxPerPlayer} per player`);
    return f;
  }
  const REFINERY_SVG = `<svg class="bld-refinery-ico" viewBox="0 0 24 24" fill="currentColor"><path d="M2 20h20v1.5H2z"/><path d="M4 8h3v11H4z"/><path d="M5 4.5h1v3.5H5z"/><path d="M8.5 6h4v13h-4z"/><path d="M9.5 3.5h2v2.5h-2z"/><path d="M7 10h1.5v1.5H7z"/><path d="M7 14h1.5v1.5H7z"/><path d="M12.5 11h2v1.5h-2z"/><path d="M14.5 9.5h6v9.5h-6z"/><path d="M15 9c0-.9 1.1-1.6 2.5-1.6s2.5.7 2.5 1.6z"/><path d="M17.5 4.5l2-1v4h-2z"/></svg>`;

  function unitFacts(u: UnitDef): string[] {
    const air = u.airDamage ?? init?.ruleset.rules.airDamageDefault ?? 0.25;
    const extra: string[] = [];
    if (u.squadSize && u.id !== 'infantry') extra.push(`Отряд: ${u.squadSize} бойцов`);
    if (u.cannotCrossFront && u.id !== 'infantry') extra.push('Перемещение только по своей территории (без пересечения фронта и границ)');
    if (u.minRange) extra.push(`Indirect fire ${u.minRange}–${u.range} km, needs a spotter`);
    if (u.cargoCap) extra.push(`${u.fuelOnly ? 'Fuel tank' : 'Cargo'} ${u.cargoCap}${u.passengerCap ? ` · carries ${u.passengerCap} infantry` : ''}`);
    if (u.maxAmmo) extra.push(`Ammo ${u.maxAmmo} rounds, ${u.ammoPerShot ?? 1} per shot (${Math.floor(u.maxAmmo / (u.ammoPerShot ?? 1))} shots); refill costs ${u.ammoCost ?? 1} ammo a round; cannot fire with fewer than ${u.ammoPerShot ?? 1} left`);
    else if (u.damage > 0 && u.kind === 'ground' && u.id !== 'infantry') extra.push('No ammunition needed');
    if (u.maxFuel) extra.push(`Fuel tank ${u.maxFuel}${u.droneType === 'strike' ? ' (one way)' : ''}`);
    if (u.missile) extra.push(`${u.missile === 'ballistic' ? 'Ballistic' : 'Cruise'} missile: about ${Math.round((u.maxFuel ?? 0) / 0.08).toLocaleString('en-US')} km range, ${Math.round((u.interceptChance ?? 1) * 100)}% of anti-air shots hit it`);
    if (u.droneType) extra.push(u.droneType === 'strike' ? `Explodes on its target (${u.damage} damage, ${u.blastKm ?? 1.8} km blast)` : 'Circles its area, refuels at an airfield');
    if (u.launchable) extra.push("Small: rides on a pickup's launcher");
    if (u.heals) extra.push(`Heals ${u.heals.targets === 'foot' ? 'troops on foot' : 'vehicles'} within ${u.heals.radiusKm} km: ${Math.round(u.heals.perSecond * 100)}% a second, once out of the fight for 10 s`);
    if (u.droneCap) extra.push(`Launcher for ${u.droneCap} small drones`);
    if (u.side) extra.push(`${u.side === 'ua' ? 'Ukraine' : 'Russia'} only`);
    const f: string[] = [
      ...extra,
      `${u.hp} HP · ${u.damage} dmg/s · range ${u.range} km`,
    ];
    if (u.id !== 'infantry' && u.id !== 'frontline_infantry') {
      const roadMult = u.roadSpeedMult ?? init?.ruleset.rules.roadSpeedMult ?? 1;
      const bonusPct = Math.round((roadMult - 1) * 100);
      const speedKmH = Math.round(u.speed * 3600);
      f.push(`Скорость: ${speedKmH} км/ч (${(u.speed * 60).toFixed(1)} км/мин)${u.kind === 'air' ? ' (по воздуху)' : ` · ${u.mobility ?? 'пешком'}, +${bonusPct}% по дорогам`}`);
    }
    f.push(`Обзор: ${u.vision} км · ${air ? `${Math.round(air * 100)}% по авиации` : 'без урона по авиации'}`);
    if (u.trainTime) f.push(`Подготовка: ${u.trainTime}с`);
    return f;
  }
  /** Supply-chain partners that must be built far apart (mirrors the server rule). */
  const chained = (a: BuildingDef, b: BuildingDef) => !!a.spacedFrom?.includes(b.id) || !!b.spacedFrom?.includes(a.id);
  const spacingBetween = (d: BuildingDef, other: string, inZone: boolean) => {
    const r = init!.ruleset.rules;
    const o = defB.get(other);
    if (o && !inZone) {
      if ((d.id === 'steel_mill' && o.id === 'mine') || (d.id === 'mine' && o.id === 'steel_mill')) return 50;
      if ((d.id === 'ammo_factory' && o.id === 'steel_mill') || (d.id === 'steel_mill' && o.id === 'ammo_factory')) return 50;
    }
    if (o && chained(d, o) && !inZone) return r.minBuildSpacing || 50;
    if (o && o.id === d.id && d.sameKindKm && !inZone) return d.sameKindKm;
    if (o && !inZone && d.category === 'civil' && o.category === 'civil' && !d.line && !o.line && d.id !== 'housing' && o.id !== 'housing') return r.civilSpacing;
    return r.fieldWorkSpacing;
  };
  /** Which side holds the ground (same rule as the server: the painted occupied area, cauldrons first). */
  function sideAt(p: LngLat): 0 | 1 {
    const pocket = snap!.pockets.find((k) => pointInRing(k.nodes, p));
    if (pocket) return pocket.team;
    if (init!.map.occupiedHoles?.some((h) => inPolygon(p, h))) return distToFrontKm(snap!.front, p) >= 0 ? 0 : 1;
    return inOccupied(snap!.front, init!.map.occupiedClosure, p) ? 1 : 0;
  }

  let forbidden: LngLat[][] = [];
  let matchDeposits: ResourceDeposit[] | undefined;
  function foreignAt(p: LngLat): boolean {
    return forbidden.some((r) => inPolygon(p, r));
  }

  function nearForeignAt(p: LngLat, marginKm = 15): boolean {
    if (foreignAt(p)) return true;
    if (!forbidden.length) return false;
    const kx = kmPerDegLng(p[1]);
    const dLng = marginKm / kx;
    const dLat = marginKm / 111.32;
    for (const ring of forbidden) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i];
        const c = ring[i + 1];
        const minX = Math.min(a[0], c[0]) - dLng;
        const maxX = Math.max(a[0], c[0]) + dLng;
        const minY = Math.min(a[1], c[1]) - dLat;
        const maxY = Math.max(a[1], c[1]) + dLat;
        if (p[0] < minX || p[0] > maxX || p[1] < minY || p[1] > maxY) continue;
        const acX = (c[0] - a[0]) * kx;
        const acY = (c[1] - a[1]) * 111.32;
        const apX = (p[0] - a[0]) * kx;
        const apY = (p[1] - a[1]) * 111.32;
        const lenSq = acX * acX + acY * acY;
        let t = lenSq > 0 ? (apX * acX + apY * acY) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const projX = a[0] + (c[0] - a[0]) * t;
        const projY = a[1] + (c[1] - a[1]) * t;
        if (distKm(p, [projX, projY]) <= marginKm) return true;
      }
    }
    return false;
  }

  const fullWest = 20.5;
  const fullEast = 54.5;
  const fullSouth = 43.0;
  const fullNorth = 61.5;
  const mercY = (lat: number) => Math.asinh(Math.tan((lat * Math.PI) / 180));
  const fullYN = mercY(fullNorth);
  const fullYS = mercY(fullSouth);


  /** Show a description card beside `el` while the pointer is over it. */
  function describe(el: HTMLElement, title: string, text: string | undefined, facts: string[], side: 'right' | 'left') {
    el.addEventListener('mouseenter', () => {
      clear(card);
      card.append(h('b', {}, title), h('p', {}, text ?? ''), ...facts.map((f) => h('div', { class: 'fact' }, f)));
      const r = el.getBoundingClientRect();
      card.style.display = 'block';
      // the card is zoomed with the interface: its left/top are in zoomed pixels
      const z = uiScale();
      const top = Math.max(8, Math.min(window.innerHeight - card.offsetHeight * z - 8, r.top));
      const left = side === 'right' ? r.right + 10 : r.left - card.offsetWidth * z - 10;
      card.style.top = `${top / z}px`;
      card.style.left = `${left / z}px`;
    });
    el.addEventListener('mouseleave', () => (card.style.display = 'none'));
  }

  // ---------- network ----------
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMsg;
    switch (msg.t) {
      case 'init':
        init = msg;
        matchDeposits = msg.map.deposits;
        defB = new Map(msg.ruleset.buildings.map((b) => [b.id, b]));
        defU = new Map(msg.ruleset.units.map((u) => [u.id, u]));
        const barriers: Record<string, number> = {};
        for (const t of msg.ruleset.terrain) if (t.barrier) barriers[t.id] = t.barrier.minCells;
        terrain = msg.map.terrain ? new TerrainGrid(msg.map.terrain, barriers) : null;
        roads = msg.map.roads?.length ? new RoadIndex(msg.map.roads) : null;
        cityPolys.clear();
        for (const f of msg.map.cities?.features ?? []) {
          if (f.properties?.type && f.properties.type !== 'city-boundary-fill') continue;
          const id = f.properties?.cityId ?? f.properties?.id;
          const rings: LngLat[][] = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.map((x: any) => x[0]) : [];
          if (id) for (const r of rings) if (r?.length >= 3) cityPolys.set(id, [...(cityPolys.get(id) ?? []), r]);
        }
        forbidden = forbiddenRings(msg.map);
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
        // a refused delivery route comes back to the panel to be fixed, stops and all
        if (pick.sentRoute && Date.now() - pick.sentRoute.at < 3000) (pick.route = pick.sentRoute.route), (pick.sentRoute = null), render();
        break;
      case 'mark':
        showMark(msg);
        break;
      case 'powerLines':
        if (mapReady && msg.building === selBuilding) {
          (map.getSource('power-lines') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: msg.lines.map((l) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: l } })) } as any);
        }
        break;
      case 'end': {
        finished = true;
        const mine = init?.team === msg.winner;
        // the full statistics of the match (also saved to the profile database)
        app.append(
          h('div', { class: 'overlay' },
            h('div', { class: 'card stats-card' },
              msg.report ? statsView(msg.report, me) : h('div', {}, h('h2', {}, msg.winner === null ? 'DRAW' : mine ? 'VICTORY' : 'DEFEAT'), h('p', { class: 'muted' }, msg.reason)),
              h('div', { class: 'row' }, h('button', { class: 'primary', onClick: leave }, 'Back to lobby')),
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
    // images being made right now: the style keeps asking for a missing image every frame, so never start one twice
    const pendingImages = new Set<string>();
    map.on('styleimagemissing', (e) => {
      if (map.hasImage(e.id) || pendingImages.has(e.id)) return;
      const marker = drawNatoImage(e.id);
      if (marker) return void map.addImage(e.id, marker, { pixelRatio: 2 });
      // aircraft sprites tinted by relation, and strike smoke
      if (e.id.startsWith('drone|')) {
        const [, def, rel, sel] = e.id.split('|');
        pendingImages.add(e.id);
        void aircraftSprite(def, relColor((['own', 'ally', 'enemy'].includes(rel) ? rel : 'enemy') as Relation), sel === '1').then((c) => {
          if (!map.hasImage(e.id)) map.addImage(e.id, c.getContext('2d')!.getImageData(0, 0, c.width, c.height), { pixelRatio: 1 });
          pendingImages.delete(e.id);
        });
        return;
      }
      if (e.id !== 'smoke') return;
      pendingImages.add(e.id);
      const img = new Image();
      img.onload = () => (!map.hasImage(e.id) && map.addImage(e.id, img, { pixelRatio: 2 }), pendingImages.delete(e.id));
      img.src = '/drones/smoke.png';
    });

    map.on('load', () => {
      for (const id of ['borders', 'cities', 'occupied', 'front', 'pockets', 'units', 'formations', 'sel', 'rings', 'ghost', 'roads', 'smokes', 'zones', 'restricted', 'power-lines', 'orbits', 'fuel-stations', 'liberated', 'freed', 'freed-new', 'drone-units', 'trenches', 'facing']) map.addSource(id, { type: 'geojson', data: empty() });

      map.addSource('deposits-iron', { type: 'geojson', data: depositsGeoJSON('iron', init?.team, matchDeposits) });
      map.addSource('deposits-oil', { type: 'geojson', data: depositsGeoJSON('oil', init?.team, matchDeposits) });
      map.addSource('housing-osm', { type: 'geojson', data: empty() });

      if (terrain) {
        map.addSource('terrain', { type: 'image', url: terrainImage(), coordinates: [[fullWest, fullNorth], [fullEast, fullNorth], [fullEast, fullSouth], [fullWest, fullSouth]] });
        map.addLayer({ id: 'terrain', type: 'raster', source: 'terrain', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.72, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } });
      }

      map.addLayer({
        id: 'deposits-iron-fill',
        type: 'fill',
        source: 'deposits-iron',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#78350f',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.22, 7, 0.35, 11, 0.45],
        },
      });
      map.addLayer({
        id: 'deposits-oil-fill',
        type: 'fill',
        source: 'deposits-oil',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#0f172a',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.20, 7, 0.30, 11, 0.38],
        },
      });

      map.addLayer({ id: 'housing-osm-fill', type: 'fill', source: 'housing-osm', paint: { 'fill-color': '#94a3b8', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 8, 0.75, 12, 0.9] } });
      map.addLayer({ id: 'housing-osm-line', type: 'line', source: 'housing-osm', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#e2e8f0', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 9, 1.2, 12, 1.8], 'line-opacity': 0.95 } });

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
        paint: { 'line-color': '#9a8a56', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 8.5, 0.6], 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.7, 8.5, 1.15, 11, 1.8] },
      });
      map.addLayer({
        id: 'roads', type: 'line', source: 'roads', filter: ['==', ['get', 'major'], 1],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#f0cb5e', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 4.5, 0.48, 8, 0.75], 'line-width': ['interpolate', ['linear'], ['zoom'], 4.5, 0.95, 8, 2, 11, 3.2] },
      });
      // state borders
      if (m.borders) (map.getSource('borders') as GeoJSONSource).setData(m.borders);
      map.addLayer({ id: 'borders-line', type: 'line', source: 'borders', filter: ['==', ['get', 'type'], 'border'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#8ab5de', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 8, 1.8, 12, 2.6], 'line-dasharray': [4, 3], 'line-opacity': 0.75 } });
      for (const f of m.borders?.features ?? []) {
        if (f.properties?.type !== 'country_label') continue;
        new maplibregl.Marker({ element: h('div', { class: 'country-label' }, f.properties.name) }).setLngLat(f.geometry.coordinates).addTo(map);
      }
      // front: flat occupied tint, a hard-edged contact zone, and a crisp cased line with sharp corners (no blur, no rounding)
      map.addLayer({ id: 'occupied-fill', type: 'fill', source: 'occupied', paint: { 'fill-color': '#e5383b', 'fill-opacity': 0.12, 'fill-antialias': false } });
      map.addLayer({ id: 'front-zone', type: 'line', source: 'front', layout: { 'line-join': 'miter', 'line-miter-limit': 4 }, paint: { 'line-color': '#e5383b', 'line-opacity': 0.2, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 5, 5, 8, 16, 11, 70] } });
      map.addLayer({ id: 'front-case', type: 'line', source: 'front', layout: { 'line-join': 'miter', 'line-miter-limit': 4 }, paint: { 'line-color': '#12060a', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3.4, 10, 6] } });
      map.addLayer({ id: 'front-line', type: 'line', source: 'front', layout: { 'line-join': 'miter', 'line-miter-limit': 4 }, paint: { 'line-color': '#ff4d57', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.7, 10, 3] } });
      // DeepState-style areas: grey = penetration area (contested: troops beyond their line, ground just taken),
      // blue = liberated by Ukraine, bright blue = liberated in the last few minutes
      map.addLayer({ id: 'freed-fill', type: 'fill', source: 'freed', paint: { 'fill-color': '#2f7bff', 'fill-opacity': 0.22 } }, 'front-zone');
      map.addLayer({ id: 'freed-line', type: 'line', source: 'freed', paint: { 'line-color': '#4f8fff', 'line-width': 1, 'line-opacity': 0.8 } }, 'front-zone');
      map.addLayer({ id: 'freed-new-fill', type: 'fill', source: 'freed-new', paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.38 } }, 'front-zone');
      map.addLayer({ id: 'freed-new-line', type: 'line', source: 'freed-new', paint: { 'line-color': '#7dd3fc', 'line-width': 1.2, 'line-opacity': 0.9 } }, 'front-zone');
      map.addLayer({ id: 'liberated-fill', type: 'fill', source: 'liberated', paint: { 'fill-color': '#8c929b', 'fill-opacity': 0.62 } }, 'front-zone');
      map.addLayer({ id: 'liberated-line', type: 'line', source: 'liberated', paint: { 'line-color': '#c9ced6', 'line-width': 1, 'line-opacity': 0.75 } }, 'front-zone');
      // trench lines: a zig-zag in the side's colour on a dark casing (faded while being dug)
      // bridges: a wide light deck on a dark casing
      const isBridge: any = ['==', ['get', 'kind'], 'bridge'];
      map.addLayer({ id: 'trench-case', type: 'line', source: 'trenches', layout: { 'line-join': 'miter' }, paint: { 'line-color': '#0b0d10', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, ['case', isBridge, 4.5, 2.5], 10, ['case', isBridge, 9, 5]], 'line-opacity': ['get', 'o'] } });
      map.addLayer({ id: 'trench-line', type: 'line', source: 'trenches', filter: ['!=', ['get', 'kind'], 'rail'], layout: { 'line-join': 'miter' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 6, ['case', isBridge, 2.5, 1.2], 10, ['case', isBridge, 5.5, 2.4]], 'line-opacity': ['get', 'o'] } });
      // railway: the classic dark line with white ties
      map.addLayer({ id: 'rail-ties', type: 'line', source: 'trenches', filter: ['==', ['get', 'kind'], 'rail'], paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 10, 2.4], 'line-dasharray': [2, 2], 'line-opacity': ['get', 'o'] } });
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
      map.addLayer({ id: 'rings', type: 'line', source: 'rings', paint: { 'line-color': ['get', 'color'], 'line-width': ['coalesce', ['get', 'w'], 1], 'line-opacity': ['coalesce', ['get', 'o'], 0.4], 'line-dasharray': [2, 3] } });
      // the selected building's ranges, filled lightly so its reach is easy to read
      map.addLayer({ id: 'rings-sel', type: 'fill', source: 'rings', filter: ['==', ['get', 'sel'], true], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.06 } }, 'rings');
      map.addLayer({ id: 'ghost-fill', type: 'fill', source: 'ghost', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'ghost-line', type: 'line', source: 'ghost', paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [3, 2] } });
      // where the selected units are going: a soft solid blue line on a faint casing
      map.addLayer({ id: 'sel-case', type: 'line', source: 'sel', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0b1220', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3.2, 10, 5.2], 'line-opacity': 0.35 } });
      map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#5aa9ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.5, 10, 2.6], 'line-opacity': 0.75, 'line-blur': 0.4 } });
      // right-drag preview: the arrow shows where the front will face, the dots where each unit will stand
      map.addLayer({ id: 'facing-line', type: 'line', source: 'facing', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#5aa9ff', 'line-width': 2.2, 'line-opacity': 0.9 } });
      map.addLayer({ id: 'facing-pts', type: 'circle', source: 'facing', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': 'rgba(90,169,255,0.25)', 'circle-stroke-color': '#5aa9ff', 'circle-stroke-width': 1.5 } });
      map.addLayer({ id: 'sel-pts', type: 'circle', source: 'sel', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#0b1220', 'circle-stroke-color': '#5aa9ff', 'circle-stroke-width': 1.6, 'circle-opacity': 0.8, 'circle-stroke-opacity': 0.85 } });

      const iconSize: any = ['interpolate', ['linear'], ['zoom'], 5, 0.4, 8, 0.58, 11, 0.85];
      // a marker = base image + overlays (rank, pips, echelon, cauldron ring) drawn on the same spot by extra layers
      const symbol = (id: string, filter: any, extra: Record<string, unknown> = {}) => {
        const size = id === 'formations' ? ['interpolate', ['linear'], ['zoom'], 5, 0.62, 8, 0.8] : iconSize;
        const layer = (lid: string, prop: string, f: any) =>
          map.addLayer({
            id: lid, type: 'symbol', source: id === 'formations' ? 'formations' : 'units', filter: f, ...extra,
            layout: { 'icon-image': ['get', prop], 'icon-size': size, 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'z'] },
          } as any);
        layer(id, 'icon', filter);
        for (const ov of ['ovRing', 'ovPips', 'ovRank', 'ovEch', 'ovStr']) layer(`${id}-${ov}`, ov, ['all', filter, ['!=', ['coalesce', ['get', ov], ''], '']]);
      };
      symbol('units-loose', ['all', ['!', ['get', 'grp']], ['!', ['get', 'air']]], { minzoom: GROUP_ZOOM });
      symbol('units-grouped', ['all', ['get', 'grp'], ['!', ['get', 'air']]], { minzoom: GROUP_ZOOM });
      symbol('formations', ['all'], { maxzoom: GROUP_ZOOM });
      // drones fly as sprites, turned to their heading; strike drones shrink as they dive
      map.addLayer({
        id: 'drones', type: 'symbol', source: 'drone-units',
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
      if (import.meta.env.DEV) (window as any).__sw = { map, fx, snap: () => snap, init: () => init, units: () => lastUnitFeatures, fakePockets: [], lastKnown: () => [...lastKnown.keys()], select: (ids: number[]) => ((selUnits = new Set(ids)), (selBuilding = null), render()) };
      mapReady = true;
      if (snap) render();
      showStart();
      // tell the server the map is drawn: the 3-2-1 countdown waits for every player
      map.once('idle', () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ready' } satisfies ClientMsg)));
      setTimeout(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ready' } satisfies ClientMsg)), 6000);
      requestAnimationFrame(animate);
    });

    const setScale = () => mapEl.style.setProperty('--s', String(Math.min(1.4, Math.max(0.42, (map.getZoom() - 3.6) / 4.6))));
    const updateZoom = () => {
      setScale();
      const z = map.getZoom();
      mapEl.classList.toggle('far', z < 6.6);
      mapEl.classList.toggle('zoom-out', z < 7.5);
    };
    map.on('zoom', updateZoom);
    map.on('zoomend', () => renderUnits()); // ground markers come back when zooming in
    updateZoom();

    let lastHover = 0;
    // line structures (trenches): press, drag the way it should run, release
    map.on('mousedown', (e) => {
      if (!placing?.line || e.originalEvent.button !== 0 || e.originalEvent.shiftKey) return;
      lineStart = [e.lngLat.lng, e.lngLat.lat];
      lineStartPx = { x: e.point.x, y: e.point.y };
    });
    map.on('mouseup', (e) => {
      if (!lineStart || !placing) return;
      const start = lineStart;
      const dragged = Math.hypot(e.point.x - lineStartPx.x, e.point.y - lineStartPx.y) > 8;
      lineStart = null;
      suppressClick = performance.now(); // the click that follows is this release
      send({ type: 'build', def: placing.id, pos: start, to: dragged ? [e.lngLat.lng, e.lngLat.lat] : undefined });
      if (!e.originalEvent.shiftKey) cancelPlacing();
    });
    map.on('mousemove', (e) => {
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (placing && lineStart) drawLineGhost(lineStart, p);
      else if (placing) drawGhost(p);
      const now = performance.now();
      if (now - lastHover > 80) (lastHover = now), showTerrain(p);
    });
    map.on('mouseout', () => (terrainChip.style.display = 'none'));
    map.on('click', (e) => {
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (performance.now() - suppressClick < 250) return; // the click that ends a box selection
      if (marking) return sendMark(marking, p);
      if (e.originalEvent.altKey && !placing) return sendMark('look', p); // quick ping
      if (garrisonPlan) {
        const targetUnit = snap?.units.find((x) => x.id === garrisonPlan!.unitId);
        if (!targetUnit) {
          garrisonPlan = null;
          return render();
        }
        if (garrisonPlan.mode === 'advance') {
          const curPath = [...(targetUnit.advancePath ?? [])];
          if (curPath.length >= 10) return toast('Максимум 10 точек маршрута', true);
          curPath.push(p);
          targetUnit.advancePath = curPath;
          send({ type: 'setGarrisonPlan', unitId: targetUnit.id, advancePath: curPath, retreatPath: targetUnit.retreatPath });
          toast(`Точка наступления #${curPath.length} добавлена`);
        } else {
          const curPath = [...(targetUnit.retreatPath ?? [])];
          if (curPath.length >= 10) return toast('Максимум 10 точек маршрута', true);
          if (sideAt(p) !== targetUnit.team || foreignAt(p)) return toast('Отступление возможно только в свой тыл / на свою территорию', true);
          curPath.push(p);
          targetUnit.retreatPath = curPath;
          send({ type: 'setGarrisonPlan', unitId: targetUnit.id, advancePath: targetUnit.advancePath, retreatPath: curPath });
          toast(`Точка отступления #${curPath.length} добавлена`);
        }
        return render();
      }
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
      if (pick.launchFrom) {
        send({ type: 'launchFrom', building: pick.launchFrom.building, units: pick.launchFrom.units, target: p });
        toast(`Launched ${pick.launchFrom.units.length}`);
        pick.launchFrom = null;
        return render();
      }
      if (pick.rally) {
        send({ type: 'rally', building: pick.rally.building, pos: p });
        toast('Rally point set: new units go there');
        pick.rally = null;
        return render();
      }
      if (pick.fuel) {
        // the vehicle under the cursor: own or allied, any that takes fuel
        const layers = ['units-loose', 'units-grouped'].filter((l) => map.getLayer(l));
        const ids = map.queryRenderedFeatures([[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]], { layers }).map((f) => Number(f.properties?.id));
        // among stacked markers: vehicles that need fuel first, then the one nearest the click
        const away = (u: UnitView) => { const q = map.project(posOf(u)); return Math.hypot(q.x - e.point.x, q.y - e.point.y); };
        const full = (u: UnitView) => (u.fuel !== undefined && u.maxFuel !== undefined && u.fuel >= u.maxFuel - 0.5 ? 1 : 0);
        const t = snap?.units
          .filter((u) => ids.includes(u.id) && u.id !== pick.fuel!.unitId && u.team === init!.team && defU.get(u.def)?.maxFuel && defU.get(u.def)?.kind === 'ground')
          .sort((a, b) => full(a) - full(b) || away(a) - away(b))[0];
        if (!t) return toast(map.getZoom() < GROUP_ZOOM ? 'Zoom in and click a vehicle' : 'Click one of your side’s vehicles', true);
        send({ type: 'giveFuel', unit: pick.fuel.unitId, target: t.id });
        toast(`Driving over to refuel the ${defU.get(t.def)?.name ?? 'vehicle'}`);
        pick.fuel = null;
        return render();
      }
      if (pick.route) {
        // a click on open map: a waypoint the truck drives through
        if (pick.route.stops.length >= 6) return toast('A route has at most 6 stops', true);
        pick.route.stops.push({ action: 'via', pos: p });
        return render();
      }
      if (placing?.line) return; // trenches are drawn with press-drag-release (see mouseup)
      if (placing) {
        send({ type: 'build', def: placing.id, pos: p });
        if (!e.originalEvent.shiftKey) cancelPlacing();
        return;
      }
      selectAt(e.point, e.originalEvent.shiftKey);
    });
    map.on('contextmenu', (e) => {
      if (garrisonPlan) {
        garrisonPlan = null;
        toast('Планирование завершено');
        return render();
      }
      if (pick.bombard) {
        send({ type: 'bombard', units: pick.bombard.unitIds, target: [e.lngLat.lng, e.lngLat.lat] });
        pick.bombard = null;
        return render();
      }
      if (pick.route || pick.launch || pick.fuel || pick.launchFrom || pick.rally) return void ((pick.route = pick.launch = pick.fuel = pick.launchFrom = pick.rally = null), render());
      if (placing) return cancelPlacing();
      if (!selUnits.size) return;
      // a right press on the map is finished on release (a drag there sets which way the formation faces)
      if (faceDrag || performance.now() - faceDone < 400) return;
      dispatchRightClick([e.lngLat.lng, e.lngLat.lat], e.point, e.originalEvent);
    });
    // right press, drag the way the front should face, release: the group forms up there facing that way
    mapEl.addEventListener('mousedown', (e) => {
      if (e.button !== 2 || !selUnits.size || (e.target as Element).closest?.('.maplibregl-marker') || placing || marking || pick.bombard || pick.route || pick.launch || pick.fuel || pick.launchFrom || pick.rally || garrisonPlan) return;
      const r = mapEl.getBoundingClientRect();
      const ll = map.unproject([e.clientX - r.left, e.clientY - r.top]);
      faceDrag = { to: [ll.lng, ll.lat], x: e.clientX, y: e.clientY };
    }, true);
    window.addEventListener('mousemove', (e) => {
      if (!faceDrag) return;
      if (Math.hypot(e.clientX - faceDrag.x, e.clientY - faceDrag.y) < 18) return void ((faceDrag.facing = undefined), drawFacing());
      const r = mapEl.getBoundingClientRect();
      const ll = map.unproject([e.clientX - r.left, e.clientY - r.top]);
      faceDrag.facing = bearing(faceDrag.to, [ll.lng, ll.lat]);
      drawFacing();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 2 || !faceDrag) return;
      const { to, facing } = faceDrag;
      const r = mapEl.getBoundingClientRect();
      const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
      faceDrag = null;
      faceDone = performance.now();
      drawFacing();
      dispatchRightClick(to, pt, e, facing);
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

  /** Right-click dispatcher: reinforces frontline garrison when clicked on one, otherwise moves selection. */
  function dispatchRightClick(to: LngLat, screenPt: { x: number; y: number }, ev: { shiftKey: boolean; altKey: boolean }, facing?: number) {
    if (!snap || !selUnits.size) return;
    const s = snap;
    const movable = [...selUnits].filter((id) => {
      const u = s.units.find((x) => x.id === id);
      return u && u.owner === me && !defU.get(u.def)?.stationary && !u.owner.startsWith('__front_');
    });
    if (!movable.length) return;

    // If it's a simple right click (not dragging a formation facing arrow):
    const myTeam = init?.team;
    if (facing === undefined && myTeam !== undefined) {
      const layers = ['units-loose', 'units-grouped', 'formations'].filter((l) => map.getLayer(l));
      const features = map.queryRenderedFeatures([[screenPt.x - 16, screenPt.y - 16], [screenPt.x + 16, screenPt.y + 16]], { layers });
      let tgtFront: UnitView | undefined;
      for (const f of features) {
        const hid = Number(f.properties?.id);
        if (hid) {
          const u = s.units.find((x) => x.id === hid && x.team === myTeam);
          if (u && (u.owner.startsWith('__front_') || u.def === 'frontline_infantry')) {
            tgtFront = u;
            break;
          }
        }
      }
      if (!tgtFront) {
        tgtFront = s.units.find((u) => u.team === myTeam && (u.owner.startsWith('__front_') || u.def === 'frontline_infantry') && distKm(posOf(u), to) <= 1.8);
      }
      if (tgtFront) {
        send({ type: 'reinforce', units: movable, targetUnit: tgtFront.id });
        toast('Отряд направлен на укрепление позиции');
        return;
      }
    }

    const shape = facing !== undefined && orders.formation === 'spread' ? 'line' : orders.formation;
    send({ type: 'move', units: movable, to, cohesion: formation && movable.length > 1, queue: ev.shiftKey, mode: ev.altKey ? 'direct' : 'fast', attack: orders.attack, formation: shape, facing });
  }

  /** Move the selection (Shift queues another waypoint, Alt goes straight across country, ready to fight). */
  function moveOrder(to: LngLat, ev: { shiftKey: boolean; altKey: boolean }, facing?: number) {
    dispatchRightClick(to, map ? map.project(to) : { x: 0, y: 0 }, ev, facing);
  }

  /** Degrees from north, clockwise, from a to b. */
  const bearing = (a: LngLat, b: LngLat) => {
    const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), dy = b[1] - a[1];
    return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  };

  /** The right-drag preview: an arrow the way the front faces and a dot where each ground unit will stand. */
  function drawFacing() {
    const src = map?.getSource('facing') as GeoJSONSource | undefined;
    if (!src) return;
    if (!faceDrag || faceDrag.facing === undefined || !snap) return src.setData(empty());
    const ground = snap.units.filter((u) => selUnits.has(u.id) && defU.get(u.def)?.kind !== 'air');
    const n = Math.max(1, ground.length);
    const centre: LngLat = ground.length ? [ground.reduce((a, u) => a + posOf(u)[0], 0) / n, ground.reduce((a, u) => a + posOf(u)[1], 0) / n] : faceDrag.to;
    const shape = orders.formation === 'spread' ? 'line' : orders.formation;
    const { to, facing } = faceDrag;
    const rad = (facing * Math.PI) / 180;
    const kmPerPx = (40075 * Math.cos((to[1] * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
    const len = Math.max(0.8, n * 0.2, 70 * kmPerPx); // at least ~70 px on screen
    const tip = offsetKm(to, Math.sin(rad) * len, Math.cos(rad) * len);
    const barb = (a: number) => offsetKm(tip, Math.sin(rad + Math.PI + a) * len * 0.35, Math.cos(rad + Math.PI + a) * len * 0.35);
    src.setData({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [to, tip] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [barb(0.45), tip, barb(-0.45)] } },
      ...Array.from({ length: n }, (_, i) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: formationSpot(shape, i, n, centre, to, facing) } })),
    ] } as any);
  }

  /** The guidebook, with this match's units and buildings. */
  function showGuide() {
    if (document.querySelector('.overlay.guide') || !init) return;
    openGuide({ ruleset: init.ruleset, side: init.team === 0 ? 'ua' : 'ru' });
  }

  /** Click selection: a plain click selects what is under the pointer; Shift adds it to (or takes it out of) the selection. */
  function selectAt(point: { x: number; y: number }, shift: boolean) {
    const layers = ['units-loose', 'units-grouped', 'drones', 'formations'].filter((l) => map.getLayer(l));
    const features = map.queryRenderedFeatures([[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]], { layers });
    const myTeam = init?.team;
    // Disallow clicking or selecting enemy units/garrisons: only friendly units are selectable
    const friendlyFeatures = features.filter((f) => {
      if (f.properties?.own) return true;
      const id = Number(f.properties?.id);
      if (id) {
        const u = snap?.units.find((x) => x.id === id);
        return u && u.team === myTeam;
      }
      if (f.properties?.ids) {
        try {
          const ids = JSON.parse(f.properties.ids) as number[];
          return ids.some((uid) => snap?.units.find((x) => x.id === uid)?.team === myTeam);
        } catch {
          return false;
        }
      }
      return false;
    });
    const hit = friendlyFeatures[0];
    const trenchHit = !hit && map.getLayer('trench-line') ? map.queryRenderedFeatures([[point.x - 8, point.y - 8], [point.x + 8, point.y + 8]], { layers: ['trench-line', 'trench-case'] })[0] : null;
    if (trenchHit?.properties?.id) {
      selBuilding = Number(trenchHit.properties.id);
      selUnits = new Set();
      render();
      return;
    }
    selBuilding = null;
    const many = hit?.properties?.gid ? [...(groups.get(Number(hit.properties.gid))?.ids ?? [])] : hit?.properties?.ids ? (JSON.parse(hit.properties.ids) as number[]) : null;
    if (many) {
      const friendlyMany = many.filter((uid) => snap?.units.find((x) => x.id === uid)?.team === myTeam);
      if (!shift) selUnits = new Set(friendlyMany);
      else if (friendlyMany.every((id) => selUnits.has(id))) friendlyMany.forEach((id) => selUnits.delete(id));
      else friendlyMany.forEach((id) => selUnits.add(id));
    } else if (hit) {
      const id = Number(hit.properties!.id);
      if (shift) selUnits.has(id) ? selUnits.delete(id) : selUnits.add(id);
      else selUnits = new Set([id]);
    } else if (!shift) selUnits = new Set();
    render();
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
    if (!snap) return;
    if (!dragged) {
      // the box selection took the mouse-down, so the map never sees this shift+click: select here instead
      const r = mapEl.getBoundingClientRect();
      suppressClick = performance.now();
      return selectAt({ x: e.clientX - r.left, y: e.clientY - r.top }, true);
    }
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
    if (markMenu.style.display !== 'none' && /^[1-4]$/.test(e.key)) return chooseMark((Object.keys(MARKS) as MarkKind[])[Number(e.key) - 1]);
    if (e.key === 'Escape' && (marking || markMenu.style.display !== 'none')) {
      toggleMarkMenu(false);
      hint.textContent = HINT;
      return void mapEl.classList.remove('picking');
    }
    if (e.key.toLowerCase() === 'p' && !e.ctrlKey && !e.metaKey) return toggleMarkMenu();
    if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.metaKey) return showGuide();
    if (e.key === 'Escape') {
      if (garrisonPlan) {
        garrisonPlan = null;
        return render();
      }
      if (pick.route || pick.bombard || pick.launch || pick.fuel || pick.launchFrom || pick.rally) return void ((pick.route = pick.bombard = pick.launch = pick.fuel = pick.launchFrom = pick.rally = null), render());
      return cancelPlacing();
    }
    const k = e.key.toLowerCase();
    if (k === 's' && selUnits.size) return void send({ type: 'stop', units: [...selUnits] });
    if (k === 'a' && selUnits.size) return void ((orders.attack = !orders.attack), toast(orders.attack ? 'Orders: attack-move (stop and fight)' : 'Orders: move (push through)'), renderHud());
    if (k === 'f' && selUnits.size) {
      const all = ['spread', 'line', 'column', 'wedge'] as const;
      orders.formation = all[(all.indexOf(orders.formation) + 1) % all.length];
      toast(`Formation: ${orders.formation}`);
      return renderHud();
    }
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
    const c = document.createElement('canvas');
    c.width = 1536;
    c.height = 1240;
    const g = c.getContext('2d')!;
    const img = g.createImageData(c.width, c.height);
    const weight: Record<string, number> = { water: 6, city: 5, mountain: 4, forest: 3, hill: 2 };
    const alpha: Record<string, number> = { water: 150, city: 200, mountain: 185, forest: 175, hill: 125 };
    const look = t.ids.map((id, i) => {
      const col = init!.ruleset.terrain.find((d) => d.id === id)?.color ?? '#000000';
      return { rgba: [parseInt(col.slice(1, 3), 16), parseInt(col.slice(3, 5), 16), parseInt(col.slice(5, 7), 16), i === 0 ? 0 : alpha[id] ?? 160], w: i === 0 ? 0 : weight[id] ?? 1 };
    });

    const td = t.data;
    const tYN = mercY(td.north);
    const tYS = mercY(td.south);

    for (let y = 0; y < c.height; y++) {
      const my = fullYN - ((y + 0.5) / c.height) * (fullYN - fullYS);
      const lat = (Math.atan(Math.sinh(my)) * 180) / Math.PI;

      for (let x = 0; x < c.width; x++) {
        const lng = fullWest + ((x + 0.5) / c.width) * (fullEast - fullWest);

        let rgba: number[];
        // Inside high-resolution raster terrain data
        if (lng >= td.west && lng <= td.east && lat >= td.south && lat <= td.north) {
          const gx = Math.floor(((lng - td.west) / (td.east - td.west)) * td.cols);
          const gy = Math.floor(((tYN - my) / (tYN - tYS)) * td.rows);
          if (gx >= 0 && gy >= 0 && gx < td.cols && gy < td.rows) {
            const k = t.kindAt(gy * td.cols + gx);
            rgba = look[k].rgba;
          } else {
            const proc = proceduralTerrain(lng, lat);
            const idx = t.ids.indexOf(proc);
            rgba = idx >= 0 ? look[idx].rgba : look[0].rgba;
          }
        } else {
          // Outside high-res grid (Russia east & north, surrounding states): procedural natural terrain
          const proc = proceduralTerrain(lng, lat);
          const idx = t.ids.indexOf(proc);
          rgba = idx >= 0 ? look[idx].rgba : look[0].rgba;
        }

        img.data.set(rgba, (y * c.width + x) * 4);
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
  /** The fog is repainted at most once per frame, however many things ask for it. */
  let fogQueued = false;
  function drawFog() {
    if (!fog || !mapReady || fogQueued) return;
    fogQueued = true;
    requestAnimationFrame(() => {
      fogQueued = false;
      if (closed || !fog) return;
      fog.render(snap, init, defU, defB, map.getLayoutProperty('osm', 'visibility') === 'none', (id, fallback) => unitPos.get(id) ?? fallback);
    });
  }

  function toggleTerrain() {
    if (!mapReady || !map.getLayer('terrain')) return;
    const on = map.getLayoutProperty('terrain', 'visibility') !== 'visible';
    map.setLayoutProperty('terrain', 'visibility', on ? 'visible' : 'none');
    terrainBtn.classList.toggle('on', on);
    updateDepositsVisibility();
  }

  function updateDepositsVisibility() {
    if (!mapReady) return;
    const terrainOn = map.getLayer('terrain') && map.getLayoutProperty('terrain', 'visibility') === 'visible';
    const placingMine = placing?.id === 'mine';
    const placingOilRig = placing?.id === 'oil_rig';
    const showIron = terrainOn || placingMine;
    const showOil = terrainOn || placingOilRig;

    const ironVis = showIron ? 'visible' : 'none';
    const oilVis = showOil ? 'visible' : 'none';

    if (map.getLayer('deposits-iron-fill')) {
      map.setLayoutProperty('deposits-iron-fill', 'visibility', ironVis);
      if (placingMine && !terrainOn) {
        map.setPaintProperty('deposits-iron-fill', 'fill-opacity', 0.52);
      } else {
        map.setPaintProperty('deposits-iron-fill', 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 4, 0.22, 7, 0.35, 11, 0.45]);
      }
    }
    if (map.getLayer('deposits-oil-fill')) {
      map.setLayoutProperty('deposits-oil-fill', 'visibility', oilVis);
      if (placingOilRig && !terrainOn) {
        map.setPaintProperty('deposits-oil-fill', 'fill-opacity', 0.48);
      } else {
        map.setPaintProperty('deposits-oil-fill', 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 4, 0.20, 7, 0.30, 11, 0.38]);
      }
    }
  }

  function showTerrain(p: LngLat) {
    if (!terrain || !init) return;
    const t = init.ruleset.terrain.find((d) => d.id === terrain!.at(p));
    const depIron = inDeposit('iron', p, init.team, matchDeposits);
    const depOil = !depIron ? inDeposit('oil', p, init.team, matchDeposits) : null;
    const friendlyDep = depIron ?? depOil;

    if (!t && !friendlyDep) return void (terrainChip.style.display = 'none');
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const classes = [...new Set(init.ruleset.units.filter((u) => u.kind !== 'air').map((u) => u.mobility ?? 'foot'))];
    clear(terrainChip);
    terrainChip.style.display = 'flex';
    if (t) {
      const barrier = terrain.isBarrier(p);
      terrainChip.append(h('i', { style: { background: t.color } }), h('b', {}, barrier ? 'River' : t.barrier ? 'Stream (fordable)' : t.name));
      if (barrier) terrainChip.append(h('span', { class: 'neg' }, 'ground units cross only on a road bridge or at a pontoon crossing'));
      else terrainChip.append(...classes.map((c) => h('span', {}, `${c} ${pct(t.speed[c] ?? t.speed.default ?? 1)}`)));
      if (t.cover) terrainChip.append(h('span', { class: t.cover > 0 ? 'pos' : 'neg' }, `cover ${t.cover > 0 ? '+' : ''}${pct(t.cover)}`));
      if (t.concealment < 1) terrainChip.append(h('span', { class: 'pos' }, 'concealed'));
      if (!barrier && (t.vision ?? 1) !== 1) terrainChip.append(h('span', { class: (t.vision ?? 1) > 1 ? 'pos' : 'neg' }, `sight ${(t.vision ?? 1) > 1 ? '+' : ''}${Math.round(((t.vision ?? 1) - 1) * 100)}%`));
    }
    if (friendlyDep) {
      const ico = friendlyDep.type === 'iron' ? '⛏' : '🛢';
      terrainChip.append(h('span', { class: 'pos', style: { marginLeft: '6px', background: friendlyDep.type === 'iron' ? '#78350f' : '#0f172a', color: '#fff', borderRadius: '3px', padding: '1px 6px', fontWeight: 'bold' } }, `${ico} ${friendlyDep.name}`));
    }
    if (roads?.isNear(p, 2)) terrainChip.append(h('span', { class: 'road' }, `road ×${init.ruleset.rules.roadSpeedMult}`));
  }

  let zoneMarkers: maplibregl.Marker[] = [];

  function clearZoneMarkers() {
    for (const m of zoneMarkers) m.remove();
    zoneMarkers = [];
  }

  // ---------- placement ----------
  /** While placing: red exclusion rings around existing sites, and the special zones this building could use. */
  function showPlacementAids() {
    if (!mapReady || !init || !snap) return;
    clearZoneMarkers();
    const zoneFeatures: any[] = [];
    if (placing) {
      if (placing.id === 'refinery') {
        if (init.team === 0) {
          const center: LngLat = [33.4397, 49.0703];
          zoneFeatures.push({
            type: 'Feature',
            properties: { color: '#f59e0b', name: 'Зона НПЗ: Кременчуг (25 км)' },
            geometry: { type: 'Polygon', coordinates: [circle(center, 25, 64)] },
          });
          const el = h('div', { class: 'placement-zone-badge' }, '⚡ Зона НПЗ: Кременчуг (25 км)');
          const m = new maplibregl.Marker({ element: el }).setLngLat(center).addTo(map);
          zoneMarkers.push(m);
        } else {
          const center: LngLat = [39.7203, 47.2357];
          zoneFeatures.push({
            type: 'Feature',
            properties: { color: '#f59e0b', name: 'Зона НПЗ: Ростов-на-Дону (65 км)' },
            geometry: { type: 'Polygon', coordinates: [circle(center, 65, 64)] },
          });
          const el = h('div', { class: 'placement-zone-badge' }, '⚡ Зона НПЗ: Ростов-на-Дону (65 км)');
          const m = new maplibregl.Marker({ element: el }).setLngLat(center).addTo(map);
          zoneMarkers.push(m);
        }
      } else {
        const zones = SPECIAL_ZONES.filter((z) => z.side === (init!.team === 0 ? 'ua' : 'ru') && z.buildingDef === placing!.id);
        for (const z of zones) {
          zoneFeatures.push({
            type: 'Feature',
            properties: { color: z.color, name: z.name },
            geometry: { type: 'Polygon', coordinates: [z.polygon] },
          });
          const lats = z.polygon.map((p) => p[1]);
          const lngs = z.polygon.map((p) => p[0]);
          const c: LngLat = [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
          const el = h('div', { class: 'placement-zone-badge' }, z.name);
          const m = new maplibregl.Marker({ element: el }).setLngLat(c).addTo(map);
          zoneMarkers.push(m);
        }
      }
    }
    (map.getSource('zones') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: zoneFeatures,
    } as any);
    const r = init.ruleset.rules;
    const rings = placing && placing.id !== 'housing'
      ? snap.buildings.filter((b) => b.def !== 'housing' && spacingBetween(placing!, b.def, false) > r.fieldWorkSpacing).map((b) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circle(b.pos, spacingBetween(placing!, b.def, false), 64)] } }))
      : [];
    (map.getSource('restricted') as GeoJSONSource).setData({ type: 'FeatureCollection', features: rings } as any);
  }

  function cancelPlacing() {
    if (!placing) return;
    clearZoneMarkers();
    lineStart = null;
    map.dragPan.enable(); // panning back on after drawing lines
    placing = null;
    showPlacementAids();
    updateDepositsVisibility();
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
    const currentInit = init;
    if (!Object.entries(def.cost).every(([k, v]) => (snap!.res[k] ?? 0) >= v)) return 'Недостаточно денег';
    if (def.id === 'hq') {
      if (terrain?.at(p) === 'water') return 'Нельзя строить на воде';
      if (foreignAt(p) || nearForeignAt(p, 15)) return 'Нельзя строить ближе 15 км к границе с нейтральным государством';
      const myHq = snap.buildings.some((b) => b.owner === me && b.def === 'hq');
      if (myHq) return 'Военный штаб уже построен (максимум 1)';
      const clash = snap.buildings.find((b) => b.def === 'hq' && distKm(b.pos, p) < 100);
      if (clash) return 'Слишком близко к другому штабу (минимум 100 км)';
      return null;
    }
    if (def.id === 'military_base') {
      if (terrain?.at(p) === 'water') return 'Нельзя строить на воде';
      if (sideAt(p) !== init.team) return 'Нельзя строить на территории противника';
      if (foreignAt(p) || nearForeignAt(p, 15)) return 'Нельзя строить ближе 15 км к границе с нейтральным государством';
      const myHq = snap.buildings.some((b) => b.owner === me && b.def === 'hq');
      if (!myHq) return 'Сначала необходимо построить Военный штаб';
      const clash = snap.buildings.find((b) => b.def === 'military_base' && distKm(b.pos, p) < 20);
      if (clash) return 'Слишком близко к другой военной базе (минимум 20 км)';
      return null;
    }
    if (def.id === 'drone_factory') {
      if (terrain?.at(p) === 'water') return 'Нельзя строить на воде';
      if (sideAt(p) !== init.team) return 'Нельзя строить на территории противника';
      if (foreignAt(p)) return 'Нельзя строить на территории соседних государств';
      const myHq = snap.buildings.some((b) => b.owner === me && b.def === 'hq');
      if (!myHq) return 'Сначала необходимо построить Военный штаб';
      const clash = snap.buildings.find((b) => b.def === 'drone_factory' && distKm(b.pos, p) < 1);
      if (clash) return 'Место занято другим заводом';
      return null;
    }
    if (def.id === 'warehouse') {
      if (terrain?.at(p) === 'water') return 'Нельзя строить на воде';
      if (sideAt(p) !== init.team) return 'Нельзя строить на территории противника';
      if (foreignAt(p) || nearForeignAt(p, 15)) return 'Нельзя строить ближе 15 км к границе с нейтральным государством';
      const myHq = snap.buildings.some((b) => b.owner === me && b.def === 'hq');
      if (!myHq) return 'Сначала необходимо построить Военный штаб';
      const clash = snap.buildings.find((b) => b.def === 'warehouse' && distKm(b.pos, p) < 100);
      if (clash) return 'Слишком близко к другому складу (минимум 100 км)';
      return null;
    }
    if (def.id === 'mine') {
      if (terrain?.at(p) === 'water') return 'Нельзя строить на воде';
      if (sideAt(p) !== init.team) return 'Нельзя строить на территории противника';
      if (foreignAt(p)) return 'Нельзя строить на территории соседних государств';
      const myHq = snap.buildings.some((b) => b.owner === me && b.def === 'hq');
      if (!myHq) return 'Сначала необходимо построить Военный штаб';
      const myMines = snap.buildings.filter((b) => b.owner === me && b.def === 'mine').length;
      if (myMines >= 1) return 'Можно построить только 1 шахту';
      if (!inDeposit('iron', p, init.team, matchDeposits)) return 'Шахту можно строить только на месторождении железа вашей команды';
      const clash = snap.buildings.find((b) => b.def === 'mine' && distKm(b.pos, p) < 1);
      if (clash) return 'Место занято другой шахтой';
      return null;
    }
    if (def.id === 'oil_rig') {
      if (terrain?.at(p) === 'water') return 'Нельзя строить на воде';
      if (sideAt(p) !== init.team) return 'Нельзя строить на территории противника';
      if (foreignAt(p)) return 'Нельзя строить на территории соседних государств';
      const myHq = snap.buildings.some((b) => b.owner === me && b.def === 'hq');
      if (!myHq) return 'Сначала необходимо построить Военный штаб';
      const myRigs = snap.buildings.filter((b) => b.owner === me && b.def === 'oil_rig').length;
      if (myRigs >= 1) return 'Можно построить только 1 нефтяную вышку';
      if (!inDeposit('oil', p, init.team, matchDeposits)) return 'Нефтяную вышку можно строить только на месторождении нефти вашей команды';
      const clash = snap.buildings.find((b) => b.def === 'oil_rig' && distKm(b.pos, p) < 1);
      if (clash) return 'Место занято другой вышкой';
      return null;
    }
    if (def.id === 'refinery') {
      if (terrain?.at(p) === 'water') return 'Нельзя строить на воде';
      if (sideAt(p) !== init.team) return 'Нельзя строить на территории противника';
      if (foreignAt(p)) return 'Нельзя строить на территории соседних государств';
      const myHq = snap.buildings.some((b) => b.owner === me && b.def === 'hq');
      if (!myHq) return 'Сначала необходимо построить Военный штаб';
      const teamRefineries = snap.buildings.filter((b) => b.team === currentInit.team && b.def === 'refinery');
      if (teamRefineries.length >= 2) return 'На команду можно построить максимум 2 нефтеперерабатывающих завода';
      if (currentInit.team === 0) {
        const isAtKremenchuk = distKm(p, [33.4397, 49.0703]) <= 25;
        const hasKremenchuk = teamRefineries.some((b) => distKm(b.pos, [33.4397, 49.0703]) <= 25);
        if (teamRefineries.length === 1 && !hasKremenchuk && !isAtKremenchuk) {
          return 'Один из заводов команды должен быть построен в Кременчуге';
        }
      } else {
        const isNearRostov = distKm(p, [39.7203, 47.2357]) <= 65;
        const hasRostov = teamRefineries.some((b) => distKm(b.pos, [39.7203, 47.2357]) <= 65);
        if (teamRefineries.length === 1 && !hasRostov && !isNearRostov) {
          return 'Один из заводов команды должен быть построен возле Ростова-на-Дону';
        }
      }
      const clash = snap.buildings.find((b) => b.def === 'refinery' && distKm(b.pos, p) < 10);
      if (clash) return 'Слишком близко к другому НПЗ (минимум 10 км)';
      return null;
    }
    if (def.id === 'housing') {
      if (terrain?.at(p) === 'water') return 'Нельзя строить на воде';
      const myHq = snap.buildings.some((b) => b.owner === me && b.def === 'hq');
      if (!myHq) return 'Сначала необходимо построить Военный штаб';
      const city = cityAt(p);
      if (!city) return 'Жилой квартал можно строить только внутри города';
      const cityIdx = init.map.capturePoints.indexOf(city);
      if (cityIdx >= 0 && snap.points[cityIdx]?.owner !== init.team) return 'Город должен контролироваться вашей командой';
      const limit = init.ruleset.rules.cityHousingLimit ?? 2;
      if (snap.buildings.filter((b) => b.def === 'housing' && cityAt(b.pos) === city).length >= limit) return `В городе ${city.name} уже построено максимум ${limit} жилых кварталов`;
      const clash = snap.buildings.find((b) => b.def === 'housing' && distKm(b.pos, p) < 0.08);
      if (clash) return 'Слишком близко к другому жилому кварталу';
      return null;
    }
    const r = init.ruleset.rules;
    const zone = specialZoneAt(p);
    const mySide = init.team === 0 ? 'ua' : 'ru';
    if (zone && zone.side !== mySide) return `${zone.name} belongs to the other side`;
    // ammo depots may go up on contested ground our side holds, even behind the line
    const inGrey = !!def.buildInGrey && (snap.grey.some((z) => z.team === init!.team && distKm(z.pos, p) <= z.r) || contestedAt(p) === init.team);
    if (!zone && !inGrey) {
      const d = Math.abs(distToFrontKm(snap.front, p));
      const pocket = snap.pockets.find((k) => pointInRing(k.nodes, p));
      if (pocket) return pocket.team === init.team ? 'this ground is encircled' : 'not your territory';
      const lib = contestedAt(p);
      if (snap.grey.some((z) => distKm(z.pos, p) <= z.r) || lib === 0 || lib === 1) return def.buildInGrey ? 'only your side’s grey zones' : 'contested ground (grey zone)';
      if (sideAt(p) !== init.team) return 'not your territory';
      if (d < r.minBuildDistanceFromFront * (def.category === 'civil' ? 2 : 1)) return 'too close to the front';
    }
    if (terrain?.at(p) === 'water') return 'cannot build on water';
    if (def.needsWaterWithinKm && !nearRiver(p, def.needsWaterWithinKm)) return 'must be on a river bank';
    const clash = snap.buildings.find((b) => b.def !== 'housing' && distKm(b.pos, p) < spacingBetween(def, b.def, !!zone));
    if (clash) {
      const other = defB.get(clash.def)!;
      const gap = spacingBetween(def, other.id, !!zone);
      return chained(def, other) ? `keep ${r.minBuildSpacing} km from the ${other.name} (goods go by truck)` : gap > r.fieldWorkSpacing ? `keep ${gap} km from the ${other.name}` : 'space occupied';
    }
    return null;
  }


  function nearRiver(p: LngLat, km: number): boolean {
    if (!terrain) return false;
    for (let a = 0; a < 16; a++) for (const r of [km * 0.5, km]) if (terrain.isBarrier(offsetKm(p, Math.cos((a / 16) * 6.2832) * r, Math.sin((a / 16) * 6.2832) * r))) return true;
    return false;
  }

  /** The area within r km of the segment a–b (a line's cover), as a closed ring. */
  function capsule(a: LngLat, b: LngLat, r: number): LngLat[] {
    const kx = Math.cos((a[1] * Math.PI) / 180) * 111.32;
    const ang = Math.atan2((b[1] - a[1]) * 111.32, (b[0] - a[0]) * kx);
    const arc = (c: LngLat, from: number) => Array.from({ length: 13 }, (_, i) => offsetKm(c, r * Math.cos(from + (i / 12) * Math.PI), r * Math.sin(from + (i / 12) * Math.PI)));
    const ring = [...arc(b, ang - Math.PI / 2), ...arc(a, ang + Math.PI / 2)];
    ring.push(ring[0]);
    return ring;
  }
  let lineStart: LngLat | null = null;
  let lineStartPx = { x: 0, y: 0 };
  /** While dragging a trench: the line, its cover either side, and length, cost and any problem in the hint. */
  function drawLineGhost(a: LngLat, b: LngLat) {
    if (!placing?.line || !init) return;
    const km = distKm(a, b);
    const lim = placing.line;
    const steps = Math.max(2, Math.ceil(km / 0.25));
    let problem: string | null = km < lim.minKm ? `at least ${lim.minKm} km` : km > lim.maxKm ? `at most ${lim.maxKm} km` : null;
    let wet = 0;
    for (let i = 0; i <= steps && !problem; i++) {
      const q: LngLat = [a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps];
      const water = !!terrain?.isBarrier(q) || terrain?.at(q) === 'water';
      if (water) wet++;
      if (placing.spansWater) {
        if ((i === 0 || i === steps) && (water || sideAt(q) !== init.team)) problem = 'both ends must be on your dry ground';
        continue;
      }
      if (sideAt(q) !== init.team) problem = 'the whole line must be on your ground';
      else if (water) problem = 'the line crosses water';
      else if (contestedAt(q) === 0 || contestedAt(q) === 1) problem = 'contested ground (grey zone)';
    }
    if (!problem && placing.spansWater && !wet) problem = 'a bridge has to cross a river';
    const size = Math.max(0.5, Math.round(km * 10) / 10);
    const cost = Object.fromEntries(Object.entries(placing.cost).map(([k, v]) => [k, Math.round(v * size)]));
    if (!problem && !Object.entries(cost).every(([k, v]) => (snap!.res[k] ?? 0) >= v)) problem = 'not enough resources';
    const color = problem ? '#ff5a5a' : '#5ae88a';
    const r = placing.defense?.radiusKm ?? placing.crossing?.radiusKm ?? 1;
    // cover zone: the line widened by its radius (a capsule)
    (map.getSource('ghost') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { color }, geometry: { type: 'Polygon', coordinates: [capsule(a, b, r)] } },
      { type: 'Feature', properties: { color }, geometry: { type: 'LineString', coordinates: [a, b] } },
    ] } as any);
    hint.textContent = `${placing.name}: ${km.toFixed(1)} km · ${Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(', ')}${problem ? ` — ${problem}` : ' — release to dig'}`;
  }

  function drawGhost(p: LngLat) {
    if (!placing || !init) return;
    const problem = placementProblem(placing, p);
    const color = problem ? '#ff5a5a' : '#5ae88a';
    // every range the building will have, each in its own colour, plus its footprint
    const zones: [number, string, string][] = [];
    if (placing.aura) zones.push([placing.aura.radiusKm, '#a3e635', `+${Math.round((placing.aura.outputMult - 1) * 100)}% output ${placing.aura.radiusKm} km`]);
    if (placing.defense) zones.push([placing.defense.radiusKm, '#4ade80', `cover ${placing.defense.radiusKm} km`]);
    if (placing.supply) zones.push([placing.supply.radiusKm, '#e39b4f', `ammo ${placing.supply.radiusKm} km`]);
    if (placing.heals) zones.push([placing.heals.radiusKm, '#f472b6', `healing ${placing.heals.radiusKm} km`]);
    if (placing.attack) zones.push([placing.attack.range, '#ffd84a', `fires ${placing.attack.range} km`]);
    if (placing.crossing) zones.push([placing.crossing.radiusKm, '#7fe7ff', `crossing ${placing.crossing.radiusKm} km`]);
    if (placing.id === 'power_plant') zones.push([init.ruleset.rules.powerGridKm, '#38bdf8', `grid ${init.ruleset.rules.powerGridKm} km`]);
    if (placing.vision) zones.push([placing.vision, '#94a3b8', `sight ${placing.vision} km`]);
    if (placing.id === 'hq') zones.push([100, '#ef4444', 'дистанция 100 км до других штабов']);
    if (placing.id === 'military_base') zones.push([20, '#38bdf8', 'дистанция 20 км до других военных баз']);
    if (placing.id === 'warehouse') zones.push([100, '#eab308', 'дистанция 100 км до других складов']);
    (map.getSource('ghost') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { color }, geometry: { type: 'Polygon', coordinates: [circle(p, 0.6)] } },
        ...zones.map(([km, c]) => ({ type: 'Feature', properties: { color: problem ? '#ff5a5a' : c }, geometry: { type: 'Polygon', coordinates: [circle(p, km, 96)] } })),
      ],
    });
    const legend = zones.map((z) => z[2]).join(' · ');
    const road = roads?.isNear(p, init.ruleset.rules.roadAccessKm);
    const bonus = Math.round((init.ruleset.rules.roadOutputMult - 1) * 100);
    hint.textContent = problem ? `${placing.name}: ${problem}` : `${placing.name}: click to build${legend ? ` · ${legend}` : ''}${placing.produces ? (road ? ` · road access +${bonus}% output` : ' · no road nearby') : ''} (Shift keeps placing, Esc cancels)`;
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

  function startPlacing(b: BuildingDef) {
    placing = b;
    if (b.line) map.dragPan.disable();
    else map.dragPan.enable();
    mapEl.classList.add('placing');
    showPlacementAids();
    updateDepositsVisibility();
    hint.textContent = b.id === 'hq'
      ? 'Размещение: Военный штаб — кликните в любой точке карты для установки (Esc — отмена)'
      : b.id === 'military_base'
        ? 'Размещение: Военная база — кликните в любой точке своей территории (минимум 20 км от других баз, Esc — отмена)'
        : b.id === 'warehouse'
          ? 'Размещение: Склад — выберите точку на своей территории (минимум 100 км от других складов, Esc — отмена)'
          : b.id === 'mine'
            ? 'Размещение: Шахта — выберите точку на месторождении железа (1 на игрока, Esc — отмена)'
            : b.id === 'oil_rig'
              ? 'Размещение: Нефтяная вышка — выберите точку на месторождении нефти (1 на игрока, Esc — отмена)'
              : b.id === 'refinery'
                ? (init?.team === 0
                    ? 'Размещение: НПЗ — 1 должен быть в Кременчуге (подсвечен кругом), 2-й в любой точке Украины (макс 2 на команду, Esc — отмена)'
                    : 'Размещение: НПЗ — 1 должен быть возле Ростова-на-Дону (подсвечен кругом), 2-й в любой точке РФ (макс 2 на команду, Esc — отмена)')
                : b.id === 'housing'
                  ? 'Размещение: Жилой квартал — выберите точку внутри города своей команды (максимум 2 на город, Esc — отмена)'
                  : b.line
                    ? `${b.name}: press and drag on the map the way it should run, release to build (Esc cancels)`
                    : `Размещение: ${b.name} — кликните на карте (Shift — серийное строительство, Esc — отмена)`;
    buildPalette();
  }


  function buildPalette() {
    if (!init) return;
    card.style.display = 'none'; // its button is about to be replaced
    clear(palette);
    const hasHq = snap?.buildings.some((x) => x.owner === me && x.def === 'hq');
    for (const cat of ['civil', 'military'] as const) {
      const list = init.ruleset.buildings.filter((x) => x.category === cat && (hasHq || x.id === 'hq'));
      if (!list.length) continue;
      palette.append(h('div', { class: 'cat' }, cat === 'civil' ? 'Civil infrastructure' : 'War infrastructure'));
      for (const b of list) {
        const owned = snap?.buildings.filter((x) => x.owner === me && x.def === b.id).length ?? 0;
        const reachedLimit = b.maxPerPlayer ? owned >= b.maxPerPlayer : false;
        const isBuiltHq = b.id === 'hq' && reachedLimit;
        const btn =
          h('button', {
            class: 'bld' + (placing?.id === b.id ? ' active' : '') + (reachedLimit && !isBuiltHq ? ' disabled' : ''),
            disabled: reachedLimit && !isBuiltHq,
            onClick: () => {
              if (isBuiltHq) {
                const myHq = snap?.buildings.find((x) => x.owner === me && x.def === b.id);
                if (myHq) {
                  selBuilding = myHq.id;
                  selUnits.clear();
                  map.easeTo({ center: myHq.pos });
                  render();
                }
                return;
              }
              if (reachedLimit) return;
              startPlacing(b);
            }
          },
            b.id === 'refinery'
              ? h('span', { class: 'ico', innerHTML: REFINERY_SVG })
              : b.id === 'housing'
                ? h('span', { class: 'ico', innerHTML: `<svg class="bld-house-ico" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>` })
                : h('span', { class: 'ico' }, b.icon),
            h('span', { class: 'meta' }, h('b', {}, b.name), isBuiltHq ? h('span', { class: 'muted' }, 'Построен (клик)') : reachedLimit ? h('span', { class: 'muted' }, 'Лимит') : costHtml(b.cost, snap?.res)),
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
      if (r.id !== 'money') continue;
      const v = snap.res[r.id] ?? 0;
      const d = snap.rates[r.id] ?? 0;
      const ico = h('span', { class: 'rico' });
      ico.innerHTML = iconHtml(r.icon, r.color);
      resBar.append(
        h('div', { class: 'chip', title: ['money', 'people', 'energy'].includes(r.id) ? r.name : `${r.name}: what lies in your HQ and warehouses (building and upgrades are paid from here). The rate is what your sites make; it reaches the HQ by truck.` },
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
        if (b.def === 'hq' && b.owner === me) {
          const available = init.ruleset.buildings.filter((x) => x.id !== 'hq');
          if (available.length) {
            side.append(h('h4', { style: { marginTop: '14px', marginBottom: '8px', fontSize: '13px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '6px' } }, '🏗 Доступные постройки'));
            for (const bld of available) {
              const owned = snap.buildings.filter((x) => x.owner === me && x.def === bld.id).length;
              const reachedLimit = bld.maxPerPlayer ? owned >= bld.maxPerPlayer : false;
              const canAfford = Object.entries(bld.cost).every(([k, v]) => (snap!.res[k] ?? 0) >= v);
              const disabled = reachedLimit || !canAfford;
              const btn = h('button', {
                class: 'bld' + (placing?.id === bld.id ? ' active' : '') + (disabled ? ' disabled' : ''),
                disabled,
                onClick: () => {
                  if (disabled) return;
                  startPlacing(bld);
                }
              },
                h('span', { class: 'ico' }, bld.icon),
                h('span', { class: 'meta' },
                  h('b', {}, bld.name),
                  reachedLimit ? h('span', { class: 'muted' }, 'Лимит') : costHtml(bld.cost, snap.res)
                ),
              );
              describe(btn, bld.name, bld.description, buildingFacts(bld), 'left');
              side.append(btn);
            }
          }
        }
        // a teammate may keep their buildings to themselves
        const locked = b.owner !== me && snap.closed.includes(b.owner);
        if (locked || b.progress < 1) (sideQueue = null), queueSlot.replaceChildren();
        const ownerName = init.players.find((p) => p.id === b.owner)?.name ?? 'a teammate';
        if (b.owner !== me) side.append(h('div', { class: locked ? 'stat warn' : 'muted' }, locked ? `Built by ${ownerName}, who keeps it private: you cannot use it` : `Built by ${ownerName}: shared with your side`));
        const rules = init.ruleset.rules;
        if (d.produces) side.append(h('div', { class: 'stat' }, b.road ? `Road access: +${Math.round((rules.roadOutputMult - 1) * 100)}% output` : 'No road access'));
        if (b.def !== 'power_plant' && init.ruleset.resources.some((r) => r.id === 'energy')) {
          const grid = snap.buildings.some((o) => o.team === b.team && o.progress >= 1 && o.def === 'power_plant' && distKm(o.pos, b.pos) <= rules.powerGridKm);
          side.append(h('div', { class: 'stat', style: { color: grid ? '#38bdf8' : 'var(--muted)' } }, grid ? `On the power grid: +${Math.round(((b.def === 'housing' ? rules.housingGridMult : rules.powerGridMult) - 1) * 100)}%` : `Off the grid (no power plant within ${rules.powerGridKm} km)`));
        }
        if (b.def === 'housing') {
          const city = cityAt(b.pos);
          const limit = rules.cityHousingLimit ?? 2;
          if (city) side.append(h('div', { class: 'stat' }, `Город: ${city.name} (${snap.buildings.filter((x) => x.def === 'housing' && cityAt(x.pos) === city).length}/${limit} районов)`));
          if (b.houses && b.houses.length > 0) {
            const alive = b.houses.filter((h) => h.hp > 0).length;
            const pct = Math.round((alive / b.houses.length) * 100);
            side.append(h('div', { class: 'stat' }, `Уцелевшие дома: ${alive}/${b.houses.length} (50 HP каждый)`));
            side.append(h('div', { class: 'stat', style: { color: pct < 50 ? '#ef4444' : pct < 100 ? '#f59e0b' : '#10b981' } }, `Доход района: ${pct}% (5 монет / 5 сек при 100%)`));
          }
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
        if ((b.def === 'mine' || b.def === 'steel_mill' || b.def === 'ammo_factory') && b.progress >= 1 && !locked) {
          const targetDef = b.def === 'mine' ? 'steel_mill' : b.def === 'steel_mill' ? 'ammo_factory' : 'warehouse';
          const targetLabel = b.def === 'mine' ? 'Сталелитейные заводы' : b.def === 'steel_mill' ? 'Заводы боеприпасов' : 'Склады';
          const resLabel = b.def === 'mine' ? 'руды' : b.def === 'steel_mill' ? 'стали' : 'боеприпасов';
          const targets = snap.buildings.filter((x) => x.team === b.team && x.progress >= 1 && x.def === targetDef);
          const currentTargets = new Set(b.serviceTargets ?? []);
          const myTrucks = snap.units.filter((u) => u.serviceBuilding === b.id && u.hp > 0);

          const logBox = h('div', { class: 'storage-box', style: { marginTop: '10px' } });
          logBox.append(
            h('b', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, `🚚 Снабжение (${resLabel})`),
            h('div', { class: 'stat' }, `Грузовиков на маршруте: ${myTrucks.length} (возит по 500 ${resLabel})`),
          );

          if (b.owner === me) {
            const canAffordTruck = (snap.res.money ?? 0) >= 125;
            const buyBtn = h('button', {
              class: 'hud-btn sm' + (canAffordTruck ? '' : ' disabled'),
              disabled: !canAffordTruck,
              onClick: () => {
                send({ type: 'buyLogisticsTruck', building: b.id });
                toast('Куплен дополнительный грузовик снабжения');
              }
            }, '🚚 Купить грузовик снабжения · 125 💰');
            logBox.append(buyBtn);
          }

          logBox.append(h('div', { class: 'stat', style: { marginTop: '8px' } }, `Куда доставлять (${targetLabel}):`));
          if (!targets.length) {
            logBox.append(h('div', { class: 'muted', style: { fontSize: '12px' } }, `Нет построенных объектов (${targetLabel.toLowerCase()}). Постройте их для доставки.`));
          } else {
            for (const tgt of targets) {
              const td = defB.get(tgt.def);
              const dist = Math.round(distKm(b.pos, tgt.pos) * 10) / 10;
              const isChecked = currentTargets.has(tgt.id);
              const stockVal = Math.floor(tgt.storage?.[b.def === 'mine' ? 'ore' : b.def === 'steel_mill' ? 'steel' : 'ammo'] ?? 0);
              const tgtRow = h('div', {
                class: 'row',
                style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.06)', cursor: b.owner === me ? 'pointer' : 'default' },
                onClick: () => {
                  if (b.owner !== me) return;
                  const nextTargets = new Set(currentTargets);
                  if (nextTargets.has(tgt.id)) {
                    if (nextTargets.size > 1) nextTargets.delete(tgt.id);
                  } else {
                    nextTargets.add(tgt.id);
                  }
                  send({ type: 'setServiceTargets', building: b.id, targets: [...nextTargets] });
                }
              },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                  b.owner === me ? h('input', { type: 'checkbox', checked: isChecked, style: { cursor: 'pointer' } }) : null,
                  h('span', {}, `${td?.icon ?? '🏢'} ${td?.name ?? 'Объект'} (${dist} км)`),
                ),
                h('small', { class: 'muted' }, `${stockVal}/5000`)
              );
              logBox.append(tgtRow);
            }
          }
          side.append(logBox);
        }
        if (b.def === 'aircraft_plant') side.append(h('div', { class: 'muted' }, 'Production starts with a coming update.'));
        // drones and missiles waiting here
        const waiting = stored.filter((x) => x.parkedAt === b.id && x.owner === me);
        if (waiting.length) {
          const box = h('div', { class: 'storage-box' }, h('b', {}, d.launches?.length ? 'Ready to launch' : 'Waiting for a launcher (Airfield for recon, Launch Site for strike)'));
          const byDef = new Map<string, UnitView[]>();
          for (const x of waiting) byDef.set(x.def, [...(byDef.get(x.def) ?? []), x]);
          for (const [def, list] of byDef) {
            const ud = defU.get(def)!;
            const can = !!d.launches?.includes(isReconDrone(ud) ? 'recon' : 'strike');
            box.append(h('div', { class: 'row' }, unitIcon(ud, 0), h('span', {}, `${ud.name} ×${list.length}`),
              can ? h('button', { class: 'hud-btn sm', onClick: () => ((pick.launchFrom = { building: b.id, units: [list[0].id] }), toast('Click the target'), render()) }, 'Launch 1 at…') : null,
              can && list.length > 1 ? h('button', { class: 'hud-btn sm', onClick: () => ((pick.launchFrom = { building: b.id, units: list.map((x) => x.id) }), toast('Click the target'), render()) }, 'Launch all at…') : null));
          }
          if (!d.launches?.length) {
            box.append(h('button', { class: 'hud-btn sm', title: 'Fly waiting drones to the nearest launch site or airfield', onClick: () => {
              send({ type: 'dispatchDrones', building: b.id });
              toast('Drones dispatched to launcher');
            } }, 'Відправити на майданчик (Dispatch to launcher)'));
          }
          side.append(box);
        }
        if (d.garrison && b.progress >= 1 && !locked) {
          const inside = b.inside ?? [];
          side.append(h('div', { class: 'stat' }, `Garrison: ${inside.length}/${d.garrison.capacity}`));
          if (inside.length) side.append(h('div', { class: 'row pupils' }, ...inside.map((u) => unitIcon(defU.get(u.def)!, u.rank))), h('button', { onClick: () => send({ type: 'release', building: b.id }) }, 'Send everyone out'));
          side.append(h('div', { class: 'muted' }, 'Select squads on foot and right click the bunker to man it. They fire out and cannot be hit until it falls.'));
        }
        if (d.training && b.progress >= 1 && !locked) {
          const t = d.training;
          const inside = b.inside ?? [];
          const rk = ranks();
          const coming = snap.units.filter((u) => u.entering === b.id).length;
          side.append(h('div', { class: 'stat' }, `Inside: ${inside.length}/${t.capacity}${coming ? ` · ${coming} on the way` : ''}`));
          if (inside.length) {
            // dimmed: inside, but needs a kill since its last course before it can rank up again
            side.append(h('div', { class: 'row pupils' }, ...inside.map((u) => {
              const ic = unitIcon(defU.get(u.def)!, u.rank);
              if (!u.ready) (ic.style.opacity = '0.35'), (ic.title = 'Needs at least one kill since its last course');
              return ic;
            })));
            const waiting = inside.filter((u) => !u.ready).length;
            if (waiting) side.append(h('div', { class: 'stat warn' }, `${waiting} cannot rank up yet: above Recruit a unit needs at least one kill since its last course`));
          }
          if (b.course) {
            const done = 1 - b.course.remaining / b.course.total;
            side.append(h('div', { class: 'stat' }, `Course in progress: ${b.course.remaining}s left · paid as it runs, pauses if money runs out`), h('div', { class: 'bar' }, h('i', { style: { width: `${Math.round(done * 100)}%`, background: 'var(--accent)' } })));
          } else {
            const rules = init.ruleset.rules;
            let top = 0;
            let perSec = 0;
            let able = 0;
            for (const u of inside) {
              if (!u.ready) continue;
              able++;
              top = Math.max(top, u.rank + 1);
              perSec += (rules.courseCostPerTick + rules.courseCostPerRank * u.rank) * rules.tickRate;
            }
            const ready = able >= t.minUnits;
            // the same time the server will use (sandbox runs courses faster)
            const secs = Math.round((t.baseTime + t.timePerRank * top) * rules.buildTimeMult);
            side.append(
              h('button', { class: 'bld', disabled: !ready || undefined, onClick: () => send({ type: 'course', building: b.id }) },
                h('span', { class: 'ico' }, '⚑'),
                h('span', { class: 'meta' },
                  h('b', {}, ready ? `Start course · ${secs}s → ${rk[top]?.name ?? ''}` : `Needs ${t.minUnits - able} more unit${t.minUnits - able === 1 ? '' : 's'} that can rank up`),
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
          const queued = snap.queue.filter((x) => x.building === b.id);
          // the queue panel lives beside the description window and survives its rebuilds
          if (d.trains?.length && sideQueue?.building !== b.id) {
            const list = new QueueList(queueCtx, 5, d.name);
            list.update(queued);
            sideQueue = { list, building: b.id };
            queueSlot.replaceChildren(list.el);
          }
          // rally point: where new units go (craft go to their launcher instead)
          if (d.trains?.length) {
            side.append(h('div', { class: 'row' },
              h('button', { class: 'hud-btn sm' + (pick.rally?.building === b.id ? ' active' : ''), title: 'Click the map: new ground units walk there', onClick: () => ((pick.rally = pick.rally ? null : { building: b.id }), render()) }, b.rally ? 'Move rally point' : 'Set rally point'),
              b.rally ? h('button', { class: 'hud-btn sm warn', onClick: () => send({ type: 'rally', building: b.id, pos: null }) }, 'Clear') : null,
              h('span', { class: 'muted' }, b.rally ? 'new units walk to the flag' : 'new units stay here')));
          }
          for (const uid of d.trains ?? []) {
            const u = defU.get(uid)!;
            if (u.side && u.side !== mySide) continue;
            // money and people from the treasury, materials from this building's own store
            const have: Record<string, number> = { ...(b.storage ?? {}), money: snap.res.money ?? 0, people: snap.res.people ?? 0 };
            const short = Object.entries(u.cost).find(([k, v]) => (have[k] ?? 0) < v);
            const n = queued.filter((x) => x.unit === uid).length;
            const btn = h('button', { class: 'bld' + (short ? ' short' : ''), onClick: () => send({ type: 'train', building: b.id, unit: uid }) },
              unitIcon(u, 0), n ? h('span', { class: 'qcount', title: `${n} in the queue` }, `×${n}`) : null,
              h('span', { class: 'meta' }, h('b', {}, `Train ${u.name} · ${Math.round(u.trainTime * init.ruleset.rules.trainTimeMult * 10) / 10}s`), costHtml(u.cost, have),
                short && short[0] !== 'money' && short[0] !== 'people' ? h('small', { class: 'warn' }, `Not enough ${short[0]} on site: deliver it by truck`) : null));
            describe(btn, u.name, u.description, unitFacts(u), 'left');
            // repeat: keep making this one while resources last
            const rep = h('button', { class: 'rep' + (b.repeat === uid ? ' on' : ''), title: b.repeat === uid ? 'Stop repeating' : `Keep training ${u.name} while resources last`, onClick: (e: MouseEvent) => (e.stopPropagation(), send({ type: 'repeat', building: b.id, unit: b.repeat === uid ? null : uid })) }, '↻');
            if (b.owner === me) btn.append(rep);
            side.append(btn);
          }
        }
        if (b.def === 'power_plant' || b.progress >= 1) ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'powerLines', building: b.id } satisfies ClientMsg));
        if (b.def !== 'hq' && b.owner === me) side.append(h('button', { class: 'ghost', onClick: () => (send({ type: 'demolish', building: b.id }), (selBuilding = null)) }, 'Demolish (40% refund)'));
      }
    } else if (selUnits.size) {
      let effects: { id: string; v: number; n: number }[] = [];
      const mine = snap.units.filter((u) => selUnits.has(u.id) && u.team === init!.team);
      if (!mine.length) {
        clear(side);
        return;
      }
      const rk = ranks();
      const group = [...groups.values()].find((g) => g.ids.size === mine.length && mine.every((u) => g.ids.has(u.id)));
      side.append(h('h3', {}, group ? `Группа ${group.id} · ${mine.length} отряд.` : `${mine.length} ${mine.length === 1 ? 'отряд выбран' : 'отрядов выбрано'}`));

      if (mine.length === 1) {
        const u = mine[0];
        const d = defU.get(u.def)!;
        const isOwn = u.owner === me;
        const isFrontGarrison = u.def === 'frontline_infantry' || u.owner.startsWith('__front_');
        const squadCount = u.squadSize ?? d.squadSize ?? (isFrontGarrison ? 100 : 5);

        if (isFrontGarrison) {
          const statusText = u.frontStatus === 'advancing'
            ? '⚔️ Гарнизон фронта (медленно наступает)'
            : u.frontStatus === 'retreating'
            ? '⚠️ Гарнизон фронта (медленно отступает)'
            : (u.advancePath && u.advancePath.length > 0
              ? '🛡️ Гарнизон фронта (удерживает рубеж: силы равны)'
              : '🛡️ Гарнизон фронта (удерживает рубеж)');
          const statusColor = u.frontStatus === 'advancing' ? '#4ade80' : u.frontStatus === 'retreating' ? '#f87171' : '#8ec5fc';

          const isAdvActive = garrisonPlan?.unitId === u.id && garrisonPlan.mode === 'advance';
          const isRetActive = garrisonPlan?.unitId === u.id && garrisonPlan.mode === 'retreat';

          const advBtn = h(
            'button',
            {
              class: isAdvActive ? 'primary' : 'ghost',
              style: { flex: '1', fontSize: '11px', padding: '4px 6px', borderColor: isAdvActive ? '#22c55e' : undefined },
              onClick: () => {
                if (isAdvActive) {
                  garrisonPlan = null;
                  toast('Маршрут наступления сохранен');
                } else {
                  garrisonPlan = { unitId: u.id, mode: 'advance' };
                  toast('Кликайте по карте для задания точек наступления (ПКМ для завершения)');
                }
                render();
              },
            },
            isAdvActive ? '✓ Готово' : '⚔️ Наступление',
          );

          const retBtn = h(
            'button',
            {
              class: isRetActive ? 'primary' : 'ghost',
              style: { flex: '1', fontSize: '11px', padding: '4px 6px', borderColor: isRetActive ? '#f97316' : undefined },
              onClick: () => {
                if (isRetActive) {
                  garrisonPlan = null;
                  toast('Маршрут отступления сохранен');
                } else {
                  garrisonPlan = { unitId: u.id, mode: 'retreat' };
                  toast('Кликайте по карте для задания точек отступления (ПКМ для завершения)');
                }
                render();
              },
            },
            isRetActive ? '✓ Готово' : '🛡️ Отступление',
          );

          const clearBtn = h(
            'button',
            {
              class: 'ghost',
              style: { fontSize: '11px', padding: '4px 6px', color: '#f87171' },
              title: 'Сбросить маршруты',
              onClick: () => {
                u.advancePath = [];
                u.retreatPath = [];
                garrisonPlan = null;
                send({ type: 'setGarrisonPlan', unitId: u.id, advancePath: [], retreatPath: [] });
                toast('Маршруты сброшены');
                render();
              },
            },
            '✕ Сброс',
          );

          const advInfo = u.advancePath && u.advancePath.length > 0
            ? `Наступление: ${u.advancePath.length} точ.`
            : 'Наступление: прямо';
          const retInfo = u.retreatPath && u.retreatPath.length > 0
            ? `Отступление: ${u.retreatPath.length} точ.`
            : 'Отступление: в тыл';

          side.append(
            h('div', { class: 'row' }, unitIcon(d, u.rank), h('div', {}, h('b', {}, 'Пехотный рубеж'), h('div', { class: 'muted' }, `Численность: ${squadCount} бойцов`))),
            h('div', { class: 'stat', style: { fontWeight: '600', color: '#e2e8f0', margin: '8px 0' } }, `Сила: ${u.strength ?? 1} · Мораль: ${u.morale ?? 100}% · БК: ${Math.round(u.ammo ?? 100)} / ${(u.strength ?? 1) * 100}`),
            h('div', { class: 'stat', style: { color: statusColor, marginTop: '4px' } }, statusText),
            h('div', { class: 'stat', style: { fontSize: '11px', color: '#94a3b8', marginTop: '6px' } }, `${advInfo} · ${retInfo}`),
            h('div', { style: { display: 'flex', gap: '4px', marginTop: '6px' } }, advBtn, retBtn, clearBtn),
          );
          if (garrisonPlan?.unitId === u.id) {
            side.append(
              h('div', { class: 'stat', style: { color: '#fbbf24', marginTop: '6px', fontSize: '11px' } }, garrisonPlan.mode === 'advance' ? 'Кликайте по карте для точек наступления. ПКМ — закончить.' : 'Кликайте по карте для точек отступления. ПКМ — закончить.'),
            );
          }
          side.append(h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '11px' } }, 'ПКМ своим отрядом пехоты по этой позиции для отправки на укрепление.'));
        } else if (u.def === 'infantry') {
          side.append(
            h('div', { class: 'row' }, unitIcon(d, u.rank), h('div', {}, h('b', {}, d.name), h('div', { class: 'muted' }, `Численность: ${squadCount} бойцов`))),
            h('div', { class: 'stat', style: { fontWeight: '600', color: '#e2e8f0', margin: '8px 0' } }, `Сила: ${u.strength ?? 1} · Мораль: ${u.morale ?? 100}% · БК: ${u.ammo ?? 100}%`),
            h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } }, 'ПКМ по отряду на фронте — отправить на укрепление позиции.'),
          );
          if (u.entering) side.append(h('div', { class: 'stat', style: { color: 'var(--accent)' } }, 'Движется в учебный центр'));
        } else {
          const sub = d.squadSize ? `Численность: ${squadCount} бойцов` : (rk[u.rank]?.name ?? '');
          side.append(
            h('div', { class: 'row' }, unitIcon(d, u.rank), h('div', {}, h('b', {}, d.name), h('div', { class: 'muted' }, sub))),
            h('div', { class: 'stat' }, `Здоровье: ${u.hp} / ${Math.round(maxHp(u))}${u.morale !== undefined ? ` · Мораль: ${u.morale}` : ''}`),
          );
          if (d.damage > 0) side.append(h('div', { class: 'stat' }, `Урон: ${d.damage}/с · Дальность: ${d.range} км · Обзор: ${d.vision} км`));
          if (d.maxAmmo) side.append(h('div', { class: 'stat' + ((u.ammo ?? 0) < (d.ammoPerShot ?? 1) ? ' warn' : '') }, `Боезапас: ${u.ammo ?? 0}/${d.maxAmmo}`));
          if (d.description) side.append(h('div', { class: 'muted', style: { marginTop: '8px', lineHeight: '1.4' } }, d.description));
          if (u.entering) side.append(h('div', { class: 'stat', style: { color: 'var(--accent)' } }, 'Движется в учебный центр'));
          if (!isOwn) {
            side.append(h('div', { class: 'stat', style: { color: '#8ec5fc', marginTop: '10px' } }, '🛡️ Гарнизон фронта (не подчиняется приказам)'));
          }
        }
        effects = u.status.map(([id, v]) => ({ id, v, n: 1 }));
      } else {
        const totalStr = mine.reduce((sum, u) => sum + (u.strength ?? 1), 0);
        const totalMen = mine.reduce((sum, u) => sum + (u.squadSize ?? defU.get(u.def)?.squadSize ?? 20), 0);
        side.append(h('div', { class: 'stat', style: { fontWeight: '600', color: '#e2e8f0', marginBottom: '8px' } }, `Общая сила: ${totalStr} · Всего бойцов: ${totalMen}`));
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
        effects = [...agg.values()];
      }

      const anyOwn = mine.some((u) => u.owner === me && !defU.get(u.def)?.stationary && !u.owner.startsWith('__front_'));
      if (anyOwn) {
        const formationBox = h('input', { type: 'checkbox', checked: formation || undefined });
        formationBox.addEventListener('change', () => (formation = formationBox.checked));
        if (mine.length > 1) side.append(h('label', { class: 'field check' }, formationBox, h('span', {}, 'Двигаться в строю')));
        side.append(
          h('div', { class: 'row', style: { marginTop: '12px' } },
            h('button', { onClick: () => makeGroup() }, 'Группа (G)'),
            group ? h('button', { onClick: () => ungroup() }, 'Разгруппировать (U)') : null,
            h('button', { class: 'ghost', onClick: () => send({ type: 'stop', units: [...selUnits] }) }, 'Стоп (S)'),
          ),
        );
      }
      renderEffects(effects);
    }
    if (!selUnits.size || selBuilding !== null) renderEffects(null);
    side.classList.toggle('open', side.childElementCount > 0);
  }

  /**
   * Buffs and debuffs of the selection: their own small panel left of the description window (where the production queue
   * goes for buildings). Icon and name only; hovering one shows what it does. Rebuilt only when the set changes.
   */
  let effectsKey = '';
  function renderEffects(items: { id: string; v: number; n: number }[] | null) {
    const key = items ? items.map((x) => `${x.id}:${x.n}:${x.v.toFixed(2)}`).join('|') : '';
    if (key === effectsKey && (items ? effectsSlot.childElementCount > 0 : effectsSlot.childElementCount === 0)) return;
    effectsKey = key;
    effectsSlot.replaceChildren();
    if (!items) return;
    items.sort((a, b) => Number(DEBUFFS.has(a.id)) - Number(DEBUFFS.has(b.id)));
    const box = h('div', { class: 'effects-panel' }, h('div', { class: 'queue-head' }, h('em', {}, 'Effects'), h('span', {}, items.length ? `${items.filter((x) => !DEBUFFS.has(x.id)).length} buffs · ${items.filter((x) => DEBUFFS.has(x.id)).length} debuffs` : 'none')));
    for (const it of items) {
      const good = !DEBUFFS.has(it.id);
      const def = STATUS[it.id];
      const ico = h('span', { class: 'st' });
      ico.innerHTML = statusIconHtml(it.id, good);
      const row = h('div', { class: 'effect ' + (good ? 'good' : 'bad') }, ico, h('b', {}, def?.name ?? it.id), it.n > 1 ? h('em', {}, `×${it.n}`) : null);
      describe(row, def?.name ?? it.id, def?.text(it.v) ?? '', it.n > 1 ? [`${it.n} of the selected units`] : [], 'left');
      box.append(row);
    }
    effectsSlot.append(box);
  }

  function unitIcon(d: UnitDef, rank: number) {
    if (d.kind === 'air') {
      const c = h('canvas', { class: 'nato-ico drone-ico', width: 128, height: 128, title: d.name });
      void aircraftSprite(d.id, relColor('own'), false).then((img) => c.getContext('2d')!.drawImage(img, 0, 0, 128, 128));
      return c;
    }
    const c = h('canvas', { class: 'nato-ico', width: 128, height: 128 });
    c.getContext('2d')!.putImageData(drawNato({ hostile: false, color: relColor('own'), symbol: d.symbol ?? 'infantry', mobility: mobilityOf(d), echelon: '', rank, selected: false, own: true, transport: false }), 0, 0);
    return c;
  }

  // ---------- snapshot → view ----------
  let lastPalette = 0;
  /**
   * Enemy buildings once seen stay on the map at half opacity where they were last seen: they may have been demolished
   * since. The memory is dropped when that spot is in sight again and the building is not there.
   */
  function rememberBuildings(s: SnapMsg) {
    if (!init?.ruleset.rules.fogOfWar) return void (lastKnown.clear(), (staleBuildings = []));
    const now = new Set<number>();
    for (const b of s.buildings) {
      if (b.team === init.team) continue;
      now.add(b.id);
      lastKnown.set(b.id, { b: { ...b }, at: s.time });
    }
    staleBuildings = [];
    if (lastKnown.size === now.size) return;
    // own sight, a little short of the server's (terrain can cut it to 80%) so a memory is only dropped when surely seen
    const eyes: { pos: LngLat; r: number }[] = [];
    for (const u of s.units) if (u.team === init.team) {
      const d = defU.get(u.def);
      if (d) eyes.push({ pos: u.pos, r: d.vision * (d.kind === 'air' ? 0.95 : 0.75) });
    }
    for (const b of s.buildings) if (b.team === init.team && b.progress >= 1) eyes.push({ pos: b.pos, r: (defB.get(b.def)?.vision ?? 6) * 0.95 });
    for (const [id, k] of lastKnown) {
      if (now.has(id)) continue;
      if (eyes.some((e) => distKm(e.pos, k.b.pos) <= e.r)) lastKnown.delete(id); // looked again: it is gone
      else staleBuildings.push(k);
    }
  }

  function onSnapshot(s: SnapMsg) {
    if (import.meta.env.DEV) s.pockets.push(...((window as any).__sw?.fakePockets ?? [])), s.grey.push(...((window as any).__sw?.fakeGrey ?? [])); // browser tests draw cauldrons this way
    // riders and craft waiting at launchers are listed in panels, not drawn on the map
    stored = s.units.filter((u) => u.embarkedIn !== undefined || u.parkedAt !== undefined);
    s.units = s.units.filter((u) => u.embarkedIn === undefined && u.parkedAt === undefined);
    if (import.meta.env.DEV) s.buildings.push(...((window as any).__sw?.fakeBuildings ?? [])); // browser tests: enemy buildings that come and go
    snap = s;
    rememberBuildings(s);
    if (import.meta.env.DEV && (window as any).__sw?.fakeLiberated) s.liberated = (window as any).__sw.fakeLiberated; // browser tests
    if (s.liberated) {
      libRuns = s.liberated;
      libCells = new Map();
      for (let k = 0; k < libRuns.length; k += 4) for (let i = 0; i < libRuns[k + 3]; i++) libCells.set(libKey(libRuns[k + 2] + i, libRuns[k]), libRuns[k + 1]);
      libDirty = true;
    }
    if (shown.length !== s.front.length) shown = s.front.map((n) => ({ ...n }));
    pruneGroups();
    for (const id of selUnits) if (!s.units.some((u) => u.id === id)) selUnits.delete(id);
    showCountdown(s.countdown);
    showStart();
    showPeace();
    updateQueues(s);
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
      orders, stored, snap, me, myTeam: init.team, sel: selUnits, defU, defB, roadMult: init.ruleset.rules.roadSpeedMult, fuelPerKm: init.ruleset.rules.fuelPerKm, pick, send, toast, rerender: render, icon: unitIcon, pos: posOf,
    });
    routeBanner.style.display = pick.route ? 'block' : 'none';
    routeBanner.textContent = pick.route
      ? pick.route.stops.length ? 'Delivery route: click buildings to add stops, the map to add a waypoint, then Start route (Esc cancels)' : 'Delivery route: click the building to load at (Esc cancels)'
      : '';
    mapEl.classList.toggle('picking', !!(pick.route || pick.bombard || pick.launch || pick.fuel || pick.launchFrom || pick.rally || garrisonPlan));
  }

  /** Full refresh after a local change (selection, grouping). */
  function render() {
    if (garrisonPlan && !selUnits.has(garrisonPlan.unitId)) garrisonPlan = null;
    if (sideQueue && selBuilding !== sideQueue.building) (sideQueue = null), queueSlot.replaceChildren();
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
      const totalStrength = us.reduce((sum, u) => sum + (u.strength ?? 1), 0);
      formations.push({ type: 'Feature', properties: { gid: g.id, own: true, z: sel ? 3 : 2, ...natoLayers({ hostile: false, color: relColor('own'), symbol, mobility: sharedMobility(us), echelon: echelonFor(totalStrength), rank, selected: sel, own: true, transport: us.filter((u) => u.transport).length * 2 > us.length, strength: totalStrength > 1 ? totalStrength : undefined }) }, geometry: { type: 'Point', coordinates: c } });
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
      const totalStrength = us.reduce((sum, u) => sum + (u.strength ?? 1), 0);
      formations.push({
        type: 'Feature',
        properties: { own, ids: own ? JSON.stringify(us.map((u) => u.id)) : '', z: sel ? 3 : own ? 2 : 1, ...natoLayers({ hostile: us[0].team !== myTeam, color: relColor(relOf(us[0])), symbol, mobility: sharedMobility(us), echelon: totalStrength > 1 ? echelonFor(totalStrength) : '', rank: Math.round(us.reduce((a, u) => a + u.rank, 0) / us.length), selected: sel, own, transport: us.filter((u) => u.transport).length * 2 > us.length, strength: totalStrength > 1 ? totalStrength : undefined }) },
        geometry: { type: 'Point', coordinates: centroid(us) },
      });
    }
    (map.getSource('formations') as GeoJSONSource).setData({ type: 'FeatureCollection', features: formations });

    renderSelLines();

    // vision rings for own long-range assets
    // trench lines
    const trenches: any[] = [];
    const staleIds = new Set(staleBuildings.map((x) => x.b.id));
    for (const b of [...snap.buildings, ...staleBuildings.map((x) => x.b)]) {
      if (!b.line) continue;
      const [a, c] = b.line;
      const kx = Math.cos((a[1] * Math.PI) / 180) * 111.32;
      const dx = (c[0] - a[0]) * kx, dy = (c[1] - a[1]) * 111.32, len = Math.hypot(dx, dy) || 1;
      const n = Math.max(2, Math.round(len / 0.12));
      const pts: LngLat[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n, side = i === 0 || i === n ? 0 : i % 2 ? 0.05 : -0.05;
        pts.push(offsetKm([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t], (-dy / len) * side, (dx / len) * side));
      }
      const bridge = !!defB.get(b.def)?.spansWater;
      const rail = !!defB.get(b.def)?.rail;
      trenches.push({ type: 'Feature', properties: { id: b.id, kind: bridge ? 'bridge' : rail ? 'rail' : 'trench', color: bridge ? '#e7e2cf' : rail ? '#f1f5f9' : relColor(b.owner === me ? 'own' : b.team === myTeam ? 'ally' : 'enemy'), o: staleIds.has(b.id) ? 0.45 : b.progress >= 1 ? 0.95 : 0.4 }, geometry: { type: 'LineString', coordinates: bridge || rail ? [a, c] : pts } });
    }
    (map.getSource('trenches') as GeoJSONSource).setData({ type: 'FeatureCollection', features: trenches } as any);
    const rings: any[] = [];
    // the selected building's rally point: a dashed line to a flag
    const rallyB = selBuilding !== null ? snap.buildings.find((x) => x.id === selBuilding && x.rally) : null;
    if (rallyB?.rally) {
      rings.push({ type: 'Feature', properties: { color: '#ffe45c', w: 2, o: 0.9 }, geometry: { type: 'LineString', coordinates: [rallyB.pos, rallyB.rally] } });
      rings.push({ type: 'Feature', properties: { color: '#ffe45c', w: 2, o: 0.9 }, geometry: { type: 'LineString', coordinates: circle(rallyB.rally, 0.4, 16) } });
    }
    // the selected building: every range it has, bold (what it covers while you read its description)
    const selB = selBuilding !== null ? snap.buildings.find((x) => x.id === selBuilding) : null;
    if (selB) {
      const d = defB.get(selB.def)!;
      const r = init.ruleset.rules;
      const big = (km: number, color: string) => rings.push({ type: 'Feature', properties: { color, w: 2, o: 0.9, sel: true }, geometry: { type: 'Polygon', coordinates: [circle(selB.pos, km, 96)] } });
      if (d.aura) big(d.aura.radiusKm, '#a3e635');
      if (d.defense && selB.line) rings.push({ type: 'Feature', properties: { color: '#4ade80', w: 2, o: 0.9, sel: true }, geometry: { type: 'Polygon', coordinates: [capsule(selB.line[0], selB.line[1], d.defense.radiusKm)] } });
      else if (d.defense) big(d.defense.radiusKm, '#4ade80');
      if (d.supply) big(d.supply.radiusKm, '#e39b4f');
      if (d.heals) big(d.heals.radiusKm, '#f472b6');
      if (d.attack) big(d.attack.range, '#ffd84a');
      if (d.crossing) big(d.crossing.radiusKm, '#7fe7ff');
      if (selB.def === 'power_plant') big(r.powerGridKm, '#38bdf8');
      if (selB.def === 'hq') big(100, '#ef4444');
      if (selB.def === 'military_base') big(20, '#38bdf8');
      if (selB.def === 'warehouse') big(100, '#eab308');
      if (d.vision) big(d.vision, '#94a3b8');
    }
    for (const b of snap.buildings) {
      const d = defB.get(b.def)!;
      if (b.team !== myTeam || b.progress < 1 || b === selB) continue;
      const ring = (km: number, color: string) => rings.push({ type: 'Feature', properties: { color }, geometry: { type: 'LineString', coordinates: circle(b.pos, km, 64) } });
      if (b.owner === me && b.def === 'military_base') ring(20, '#38bdf8');
      if (b.owner === me && b.def === 'hq') ring(100, '#ef4444');
      if (b.owner === me && b.def === 'warehouse') ring(100, '#eab308');
      if (b.owner === me && (d.vision ?? 0) >= 20) ring(d.vision!, TEAM_COLOR[b.team]);
      if (d.attack) ring(d.attack.range, '#ffd84a');
      if (d.crossing) ring(d.crossing.radiusKm, '#7fe7ff');
      if (d.supply) ring(d.supply.radiusKm, (b.storage?.ammo ?? 0) > 0 ? '#e39b4f' : '#6b7280');
    }
    // artillery reach for selected guns: outer = max range, inner = minimum range
    for (const u of snap.units) {
      const d = defU.get(u.def);
      if (!selUnits.has(u.id) || !d?.minRange) continue;
      rings.push({ type: 'Feature', properties: { color: '#f59e0b' }, geometry: { type: 'LineString', coordinates: circle(posOf(u), d.range, 64) } });
      rings.push({ type: 'Feature', properties: { color: '#ef4444' }, geometry: { type: 'LineString', coordinates: circle(posOf(u), d.minRange, 48) } });
      if (u.bombardTarget) rings.push({ type: 'Feature', properties: { color: '#ef4444' }, geometry: { type: 'LineString', coordinates: circle(u.bombardTarget, 1, 32) } });
    }
    // planned routes for frontline garrisons (advance = green, retreat = orange)
    for (const u of snap.units) {
      if (!selUnits.has(u.id)) continue;
      const isFrontGarrison = u.def === 'frontline_infantry' || u.owner.startsWith('__front_');
      if (!isFrontGarrison) continue;
      if (u.advancePath && u.advancePath.length > 0) {
        rings.push({
          type: 'Feature',
          properties: { color: '#22c55e', w: 3, o: 0.9 },
          geometry: { type: 'LineString', coordinates: [posOf(u), ...u.advancePath] },
        });
        for (const pt of u.advancePath) {
          rings.push({
            type: 'Feature',
            properties: { color: '#22c55e', w: 2, o: 0.9 },
            geometry: { type: 'LineString', coordinates: circle(pt, 0.25, 16) },
          });
        }
      }
      if (u.retreatPath && u.retreatPath.length > 0) {
        rings.push({
          type: 'Feature',
          properties: { color: '#f97316', w: 3, o: 0.9 },
          geometry: { type: 'LineString', coordinates: [posOf(u), ...u.retreatPath] },
        });
        for (const pt of u.retreatPath) {
          rings.push({
            type: 'Feature',
            properties: { color: '#f97316', w: 2, o: 0.9 },
            geometry: { type: 'LineString', coordinates: circle(pt, 0.25, 16) },
          });
        }
      }
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

    const housingFeatures: any[] = [];
    for (const b of snap.buildings) {
      if (b.def !== 'housing') continue;
      if (b.houses && b.houses.length > 0) {
        for (const h of b.houses) {
          if (h.hp > 0) {
            housingFeatures.push({
              type: 'Feature',
              properties: { team: b.team, id: h.id, hp: h.hp, maxHp: h.maxHp },
              geometry: { type: 'Polygon', coordinates: [h.poly] },
            });
          }
        }
      } else {
        const polys = generateCityHousePolygons(b.pos, b.id);
        for (const poly of polys) {
          housingFeatures.push({
            type: 'Feature',
            properties: { team: b.team },
            geometry: { type: 'Polygon', coordinates: poly },
          });
        }
      }
    }
    (map.getSource('housing-osm') as GeoJSONSource)?.setData({
      type: 'FeatureCollection',
      features: housingFeatures,
    });

    // buildings → DOM markers with construction animation
    const alive = new Set<number>();
    for (const b of snap.buildings) {
      if (b.def === 'trench') continue;
      alive.add(b.id);
      const d = defB.get(b.def)!;
      let m = bMarkers.get(b.id);
      if (!m) {
        const el = h('div', { class: `bm t${b.team} bm-${b.def}` });
        el.innerHTML = `<div class="blueprint"></div><svg class="ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" /></svg><div class="glyph"></div><div class="qbar"><i></i></div>`;
        if (b.def === 'housing') {
          el.querySelector('.glyph')!.innerHTML = `<svg class="bld-house-ico" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>`;
        } else if (b.def === 'refinery') {
          el.querySelector('.glyph')!.innerHTML = REFINERY_SVG;
        } else {
          el.querySelector('.glyph')!.textContent = d.icon;
        }
        el.addEventListener('click', (ev) => {
          if (placing || b.team !== myTeam) return;
          ev.stopPropagation();
          if (pick.route) {
            // delivery route: each building is a stop (the first loads, later ones unload; switch it in the panel)
            if (pick.route.stops.length >= 6) return toast('A route has at most 6 stops', true);
            const action = pick.route.stops.some((x) => x.action === 'load') ? 'unload' : 'load';
            pick.route.stops.push({ action, building: b.id });
            toast(`${action === 'load' ? 'Load' : 'Unload'} at ${d.name}`);
            return render();
          }
          selBuilding = b.id;
          selUnits.clear();
          render();
        });
        el.addEventListener('contextmenu', (ev) => {
          // right click on your own training centre with units selected sends them inside
          if (b.team !== myTeam || !(d.training || d.garrison) || !selUnits.size) return;
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
      m.el.classList.toggle('route-candidate', !!pick.route && !pick.route.stops.some((x) => x.building === b.id));
      m.el.classList.toggle('route-from', !!pick.route?.stops.some((x) => x.building === b.id));
      m.el.classList.toggle('selected', selBuilding === b.id);
      m.el.style.setProperty('--p', String(b.progress));
      m.el.dataset.n = b.inside?.length ? String(b.inside.length) : '';
      m.el.dataset.lv = b.level > 1 ? 'I'.repeat(b.level) : '';
      m.el.classList.toggle('busy', !!b.course);
      // training: a thin progress bar under the marker and the number of orders
      const q = snap.queue.filter((x) => x.building === b.id);
      m.el.classList.toggle('training', q.length > 0);
      m.el.dataset.q = q.length > 1 ? String(q.length) : '';
      if (q.length) m.el.style.setProperty('--q', String(Math.max(0, Math.min(1, 1 - q[0].remaining / Math.max(0.01, q[0].total)))));
      if (done && !m.done) {
        m.done = true;
        m.el.classList.add('complete');
        const el = m.el;
        setTimeout(() => el.classList.remove('complete'), 1200);
      }
      if (m.el.classList.contains('stale')) m.el.classList.remove('stale'), (m.el.title = '');
    }
    // enemy buildings out of sight: where they were last seen, half transparent
    for (const { b, at } of staleBuildings) {
      if (b.line) continue; // drawn with the lines
      alive.add(b.id);
      let m = bMarkers.get(b.id);
      if (!m) {
        const el = h('div', { class: `bm t${b.team} bm-${b.def}` });
        el.innerHTML = `<div class="blueprint"></div><svg class="ring" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" /></svg><div class="glyph"></div><div class="qbar"><i></i></div>`;
        if (b.def === 'housing') {
          el.querySelector('.glyph')!.innerHTML = `<svg class="bld-house-ico" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>`;
        } else if (b.def === 'refinery') {
          el.querySelector('.glyph')!.innerHTML = REFINERY_SVG;
        } else {
          el.querySelector('.glyph')!.textContent = defB.get(b.def)?.icon ?? '?';
        }
        m = { el, marker: new maplibregl.Marker({ element: el }).setLngLat(b.pos).addTo(map), done: true };
        bMarkers.set(b.id, m);
      }
      if (!m.el.classList.contains('stale')) {
        m.el.classList.add('stale');
        m.el.classList.remove('training', 'busy', 'selected');
        m.el.dataset.q = '';
      }
      const ago = Math.max(0, Math.round((snap.time - at) / 60));
      m.el.title = `${defB.get(b.def)?.name ?? b.def}: last seen ${ago ? `${ago} min ago` : 'just now'}. It may have been destroyed or demolished since.`;
    }
    for (const [id, m] of bMarkers) {
      if (!alive.has(id)) {
        m.el.classList.remove('stale');
        m.el.classList.add('gone');
        setTimeout(() => m.marker.remove(), 400);
        bMarkers.delete(id);
      }
    }

    if (libDirty) {
      // liberated ground still contested: grey cells (rows of them merged into rectangles)
      libDirty = false;
      // traced into smooth outlines: grey = contested after a side took it, blue = liberated by Ukraine
      const { lng: cw, lat: ch } = LIBERATED_CELL;
      const grey: [number, number][] = [], free: [number, number][] = [], fresh: [number, number][] = [];
      for (let k = 0; k < libRuns.length; k += 4) {
        const [iy, kind, ix, n] = [libRuns[k], libRuns[k + 1], libRuns[k + 2], libRuns[k + 3]];
        for (let i = 0; i < n; i++) (kind === 3 ? fresh : kind === 2 ? free : grey).push([ix + i, iy]);
      }
      const shape = (cells: [number, number][]) => ({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: cellsToMultiPolygon(cells, cw, ch) } });
      (map.getSource('liberated') as GeoJSONSource).setData(shape(grey) as any);
      (map.getSource('freed') as GeoJSONSource).setData(shape(free) as any);
      (map.getSource('freed-new') as GeoJSONSource).setData(shape(fresh) as any);
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

    // Frontline garrison posts (Requirements 1, 3, 4, 5, 6)
    const alivePosts = new Set<number>();
    for (const p of snap.posts ?? []) {
      alivePosts.add(p.id);
      let m = postMarkers.get(p.id);
      const isFriendly = p.team === myTeam;
      const empty = p.garrison.length === 0;
      const title = empty
        ? (isFriendly ? 'Прорив / порожній рубіж! Правий клік щоб зайняти гарнізон' : 'Порожній рубіж ворога! Правий клік щоб атакувати рубежем')
        : `Гарнізон рубежу: ${p.garrison.length}/${p.cap}${p.advancing ? ' (Наступ)' : ''}`;
      const innerCls = `post-inner ${isFriendly ? 'friendly' : 'hostile'} ${empty ? 'post-empty' : 'post-occupied'}${p.advancing ? ' advancing' : ''}`;
      const innerHtml = empty
        ? `<span class="post-empty-tag">!</span>`
        : `<svg class="post-shield-ico" viewBox="0 0 16 16"><path d="M8 1.5 13.5 3.5v4.2c0 3.2-2.3 5.6-5.5 6.8C4.8 13.3 2.5 10.9 2.5 7.7V3.5z" fill="currentColor"/></svg>${p.garrison.length > 1 ? `<span class="post-count">${p.garrison.length}</span>` : ''}${p.advancing ? '<span class="post-adv">▲</span>' : ''}`;
      if (!m) {
        const el = h('div', {
          class: 'maplibregl-marker post-marker',
          onClick: (e: MouseEvent) => {
            e.stopPropagation();
            const cur = snap?.posts?.find((x) => x.id === p.id)?.pos ?? p.pos;
            if (selUnits.size) moveOrder(cur, e);
          },
          onContextmenu: (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const cur = snap?.posts?.find((x) => x.id === p.id)?.pos ?? p.pos;
            if (selUnits.size) moveOrder(cur, e);
          },
        });
        const inner = h('div', { class: innerCls, title });
        inner.innerHTML = innerHtml;
        el.append(inner);
        const marker = new maplibregl.Marker({ element: el }).setLngLat(p.pos).addTo(map);
        m = { el, marker };
        postMarkers.set(p.id, m);
      } else {
        m.marker.setLngLat(p.pos);
        const inner = m.el.firstElementChild as HTMLElement;
        if (inner) {
          inner.className = innerCls;
          inner.title = title;
          inner.innerHTML = innerHtml;
        }
      }
    }
    for (const [id, m] of postMarkers) {
      if (!alivePosts.has(id)) {
        m.marker.remove();
        postMarkers.delete(id);
      }
    }

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
        let layers: Record<string, string> = {};
        let bearing = 0;
        let scale = 1;
        if (air) {
          icon = `drone|${u.def}|${relOf(u)}|${sel ? 1 : 0}`;
          bearing = droneBearing.get(u.id)?.b ?? u.bearing ?? 0;
          // a strike drone shrinks as it dives on the last 18 km
          if (isStrikeDrone(d) && u.target) scale = Math.min(1, 0.45 + 0.55 * (distKm(pos, u.target) / 18));
        } else {
          const l = natoLayers({ hostile: u.team !== myTeam, color: relColor(relOf(u)), symbol: d?.symbol ?? 'infantry', mobility: mobilityOf(d), echelon: '', rank: u.rank, selected: sel, own, transport: u.transport, encircled: u.encircled, buffs: u.status.filter((x) => !DEBUFFS.has(x[0])).length, debuffs: u.status.filter((x) => DEBUFFS.has(x[0])).length, strength: u.strength });
          ({ icon, ...layers } = l);
        }
        return { type: 'Feature', properties: { id: u.id, own, grp: grouped.has(u.id), air, icon, ...layers, bearing, scale, z: sel ? 4 : air ? 3 : own ? 2 : 1 }, geometry: { type: 'Point', coordinates: pos } };
    });
    // zoomed out, ground units are shown as formations only: skip feeding (and re-tiling) hundreds of hidden markers
    const ground = map.getZoom() >= GROUP_ZOOM - 0.3 ? lastUnitFeatures.filter((f) => !f.properties.air) : [];
    if (ground.length || groundShown) (map.getSource('units') as GeoJSONSource).setData({ type: 'FeatureCollection', features: ground } as any);
    groundShown = ground.length > 0;
    (map.getSource('drone-units') as GeoJSONSource).setData({ type: 'FeatureCollection', features: lastUnitFeatures.filter((f) => f.properties.air) } as any);
  }
  let groundShown = false;
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
    // re-sending every unit to the map is not free: about 20 updates a second look just as smooth
    const now = performance.now();
    if (unitsMoved && now - lastUnitDraw > 50) {
      lastUnitDraw = now;
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
    (map.getSource('front') as GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } } as any);
    (map.getSource('occupied') as GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[[...line, ...init.map.occupiedClosure, line[0]], ...holes, ...mapHoles], ...patches.map((p) => [p])] } } as any);
    (map.getSource('pockets') as GeoJSONSource).setData({ type: 'FeatureCollection', features: snap.pockets.map((k) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(k)] } })) } as any);
  }
  let frontDrawn = false;
  let lastUnitDraw = 0;
  /** Contested liberated ground: runs [iy, team, ix, n, …] from the server, and a lookup of its cells. */
  let libRuns: number[] = [];
  let libCells = new Map<number, number>();
  let libDirty = false;
  const libKey = (ix: number, iy: number) => ix * 100000 + iy;
  /** Team that took this contested liberated cell, or undefined. */
  const contestedAt = (p: LngLat) => libCells.get(libKey(Math.floor(p[0] / LIBERATED_CELL.lng), Math.floor(p[1] / LIBERATED_CELL.lat)));
  let lastFuel = -10;
  let lastPockets = '';

  const ping = setInterval(() => (closed ? clearInterval(ping) : ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ping' } satisfies ClientMsg))), 15000);
}
