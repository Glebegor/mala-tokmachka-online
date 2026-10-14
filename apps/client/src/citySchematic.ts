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
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}
