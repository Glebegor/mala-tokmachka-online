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

## M3 — Depth (next)
- Supply lines: units and forward buildings need a road link back to an HQ; cutting roads matters.
- Bridges as destructible objects; engineers; river crossings as a real operation.
- Terrain-aware pathfinding off-road (currently only roads are routed; cross-country legs are straight).
- Game modes: capture the flag, destruction; ranked matchmaking; spectators and replays.
- Persistence: Postgres for accounts/match history, reconnect after game-service restart.
- More units via mods: air defence, mechanized infantry, supply trucks, engineers (icons already exist).
- Self-hosted vector tiles instead of the public OSM tile server.
