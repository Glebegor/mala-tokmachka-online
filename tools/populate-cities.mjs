import { readFileSync, writeFileSync } from 'node:fs';

const mapFile = 'mods/base/maps/ukraine.json';
const map = JSON.parse(readFileSync(mapFile, 'utf8'));

// Calculation of distToFrontKm matching packages/core/src/frontline.ts
function distKm(a, b) {
  const dlat = (b[1] - a[1]) * 111.32;
  const dlng = (b[0] - a[0]) * 111.32 * Math.cos(((a[1] + b[1]) * 0.5 * Math.PI) / 180);
  return Math.hypot(dlat, dlng);
}

function buildFront(raw, spacingKm = 2.0) {
  const out = [];
  for (let i = 0; i < raw.length - 1; i++) {
    const a = raw[i], b = raw[i + 1];
    const segLen = distKm(a, b);
    const steps = Math.max(1, Math.round(segLen / spacingKm));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({
        lng: a[0] + (b[0] - a[0]) * t,
        lat: a[1] + (b[1] - a[1]) * t,
      });
    }
  }
  const last = raw[raw.length - 1];
  out.push({ lng: last[0], lat: last[1] });
  return out;
}

function distToFrontKm(front, p) {
  let bestD = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < front.length; i++) {
    const d = distKm([front[i].lng, front[i].lat], p);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  const i0 = Math.max(0, bestIdx - 1);
  const i1 = Math.min(front.length - 1, bestIdx + 1);
  const dx = front[i1].lng - front[i0].lng;
  const dy = front[i1].lat - front[i0].lat;
  const px = p[0] - front[bestIdx].lng;
  const py = p[1] - front[bestIdx].lat;
  const cross = dx * py - dy * px;
  return cross >= 0 ? bestD : -bestD;
}

const front = buildFront(map.front, 2.0);

// Curated list of Ukrainian cities & towns (west of frontline)
const uaCandidates = [
  // Major Regional Capitals
  { id: 'kyiv', name: 'Kyiv', pos: [30.5234, 50.4501], value: 5 },
  { id: 'kharkiv', name: 'Kharkiv', pos: [36.2304, 49.9935], value: 4 },
  { id: 'dnipro', name: 'Dnipro', pos: [35.0407, 48.4647], value: 4 },
  { id: 'odesa', name: 'Odesa', pos: [30.7233, 46.4825], value: 4 },
  { id: 'zaporizhzhia', name: 'Zaporizhzhia', pos: [35.1396, 47.8388], value: 3 },
  { id: 'lviv', name: 'Lviv', pos: [24.0311, 49.8429], value: 4 },
  { id: 'kryvyi_rih', name: 'Kryvyi Rih', pos: [33.3918, 47.9105], value: 3 },
  { id: 'mykolaiv', name: 'Mykolaiv', pos: [31.9946, 46.9750], value: 3 },
  { id: 'kherson', name: 'Kherson', pos: [32.6169, 46.6354], value: 3 },
  { id: 'poltava', name: 'Poltava', pos: [34.5514, 49.5883], value: 3 },
  { id: 'chernihiv', name: 'Chernihiv', pos: [31.2893, 51.4982], value: 3 },
  { id: 'cherkasy', name: 'Cherkasy', pos: [32.0598, 49.4444], value: 3 },
  { id: 'zhytomyr', name: 'Zhytomyr', pos: [28.6684, 50.2547], value: 3 },
  { id: 'sumy', name: 'Sumy', pos: [34.7981, 50.9077], value: 3 },
  { id: 'vinnytsia', name: 'Vinnytsia', pos: [28.4682, 49.2331], value: 3 },
  { id: 'kropyvnytskyi', name: 'Kropyvnytskyi', pos: [32.2623, 48.5079], value: 3 },
  { id: 'rivne', name: 'Rivne', pos: [26.2516, 50.6199], value: 3 },
  { id: 'lutsk', name: 'Lutsk', pos: [25.3254, 50.7472], value: 3 },
  { id: 'ternopil', name: 'Ternopil', pos: [25.5948, 49.5535], value: 3 },
  { id: 'ivano_frankivsk', name: 'Ivano-Frankivsk', pos: [24.7111, 48.9226], value: 3 },
  { id: 'khmelnytskyi', name: 'Khmelnytskyi', pos: [26.9871, 49.4230], value: 3 },
  { id: 'chernivtsi', name: 'Chernivtsi', pos: [25.9354, 48.2921], value: 3 },
  { id: 'uzhhorod', name: 'Uzhhorod', pos: [22.2879, 48.6208], value: 3 },

  // Key Strategic & Industrial Centers
  { id: 'kremenchuk', name: 'Kremenchuk', pos: [33.4397, 49.0703], value: 3 },
  { id: 'bila_tserkva', name: 'Bila Tserkva', pos: [30.1242, 49.7989], value: 2 },
  { id: 'kamianske', name: 'Kamianske', pos: [34.6074, 48.5133], value: 2 },
  { id: 'nikopol', name: 'Nikopol', pos: [34.3971, 47.5762], value: 2 },
  { id: 'pavlohrad', name: 'Pavlohrad', pos: [35.8679, 48.5284], value: 2 },
  { id: 'kramatorsk', name: 'Kramatorsk', pos: [37.5639, 48.7390], value: 3 },
  { id: 'sloviansk', name: 'Sloviansk', pos: [37.6167, 48.8534], value: 2 },
  { id: 'druzhkivka', name: 'Druzhkivka', pos: [37.5255, 48.6206], value: 2 },
  { id: 'kostiantynivka', name: 'Kostiantynivka', pos: [37.7126, 48.5286], value: 2 },
  { id: 'orikhiv', name: 'Orikhiv', pos: [35.7869, 47.5684], value: 1 },
  { id: 'mala_tokmachka', name: 'Mala Tokmachka', pos: [35.8897, 47.5342], value: 2 },
  { id: 'stepnohirsk', name: 'Stepnohirsk', pos: [35.3621, 47.5869], value: 1 },
  { id: 'novodanylivka', name: 'Novodanylivka', pos: [35.8122, 47.5190], value: 1 },
  { id: 'vilniansk', name: 'Vilniansk', pos: [35.4328, 47.9422], value: 1 },
  { id: 'synelnykove', name: 'Synelnykove', pos: [35.5186, 48.3228], value: 2 },
  { id: 'marhanets', name: 'Marhanets', pos: [34.6294, 47.6447], value: 2 },
  { id: 'novomoskovsk', name: 'Samar', pos: [35.2289, 48.6344], value: 2 },
  { id: 'chuhuiv', name: 'Chuhuiv', pos: [36.6869, 49.8356], value: 2 },
  { id: 'izium', name: 'Izium', pos: [37.2801, 49.2064], value: 2 },
  { id: 'kupiansk', name: 'Kupiansk', pos: [37.6169, 49.7071], value: 2 },
  { id: 'balakliia', name: 'Balakliia', pos: [36.8583, 49.4608], value: 2 },
  { id: 'lozova', name: 'Lozova', pos: [36.3181, 48.8894], value: 2 },
  { id: 'bohodukhiv', name: 'Bohodukhiv', pos: [35.5319, 50.1606], value: 1 },
  { id: 'valky', name: 'Valky', pos: [35.6175, 49.8392], value: 1 },
  { id: 'lubny', name: 'Lubny', pos: [33.0039, 50.0153], value: 2 },
  { id: 'myrhorod', name: 'Myrhorod', pos: [33.6072, 49.9658], value: 2 },
  { id: 'hadiach', name: 'Hadiach', pos: [33.9875, 50.3667], value: 1 },
  { id: 'romny', name: 'Romny', pos: [33.4867, 50.7444], value: 2 },
  { id: 'konotop', name: 'Konotop', pos: [33.2014, 51.2408], value: 2 },
  { id: 'shostka', name: 'Shostka', pos: [33.4869, 51.8628], value: 2 },
  { id: 'hlukhiv', name: 'Hlukhiv', pos: [33.9114, 51.6778], value: 2 },
  { id: 'okhtyrka', name: 'Okhtyrka', pos: [34.8986, 50.3081], value: 2 },
  { id: 'lebedyn', name: 'Lebedyn', pos: [34.4819, 50.5828], value: 1 },
  { id: 'krolevets', name: 'Krolevets', pos: [33.3828, 51.5542], value: 1 },
  { id: 'nizhyn', name: 'Nizhyn', pos: [31.8847, 51.0483], value: 2 },
  { id: 'pryluky', name: 'Pryluky', pos: [32.3867, 50.5914], value: 2 },
  { id: 'bakhmach', name: 'Bakhmach', pos: [32.8358, 51.1808], value: 1 },
  { id: 'mena', name: 'Mena', pos: [32.2156, 51.5222], value: 1 },
  { id: 'ichnia', name: 'Ichnia', pos: [32.3786, 50.8589], value: 1 },
  { id: 'kozelets', name: 'Kozelets', pos: [31.1147, 50.9136], value: 1 },
  { id: 'fastiv', name: 'Fastiv', pos: [29.9197, 50.0781], value: 2 },
  { id: 'vasylkiv', name: 'Vasylkiv', pos: [30.3167, 50.1778], value: 2 },
  { id: 'obukhiv', name: 'Obukhiv', pos: [30.6206, 50.1161], value: 2 },
  { id: 'boryspil', name: 'Boryspil', pos: [30.9547, 50.3517], value: 2 },
  { id: 'brovary', name: 'Brovary', pos: [30.7908, 50.5114], value: 2 },
  { id: 'irpin', name: 'Irpin', pos: [30.2444, 50.5217], value: 2 },
  { id: 'bucha', name: 'Bucha', pos: [30.2153, 50.5489], value: 2 },
  { id: 'vyshhorod', name: 'Vyshhorod', pos: [30.4908, 50.5833], value: 2 },
  { id: 'pereyaslav', name: 'Pereyaslav', pos: [31.4489, 50.0650], value: 2 },
  { id: 'yahotyn', name: 'Yahotyn', pos: [31.7761, 50.2583], value: 1 },
  { id: 'berdychiv', name: 'Berdychiv', pos: [28.5808, 49.8925], value: 2 },
  { id: 'korosten', name: 'Korosten', pos: [28.6472, 50.9525], value: 2 },
  { id: 'zviahel', name: 'Zviahel', pos: [27.6322, 50.5847], value: 2 },
  { id: 'malyn', name: 'Malyn', pos: [29.2392, 50.7711], value: 1 },
  { id: 'korostyshiv', name: 'Korostyshiv', pos: [29.0558, 50.3150], value: 1 },
  { id: 'radomyshl', name: 'Radomyshl', pos: [29.2319, 50.4939], value: 1 },
  { id: 'uman', name: 'Uman', pos: [30.2217, 48.7483], value: 2 },
  { id: 'smila', name: 'Smila', pos: [31.8711, 49.2158], value: 2 },
  { id: 'zolotonosha', name: 'Zolotonosha', pos: [32.0353, 49.6672], value: 1 },
  { id: 'kaniv', name: 'Kaniv', pos: [31.4589, 49.7547], value: 1 },
  { id: 'shpola', name: 'Shpola', pos: [31.3969, 49.0044], value: 1 },
  { id: 'zvenyhorodka', name: 'Zvenyhorodka', pos: [30.9678, 49.0714], value: 1 },
  { id: 'koziatyn', name: 'Koziatyn', pos: [28.8353, 49.7183], value: 1 },
  { id: 'zhmerynka', name: 'Zhmerynka', pos: [28.1067, 49.0375], value: 2 },
  { id: 'mohyliv_podilskyi', name: 'Mohyliv-Podilskyi', pos: [27.7850, 48.4550], value: 1 },
  { id: 'haisyn', name: 'Haisyn', pos: [29.3892, 48.8106], value: 1 },
  { id: 'ladyzhyn', name: 'Ladyzhyn', pos: [29.2433, 48.6908], value: 1 },
  { id: 'tulchyn', name: 'Tulchyn', pos: [28.8544, 48.6756], value: 1 },
  { id: 'khmilnyk', name: 'Khmilnyk', pos: [27.9622, 49.5569], value: 1 },
  { id: 'oleksandriia', name: 'Oleksandriia', pos: [33.1097, 48.6714], value: 2 },
  { id: 'svitlovodsk', name: 'Svitlovodsk', pos: [33.2081, 49.0519], value: 2 },
  { id: 'znamianka', name: 'Znamianka', pos: [32.6733, 48.7119], value: 1 },
  { id: 'novoukrainka', name: 'Novoukrainka', pos: [31.5283, 48.3150], value: 1 },
  { id: 'voznesensk', name: 'Voznesensk', pos: [31.3167, 47.5622], value: 2 },
  { id: 'yuzhnoukrainsk', name: 'Yuzhnoukrainsk', pos: [31.1733, 47.8219], value: 2 },
  { id: 'pervomaisk_myk', name: 'Pervomaisk', pos: [30.8525, 48.0442], value: 2 },
  { id: 'ochakiv', name: 'Ochakiv', pos: [31.5500, 46.6186], value: 1 },
  { id: 'bashtanka', name: 'Bashtanka', pos: [32.4447, 47.4069], value: 1 },
  { id: 'novyi_buh', name: 'Novyi Buh', pos: [32.5028, 47.6833], value: 1 },
  { id: 'chornomorsk', name: 'Chornomorsk', pos: [30.6558, 46.2997], value: 2 },
  { id: 'bilhorod_dnistrovskyi', name: 'Bilhorod-Dnistrovskyi', pos: [30.3444, 46.1839], value: 2 },
  { id: 'izmail', name: 'Izmail', pos: [28.8361, 45.3486], value: 2 },
  { id: 'podilsk', name: 'Podilsk', pos: [29.5350, 47.7419], value: 2 },
  { id: 'yuzhne', name: 'Pivdenne', pos: [31.1008, 46.6217], value: 1 },
  { id: 'dubno', name: 'Dubno', pos: [25.7428, 50.4181], value: 1 },
  { id: 'sarny', name: 'Sarny', pos: [26.6083, 51.3375], value: 2 },
  { id: 'varash', name: 'Varash', pos: [25.8653, 51.3411], value: 2 },
  { id: 'ostroh', name: 'Ostroh', pos: [26.5186, 50.3292], value: 1 },
  { id: 'kovel', name: 'Kovel', pos: [24.7100, 51.2167], value: 2 },
  { id: 'volodymyr', name: 'Volodymyr', pos: [24.3167, 50.8500], value: 2 },
  { id: 'novovolynsk', name: 'Novovolynsk', pos: [24.1667, 50.7333], value: 2 },
  { id: 'stryi', name: 'Stryi', pos: [23.8500, 49.2500], value: 2 },
  { id: 'sambir', name: 'Sambir', pos: [23.2000, 49.5167], value: 2 },
  { id: 'drohobych', name: 'Drohobych', pos: [23.5000, 49.3500], value: 2 },
  { id: 'truskavets', name: 'Truskavets', pos: [23.5000, 49.2833], value: 1 },
  { id: 'chervonohrad', name: 'Sheptytskyi', pos: [24.2333, 50.4000], value: 2 },
  { id: 'kalush', name: 'Kalush', pos: [24.3667, 49.0333], value: 2 },
  { id: 'kolomyia', name: 'Kolomyia', pos: [25.0333, 48.5333], value: 2 },
  { id: 'mukachevo', name: 'Mukachevo', pos: [22.7167, 48.4500], value: 2 },
  { id: 'berehove', name: 'Berehove', pos: [22.6500, 48.2000], value: 1 },
  { id: 'khust', name: 'Khust', pos: [23.3000, 48.1833], value: 1 },
  { id: 'kamianets_podilskyi', name: 'Kamianets-Podilskyi', pos: [26.5833, 48.6833], value: 2 },
  { id: 'shepetivka', name: 'Shepetivka', pos: [27.0667, 50.1833], value: 2 },
  { id: 'starokostiantyniv', name: 'Starokostiantyniv', pos: [27.2167, 49.7500], value: 2 },
  { id: 'netishyn', name: 'Netishyn', pos: [26.6500, 50.3500], value: 2 }
];

// Curated list of Russian & East-of-frontline cities & towns (east of frontline)
const ruCandidates = [
  // Mega Capitals & Large Metropolises
  { id: 'moscow', name: 'Moscow', pos: [37.6173, 55.7558], value: 5 },
  { id: 'saint_petersburg', name: 'Saint Petersburg', pos: [30.3351, 59.9343], value: 5 },
  { id: 'nizhny_novgorod', name: 'Nizhny Novgorod', pos: [44.0059, 56.3269], value: 4 },
  { id: 'kazan', name: 'Kazan', pos: [49.1221, 55.7887], value: 4 },
  { id: 'samara', name: 'Samara', pos: [50.1500, 53.2000], value: 4 },
  { id: 'rostov', name: 'Rostov-on-Don', pos: [39.7203, 47.2357], value: 4 },
  { id: 'voronezh', name: 'Voronezh', pos: [39.2003, 51.6720], value: 3 },
  { id: 'ulyanovsk', name: 'Ulyanovsk', pos: [48.4000, 54.3200], value: 3 },
  { id: 'tolyatti', name: 'Tolyatti', pos: [49.4200, 53.5100], value: 3 },
  { id: 'yaroslavl', name: 'Yaroslavl', pos: [39.8700, 57.6200], value: 3 },
  { id: 'ryazan', name: 'Ryazan', pos: [39.7400, 54.6300], value: 3 },
  { id: 'tula', name: 'Tula', pos: [37.6200, 54.2000], value: 3 },
  { id: 'lipetsk', name: 'Lipetsk', pos: [39.6000, 52.6100], value: 3 },
  { id: 'penza', name: 'Penza', pos: [45.0000, 53.2000], value: 3 },
  { id: 'cheboksary', name: 'Cheboksary', pos: [47.2500, 56.1300], value: 3 },
  { id: 'kaluga', name: 'Kaluga', pos: [36.2700, 54.5300], value: 3 },
  { id: 'kursk', name: 'Kursk', pos: [36.1930, 51.7304], value: 3 },
  { id: 'belgorod', name: 'Belgorod', pos: [36.5983, 50.5997], value: 3 },
  { id: 'orel', name: 'Orel', pos: [36.0800, 52.9700], value: 3 },
  { id: 'bryansk', name: 'Bryansk', pos: [34.3717, 53.2521], value: 3 },
  { id: 'smolensk', name: 'Smolensk', pos: [32.0453, 54.7818], value: 3 },
  { id: 'tver', name: 'Tver', pos: [35.9000, 56.8600], value: 3 },
  { id: 'ivanovo', name: 'Ivanovo', pos: [40.9700, 57.0000], value: 3 },
  { id: 'vladimir', name: 'Vladimir', pos: [40.4000, 56.1300], value: 3 },
  { id: 'tambov', name: 'Tambov', pos: [41.4500, 52.7200], value: 3 },
  { id: 'saransk', name: 'Saransk', pos: [45.1800, 54.1800], value: 3 },
  { id: 'kostroma', name: 'Kostroma', pos: [40.9300, 57.7700], value: 2 },
  { id: 'yoshkar_ola', name: 'Yoshkar-Ola', pos: [47.8900, 56.6300], value: 2 },
  { id: 'novgorod', name: 'Veliky Novgorod', pos: [31.2700, 58.5200], value: 3 },
  { id: 'pskov', name: 'Pskov', pos: [28.3300, 57.8200], value: 3 },
  { id: 'cherepovets', name: 'Cherepovets', pos: [37.9000, 59.1300], value: 3 },
  { id: 'vologda', name: 'Vologda', pos: [39.8900, 59.2200], value: 3 },

  // Rostov & South Region Cities
  { id: 'taganrog', name: 'Taganrog', pos: [38.9200, 47.2200], value: 2 },
  { id: 'shakhty', name: 'Shakhty', pos: [40.2100, 47.7100], value: 2 },
  { id: 'novocherkassk', name: 'Novocherkassk', pos: [40.0900, 47.4200], value: 2 },
  { id: 'volgodonsk', name: 'Volgodonsk', pos: [42.1700, 47.5100], value: 2 },
  { id: 'bataysk', name: 'Bataysk', pos: [39.7500, 47.1400], value: 2 },
  { id: 'kamensk_shakhtinsky', name: 'Kamensk-Shakhtinsky', pos: [40.2600, 48.3200], value: 2 },
  { id: 'millerovo', name: 'Millerovo', pos: [40.4000, 48.9200], value: 2 },
  { id: 'donetsk_ru', name: 'Donetsk (RF)', pos: [39.9500, 48.3300], value: 1 },
  { id: 'morozovsk', name: 'Morozovsk', pos: [41.8300, 48.3500], value: 1 },
  { id: 'salsk', name: 'Salsk', pos: [41.5000, 46.4700], value: 2 },
  { id: 'azov', name: 'Azov', pos: [39.4200, 47.1100], value: 2 },

  // Belgorod, Kursk, Bryansk, Voronezh Hubs
  { id: 'stary_oskol', name: 'Stary Oskol', pos: [37.8300, 51.3000], value: 2 },
  { id: 'gubkin', name: 'Gubkin', pos: [37.5500, 51.2800], value: 2 },
  { id: 'shebekino', name: 'Shebekino', pos: [36.9000, 50.4100], value: 1 },
  { id: 'valuyki', name: 'Valuyki', pos: [38.1200, 50.1900], value: 1 },
  { id: 'alekseevka', name: 'Alekseevka', pos: [38.6900, 50.6300], value: 1 },
  { id: 'rylsk', name: 'Rylsk', pos: [35.2700, 51.5700], value: 1 },
  { id: 'kurchatov', name: 'Kurchatov', pos: [35.6500, 51.6600], value: 2 },
  { id: 'lgov', name: 'Lgov', pos: [35.2600, 51.6700], value: 1 },
  { id: 'sudzha', name: 'Sudzha', pos: [35.2700, 51.1900], value: 1 },
  { id: 'zheleznogorsk', name: 'Zheleznogorsk', pos: [35.3700, 52.3300], value: 2 },
  { id: 'klintsy', name: 'Klintsy', pos: [32.2300, 52.7500], value: 2 },
  { id: 'novozybkov', name: 'Novozybkov', pos: [31.9300, 52.5300], value: 2 },
  { id: 'unecha', name: 'Unecha', pos: [32.6800, 52.8400], value: 1 },
  { id: 'starodub', name: 'Starodub', pos: [32.6000, 52.5800], value: 1 },
  { id: 'karachev', name: 'Karachev', pos: [34.9800, 53.1200], value: 1 },
  { id: 'dyatkovo', name: 'Dyatkovo', pos: [34.3300, 53.6000], value: 1 },
  { id: 'pochep', name: 'Pochep', pos: [33.4500, 52.9300], value: 1 },
  { id: 'roslavl', name: 'Roslavl', pos: [32.8600, 53.9500], value: 2 },
  { id: 'vyazma', name: 'Vyazma', pos: [34.3000, 55.2100], value: 2 },
  { id: 'yartsevo', name: 'Yartsevo', pos: [32.7000, 55.0700], value: 1 },
  { id: 'safonovo', name: 'Safonovo', pos: [33.2300, 55.1100], value: 1 },
  { id: 'desnogorsk', name: 'Desnogorsk', pos: [33.2800, 54.1500], value: 2 },
  { id: 'yelets', name: 'Yelets', pos: [38.5000, 52.6200], value: 2 },
  { id: 'gryazi', name: 'Gryazi', pos: [39.9400, 52.5000], value: 1 },
  { id: 'rossosh', name: 'Rossosh', pos: [39.5700, 50.2000], value: 2 },
  { id: 'liski', name: 'Liski', pos: [39.5000, 50.9800], value: 2 },
  { id: 'ostrogozhsk', name: 'Ostrogozhsk', pos: [39.0400, 50.8600], value: 1 },
  { id: 'pavlovsk_vrn', name: 'Pavlovsk', pos: [40.0700, 50.4600], value: 1 },
  { id: 'boguchar', name: 'Boguchar', pos: [40.5500, 49.9300], value: 1 },
  { id: 'buturlinovka', name: 'Buturlinovka', pos: [40.5800, 50.8300], value: 1 },
  { id: 'novovoronezh', name: 'Novovoronezh', pos: [39.2200, 51.3100], value: 2 },
  { id: 'borisoglebsk', name: 'Borisoglebsk', pos: [42.0800, 51.3700], value: 2 },
  { id: 'michurinsk', name: 'Michurinsk', pos: [40.4900, 52.8900], value: 2 },
  { id: 'morshansk', name: 'Morshansk', pos: [41.8100, 53.4400], value: 1 },
  { id: 'kotovsk', name: 'Kotovsk', pos: [41.5000, 52.5900], value: 1 },
  { id: 'livny', name: 'Livny', pos: [37.6100, 52.4200], value: 2 },
  { id: 'mtsensk', name: 'Mtsensk', pos: [36.5700, 53.2800], value: 2 },
  { id: 'novomoskovsk_tula', name: 'Novomoskovsk (RF)', pos: [38.2900, 54.0300], value: 2 },
  { id: 'efremov', name: 'Efremov', pos: [38.1200, 53.1400], value: 1 },
  { id: 'obninsk', name: 'Obninsk', pos: [36.6100, 55.1000], value: 2 },
  { id: 'murom', name: 'Murom', pos: [42.0500, 55.5700], value: 2 },
  { id: 'kovrov', name: 'Kovrov', pos: [41.3100, 56.3600], value: 2 },

  // Donbas, South & Crimea (East of frontline)
  { id: 'donetsk', name: 'Donetsk', pos: [37.8028, 48.0159], value: 4 },
  { id: 'luhansk', name: 'Luhansk', pos: [39.3078, 48.5740], value: 3 },
  { id: 'makiivka', name: 'Makiivka', pos: [37.9614, 48.0556], value: 3 },
  { id: 'horlivka', name: 'Horlivka', pos: [38.0028, 48.3061], value: 2 },
  { id: 'mariupol', name: 'Mariupol', pos: [37.5550, 47.0958], value: 3 },
  { id: 'melitopol', name: 'Melitopol', pos: [35.3686, 46.8489], value: 3 },
  { id: 'berdiansk', name: 'Berdiansk', pos: [36.7864, 46.7556], value: 2 },
  { id: 'alchevsk', name: 'Alchevsk', pos: [38.8167, 48.4833], value: 2 },
  { id: 'sievierodonetsk', name: 'Sievierodonetsk', pos: [38.4833, 48.9500], value: 2 },
  { id: 'lysychansk', name: 'Lysychansk', pos: [38.4333, 48.8833], value: 2 },
  { id: 'bakhmut', name: 'Bakhmut', pos: [38.0000, 48.6000], value: 2 },
  { id: 'pokrovsk', name: 'Pokrovsk', pos: [37.1800, 48.2800], value: 2 },
  { id: 'avdiivka', name: 'Avdiivka', pos: [37.7400, 48.1400], value: 1 },
  { id: 'svatove', name: 'Svatove', pos: [38.1500, 49.4100], value: 1 },
  { id: 'starobilsk', name: 'Starobilsk', pos: [38.9000, 49.2700], value: 2 },
  { id: 'tokmak', name: 'Tokmak', pos: [35.7100, 47.2500], value: 2 },
  { id: 'polohy', name: 'Polohy', pos: [36.2600, 47.4800], value: 1 },
  { id: 'enerhodar', name: 'Enerhodar', pos: [34.6500, 47.5000], value: 2 },
  { id: 'nova_kakhovka', name: 'Nova Kakhovka', pos: [33.3700, 46.7600], value: 1 },
  { id: 'kakhovka', name: 'Kakhovka', pos: [33.4800, 46.8100], value: 1 },
  { id: 'oleshky', name: 'Oleshky', pos: [32.7200, 46.6100], value: 1 },
  { id: 'skadovsk', name: 'Skadovsk', pos: [32.9100, 46.1200], value: 1 },
  { id: 'henichesk', name: 'Henichesk', pos: [34.8000, 46.1700], value: 2 },
  { id: 'armiansk', name: 'Armiansk', pos: [33.6900, 46.1100], value: 1 },
  { id: 'dzhankoi', name: 'Dzhankoi', pos: [34.3900, 45.7100], value: 2 },
  { id: 'simferopol', name: 'Simferopol', pos: [34.1000, 44.9500], value: 3 },
  { id: 'sevastopol', name: 'Sevastopol', pos: [33.5200, 44.6100], value: 3 },
  { id: 'yalta', name: 'Yalta', pos: [34.1600, 44.5000], value: 2 },
  { id: 'feodosia', name: 'Feodosia', pos: [35.3800, 45.0300], value: 2 },
  { id: 'kerch', name: 'Kerch', pos: [36.4700, 45.3600], value: 3 },
  { id: 'yevpatoria', name: 'Yevpatoria', pos: [33.3600, 45.1900], value: 2 },
  { id: 'huliaipole', name: 'Huliaipole', pos: [36.2600, 47.6600], value: 1 }
];

console.log(`Initial UA candidates: ${uaCandidates.length}, RU candidates: ${ruCandidates.length}`);

// Verify side for each candidate
const finalUA = [];
for (const c of uaCandidates) {
  const d = distToFrontKm(front, c.pos);
  if (d > 0) {
    finalUA.push(c);
  } else {
    console.log(`UA candidate ${c.name} has distance ${d.toFixed(1)} km (on RU side!)`);
  }
}

const finalRU = [];
for (const c of ruCandidates) {
  const d = distToFrontKm(front, c.pos);
  if (d < 0) {
    finalRU.push(c);
  } else {
    console.log(`RU candidate ${c.name} has distance ${d.toFixed(1)} km (on UA side!)`);
  }
}

console.log(`Verified UA side count: ${finalUA.length}, RU side count: ${finalRU.length}`);

if (finalUA.length < 100 || finalRU.length < 100) {
  console.error(`Not enough verified points! UA: ${finalUA.length}, RU: ${finalRU.length}`);
  process.exit(1);
}

// Slice exactly 100 from each side
const selectedUA = finalUA.slice(0, 100);
const selectedRU = finalRU.slice(0, 100);

const totalPoints = [...selectedUA, ...selectedRU];
console.log(`Selected exactly ${selectedUA.length} UA points and ${selectedRU.length} RU points (Total: ${totalPoints.length})`);

// Ensure unique IDs
const idSet = new Set();
for (const p of totalPoints) {
  if (idSet.has(p.id)) {
    console.error(`Duplicate ID found: ${p.id}`);
    process.exit(1);
  }
  idSet.add(p.id);
}

map.capturePoints = totalPoints;

writeFileSync(mapFile, JSON.stringify(map, null, 2));
console.log(`Successfully updated ${mapFile} with 200 capture points!`);
