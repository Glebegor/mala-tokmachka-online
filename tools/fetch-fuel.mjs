import { readFileSync, writeFileSync } from 'node:fs';

const map = JSON.parse(readFileSync('mods/base/maps/ukraine.json', 'utf8'));
const cities = map.capturePoints;

console.log(`Processing fuel stations for ${cities.length} cities...`);

// Real fuel brands in Ukraine and Russia
const UKR_BRANDS = ['OKKO', 'WOG', 'SOCAR', 'Укрнафта', 'AMIC Energy', 'KLO', 'Shell', 'БРСМ-Нафта'];
const RU_BRANDS = ['Лукойл', 'Роснефть', 'Газпромнефть', 'Татнефть', 'Башнефть', 'Сургутнефтегаз', 'Teboil'];

// Additional cities to cover the vast territory evenly
const EXTRA_CITIES = [
  { id: 'lviv', name: 'Lviv', pos: [24.03, 49.84] },
  { id: 'zhytomyr', name: 'Zhytomyr', pos: [28.66, 50.25] },
  { id: 'vinnytsia', name: 'Vinnytsia', pos: [28.46, 49.23] },
  { id: 'cherkasy', name: 'Cherkasy', pos: [32.06, 49.44] },
  { id: 'chernihiv', name: 'Chernihiv', pos: [31.28, 51.49] },
  { id: 'kropyvnytskyi', name: 'Kropyvnytskyi', pos: [32.26, 48.51] },
  { id: 'mykolaiv', name: 'Mykolaiv', pos: [31.99, 46.97] },
  { id: 'berdyansk', name: 'Berdyansk', pos: [36.78, 46.75] },
  { id: 'kerch', name: 'Kerch', pos: [36.47, 45.35] },
  { id: 'feodosia', name: 'Feodosia', pos: [35.38, 45.03] },
  { id: 'yalta', name: 'Yalta', pos: [34.16, 44.49] },
  { id: 'tula', name: 'Tula', pos: [37.61, 54.19] },
  { id: 'kaluga', name: 'Kaluga', pos: [36.26, 54.52] },
  { id: 'orel', name: 'Orel', pos: [36.06, 52.96] },
  { id: 'lipetsk', name: 'Lipetsk', pos: [39.59, 52.61] },
  { id: 'tambov', name: 'Tambov', pos: [41.44, 52.72] },
  { id: 'ryazan', name: 'Ryazan', pos: [39.73, 54.62] },
  { id: 'vladimir', name: 'Vladimir', pos: [40.40, 56.12] },
  { id: 'tver', name: 'Tver', pos: [35.91, 56.85] },
  { id: 'veliky_novgorod', name: 'Veliky Novgorod', pos: [31.27, 58.52] },
  { id: 'pskov', name: 'Pskov', pos: [28.33, 57.81] },
  { id: 'penza', name: 'Penza', pos: [45.01, 53.19] },
  { id: 'saransk', name: 'Saransk', pos: [45.18, 54.18] },
  { id: 'saratov', name: 'Saratov', pos: [46.03, 51.53] },
  { id: 'volgograd', name: 'Volgograd', pos: [44.51, 48.70] },
  { id: 'krasnodar', name: 'Krasnodar', pos: [38.97, 45.03] },
  { id: 'novorossiysk', name: 'Novorossiysk', pos: [37.77, 44.72] },
  { id: 'sochi', name: 'Sochi', pos: [39.72, 43.58] },
  { id: 'gomel', name: 'Gomel', pos: [30.98, 52.42] },
  { id: 'mogilev', name: 'Mogilev', pos: [30.34, 53.90] },
  { id: 'vitebsk', name: 'Vitebsk', pos: [30.20, 55.19] },
  { id: 'minsk', name: 'Minsk', pos: [27.56, 53.90] },
];

const allLocations = [...cities, ...EXTRA_CITIES];

// Query Overpass in a single consolidated request for amenity=fuel around each location
async function fetchStations() {
  const parts = allLocations.map(c => `node["amenity"="fuel"](around:12000, ${c.pos[1]}, ${c.pos[0]});`).join('\n');
  const query = `
    [out:json][timeout:35];
    (
      ${parts}
    );
    out body;
  `;

  console.log('Fetching Overpass stations for', allLocations.length, 'locations...');
  let elements = [];
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'User-Agent': 'MalaTokmachkaGame/1.0' }
    });
    if (res.ok) {
      const data = await res.json();
      elements = data.elements || [];
      console.log(`Received ${elements.length} raw OSM fuel stations from Overpass!`);
    } else {
      console.log('Overpass returned status:', res.status);
    }
  } catch (e) {
    console.log('Overpass request failed:', e.message);
  }

  // Thinning: ~1 gas station per city/town, min distance ~15 km
  const features = [];
  const minSpacingDeg = 0.15; // ~15 km

  function isFar(lng, lat) {
    return features.every(f => {
      const [exLng, exLat] = f.geometry.coordinates;
      const d = Math.hypot(exLng - lng, exLat - lat);
      return d >= minSpacingDeg;
    });
  }

  // For each city/location, pick the best station from Overpass, or synthesize one
  for (let i = 0; i < allLocations.length; i++) {
    const loc = allLocations[i];
    const [cLng, cLat] = loc.pos;

    // Look for OSM elements near this city
    const nearby = elements.filter(e => Math.hypot(e.lon - cLng, e.lat - cLat) < 0.25);
    let chosen = null;
    if (nearby.length > 0) {
      // Prefer ones with brand or name
      nearby.sort((a, b) => {
        const aHas = (a.tags?.brand || a.tags?.name) ? 1 : 0;
        const bHas = (b.tags?.brand || b.tags?.name) ? 1 : 0;
        return bHas - aHas;
      });
      for (const n of nearby) {
        if (isFar(n.lon, n.lat)) {
          chosen = {
            lng: Math.round(n.lon * 1e4) / 1e4,
            lat: Math.round(n.lat * 1e4) / 1e4,
            name: n.tags?.brand || n.tags?.name || 'АЗС',
            osmId: n.id,
          };
          break;
        }
      }
    }

    // Fallback if none found or spaced too close
    if (!chosen && isFar(cLng + 0.02, cLat + 0.015)) {
      const isEast = cLng > 37.0;
      const brand = isEast
        ? RU_BRANDS[i % RU_BRANDS.length]
        : UKR_BRANDS[i % UKR_BRANDS.length];
      chosen = {
        lng: Math.round((cLng + 0.02 * Math.cos(i * 1.7)) * 1e4) / 1e4,
        lat: Math.round((cLat + 0.015 * Math.sin(i * 1.7)) * 1e4) / 1e4,
        name: brand,
        osmId: 100000 + i,
      };
    }

    if (chosen) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [chosen.lng, chosen.lat]
        },
        properties: {
          id: `fuel_${features.length + 1}`,
          name: chosen.name,
          city: loc.name,
        }
      });
    }
  }

  const geojson = {
    type: 'FeatureCollection',
    features
  };

  const outFile = 'mods/base/maps/ukraine.fuel.json';
  writeFileSync(outFile, JSON.stringify(geojson, null, 2));
  console.log(`Saved ${features.length} gas stations to ${outFile}`);
}

fetchStations();
