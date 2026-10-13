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
- **Frontline**: 56 nodes along the north-south axis; each node's longitude moves from the local force balance
  (units in range + an abstract economy-driven term, multiplied by trench/bunker defence). Territory, capture points
  and enemy buildings follow the front, so ground is won or lost without discrete segments.
- **Economy**: money, energy, people (+ ore, metal, fuel from the base mod). Energy deficit slows production; rail hubs boost nearby output.
- **Fog of war**: enemy units/buildings are sent only inside friendly vision; signal stations and drones extend it.
- **Victory**: all points held, enemy HQs destroyed, or most points-time when the clock runs out.

## Known limits / next steps

- Matches live in memory in one game process; scale out by running more game instances and having lobby pick one.
- Services talk plain HTTP with a shared internal key; use mTLS or a message bus for real deployments.
- The front is a function of latitude (it cannot fold back on itself). Replace with polyline nodes + normals for full DeepState-style bulges.
- Capture-the-flag and destruction game modes are not implemented yet.
