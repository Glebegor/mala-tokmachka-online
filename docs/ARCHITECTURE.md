# Architecture

```
client (Vite + MapLibre) ──HTTP/WS──> gateway :8080 ──> auth :4001
                                                   ├──> lobby :4002 ──(internal key)──> game :4003
                                                   └──(WS proxy, token verified)───────> game :4003
```

| Unit | Responsibility |
| --- | --- |
| `packages/core` | Pure domain: definitions, world state, simulation (`Sim`), frontline, fog of war, protocol. No I/O. Shared by server and client. |
| `packages/kit` | Cross-service plumbing: tiny HTTP router, signed tokens, config. |
| `services/auth` | Accounts and tokens. `domain` (entities + ports) → `application` (use cases) → `infrastructure` (JSON repo, scrypt) → `interface` (HTTP). |
| `services/lobby` | Rooms, 8v8 slots, bot fill, launches matches in the game service. |
| `services/game` | Authoritative match servers: mod loader, sandboxed script host, bots, tick loop, per-player fog-filtered snapshots over WebSocket. |
| `services/gateway` | Single public entry: REST routing, WebSocket authentication and proxying. |
| `apps/client` | Map rendering, building construction animation, HUD, input. |

Dependencies point inward: interface → application → domain; infrastructure implements domain ports and is wired only in each `main.ts`.

## Simulation

- 10 Hz tick, 5 Hz snapshots. Clients only send intents (`Command`); the server validates everything.
- **Frontline** (`frontline.ts`): a polyline of nodes ~9 km apart. Team 0 is on its left, team 1 on its right. Each tick every
  node moves along its normal from the local force balance (units in range + an abstract economy term, multiplied by
  trench/bunker defence, damped by terrain). Neighbours share speed, the line is re-spaced every 5 s, both ends are anchored.
  Territory, capture points and overrun buildings are derived from which side of the line they are on.
- **Roads** (`roads.ts`): graph built from the map's polylines with A* routing. A move order plans one route for the group
  (stragglers plan their own); road legs use `roadSpeedMult` and ignore terrain.
- **Terrain** (`terrain.ts`): run-length-encoded grid aligned with Web Mercator. Terrain definitions are mod data.
- **Combat**: nearest enemy in range, one salvo per second; cover (terrain) and fortifications reduce damage.
  Every salvo is also reported as a `Shot` for client animation. Damage and kills give XP; ranks multiply damage/HP/range.
- **Economy**: money, energy, people (+ ore, metal, fuel from the base mod). Energy deficit slows production; rail hubs and
  road access boost output.
- **Fog of war**: enemy units/buildings are sent only inside friendly vision; forest and city shrink the spotting distance.
- **Victory**: all points held, enemy HQs destroyed, or most points-time when the clock runs out.

## Known limits / next steps

- Matches live in memory in one game process; scale out by running more game instances and having lobby pick one.
- Services talk plain HTTP with a shared internal key; use mTLS or a message bus for real deployments.
- The front does not check for self-intersection; extreme pincer moves could cross it over itself.
- Off-road movement is a straight line (terrain only changes speed); only roads are path-planned.
- Groups are client-side (not shared with allies, lost on page reload).
- Capture-the-flag and destruction game modes are not implemented yet.
