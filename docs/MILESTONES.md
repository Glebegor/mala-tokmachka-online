# Milestones

## M1 — Playable prototype (done)
- Microservices: gateway, auth, lobby, game; shared `core` rules; Docker Compose.
- Zaporizhzhia sector map, moving frontline, civil + war buildings with construction animation.
- Economy (money, energy, people, ore, metal, fuel), units, bots, fog of war, mods (data, theme, scripts).
- Lobby settings: duration, team size, bots, difficulty, starting resources, front speed, fog.

## M2 — The whole front (done, v0.2.0)
- **Ukraine map**: full line of contact from the Dnipro mouth to the northern border (180 front nodes),
  20 capture points, 8 spawns per side. The front is now a free polyline: nodes move along their normal,
  so it can bulge, fold and form salients. Old sector map kept as a small/fast option; map is chosen in the lobby.
- **Roads**: real network from Natural Earth (1,389 roads). Ground units route along roads when faster (×2.4 speed),
  buildings near a road produce +15%.
- **Terrain**: real grid (field / forest / city / water, ~1.6 km cells) built from OpenStreetMap + Natural Earth.
  Each terrain sets speed per mobility class (foot / tracked / wheeled), cover, concealment and how much it slows the front.
- **NATO markers**: APP-6 style frames (friendly rectangle, hostile diamond), branch icons, echelon marks, rank chevrons.
- **Groups**: G / Ctrl+1-9 to form, 1-9 to select, formation markers when zoomed out, optional "move in formation".
- **Veterancy**: Recruit → Regular → Veteran → Elite → Guards, earned in combat or bought.
- **Fire animation**: distinct per unit (burst, shell, arc, beam), with cosmetic misses.

## M3 — Manoeuvre (done, v0.3.0)
- **Transport mode**: move orders are planned for the shortest travel time. On road legs ground units drive in column
  (×2.4 speed, wheels under the marker), cannot fire and take +50% damage; a column that meets the enemy halts and deploys.
- **Rivers**: the major rivers (Dnipro, Donets, Desna, Southern Bug, Dniester, Don…) and the sea are barriers.
  Ground units cross only on road bridges or at a **Pontoon Crossing** you build on the bank (6 km radius). Small streams stay fordable.
- **Waypoints**: Shift+right click queues up to 8 legs; Alt+right click moves straight across country without mounting up.
- **Anti-Air Station**: static air defence (14 km). Ground weapons now do only 0–30% damage to aircraft.
- **Spawns and balance**: 12 mirrored spawn pairs, every one 60 km from the front on a road; players are spread evenly and
  face their opposite number. Capture point value is equal per side (31 / 31).
- **Frontline look**: crisp cased line with sharp corners and a hard-edged contact zone; arrowheads show where and which way
  it is moving. The line is re-spaced locally, so its corners are no longer rounded off over time.
- **NATO markers**: standard light fill with black frame and icon.

## M4 — Training, relief, presentation (done, v0.4.0)
- **Training Centre**: ground units walk inside (off the map). With at least 3 inside you pay for a course; after the wait
  the class comes out one rank higher and at full strength. Holds 12, two per player. Instant paid promotion is gone:
  ranks now come from combat (25 XP per kill plus XP for damage) or from courses.
- **Terrain at twice the resolution** (~0.8 km cells) with two new types from real elevation data: **hills** and **mountains**
  (see further, some cover, slow or nearly closed to vehicles off-road).
- **Descriptions** for every building and unit: hover a build or train button for what it does and its numbers.
- **Map**: near-monochrome dark basemap with real relief shading, hatched occupied territory, vignette.
- **Attack arrows** in situation-map style: bold tapered arrows across the stretches of front that are moving, animated.
- **Markers**: echelon on top of the frame, rank chevrons on the right, transport wheels below.

## M5 — Encirclement (done, v0.5.0)
- **Cauldrons**: when two stretches of the front close to within 3.5 km of each other, the loop between them is cut off
  as a pocket. Ground inside still belongs to the encircled side, but its units are cut off: 60% damage, losing 0.4% of
  their strength per second, no economic support for the pocket's front. A pocket squeezed below 40 km² (or left without
  defenders) collapses: the garrison is lost and the besiegers score. This also stops the front from ever crossing itself.
- **Faster front**: four times the push and roughly twice the top speed.
- **Battle arrows**: attack arrows are drawn only where units are actually shooting at each other, and only for fights
  you can see through the fog of war.
- **Training is paid as it runs**: 0.1 money per unit per tick (1/s), plus 0.05 per tick for every rank the unit already
  holds. Nothing up front; the course pauses if the money runs out.
- **Terrain at ~0.2 km cells** (four times finer than before) with a smoother, clearer overlay.

- **Buffs and debuffs** (v0.5.1): green up-triangles (buffs) and red down-triangles (debuffs) on the left of every unit
  marker; the unit panel lists each effect with an icon and exactly what it does.

## M6 — Profiles and polish (done, v0.6.0)
- **Profile service** (new microservice, :4004): career statistics per player (matches, wins/losses/draws, units destroyed
  and lost, buildings, damage, time played, last 10 matches) and a top-10 leaderboard. The game service reports every
  finished match; the lobby has a Profile button.
- **No automatic bots**: a room starts with exactly the players and bots listed. "Fill empty slots with bots" is still
  there as an option, off by default.
- **Start of match**: the server waits until every player's map is drawn, then counts 3-2-1. The camera opens on your
  headquarters with a big "YOU START HERE" arrow. Nothing moves and no orders are accepted before GO.
- **Fortifications**: trenches do not stack with trenches, bunkers do not stack with bunkers (a trench and a bunker still
  add up). Both can be upgraded to level 3 for resources (trench +25/40/55%, bunker +60/85/110%).
- **Zones**: blue tint on ground held by Ukraine, red on occupied ground, and **grey zones**: a ground unit that stays
  10 s behind the enemy line with no enemy within 6 km turns a 5 km patch grey. Nobody can build there, the front is
  easier to push at that spot, and the patch fades 20 s after the troops leave.

## Merge of `akira` (v0.7.0)
Taken from akira: the expanded Eastern Europe map (DeepState line of contact, 200 cities as capture points, Sea of
Azov cut-out), the full OpenStreetMap road network (25k roads), state borders with country labels, real city
boundaries, fuel-station data, the map-building tools, Windows path fixes, "Until victory" (no time limit), and the
anti-tank / assault NATO icons. Kept from hlib where both branches did the same thing differently: the simulation
core (cauldrons, roads/rivers routing, training, fortifications, grey zones), the client game screen, buildings,
units, rules and economy, lobby flow. Spawns were regenerated as 12 mirrored pairs on the new front and
capture-point value equalised per side (196 / 196).

Not taken (they live inside akira's version of the simulation and client, which conflicts with hlib's): logistics
(trucks, warehouses, fuel supply), military base and new infantry types, side-specific drones with sprites and
loitering, artillery bombardment, aviation plant, power lines, city HP / housing limits / rescuers, special zones
(Kremenchuk, Alabuga), shared team buildings, the fog-of-war overlay. The drone sprites are in
`mods/base/assets/drones` for when those features are ported.

## M7 — akira's gameplay, ported (v0.8.0)
Everything from the akira branch now runs on hlib's core:
- **Logistics economy**: goods (ore, metal, fuel) pile up in the building that makes them and must be trucked.
  Trucks and fuel trucks run standing delivery routes (click the loading site, then the unloading site). Training takes
  metal and fuel from the factory's own store; money and people are shared by the whole team.
- **New buildings**: oil refinery, filling station, machine factory, warehouse, drone factory, airfield, missile factory and
  aircraft plant (the last two are placeholders). The HQ is now the Military Base and trains every infantry type.
  Industrial sites must be 35 km apart; field works (trenches, bunkers, air defence, signal posts, crossings) are exempt.
  Housing only inside cities your side holds, at most 10 per city.
- **New units**: recon team, assault infantry, anti-tank team, pickup, truck, fuel truck, rescue crew, and side-specific
  drones (Shahed, Orion, Liutyi, PD-2, Mini Shark, FP-2).
- **Fuel, stamina, sprint, fire discipline**: vehicles and drones burn fuel (refuel at filling stations, fuel trucks, the
  base; recon drones only at airfields; strike drones are one-way). Infantry can sprint on stamina. Fire at will / return
  fire / hold fire.
- **Drones**: recon drones circle their area; strike drones dive on the target, explode (units, buildings, city
  structure) and leave smoke. Drawn as turning sprites.
- **Artillery**: 3–20 km, fires only at what your side can see, barrage a chosen area, never drives up to the front.
- **Cities and repair**: cities have structure points that strikes wear down; rescue crews repair cities, housing and
  buildings. Defenders near their own cities take up to 50% less damage.
- **Power grid**: a power plant powers everything within 100 km (+25% output and training speed, +50% for housing);
  select a plant to see its power lines along the roads.
- **Special zones**: Kremenchuk refinery (Ukraine, +50% fuel) and Alabuga (Russia, drones 50% faster).
- **Theatre limits**: nobody can enter Belarus, Moldova or the EU.
- **Client**: Map ON/OFF filter (M), visible fog of war, bottom command panel, route lines along the planned path,
  arrival times, building stores, smooth 60 fps unit movement.
- **Lobby**: Rejoin is only offered to players who were in the match when it started.

## M7.1 — Modes, ceasefire, missiles (v0.9.0)
- **Sandbox game type** (lobby): a test range with full treasuries and stores, building, upgrades, courses and training
  ten times faster, and no victory or time limit.
- **Ceasefire at the start** (lobby, default 15 min): build and deploy, but nobody shoots, nobody may cross the front (ground
  units halt at the line, drones turn back), the front stands still and nothing is captured. The match clock starts when
  it ends; a banner counts it down and "THE WAR BEGINS" marks the end.
- **Private buildings**: the top bar toggle "Buildings: shared / private" decides whether teammates may train at, supply,
  school at, upgrade or refuel at your buildings. Closing them also stops teammates' standing deliveries to and from them.
  Only the owner may demolish a building.
- **Missiles**: the missile factory builds Iskander-M (ballistic) and Kh-101 (cruise) for Russia, R-360 Neptune and FP-5
  Flamingo (cruise) for Ukraine. A missile waits on the launcher until it gets a target, flies there and explodes. Ballistic
  missiles are fast and rarely intercepted; cruise missiles are slower and anti-air stations shoot many of them down.
- **Drones from pickups**: a pickup carries two small drones (generic recon drone, Mini Shark, FP-2, and the new Russian
  Lancet and ZALA). Select the drones next to it and press *Load*, then *Launch at…* (click the target) or *Launch here*.
- **Markers**: own units blue, allies green, the enemy red (aircraft sprites too). Vehicles carry the APP-6 mobility
  indicator (two wheels, or a track); in column it turns yellow with a ». The supply bar reads properly on enemy markers.
- The attack arrows were removed.
- **Training queue view**: each factory lists its orders with unit icons, a live progress bar for the one in training,
  when each will be ready and a × to cancel your own orders (full refund, goods back into the store). A production strip
  over the map shows everything training for you (click a chip to open the building); building markers get a progress bar
  and an order count; train buttons show how many are queued; a message announces each finished unit.

## M8 — Depth (next)
- Breaking a cauldron from outside (re-joining a pocket to the main front).
- Supply lines: units and forward buildings need a road link back to an HQ; cutting roads matters.
- Bridges as destructible objects; engineers.
- Terrain-aware pathfinding off-road (cross-country legs are straight lines; units route around rivers only via roads and crossings).
- Choosing your spawn in the lobby.
- Game modes: capture the flag, destruction; ranked matchmaking; spectators and replays.
- Persistence: Postgres for accounts/match history, reconnect after game-service restart.
- More units via mods: air defence, mechanized infantry, supply trucks, engineers (icons already exist).
- Self-hosted vector tiles instead of the public OSM tile server.
