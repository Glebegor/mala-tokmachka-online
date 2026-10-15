import type { BuildingDef, Ruleset, UnitDef } from '@sw/core';
import { clear, h } from './dom';

type Section = { id: string; title: string; body: () => (HTMLElement | string)[] };

const p = (...t: (string | HTMLElement)[]) => h('p', {}, ...t);
const list = (...items: string[]) => h('ul', {}, ...items.map((i) => h('li', {}, i)));
const keys = (rows: [string, string][]) => h('table', { class: 'g-keys' }, h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v)))));

const SECTIONS: Section[] = [
  {
    id: 'start', title: 'Getting started', body: () => [
      p('Mala Tokmachka Online is a real-time wargame on the real line of contact: Ukraine against Russia, up to eight players a side (bots fill in if you like).'),
      h('h4', {}, 'How to win'),
      list('Take every city on the map, or', 'destroy every enemy headquarters, or', 'have the higher score when the time runs out (cities you hold earn score every second).'),
      h('h4', {}, 'Your first minutes'),
      list(
        'You start next to your Military Base (HQ) with a few infantry squads. The big arrow points at it.',
        'Build a Power Plant and an Ore Mine, then a Metal Works at least 17.5 km from the mine: a truck carries the ore between them.',
        'Train troops at the HQ, move them to the front with right click, and fortify with trenches and bunkers.',
        'Set up supply: trucks for ore, metal and ammo, fuel trucks for fuel. Units run out of ammo and fuel.',
      ),
      h('h4', {}, 'Lobby options'),
      list(
        'Ceasefire at start (default 15 min): build and deploy, but nobody may shoot or cross the front until it ends.',
        'Game type Sandbox: endless resources, everything ten times faster, no victory: for trying things out.',
        'Fill empty slots with bots, bot difficulty, front speed, fog of war, match length.',
      ),
    ],
  },
  {
    id: 'controls', title: 'Controls', body: () => [
      keys([
        ['Left click', 'Select a unit, formation or building'],
        ['Shift + click', 'Add to / remove from the selection'],
        ['Shift + drag', 'Box selection'],
        ['Right click', 'Move by the fastest route (roads in transport mode, bridges over rivers)'],
        ['Shift + right click', 'Add a waypoint'],
        ['Alt + right click', 'Move straight across country, ready to fight'],
        ['Right drag', 'Move and form up facing the way you drag (line, column or wedge; a spread group forms a line)'],
        ['F', 'Next formation: spread, line, column, wedge'],
        ['S', 'Stop'],
        ['G / U', 'Group / ungroup the selection'],
        ['Ctrl + 1–9, 1–9', 'Assign / select a numbered group (press again to jump to it)'],
        ['P', 'Ping menu: Going here, Defend here, Danger here, Look here (keys 1–4 in the menu)'],
        ['Alt + click', 'Quick "look here" ping for your team'],
        ['T / M', 'Terrain overlay / real map on and off'],
        ['H', 'This guide'],
        ['Esc', 'Cancel placing, picking or pinging'],
      ]),
    ],
  },
  {
    id: 'map', title: 'Reading the map', body: () => [
      h('h4', {}, 'Territory, as on DeepState'),
      list(
        'Red, hatched: ground held by Russia. The red line is the front.',
        'Grey: ground that has just changed hands and is still contested. It becomes the taker\'s once no enemy ground troops have been within 3 km of it for 30 seconds. Nothing but ammo depots can be built on grey ground.',
        'Blue: ground Ukraine has liberated.',
        'Grey circles behind the enemy line: your troops sitting there unopposed (for 10 s) loosen the enemy\'s hold.',
        'Yellow broken ring: a cauldron. Units cut off inside lose strength every second until relieved or destroyed.',
      ),
      h('h4', {}, 'Markers'),
      list(
        'NATO symbols: rectangle = your side, diamond = enemy. Your units are in your nation\'s colour (Ukraine blue, Russia red), allies green.',
        'Under the frame: two wheels = wheeled vehicle, track = tracked. Yellow with » = driving in column on a road.',
        'Right of the frame: rank chevrons. Left: green buff and red debuff pips. On top: the size of a formation.',
      ),
      h('h4', {}, 'Terrain'),
      list(
        'Forest and cities give cover and hide troops; hills and mountains see further; open fields expose.',
        'Big rivers can only be crossed on road bridges or at your pontoon crossings.',
        'Belarus, Moldova and the EU are off limits. Special zones (Kremenchuk refinery, Alabuga) boost one building type.',
      ),
      h('h4', {}, 'Fog of war'),
      p('You only see what your units, buildings and recon drones see. Recon teams are stealthy, signal stations and drones see far. Enemy buildings you have seen stay on the map at half opacity where they were last seen: they may have been destroyed since.'),
    ],
  },
  {
    id: 'economy', title: 'Economy & logistics', body: () => [
      h('h4', {}, 'Two kinds of resources'),
      list(
        'Money, people and energy are pooled for the whole team.',
        'Goods (ore, metal, fuel, ammo) are physical: they lie in buildings. What you can spend on building and upgrades is what lies in your HQ and warehouses (the top bar).',
        'Producers keep what they make in their own store: a truck has to bring it home or to the factory that needs it.',
      ),
      h('h4', {}, 'Supply chains'),
      list(
        'Ore Mine → (truck) → Metal Works → metal → (truck) → HQ, Machine Factory, Ammo Factory…',
        'Oil Refinery → (fuel truck) → Filling Stations, Airfield, HQ.',
        'Ammo Factory → (truck, cargo "Ammo") → Ammo Depots near the front.',
      ),
      h('h4', {}, 'Spacing between sites'),
      list(
        'Ore Mine ↔ Metal Works: at least 17.5 km (the ore goes by truck).',
        'Two mines or two metal works: 2.9 km. Two oil refineries: 4.4 km.',
        'Other civil sites (power plants, housing, filling stations, factories…): 5 km from each other.',
        'Military sites only need their own patch of ground (0.6 km).',
      ),
      h('h4', {}, 'Delivery routes'),
      p('Select a truck, press Set delivery route and click 2–6 stops: buildings to load or unload at (switch each in the panel) and spots on the map to drive through. Choose the cargo ("Any" takes what each destination wants) and how much it must have on board before it leaves. It keeps running the loop: at an empty source it waits, at a full store it waits for room, and when low on fuel it fills up on the way. Goods left on board from an earlier job are dropped at the nearest store first.'),
      h('h4', {}, 'Railways'),
      p('Build Railway Stations and draw Railway track between them (press and drag, up to 40 km a piece; ends near a station or other track join up). A Freight Train carries 20,000 at a time between stations, far faster than trucks. If the track is cut it waits for a connection.'),
      h('h4', {}, 'Bonuses'),
      list('Power Plant: everything within 100 km works 25% faster.', 'Road access: +15% output.', 'Housing: only inside cities your side holds (at most 10 per city).'),
      p('New buildings start empty, except factories, which get materials for two units. Teammates can use your buildings unless you switch Buildings: private.'),
    ],
  },
  {
    id: 'army', title: 'Army', body: () => [
      h('h4', {}, 'Ammunition and fuel'),
      list(
        'Every armed unit carries rounds; each shot uses some (infantry fire 2-round bursts). With too few left it cannot fire.',
        'Units refill near an Ammo Depot (18.75 km) or their base (8 km), paid from that building\'s ammo store. Ammo depots can stand in your grey zones, even behind the enemy line.',
        'Vehicles burn fuel as they drive (sprinting burns more). Refuel at filling stations, the base, fuel trucks, or have any vehicle Give fuel… to another.',
      ),
      h('h4', {}, 'Combat'),
      list(
        'Fire at will / return fire / hold fire. Sprint doubles speed: infantry tire, vehicles burn fuel.',
        'In transport mode (driving in column on a road) units are fast but cannot fire and take more damage.',
        'Artillery fires 4–20 km (nothing closer than a fifth of its range), takes 2.5 s to aim at each new target and only hits what your side can see; spot for it, or barrage an area.',
        'Only anti-air stations and MANPADS teams can hit drones and missiles.',
        'Trenches and bunkers protect troops nearby; the best of each kind counts.',
        'A unit that stands still digs in: up to 40% less damage after two minutes. Moving loses it.',
        'More than 6 units within 1.5 km crowd each other: they take more damage and deal less. Spread out.',
      ),
      h('h4', {}, 'Orders, stances and formations'),
      list(
        'Stance: Hold (stay put, fire at what comes into range), Defend (engage within 3 km of the post, then return) or Aggressive (go after any enemy in sight).',
        'Move pushes through, firing on the way; Attack-move (A) stops to fight whatever it meets.',
        'Formation at the destination (F): spread, line, column or wedge. Right drag sets which way the front faces.',
        'Retreat: units fall back to a field hospital or base by themselves when health drops below 25% or 50%.',
      ),
      h('h4', {}, 'Morale'),
      p('Morale falls when units are encircled, out of ammo or under fire. Below 50 they fight worse; encircled at 0 they surrender. It comes back out of the fight, faster near the base or a field hospital.'),
      h('h4', {}, 'Fortifications'),
      list(
        'Trench Line: press and drag on the map the way it should run (0.3–10 km). Troops within 1.5 km take less damage.',
        'Bunker: up to 4 squads on foot man it (select them, right click the bunker). They fire out and cannot be hit until it falls. Shelled down, the garrison dies; stormed by troops, they come out shaken for 8 s.',
        'Bridge: drag across a river (up to 2 km). Takes minutes to build; drones, missiles and artillery can bring it down.',
      ),
      h('h4', {}, 'Drones & missiles'),
      list(
        'Recon drones circle their area and see far; strike drones dive on a target and explode.',
        'Recon drones wait at an Airfield and refuel only there; strike drones and missiles wait at a Launch Site. Select the site, Launch at…, click the target.',
        'Small drones ride on a pickup (2 each): Load them next to it (or from a launcher nearby), then Launch at… from the field.',
        'A strike drone or missile aimed at a unit or building locks on and follows it.',
      ),
      h('h4', {}, 'Ranks and training'),
      list(
        'Units earn experience in combat and climb ranks (Regular → Veteran → Elite → Guards); each rank adds damage, health and range.',
        'Training Centre: put at least 3 units inside and pay for a course (75 s to Regular, 45 s more per rank). From the second rank on a unit needs at least one kill since its last course.',
        'Combat experience needed: Regular 60, Veteran 600, Elite 1,800, Guards 4,000.',
      ),
      h('h4', {}, 'Production'),
      list(
        'Orders queue up per building; cancel one for a full refund.',
        'Rally point: new ground units walk to the flag. Repeat (↻): keep training a unit while resources last.',
        'APCs and IFVs carry infantry to the front under armour: Board from the infantry\'s panel.',
      ),
      h('h4', {}, 'Healing'),
      list('Medic Team: heals troops on foot within 2 km.', 'Mechanic Crew: repairs vehicles within 2 km.', 'Field Hospital: heals troops on foot within 6 km.', 'Nobody heals within 10 s of being hit. Rescue crews repair cities and buildings.'),
    ],
  },
  {
    id: 'team', title: 'Team play', body: () => [
      list(
        'Ping the map (P, or Alt+click) to show your team where you are going, what to defend, where the danger is or what to look at. Everyone on your side sees the mark and hears a tone; click the message to fly there.',
        'Factories and stores are shared by the team unless their owner sets Buildings: private.',
        'Only the owner can demolish a building.',
        'If everyone leaves a match it is closed after a minute. Statistics of every finished match are saved to your profile.',
      ),
    ],
  },
];

/** Live tables of every unit and building from the match rules (in-game only). */
function catalogue(rs: Omit<Ruleset, 'scripts' | 'maps'>, side: 'ua' | 'ru'): Section[] {
  const cost = (c: Record<string, number>) => Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ');
  const units = rs.units.filter((u: UnitDef) => !u.side || u.side === side);
  return [
    {
      id: 'units', title: 'Units', body: () => [
        h('table', { class: 'g-table' },
          h('thead', {}, h('tr', {}, ...['Unit', 'HP', 'Damage', 'Range', 'Speed', 'Ammo', 'Cost'].map((t) => h('th', {}, t)))),
          h('tbody', {}, ...units.map((u) => h('tr', { title: u.description ?? '' },
            h('td', {}, h('b', {}, u.name), h('div', { class: 'muted' }, u.description ?? '')),
            h('td', {}, String(u.hp)), h('td', {}, String(u.damage)), h('td', {}, `${u.range} km`), h('td', {}, `${(u.speed * 60).toFixed(0)} km/min`),
            h('td', {}, u.maxAmmo ? `${u.maxAmmo} (${u.ammoPerShot ?? 1}/shot)` : '—'), h('td', {}, cost(u.cost)))))),
      ],
    },
    {
      id: 'buildings', title: 'Buildings', body: () => [
        h('table', { class: 'g-table' },
          h('thead', {}, h('tr', {}, ...['Building', 'Cost', 'Build time'].map((t) => h('th', {}, t)))),
          h('tbody', {}, ...rs.buildings.map((b: BuildingDef) => h('tr', {},
            h('td', {}, h('b', {}, `${b.icon} ${b.name}`), h('div', { class: 'muted' }, b.description ?? '')),
            h('td', {}, cost(b.cost)), h('td', {}, `${b.buildTime}s`))))),
      ],
    },
  ];
}

/** The guidebook as a window over the page: sections on the left, the chosen one on the right. */
export function openGuide(ctx?: { ruleset: Omit<Ruleset, 'scripts' | 'maps'>; side: 'ua' | 'ru' }): () => void {
  const sections = [...SECTIONS, ...(ctx ? catalogue(ctx.ruleset, ctx.side) : [])];
  const body = h('div', { class: 'g-body' });
  const nav = h('div', { class: 'g-nav' });
  const show = (id: string) => {
    const s = sections.find((x) => x.id === id) ?? sections[0];
    clear(body);
    body.append(h('h3', {}, s.title), ...s.body());
    body.scrollTop = 0;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.id === s.id));
  };
  for (const s of sections) {
    const b = h('button', { onClick: () => show(s.id) }, s.title);
    b.dataset.id = s.id;
    nav.append(b);
  }
  const close = () => (overlay.remove(), window.removeEventListener('keydown', onKey));
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const overlay = h('div', { class: 'overlay guide', onClick: (e: MouseEvent) => e.target === overlay && close() },
    h('div', { class: 'card g-card' },
      h('div', { class: 'row between' }, h('h2', {}, 'Guidebook'), h('button', { onClick: close }, 'Close (Esc)')),
      h('div', { class: 'g-wrap' }, nav, body)));
  document.body.append(overlay);
  window.addEventListener('keydown', onKey);
  show(sections[0].id);
  return close;
}
