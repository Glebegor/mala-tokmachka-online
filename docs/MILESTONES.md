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

## M7 — Depth (next)
- Breaking a cauldron from outside (re-joining a pocket to the main front).
- Supply lines: units and forward buildings need a road link back to an HQ; cutting roads matters.
- Bridges as destructible objects; engineers.
- Terrain-aware pathfinding off-road (cross-country legs are straight lines; units route around rivers only via roads and crossings).
- Choosing your spawn in the lobby.
- Game modes: capture the flag, destruction; ranked matchmaking; spectators and replays.
- Persistence: Postgres for accounts/match history, reconnect after game-service restart.
- More units via mods: air defence, mechanized infantry, supply trucks, engineers (icons already exist).
- Self-hosted vector tiles instead of the public OSM tile server.
