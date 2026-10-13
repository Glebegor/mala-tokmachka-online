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
    "maps": ["maps/my_map.json"],
    "theme": "theme.css",
    "scripts": ["scripts/main.js"]
  }
}
```

All `content` keys are optional. Definitions are validated at load (unknown resources/units fail fast).

- **Resources** – `{ id, name, color, start, cap }`. `energy` is special: it is a stock fed by `produces.energy` and drained by `consumes.energy`.
- **Buildings** – see `mods/base/buildings.json`. Mechanics are composable fields: `produces`, `consumes`, `aura`, `defense`, `vision`, `trains`.
  A building with id `hq` is required.
- **Units** – `{ id, kind: ground|air, cost, trainTime, hp, speed (km/s), range (km), damage (dps), vision (km) }`.
- **Maps** – bounds, initial `front` polyline (north→south, team 0 west), `capturePoints`, `spawns`.
- **Rules** – overrides of `RulesConfig` in `packages/core/src/defs.ts` (front push speed, match length, starting units…).
- **Theme** – CSS variables injected into the client UI.
- **Scripts** – JavaScript run in an isolated V8 context:

```js
sw.on('pointCaptured', (e) => sw.giveResource(sw.teamPlayers(e.team)[0], 'money', 100));
```

Events: `tick` (1/s), `buildingCompleted`, `buildingDestroyed`, `unitTrained`, `unitKilled`, `pointCaptured`.
API: `sw.on`, `sw.giveResource`, `sw.teamPlayers`, `sw.toast`, `sw.log`.

Security: scripts have no I/O and a CPU timeout, but `node:vm` is not a hard boundary. Only install mods you trust.
