// apps/client/src/citySchematic.ts
// Procedural schematic city generator matching medieval/tactical fantasy city maps (Watabou style)
import type { CapturePointDef, LngLat } from '@sw/core';

// Palette of muted tactical pastel district colors (from medieval fantasy city map style)
const DISTRICT_COLORS = [
  '#4a6fa5', // muted slate blue
  '#588157', // muted sage green
  '#b56576', // dusty rose / terracotta
  '#6d597a', // muted mauve / purple
  '#9c6644', // warm ochre / clay
  '#3a7d78', // muted teal
  '#8d5b4c', // tactical heather
  '#6b705c', // olive drab
  '#52796f', // deep muted pine
  '#7f7f7f', // tactical parchment grey
];

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

    // Radius in km according to importance:
    // val 5 (Kyiv/Moscow): ~3.8 km
    // val 4 (Kharkiv/Dnipro): ~2.8 km
    // val 3 (Zaporizhzhia): ~2.0 km
    // val 2 (Medium town): ~1.3 km
    // val 1 (Small settlement): ~0.85 km
    const baseRadiusKm = val === 5 ? 3.8 :
                         val === 4 ? 2.8 :
                         val === 3 ? 2.0 :
                         val === 2 ? 1.3 : 0.85;

    const kmPerLat = 111.32;
    const kmPerLng = 111.32 * Math.cos((cLat * Math.PI) / 180);

    const toCoords = (dxKm: number, dyKm: number): LngLat => [
      Math.round((cLng + dxKm / kmPerLng) * 1e5) / 1e5,
      Math.round((cLat + dyKm / kmPerLat) * 1e5) / 1e5,
    ];

    // Number of perimeter sectors / districts (7 to 10 for major, 5 to 7 for minor)
    const numSectors = val >= 4 ? 8 + Math.floor(rng() * 3) :
                       val === 3 ? 6 + Math.floor(rng() * 3) :
                       5 + Math.floor(rng() * 2);

    // Compute perimeter sector angles with organic variation
    const angles: number[] = [];
    let angleSum = 0;
    const angleDeltas: number[] = [];
    for (let s = 0; s < numSectors; s++) {
      const d = 1.0 + (rng() - 0.5) * 0.4;
      angleDeltas.push(d);
      angleSum += d;
    }
    let curAngle = rng() * Math.PI * 2;
    for (let s = 0; s < numSectors; s++) {
      angles.push(curAngle);
      curAngle += (angleDeltas[s] / angleSum) * Math.PI * 2;
    }

    const wallRadius: number[] = [];
    const wallVerticesKm: [number, number][] = [];
    for (let s = 0; s < numSectors; s++) {
      // organic radius variation per vertex: 85% to 115%
      const r = baseRadiusKm * (0.85 + rng() * 0.3);
      wallRadius.push(r);
      const a = angles[s];
      wallVerticesKm.push([Math.cos(a) * r, Math.sin(a) * r]);
    }

    // Plaza / Central square in the center (radius 20% to 25% of city)
    const plazaR = baseRadiusKm * 0.22;
    const plazaVerticesKm: [number, number][] = [];
    for (let s = 0; s < numSectors; s++) {
      const a = angles[s];
      plazaVerticesKm.push([Math.cos(a) * plazaR, Math.sin(a) * plazaR]);
    }

    // 1. DISTRICTS: Each wedge between radial avenues with pastel fills
    for (let s = 0; s < numSectors; s++) {
      const nextS = (s + 1) % numSectors;
      const col = DISTRICT_COLORS[(s + Math.floor(rng() * 3)) % DISTRICT_COLORS.length];

      // Outer curve / edge with interpolation steps
      const outerArcKm: [number, number][] = [];
      const steps = 3;
      const angleDiff = angles[nextS] > angles[s] ? angles[nextS] - angles[s] : (angles[nextS] + Math.PI * 2) - angles[s];
      for (let st = 0; st <= steps; st++) {
        const t = st / steps;
        const a = angles[s] + angleDiff * t;
        const r = wallRadius[s] * (1 - t) + wallRadius[nextS] * t;
        outerArcKm.push([Math.cos(a) * r, Math.sin(a) * r]);
      }

      // Inner plaza edge
      const pInner1 = plazaVerticesKm[s];
      const pInner2 = plazaVerticesKm[nextS];

      const districtRing: LngLat[] = [
        toCoords(pInner1[0], pInner1[1]),
        ...outerArcKm.map(p => toCoords(p[0], p[1])),
        toCoords(pInner2[0], pInner2[1]),
        toCoords(pInner1[0], pInner1[1]),
      ];

      features.push({
        type: 'Feature',
        properties: {
          type: 'district',
          cityId: cp.id,
          cityName: cp.name,
          color: col,
          val,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [districtRing],
        },
      });

      // 2. CITY BLOCKS inside this district
      const numRings = val >= 3 ? 3 : 2;
      const numRadialSlices = val >= 4 ? 3 : 2;

      for (let ri = 0; ri < numRings; ri++) {
        const rFrac1 = 0.25 + (ri / numRings) * 0.7;
        const rFrac2 = 0.25 + ((ri + 1) / numRings) * 0.7;
        // Inset to leave street alleys between blocks
        const r1 = rFrac1 + 0.035;
        const r2 = rFrac2 - 0.035;

        for (let si = 0; si < numRadialSlices; si++) {
          const t1 = (si / numRadialSlices) + 0.06;
          const t2 = ((si + 1) / numRadialSlices) - 0.06;

          const a1 = angles[s] + angleDiff * t1;
          const a2 = angles[s] + angleDiff * t2;

          const rAvg1 = wallRadius[s] * (1 - t1) + wallRadius[nextS] * t1;
          const rAvg2 = wallRadius[s] * (1 - t2) + wallRadius[nextS] * t2;

          const bk1: [number, number] = [Math.cos(a1) * rAvg1 * r1, Math.sin(a1) * rAvg1 * r1];
          const bk2: [number, number] = [Math.cos(a1) * rAvg1 * r2, Math.sin(a1) * rAvg1 * r2];
          const bk3: [number, number] = [Math.cos(a2) * rAvg2 * r2, Math.sin(a2) * rAvg2 * r2];
          const bk4: [number, number] = [Math.cos(a2) * rAvg2 * r1, Math.sin(a2) * rAvg2 * r1];

          // Small random chance of an internal courtyard opening
          const isCourtyard = rng() < 0.12;
          const blockColor = isCourtyard ? '#18202c' : '#283344';

          features.push({
            type: 'Feature',
            properties: {
              type: 'block',
              cityId: cp.id,
              val,
              color: blockColor,
              courtyard: isCourtyard,
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                toCoords(bk1[0], bk1[1]),
                toCoords(bk2[0], bk2[1]),
                toCoords(bk3[0], bk3[1]),
                toCoords(bk4[0], bk4[1]),
                toCoords(bk1[0], bk1[1]),
              ]],
            },
          });
        }
      }
    }

    // 3. RADIAL AVENUES (Streets from central plaza to perimeter gates)
    for (let s = 0; s < numSectors; s++) {
      const v = wallVerticesKm[s];
      features.push({
        type: 'Feature',
        properties: { type: 'street', cityId: cp.id, val },
        geometry: {
          type: 'LineString',
          coordinates: [
            toCoords(0, 0),
            toCoords(v[0], v[1]),
          ],
        },
      });
    }

    // 4. CENTRAL PLAZA / SQUARE
    const plazaRing: LngLat[] = [...plazaVerticesKm.map(p => toCoords(p[0], p[1])), toCoords(plazaVerticesKm[0][0], plazaVerticesKm[0][1])];
    features.push({
      type: 'Feature',
      properties: { type: 'plaza', cityId: cp.id, val },
      geometry: { type: 'Polygon', coordinates: [plazaRing] },
    });

    // 5. CITADEL / TOWN HALL / KEEP (In the center of the plaza, stylized "T" / castle footprint)
    const citR = plazaR * 0.65;
    const citCoordsKm: [number, number][] = [
      [-citR * 0.35, -citR * 0.55],
      [citR * 0.35, -citR * 0.55],
      [citR * 0.35, -citR * 0.15],
      [citR * 0.75, -citR * 0.15],
      [citR * 0.75, citR * 0.45],
      [citR * 0.28, citR * 0.45],
      [citR * 0.28, citR * 0.15],
      [-citR * 0.28, citR * 0.15],
      [-citR * 0.28, citR * 0.45],
      [-citR * 0.75, citR * 0.45],
      [-citR * 0.75, -citR * 0.15],
      [-citR * 0.35, -citR * 0.15],
      [-citR * 0.35, -citR * 0.55],
    ];
    // Rotate citadel deterministically
    const rot = rng() * Math.PI * 2;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const rotCit = citCoordsKm.map(([x, y]) => [x * cosR - y * sinR, x * sinR + y * cosR]);

    features.push({
      type: 'Feature',
      properties: { type: 'citadel', cityId: cp.id, val },
      geometry: {
        type: 'Polygon',
        coordinates: [rotCit.map(p => toCoords(p[0], p[1]))],
      },
    });

    // 6. OUTER PERIMETER DEFENSIVE WALL
    const wallRing: LngLat[] = [...wallVerticesKm.map(p => toCoords(p[0], p[1])), toCoords(wallVerticesKm[0][0], wallVerticesKm[0][1])];
    features.push({
      type: 'Feature',
      properties: { type: 'wall', cityId: cp.id, val },
      geometry: {
        type: 'LineString',
        coordinates: wallRing,
      },
    });

    // 7. BASTIONS / WALL TOWERS (Points at each wall vertex)
    for (let s = 0; s < numSectors; s++) {
      features.push({
        type: 'Feature',
        properties: { type: 'bastion', cityId: cp.id, val },
        geometry: {
          type: 'Point',
          coordinates: toCoords(wallVerticesKm[s][0], wallVerticesKm[s][1]),
        },
      });
    }
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}
