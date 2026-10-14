import { readFileSync, writeFileSync } from 'node:fs';

async function run() {
  console.log('Fetching DeepStateMap GeoJSON...');
  const res = await fetch('https://raw.githubusercontent.com/cyterat/deepstate-map-data/main/data/deepstatemap_data_20261013.geojson');
  const ds = await res.json();
  const ring = ds.features[0].geometry.coordinates[0][0];
  console.log(`DeepState poly 0 points: ${ring.length}`);

  // 1. Identify start point near Kinburn / Dnipro mouth
  // Point near [31.547, 46.539]
  let startIdx = -1;
  let minStartD = Infinity;
  for (let i = 600; i < 660; i++) {
    const d = Math.hypot(ring[i][0] - 31.547, ring[i][1] - 46.539);
    if (d < minStartD) {
      minStartD = d;
      startIdx = i;
    }
  }
  console.log(`Start point near Kinburn at idx ${startIdx}:`, ring[startIdx]);

  // 2. Identify end point near Russian border (north of Kupyansk / Velykyi Burluk)
  // around idx 1480-1490
  let endIdx = -1;
  let maxLat = -Infinity;
  for (let i = 1470; i < 1500; i++) {
    if (ring[i][1] > maxLat && ring[i][0] < 37.7) {
      maxLat = ring[i][1];
      endIdx = i;
    }
  }
  console.log(`Frontline hits border at idx ${endIdx}:`, ring[endIdx]);

  // Slice the actual combat frontline from DeepState
  const rawCombatFront = ring.slice(startIdx, endIdx + 1);
  console.log(`Raw combat front points: ${rawCombatFront.length}`);

  // Simplify slightly to ~40-60m resolution so it's performant in sim
  // Douglas-Peucker
  function simplify(pts, tol) {
    if (pts.length <= 2) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = 1;
    keep[pts.length - 1] = 1;
    function recurse(start, end) {
      let maxD = 0, maxIdx = -1;
      const [x1, y1] = pts[start], [x2, y2] = pts[end];
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1e-12;
      for (let i = start + 1; i < end; i++) {
        const d = Math.abs((pts[i][0] - x1) * dy - (pts[i][1] - y1) * dx) / len;
        if (d > maxD) { maxD = d; maxIdx = i; }
      }
      if (maxD > tol && maxIdx > 0) {
        keep[maxIdx] = 1;
        recurse(start, maxIdx);
        recurse(maxIdx, end);
      }
    }
    recurse(0, pts.length - 1);
    return pts.filter((_, i) => keep[i]);
  }

  // 0.0004 deg is ~40 meters
  const combatFront = simplify(rawCombatFront, 0.0004);
  console.log(`Simplified combat front: ${combatFront.length} points.`);

  // 3. Connect to the Ukraine-Russia international border from borders.geojson
  const borders = JSON.parse(readFileSync('mods/base/maps/borders.geojson', 'utf8'));
  const uaRuBorder = borders.features[0].geometry.coordinates; // From [31.764, 52.101] to [38.217, 47.103]
  console.log(`Ukraine-Russia border points: ${uaRuBorder.length}`);

  // Find nearest point on uaRuBorder to combatFront's last point
  const lastCombatPt = combatFront[combatFront.length - 1];
  let bestBorderIdx = -1;
  let minBorderD = Infinity;
  for (let i = 0; i < uaRuBorder.length; i++) {
    const d = Math.hypot(uaRuBorder[i][0] - lastCombatPt[0], uaRuBorder[i][1] - lastCombatPt[1]);
    if (d < minBorderD) {
      minBorderD = d;
      bestBorderIdx = i;
    }
  }
  console.log(`Nearest border pt to combat front end at idx ${bestBorderIdx}:`, uaRuBorder[bestBorderIdx]);

  // uaRuBorder[0] is [31.764, 52.101] (Belarus junction)
  // uaRuBorder goes from index 0 ([31.764, 52.101]) down to index bestBorderIdx
  // Since combatFront goes south-to-north, we need border points from bestBorderIdx backward to 0!
  const borderSection = [];
  for (let i = bestBorderIdx; i >= 0; i--) {
    borderSection.push(uaRuBorder[i]);
  }
  console.log(`Border section from hit point to Belarus junction: ${borderSection.length} points.`);

  // Full realistic frontline:
  // Starts at [31.547, 46.539] -> combatFront -> borderSection -> ends at [31.764, 52.101]
  const fullFront = [
    [31.547, 46.539],
    ...combatFront,
    ...borderSection.slice(1) // Avoid duplicate point
  ];

  // Round coordinates to 5 decimal places (~1m accuracy)
  const cleanFront = fullFront.map(p => [
    Math.round(p[0] * 100000) / 100000,
    Math.round(p[1] * 100000) / 100000
  ]);

  console.log(`Total realistic frontline points: ${cleanFront.length}`);
  console.log('Start point:', cleanFront[0]);
  console.log('End point:', cleanFront[cleanFront.length - 1]);

  // Update mods/base/maps/ukraine.json
  const ukraineMap = JSON.parse(readFileSync('mods/base/maps/ukraine.json', 'utf8'));
  ukraineMap.front = cleanFront;
  writeFileSync('mods/base/maps/ukraine.json', JSON.stringify(ukraineMap, null, 2));
  console.log('Updated mods/base/maps/ukraine.json successfully!');
}

run().catch(console.error);
