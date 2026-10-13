# Modding

A mod is a folder in `mods/` with a `mod.json` manifest. All mods are loaded at game-service start (`base` first, then alphabetical);
later mods override earlier entries with the same `id`. Set `SW_MODS=base,my_mod` to restrict the list.

```json
{
  "id": "my_mod", "name": "My Mod", "version": "1.0.0",
  "content": {
    "rules": "rules.json",
    "resources": "resources.json",
    "buildings": "buildings.json",
    "units": "units.json",
    "terrain": "terrain.json",
    "ranks": "ranks.json",
    "maps": ["maps/my_map.json"],
    "theme": "theme.css",
    "scripts": ["scripts/main.js"]
  }
}
```

All `content` keys are optional. Definitions are validated at load (unknown resources/units fail fast).

- **Resources** – `{ id, name, color, start, cap }`. `energy` is special: it is a stock fed by `produces.energy` and drained by `consumes.energy`.
- **Buildings** – see `mods/base/buildings.json`. Mechanics are composable fields: `produces`, `consumes`, `aura`, `defense`, `vision`, `trains`,
  `attack` (`{ range, damage, targets: air|ground|all, fx, missRate }`), `crossing` (`{ radiusKm, speed }`), `needsWaterWithinKm`,
  `training` (`{ minUnits, capacity, baseTime, timePerRank }`), `levels` (`[{ cost, time, defenseMult, hp }]`, upgrades to level 2, 3, …). `description` is shown on the hover card.
  A building with id `hq` is required.
- **Units** – `{ id, kind: ground|air, cost, trainTime, hp, speed (km/s), range (km), damage (dps), vision (km) }` plus
  `mobility` (key into terrain speed tables: foot, tracked, wheeled, or your own), `symbol` (NATO icon: infantry, armor,
  mechanized, artillery, uav, recon, antiair, engineer, supply), `fx` (burst, shell, arc, beam, missile), `missRate` (cosmetic) and `airDamage` (multiplier against aircraft).
- **Terrain** – `{ id, name, color, speed: { <mobility>: mult }, cover, concealment, frontResist, barrier?: { minCells, mobility[] } }`. Ids must match the map grid legend.
- **Ranks** – `{ id, name, xp, damage, hp, range, cost }`, ordered by `xp`. The first one is what new units start with;
  training courses are charged per tick through `rules.courseCostPerTick` / `courseCostPerRank`, so `cost` is normally `{}`.
- **Maps** – bounds, initial `front` polyline (team 0 on the left of its direction, team 1 on the right), `occupiedClosure`
  (points that close team 1's side into a polygon for drawing), `capturePoints`, `spawns`, and optional `roadsFile` /
  `terrainFile` produced by `tools/build-roads.mjs` and `tools/build-terrain.mjs`. `tools/gen-spawns.mts` generates mirrored spawn pairs. Run `npm run check:maps` to verify that
  every point and spawn is on the intended side.
- **Rules** – overrides of `RulesConfig` in `packages/core/src/defs.ts` (front push speed, match length, starting units…).
- **Theme** – CSS variables injected into the client UI.
- **Scripts** – JavaScript run in an isolated V8 context:

```js
sw.on('pointCaptured', (e) => sw.giveResource(sw.teamPlayers(e.team)[0], 'money', 100));
```

Events: `tick` (1/s), `buildingCompleted`, `buildingDestroyed`, `unitTrained`, `unitKilled`, `unitPromoted`, `courseFinished`, `pointCaptured`, `cauldronFormed`, `cauldronDestroyed`.
API: `sw.on`, `sw.giveResource`, `sw.teamPlayers`, `sw.toast`, `sw.log`.

Security: scripts have no I/O and a CPU timeout, but `node:vm` is not a hard boundary. Only install mods you trust.
