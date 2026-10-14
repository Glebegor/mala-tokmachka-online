// Extracts international borders of Ukraine and neighbouring countries from Natural Earth vector data.
// usage: node tools/build-borders.mjs <ne_10m_admin_0_boundary_lines_land.geojson> <out.geojson>
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out = 'mods/base/maps/borders.geojson'] = process.argv.slice(2);
if (!src) {
  console.error('Usage: node tools/build-borders.mjs <ne_10m_admin_0_boundary_lines_land.geojson> [out.geojson]');
  process.exit(1);
}

const data = JSON.parse(readFileSync(src, 'utf8'));

function getSegments(feature) {
  if (feature.geometry.type === 'LineString') return [feature.geometry.coordinates];
  if (feature.geometry.type === 'MultiLineString') return feature.geometry.coordinates;
  return [];
}

function stitch(segments) {
  let segs = segments.map((s) => [...s]);
  let chains = [];
  while (segs.length > 0) {
    let cur = segs.shift();
    let extended = true;
    while (extended) {
      extended = false;
      const start = cur[0], end = cur[cur.length - 1];
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const d = (p1, p2) => Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
        if (d(end, s[0]) < 0.005) { cur = cur.concat(s.slice(1)); segs.splice(i, 1); extended = true; break; }
        else if (d(end, s[s.length - 1]) < 0.005) { cur = cur.concat([...s].reverse().slice(1)); segs.splice(i, 1); extended = true; break; }
        else if (d(start, s[s.length - 1]) < 0.005) { cur = s.slice(0, -1).concat(cur); segs.splice(i, 1); extended = true; break; }
        else if (d(start, s[0]) < 0.005) { cur = [...s].reverse().slice(0, -1).concat(cur); segs.splice(i, 1); extended = true; break; }
      }
    }
    chains.push(cur);
  }
  return chains;
}

function rdp(points, epsilon) {
  if (points.length <= 2) return points;
  let dmax = 0, index = 0;
  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const d = Math.abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / Math.hypot(y2 - y1, x2 - x1);
    if (d > dmax) { dmax = d; index = i; }
  }
  if (dmax > epsilon) {
    const r1 = rdp(points.slice(0, index + 1), epsilon);
    const r2 = rdp(points.slice(index), epsilon);
    return r1.slice(0, -1).concat(r2);
  }
  return [points[0], points[points.length - 1]];
}

const pairs = [
  { a: 'Ukraine', b: 'Russia', label: 'Ukraine — Russia' },
  { a: 'Ukraine', b: 'Belarus', label: 'Ukraine — Belarus' },
  { a: 'Ukraine', b: 'Poland', label: 'Ukraine — Poland' },
  { a: 'Ukraine', b: 'Slovakia', label: 'Ukraine — Slovakia' },
  { a: 'Ukraine', b: 'Hungary', label: 'Ukraine — Hungary' },
  { a: 'Ukraine', b: 'Romania', label: 'Ukraine — Romania' },
  { a: 'Ukraine', b: 'Moldova', label: 'Ukraine — Moldova' },
  { a: 'Belarus', b: 'Russia', label: 'Belarus — Russia' },
  { a: 'Poland', b: 'Belarus', label: 'Poland — Belarus' },
  { a: 'Poland', b: 'Slovakia', label: 'Poland — Slovakia' },
  { a: 'Slovakia', b: 'Hungary', label: 'Slovakia — Hungary' },
  { a: 'Hungary', b: 'Romania', label: 'Hungary — Romania' },
  { a: 'Moldova', b: 'Romania', label: 'Moldova — Romania' },
  { a: 'Lithuania', b: 'Belarus', label: 'Lithuania — Belarus' },
  { a: 'Lithuania', b: 'Russia', label: 'Lithuania — Russia' },
  { a: 'Poland', b: 'Lithuania', label: 'Poland — Lithuania' }
];

const features = [];
for (const p of pairs) {
  const feats = data.features.filter((f) => 
    (f.properties.ADM0_LEFT === p.a && f.properties.ADM0_RIGHT === p.b) ||
    (f.properties.ADM0_LEFT === p.b && f.properties.ADM0_RIGHT === p.a)
  );
  const rawSegs = feats.flatMap(getSegments);
  const chains = stitch(rawSegs);
  for (const c of chains) {
    const simplified = rdp(c, 0.008).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
    features.push({
      type: 'Feature',
      properties: {
        type: 'border',
        name: p.label,
        countryA: p.a,
        countryB: p.b
      },
      geometry: {
        type: 'LineString',
        coordinates: simplified
      }
    });
  }
}

const countryLabels = [
  { name: 'UKRAINE', pos: [31.5, 49.0], code: 'UA' },
  { name: 'RUSSIA', pos: [37.5, 52.2], code: 'RU' },
  { name: 'BELARUS', pos: [28.5, 52.8], code: 'BY' },
  { name: 'POLAND', pos: [23.2, 51.2], code: 'PL' },
  { name: 'SLOVAKIA', pos: [21.8, 48.8], code: 'SK' },
  { name: 'HUNGARY', pos: [21.5, 47.8], code: 'HU' },
  { name: 'ROMANIA', pos: [26.0, 46.5], code: 'RO' },
  { name: 'MOLDOVA', pos: [28.5, 47.2], code: 'MD' }
];
for (const cl of countryLabels) {
  features.push({
    type: 'Feature',
    properties: {
      type: 'country_label',
      name: cl.name,
      code: cl.code
    },
    geometry: {
      type: 'Point',
      coordinates: cl.pos
    }
  });
}

const geojson = { type: 'FeatureCollection', features };
writeFileSync(out, JSON.stringify(geojson, null, 2));
console.log(`Wrote ${features.length} border features to ${out}`);
