// apps/client/src/citySchematic.ts
// Realistic schematic city boundaries and downtown building footprints
import type { CapturePointDef, LngLat } from '@sw/core';

function makeRng(seedStr: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 15), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
    h ^= h >>> 16;
    return ((h >>> 0) % 100000) / 100000;
  };
}

export function buildCitySchematicsGeoJSON(capturePoints: CapturePointDef[]) {
  const features: any[] = [];

  for (const cp of capturePoints) {
    const rng = makeRng(cp.id + '_' + cp.name);
    const [cLng, cLat] = cp.pos;
    const val = cp.value ?? 2;

    const kmPerLat = 111.32;
    const kmPerLng = 111.32 * Math.cos((cLat * Math.PI) / 180);

    const toCoords = (dxKm: number, dyKm: number): LngLat => [
      Math.round((cLng + dxKm / kmPerLng) * 1e5) / 1e5,
      Math.round((cLat + dyKm / kmPerLat) * 1e5) / 1e5,
    ];

    // City Boundary radius in km:
    // val 5 (Kyiv/Moscow): ~4.2 km
    // val 4 (Kharkiv/Dnipro): ~3.0 km
    // val 3 (Zaporizhzhia/Poltava): ~2.0 km
    // val 2 (Mala Tokmachka/Nikopol): ~1.2 km
    // val 1 (Orikhiv/Stepnohirsk): ~0.8 km
    const boundaryRadiusKm = val === 5 ? 4.2 :
                             val === 4 ? 3.0 :
                             val === 3 ? 2.0 :
                             val === 2 ? 1.2 : 0.8;

    // 1. CITY BOUNDARY (Граница города — как на схеме Киева)
    // Organic municipal boundary with 12 to 16 lobes/corners
    const numVerts = 12 + Math.floor(rng() * 5);
    const baseAngle = rng() * Math.PI * 2;
    const boundaryRingKm: [number, number][] = [];
    for (let i = 0; i < numVerts; i++) {
      const a = baseAngle + (i / numVerts) * Math.PI * 2;
      // Organic lobe elongation
      const r = boundaryRadiusKm * (0.75 + rng() * 0.45);
      boundaryRingKm.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const boundaryCoords: LngLat[] = [
      ...boundaryRingKm.map(p => toCoords(p[0], p[1])),
      toCoords(boundaryRingKm[0][0], boundaryRingKm[0][1]),
    ];

    features.push({
      type: 'Feature',
      properties: {
        type: 'city-boundary-fill',
        cityId: cp.id,
        cityName: cp.name,
        val,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [boundaryCoords],
      },
    });

    features.push({
      type: 'Feature',
      properties: {
        type: 'city-boundary-line',
        cityId: cp.id,
        val,
      },
      geometry: {
        type: 'LineString',
        coordinates: boundaryCoords,
      },
    });

    // 2. SCHEMATIC HOUSES / BUILDINGS IN CITY CENTER ("дома в центре городов")
    // Target building count per city value
    const targetHouses = val === 5 ? 110 :
                         val === 4 ? 75 :
                         val === 3 ? 42 :
                         val === 2 ? 22 : 12;

    const coreRadiusKm = boundaryRadiusKm * 0.45;
    // Orientation of city street grid (rotated deterministically per city)
    const gridAngle = rng() * Math.PI * 0.5;
    const cosG = Math.cos(gridAngle), sinG = Math.sin(gridAngle);

    // Block dimensions in km (~90m x ~65m)
    const blockXKm = 0.092;
    const blockYKm = 0.068;
    const gridRadius = Math.ceil(coreRadiusKm / Math.min(blockXKm, blockYKm));

    let createdHouses = 0;
    // Walk grid outwards from center
    const blocks: { gx: number; gy: number; dist: number }[] = [];
    for (let gx = -gridRadius; gx <= gridRadius; gx++) {
      for (let gy = -gridRadius; gy <= gridRadius; gy++) {
        const bxKm = gx * blockXKm;
        const byKm = gy * blockYKm;
        const dist = Math.sqrt(bxKm * bxKm + byKm * byKm);
        if (dist <= coreRadiusKm) {
          blocks.push({ gx, gy, dist });
        }
      }
    }
    blocks.sort((a, b) => a.dist - b.dist);

    for (const b of blocks) {
      if (createdHouses >= targetHouses) break;

      const bxKm = b.gx * blockXKm;
      const byKm = b.gy * blockYKm;

      // Rotate into city grid coordinate system
      const rxKm = bxKm * cosG - byKm * sinG;
      const ryKm = bxKm * sinG + byKm * cosG;

      // Within this block, place 1 or 2 rectangular buildings
      const inBlock = (targetHouses - createdHouses >= 2 && rng() < 0.6) ? 2 : 1;
      for (let bi = 0; bi < inBlock; bi++) {
        if (createdHouses >= targetHouses) break;

        const offX = (bi === 0 ? -0.016 : 0.016) + (rng() - 0.5) * 0.008;
        const offY = (rng() - 0.5) * 0.012;
        const cx = rxKm + (offX * cosG - offY * sinG);
        const cy = ryKm + (offX * sinG + offY * cosG);

        // Building dimensions: length ~32..58m, width ~16..26m
        const bLen = 0.032 + rng() * 0.024;
        const bWid = 0.016 + rng() * 0.010;

        const isL = rng() < 0.15; // 15% L-shaped buildings
        let bPolyKm: [number, number][];
        if (isL) {
          const hx = bLen / 2, hy = bWid / 2;
          bPolyKm = [
            [-hx, -hy],
            [hx, -hy],
            [hx, hy * 0.3],
            [-hx * 0.2, hy * 0.3],
            [-hx * 0.2, hy * 2.2],
            [-hx, hy * 2.2],
            [-hx, -hy],
          ];
        } else {
          const hx = bLen / 2, hy = bWid / 2;
          bPolyKm = [
            [-hx, -hy],
            [hx, -hy],
            [hx, hy],
            [-hx, hy],
            [-hx, -hy],
          ];
        }

        const bAngle = gridAngle + (rng() < 0.1 ? Math.PI / 2 : 0);
        const cosB = Math.cos(bAngle), sinB = Math.sin(bAngle);

        const buildingCoords: LngLat[] = bPolyKm.map(([x, y]) => {
          const px = cx + (x * cosB - y * sinB);
          const py = cy + (x * sinB + y * cosB);
          return toCoords(px, py);
        });

        features.push({
          type: 'Feature',
          properties: {
            type: 'building',
            cityId: cp.id,
            val,
          },
          geometry: {
            type: 'Polygon',
            coordinates: [buildingCoords],
          },
        });
        createdHouses++;
      }
    }
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}
