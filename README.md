# Mala Tokmachka Online

Minimalist online RTS wargame on a real map of Ukraine with the full line of contact (Ukraine vs Russia, 8v8 with bots).
Build civil and war infrastructure, command units by hand, and push a living frontline.

## Run

```
npm install
npm run dev        # auth :4001, lobby :4002, game :4003, gateway :8080, client :5173
```

Open http://localhost:5173, register, create a room, start (empty slots are filled with bots).
The basemap uses CARTO's free dark tiles, so it needs internet access.

`npm test` runs a headless 8v8 bot match against the simulation (`npm test -- zaporizhzhia` for the small map).

## Controls

| Action | Input |
| --- | --- |
| Select unit / formation / building | left click (Shift+click adds) |
| Box select | Shift + drag |
| Move (uses roads when faster) | right click |
| Stop | S |
| Group / ungroup selection | G / U |
| Numbered group: assign / select / jump to | Ctrl+1-9 / 1-9 / press again |
| Terrain overlay | T |
| Place building | pick from left panel, click your territory (Shift = keep placing, Esc = cancel) |

Hover the map to see the terrain under the cursor and how it affects each kind of unit.

## Layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/MODDING.md](docs/MODDING.md) and [docs/MILESTONES.md](docs/MILESTONES.md).

## Map data

Roads and urban areas: Natural Earth (public domain). Forest/water classification and basemap: © OpenStreetMap contributors (ODbL).
Rebuild with `tools/build-roads.mjs` and `tools/build-terrain.mjs`; validate with `npm run check:maps`.

## Docker

```
cp .env.example .env     # set real secrets
docker compose up -d --build   # → http://localhost:5173
docker compose logs -f
docker compose down
```

Only the client (nginx, :5173) is exposed; it proxies `/api` and `/ws` to the gateway. Accounts persist in the `auth-data` volume.
`./mods` is mounted into the game service, so drop a mod in and run `docker compose restart game`.
