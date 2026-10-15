/** Ukrainian names of the game world: cities, countries, maps, units, buildings, ranks, terrain and resources. */

export const UK_CITIES: Record<string, string> = {
  Alchevsk: 'Алчевськ', Alekseevka: 'Олексіївка', Avdiivka: 'Авдіївка', Azov: 'Азов', Bakhmach: 'Бахмач', Bakhmut: 'Бахмут',
  Balakliia: 'Балаклія', Bashtanka: 'Баштанка', Bataysk: 'Батайськ', Belgorod: 'Бєлгород', Berdiansk: 'Бердянськ', Berdychiv: 'Бердичів',
  'Bila Tserkva': 'Біла Церква', 'Bilhorod-Dnistrovskyi': 'Білгород-Дністровський', Boguchar: 'Богучар', Bohodukhiv: 'Богодухів',
  Borisoglebsk: 'Борисоглібськ', Boryspil: 'Бориспіль', Brovary: 'Бровари', Bryansk: 'Брянськ', Bucha: 'Буча', Buturlinovka: 'Бутурлинівка',
  Cheboksary: 'Чебоксари', Cherepovets: 'Череповець', Cherkasy: 'Черкаси', Chernihiv: 'Чернігів', Chornomorsk: 'Чорноморськ', Chuhuiv: 'Чугуїв',
  Desnogorsk: 'Десногорськ', Dnipro: 'Дніпро', Donetsk: 'Донецьк', 'Donetsk (RF)': 'Донецьк (РФ)', Druzhkivka: 'Дружківка', Dubno: 'Дубно',
  Dyatkovo: 'Дятьково', Efremov: 'Єфремов', Fastiv: 'Фастів', Gryazi: 'Грязі', Gubkin: 'Губкін', Hadiach: 'Гадяч', Haisyn: 'Гайсин',
  Hlukhiv: 'Глухів', Horlivka: 'Горлівка', Huliaipole: 'Гуляйполе', Ichnia: 'Ічня', Irpin: 'Ірпінь', Ivanovo: 'Іваново', Izium: 'Ізюм',
  Izmail: 'Ізмаїл', Kaluga: 'Калуга', 'Kamensk-Shakhtinsky': 'Каменськ-Шахтинський', Kamianske: "Кам'янське", Kaniv: 'Канів',
  Karachev: 'Карачев', Kazan: 'Казань', Kharkiv: 'Харків', Kherson: 'Херсон', Khmelnytskyi: 'Хмельницький', Khmilnyk: 'Хмільник',
  Klintsy: 'Клинці', Konotop: 'Конотоп', Korosten: 'Коростень', Korostyshiv: 'Коростишів', Kostiantynivka: 'Костянтинівка',
  Kostroma: 'Кострома', Kotovsk: 'Котовськ', Kovrov: 'Ковров', Kozelets: 'Козелець', Koziatyn: 'Козятин', Kramatorsk: 'Краматорськ',
  Kremenchuk: 'Кременчук', Krolevets: 'Кролевець', Kropyvnytskyi: 'Кропивницький', 'Kryvyi Rih': 'Кривий Ріг', Kupiansk: "Куп'янськ",
  Kurchatov: 'Курчатов', Kursk: 'Курськ', Kyiv: 'Київ', Lebedyn: 'Лебедин', Lgov: 'Льгов', Lipetsk: 'Липецьк', Liski: 'Лиски',
  Livny: 'Лівни', Lozova: 'Лозова', Lubny: 'Лубни', Luhansk: 'Луганськ', Lutsk: 'Луцьк', Lviv: 'Львів', Lysychansk: 'Лисичанськ',
  Makiivka: 'Макіївка', 'Mala Tokmachka': 'Мала Токмачка', Malyn: 'Малин', Marhanets: 'Марганець', Mariupol: 'Маріуполь',
  Melitopol: 'Мелітополь', Mena: 'Мена', Michurinsk: 'Мічурінськ', Millerovo: 'Міллерово', Morozovsk: 'Морозовськ', Morshansk: 'Моршанськ',
  Moscow: 'Москва', Mtsensk: 'Мценськ', Murom: 'Муром', Mykolaiv: 'Миколаїв', Myrhorod: 'Миргород', Nikopol: 'Нікополь',
  'Nizhny Novgorod': 'Нижній Новгород', Nizhyn: 'Ніжин', Novocherkassk: 'Новочеркаськ', Novodanylivka: 'Новоданилівка',
  'Novomoskovsk (RF)': 'Новомосковськ (РФ)', Novoukrainka: 'Новоукраїнка', Novovoronezh: 'Нововоронеж', Novozybkov: 'Новозибков',
  'Novyi Buh': 'Новий Буг', Obninsk: 'Обнінськ', Obukhiv: 'Обухів', Ochakiv: 'Очаків', Odesa: 'Одеса', Okhtyrka: 'Охтирка',
  Oleksandriia: 'Олександрія', Orel: 'Орел', Orikhiv: 'Оріхів', Ostrogozhsk: 'Острогозьк', Pavlohrad: 'Павлоград', Pavlovsk: 'Павловськ',
  Penza: 'Пенза', Pereyaslav: 'Переяслав', Pervomaisk: 'Первомайськ', Pivdenne: 'Південне', Pochep: 'Почеп', Pokrovsk: 'Покровськ',
  Polohy: 'Пологи', Poltava: 'Полтава', Pryluky: 'Прилуки', Pskov: 'Псков', Radomyshl: 'Радомишль', Rivne: 'Рівне', Romny: 'Ромни',
  Roslavl: 'Рославль', Rossosh: 'Россош', 'Rostov-on-Don': 'Ростов-на-Дону', Ryazan: 'Рязань', Rylsk: 'Рильськ', Safonovo: 'Сафоново',
  'Saint Petersburg': 'Санкт-Петербург', Salsk: 'Сальськ', Samar: 'Самар', Samara: 'Самара', Saransk: 'Саранськ', Sarny: 'Сарни',
  Shakhty: 'Шахти', Shebekino: 'Шебекіно', Shostka: 'Шостка', Shpola: 'Шпола', Sievierodonetsk: 'Сєвєродонецьк', Sloviansk: "Слов'янськ",
  Smila: 'Сміла', Smolensk: 'Смоленськ', Starobilsk: 'Старобільськ', Starodub: 'Стародуб', 'Stary Oskol': 'Старий Оскол',
  Stepnohirsk: 'Степногірськ', Sudzha: 'Суджа', Sumy: 'Суми', Svatove: 'Сватове', Svitlovodsk: 'Світловодськ', Synelnykove: 'Синельникове',
  Taganrog: 'Таганрог', Tambov: 'Тамбов', Ternopil: 'Тернопіль', Tokmak: 'Токмак', Tolyatti: "Тольятті", Tula: 'Тула', Tver: 'Твер',
  Ulyanovsk: 'Ульяновськ', Uman: 'Умань', Unecha: 'Унеча', Valky: 'Валки', Valuyki: 'Валуйки', Vasylkiv: 'Васильків',
  'Veliky Novgorod': 'Великий Новгород', Vilniansk: 'Вільнянськ', Vladimir: 'Владимир', Volgodonsk: 'Волгодонськ', Vologda: 'Вологда',
  Voronezh: 'Воронеж', Voznesensk: 'Вознесенськ', Vyazma: "В'язьма", Vyshhorod: 'Вишгород', Yahotyn: 'Яготин', Yaroslavl: 'Ярославль',
  Yartsevo: 'Ярцево', Yelets: 'Єлець', 'Yoshkar-Ola': 'Йошкар-Ола', Yuzhnoukrainsk: 'Южноукраїнськ', Zaporizhzhia: 'Запоріжжя',
  Zheleznogorsk: 'Железногорськ', Zhytomyr: 'Житомир', Znamianka: "Знам'янка", Zolotonosha: 'Золотоноша', Zvenyhorodka: 'Звенигородка',
  Zviahel: 'Звягель',
  // countries and maps
  BELARUS: 'БІЛОРУСЬ', HUNGARY: 'УГОРЩИНА', MOLDOVA: 'МОЛДОВА', POLAND: 'ПОЛЬЩА', ROMANIA: 'РУМУНІЯ', SLOVAKIA: 'СЛОВАЧЧИНА',
  RUSSIA: 'РОСІЯ', UKRAINE: 'УКРАЇНА', Russia: 'Росія', Ukraine: 'Україна',
  'Eastern Europe — Expanded Theater': 'Східна Європа — розширений театр',
  'Zaporizhzhia sector (small)': 'Запорізький сектор (малий)',
};

export const UK_DEFS: Record<string, string> = {
  // units
  Infantry: 'Піхота',
  'Cheap all-round riflemen. Best in forest and cities where they get cover; can ford streams. Weak in the open against armour. Can ride in pickups and trucks.':
    'Дешеві універсальні стрільці. Найкращі в лісі та містах, де є укриття; переходять струмки вбрід. Слабкі у відкритому полі проти броні. Можуть їхати в пікапах і вантажівках.',
  'Recon Team': 'Розвідгрупа',
  'Small, hard to spot (sees 12 km, very stealthy). The eyes your artillery needs.': 'Невелика й малопомітна (бачить на 12 км, дуже скритна). Очі, яких потребує ваша артилерія.',
  'Assault Infantry': 'Штурмова піхота',
  'Heavy assault troops: lots of damage at close range, slow.': 'Важкі штурмові війська: велика шкода на близькій відстані, повільні.',
  'Anti-Tank Team': 'Протитанкова група',
  'Missile team: hits hard at 2.2 km, ideal against armour. Fragile.': 'Розрахунок ПТРК: б’є сильно на 2,2 км, ідеальний проти броні. Вразливий.',
  'MANPADS Team': 'Розрахунок ПЗРК',
  'Shoulder-launched anti-aircraft missiles (Stinger, Igla): shoots down recon drones, strike drones and cruise missiles within 5 km. Cannot engage ground targets. 6 missiles; refill at an ammo depot or base.':
    'Переносні зенітні ракети (Stinger, «Ігла»): збиває розвідувальні та ударні дрони й крилаті ракети в радіусі 5 км. Не може бити наземні цілі. 6 ракет; поповнення на складі БК або базі.',
  'Medic Team': 'Медична група',
  'Combat medics: troops on foot within 2 km get back 2% of their strength a second once they have been out of the fight for 10 s. Unarmed. Works only out of the fight: not under fire for 10 s and no enemy ground troops within 3 km.':
    'Бойові медики: піші війська в радіусі 2 км відновлюють 2% сили щосекунди, якщо вже 10 с поза боєм. Без зброї. Працює лише поза боєм: 10 с без обстрілу й жодних ворожих наземних військ у радіусі 3 км.',
  Pickup: 'Пікап',
  'Fast light vehicle with a machine gun. Carries 500 cargo, one infantry squad and a launcher for two small drones (load them next to it, launch them from the field).':
    'Швидка легка машина з кулеметом. Везе 500 вантажу, один піхотний загін і пускову установку на два малі дрони (завантажте їх поруч, запускайте з поля).',
  Truck: 'Вантажівка',
  'Logistics: hauls 3,000 ore or metal on a delivery route and carries four infantry squads. Unarmed.': 'Логістика: возить 3 000 руди чи металу маршрутом доставки й перевозить чотири піхотні загони. Без зброї.',
  'Fuel Truck': 'Паливозаправник',
  'Tanker: hauls 3,000 fuel on a delivery route and refuels vehicles within 5 km. Unarmed.': 'Цистерна: возить 3 000 пального маршрутом доставки й заправляє техніку в радіусі 5 км. Без зброї.',
  'Freight Train': 'Вантажний потяг',
  'Carries 20,000 goods on a delivery route between railway stations, at 72 km/min. Runs only on your track; if the track is cut it waits for a connection. Refuels at stations.':
    'Везе 20 000 вантажу маршрутом між залізничними станціями зі швидкістю 72 км/хв. Їздить лише вашою колією; якщо колію перерізано, чекає на сполучення. Заправляється на станціях.',
  'Rescue Crew': 'Рятувальники',
  'Repairs: inside a city it restores the city and its housing; outside it patches buildings within 2 km. Nothing can be repaired within 60 s of being hit. Works only out of the fight: not under fire for 10 s and no enemy ground troops within 3 km.':
    'Ремонт: у місті відновлює місто та його житло; поза містом лагодить будівлі в радіусі 2 км. Нічого не ремонтується впродовж 60 с після влучання. Працює лише поза боєм: 10 с без обстрілу й жодних ворожих наземних військ у радіусі 3 км.',
  'Mechanic Crew': 'Ремонтна бригада',
  'Recovery and repair crew: tanks, artillery and other vehicles within 2 km get back 2% of their strength a second once they have been out of the fight for 10 s. Unarmed. Works only out of the fight: not under fire for 10 s and no enemy ground troops within 3 km.':
    'Евакуаційно-ремонтна бригада: танки, артилерія та інша техніка в радіусі 2 км відновлюють 2% сили щосекунди, якщо вже 10 с поза боєм. Без зброї. Працює лише поза боєм: 10 с без обстрілу й жодних ворожих наземних військ у радіусі 3 км.',
  'APC (BTR / M113)': 'БТР (БТР / M113)',
  "Armoured personnel carrier: brings two infantry squads to the front under armour (Board from the infantry's panel). A heavy machine gun; weak against tanks and anti-tank teams.":
    'Бронетранспортер: довозить два піхотні загони до фронту під бронею («Сісти» в панелі піхоти). Великокаліберний кулемет; слабкий проти танків і протитанкових груп.',
  'IFV (BMP / Bradley)': 'БМП (БМП / Bradley)',
  'Infantry fighting vehicle: carries one squad and backs it with an autocannon (2 km). Tracked: copes with fields and mud better than an APC.':
    'Бойова машина піхоти: везе один загін і підтримує його автоматичною гарматою (2 км). Гусенична: краще за БТР долає поля й багнюку.',
  Tank: 'Танк',
  'Heavy direct fire and armour. Fast on roads and open fields, bogs down in forest, hills and cities. Needs metal and fuel. Burns fuel.':
    'Потужний прямий вогонь і броня. Швидкий на дорогах і в полі, грузне в лісі, на пагорбах і в містах. Потребує металу й пального. Витрачає пальне.',
  Artillery: 'Артилерія',
  'Indirect fire from 4 to 20 km (nothing closer than a fifth of its range). Takes 2.5 s to aim at each new target. Only fires at what your side can see (spot for it with recon or drones), or barrage a chosen area. Never drives up to the front line.':
    'Вогонь із закритих позицій на 4–20 км (не ближче п’ятої частини дальності). Наводиться 2,5 с на кожну нову ціль. Стріляє лише по тому, що бачить ваша сторона (коригуйте розвідкою чи дронами), або накриває обрану площу. Ніколи не під’їжджає до лінії фронту.',
  'Recon Drone': 'Розвідувальний дрон',
  "Generic recon drone: flies over any terrain, sees 18 km and circles its area. Refuels only at an airfield. Small enough to ride on a pickup's launcher.":
    'Звичайний розвідувальний дрон: літає над будь-якою місцевістю, бачить на 18 км і кружляє над своєю зоною. Заправляється лише на аеродромі. Досить малий для пускової установки пікапа.',
  'Shahed-136': 'Shahed-136',
  'Strike drone (one-way): flies to the target and explodes, wrecking units, buildings and city structure nearby. Cannot refuel.':
    'Ударний дрон (одноразовий): летить до цілі й вибухає, нищачи війська, будівлі та міську забудову поруч. Не заправляється.',
  'Strike drone (one-way): flies to the target and explodes, wrecking units, buildings and city structure nearby. Cannot refuel. Small enough to ride on a pickup\'s launcher.':
    'Ударний дрон (одноразовий): летить до цілі й вибухає, нищачи війська, будівлі та міську забудову поруч. Не заправляється. Досить малий для пускової установки пікапа.',
  Orion: 'Orion',
  'Recon drone: sees 28 km and circles its area. Refuels only at an airfield.': 'Розвідувальний дрон: бачить на 28 км і кружляє над своєю зоною. Заправляється лише на аеродромі.',
  Liutyi: 'Лютий',
  'PD-2': 'PD-2',
  'Mini Shark': 'Mini Shark',
  "Recon drone: sees 16 km and circles its area. Refuels only at an airfield. Small enough to ride on a pickup's launcher.":
    'Розвідувальний дрон: бачить на 16 км і кружляє над своєю зоною. Заправляється лише на аеродромі. Досить малий для пускової установки пікапа.',
  'FP-2 (Fire Point)': 'FP-2 (Fire Point)',
  Lancet: 'Ланцет',
  "Loitering munition (one-way, about 125 km): small blast, cheap. Rides on a pickup's launcher and is launched from the field.":
    'Баражуючий боєприпас (одноразовий, близько 125 км): невеликий вибух, дешевий. Їде на пусковій установці пікапа й запускається з поля.',
  "Loitering munition (one-way): short range (about 125 km), small blast, cheap. Rides on a pickup's launcher and is launched from the field.":
    'Баражуючий боєприпас (одноразовий): мала дальність (близько 125 км), невеликий вибух, дешевий. Їде на пусковій установці пікапа й запускається з поля.',
  'ZALA 421-16E': 'ZALA 421-16E',
  "Small recon drone: sees 14 km and circles its area. Rides on a pickup's launcher and is launched from the field. Refuels only at an airfield.":
    'Малий розвідувальний дрон: бачить на 14 км і кружляє над своєю зоною. Їде на пусковій установці пікапа й запускається з поля. Заправляється лише на аеродромі.',
  'Iskander-M': 'Іскандер-М',
  'Ballistic missile (one-way, about 500 km): very fast and hard to intercept, heavy blast. Waits at the factory until you give it a target.':
    'Балістична ракета (одноразова, близько 500 км): дуже швидка й важко перехоплюється, потужний вибух. Чекає на пусковому майданчику, доки ви не дасте ціль.',
  'Kh-101': 'Х-101',
  'Cruise missile (one-way, about 2,500 km): flies low and can be shot down by anti-air. Waits at the factory until you give it a target.':
    'Крилата ракета (одноразова, близько 2 500 км): летить низько, ППО може її збити. Чекає на пусковому майданчику, доки ви не дасте ціль.',
  'R-360 Neptune': 'Р-360 «Нептун»',
  'Cruise missile (one-way, about 600 km): flies low and can be shot down by anti-air. Waits at the factory until you give it a target.':
    'Крилата ракета (одноразова, близько 600 км): летить низько, ППО може її збити. Чекає на пусковому майданчику, доки ви не дасте ціль.',
  'FP-5 Flamingo': 'FP-5 «Фламінго»',
  'Heavy long-range cruise missile (one-way, about 3,000 km): the biggest warhead in the game. Can be shot down by anti-air. Waits at the factory until you give it a target.':
    'Важка крилата ракета великої дальності (одноразова, близько 3 000 км): найбільша бойова частина в грі. ППО може її збити. Чекає на пусковому майданчику, доки ви не дасте ціль.',

  // buildings
  'Military Base (HQ)': 'Військова база (штаб)',
  'Command centre and barracks: trains infantry of every kind (including MANPADS teams and medics), tanks and artillery, earns a little money and backs the front. All your goods (metal, fuel, ore, ammo) are kept here and in your warehouses: building and upgrades are paid from them, training draws on this store. Lose all your bases and you are out. Units within 8 km refill their ammunition from its store.':
    'Командний центр і казарми: готує піхоту всіх видів (зокрема розрахунки ПЗРК і медиків), танки й артилерію, приносить трохи грошей і тримає фронт. Усі ваші товари (метал, пальне, руда, БК) зберігаються тут і на ваших складах: з них оплачуються будівництво й покращення, навчання бере з цього запасу. Втратите всі бази — вибуваєте з гри. Війська в радіусі 8 км поповнюють тут боєкомплект.',
  'Power Plant': 'Електростанція',
  "Generates energy for your side's grid. Every building within 100 km of a power plant works 25% faster (housing earns 50% more). Select it to see its power lines.":
    'Виробляє енергію для мережі вашої сторони. Кожна будівля в радіусі 100 км від електростанції працює на 25% швидше (житло приносить на 50% більше). Виберіть її, щоб побачити лінії електропередач.',
  'Housing Block': 'Житловий квартал',
  'Only inside a city your side holds, at most 10 per city. Citizens pay taxes (money) and enlist (people), shared between teammates. 50% more income on the power grid.':
    'Лише в місті, яке тримає ваша сторона, не більше 10 на місто. Мешканці платять податки (гроші) і йдуть до війська (люди), спільно для всієї команди. На 50% більше доходу при підключенні до мережі.',
  'Ore Mine': 'Рудник',
  'Extracts ore into its own store. Truck the ore to a metal works.': 'Видобуває руду у власне сховище. Возіть руду вантажівкою на металургійний завод.',
  'Metal Works': 'Металургійний завод',
  'Smelts ore into metal. Needs ore delivered into its store by truck; the metal it makes stays on site until trucked away.':
    'Виплавляє метал із руди. Потребує руди, яку привозять вантажівкою; виплавлений метал лишається на місці, доки його не вивезуть.',
  'Oil Refinery': 'НПЗ',
  'Refines fuel (5/s) into its tank. Fuel trucks take it to filling stations, airfields and bases. Built in the Kremenchuk zone (Ukraine only) it makes 50% more.':
    'Переробляє пальне (5/с) у свій резервуар. Паливозаправники везуть його на АЗС, аеродроми й бази. У зоні Кременчука (лише Україна) виробляє на 50% більше.',
  'Filling Station': 'АЗС',
  'Fuel depot (20,000). Vehicles within 8 km refuel here automatically; keep it supplied with a fuel truck. Never shown to the enemy.':
    'Склад пального (20 000). Техніка в радіусі 8 км заправляється тут автоматично; підвозьте пальне паливозаправником. Ворог її ніколи не бачить.',
  'Railway Station': 'Залізнична станція',
  'Rail freight terminal: stores metal, fuel, ore and ammo (30,000 each), builds trains and refuels them. Connect stations with Railway track; trains then carry 20,000 at a time between them, far faster than trucks.':
    'Вантажний термінал: зберігає метал, пальне, руду й БК (по 30 000), будує потяги та заправляє їх. З’єднайте станції колією — і потяги возитимуть між ними по 20 000 за раз, набагато швидше за вантажівки.',
  Railway: 'Залізниця',
  'Railway track: drag on the map (0.5–40 km); ends within 1.5 km of a station or other track join up. It cannot cross water. Trains run only on track; drones, missiles and artillery can cut it.':
    'Залізнична колія: протягніть на мапі (0,5–40 км); кінці в межах 1,5 км від станції чи іншої колії з’єднуються. Не може перетинати воду. Потяги їздять лише колією; дрони, ракети й артилерія можуть її перерізати.',
  'Machine Factory': 'Машинобудівний завод',
  'Builds pickups, trucks, fuel trucks, rescue crews and mechanic crews. Metal and fuel come from its own store (a new factory has enough for two vehicles; deliver more by truck).':
    'Будує пікапи, вантажівки, паливозаправники, рятувальників і ремонтні бригади. Метал і пальне беруться з власного сховища (новий завод має запас на дві машини; решту привозьте вантажівкою).',
  Warehouse: 'Склад',
  'Stores metal, fuel and ore (up to 30,000 each) as a hub for delivery routes.': 'Зберігає метал, пальне й руду (до 30 000 кожного) як вузол для маршрутів доставки.',
  'Trench Line': 'Лінія окопів',
  'Dug-in line: drag on the map to draw it, 0.3 to 10 km long (a click gives 1 km along the front). Friendly troops and buildings within 1.5 km of it take less damage and the front is harder to push there. Cost and digging time are per km. Overlapping trenches do not add up: upgrade one instead (3 levels).':
    'Окопна лінія: протягніть мишею на мапі, завдовжки від 0,3 до 10 км (клік дає 1 км уздовж фронту). Свої війська й будівлі в межах 1,5 км отримують менше шкоди, а фронт там важче зрушити. Вартість і час копання — за кілометр. Окопи, що перекриваються, не сумуються: краще покращте один (3 рівні).',
  Bunker: 'Бункер',
  'Hardened position: up to 4 armed squads on foot can man it (select them, right click the bunker). They fire out of it, cannot be hit until it falls, and the front is very hard to push past it. Shelled down by artillery, missiles or drones, the garrison dies with it; stormed by troops, they stumble out shaken (8 s: cannot fire, take 25% more damage). Also gives cover within 8 km. Bunkers do not add up: upgrade one instead.':
    'Укріплена позиція: до 4 озброєних піших загонів можуть її зайняти (виберіть їх і клацніть правою кнопкою по бункеру). Вони стріляють з нього, невразливі, доки він стоїть, а фронт повз нього зрушити дуже важко. Якщо бункер зруйнують артилерія, ракети чи дрони, гарнізон гине разом із ним; якщо його візьмуть штурмом, бійці виходять приголомшеними (8 с: не стріляють, отримують на 25% більше шкоди). Також дає укриття в радіусі 8 км. Бункери не сумуються: краще покращте один.',
  'Signal Station': 'Станція зв’язку',
  'Radio and recon post. Reveals enemy units and buildings within 35 km through the fog of war. Uses energy.': 'Радіо- та розвідувальний пост. Показує ворожі війська й будівлі в радіусі 35 км крізь туман війни. Споживає енергію.',
  'Pontoon Crossing': 'Понтонна переправа',
  'Boats and pontoons on a river bank. Your ground units can cross the river within 6 km. Without it rivers are crossed only on road bridges.':
    'Човни й понтони на березі річки. Ваші наземні війська можуть перетнути річку в межах 6 км. Без неї річки перетинають лише дорожніми мостами.',
  Bridge: 'Міст',
  'A real bridge: drag across a river (up to 2 km) with both ends on your dry ground. Takes minutes to build (1 min plus 3 min per km). Your troops cross on it at road speed. Strike drones, missiles and artillery can bring it down.':
    'Справжній міст: протягніть через річку (до 2 км), обидва кінці — на вашій суші. Будується хвилинами (1 хв плюс 3 хв за км). Ваші війська переходять ним із дорожньою швидкістю. Ударні дрони, ракети й артилерія можуть його зруйнувати.',
  'Anti-Air Station': 'Станція ППО',
  'Shoots down enemy drones and missiles within 14 km. Only anti-air stations and MANPADS teams can engage aircraft; other troops cannot. Uses energy.':
    'Збиває ворожі дрони й ракети в радіусі 14 км. Лише станції ППО та розрахунки ПЗРК можуть бити повітряні цілі; інші війська — ні. Споживає енергію.',
  'Training Centre': 'Навчальний центр',
  'Send ground units inside (select them, right click the centre). With at least 3 inside you can pay for a course: after the wait they come out one rank higher and at full strength. A course to Regular takes 75 s, every rank above that 45 s more. Recruits can always be trained; from the second rank on a unit needs at least one kill since its last course. Holds 12.':
    'Відправте наземні війська всередину (виберіть їх і клацніть правою кнопкою по центру). Коли всередині щонайменше 3, можна оплатити курс: після очікування вони виходять на звання вище й на повній силі. Курс до «Бійця» триває 75 с, кожне наступне звання — на 45 с довше. Новобранців можна навчати завжди; з другого звання загону потрібне щонайменше одне знищення після останнього курсу. Вміщує 12.',
  'Field Hospital': 'Польовий госпіталь',
  'Treats the wounded: troops on foot within 6 km get back 3% of their strength a second once they have been out of the fight for 10 s. Send battered squads back to it.':
    'Лікує поранених: піші війська в радіусі 6 км відновлюють 3% сили щосекунди, якщо вже 10 с поза боєм. Відводьте до нього потріпані загони.',
  'Drone Factory': 'Завод дронів',
  "Builds your side's drones. A finished drone is delivered to the nearest launcher: recon drones to an Airfield, strike drones to a Launch Site (small ones can also be loaded on a pickup there). Built in the Alabuga zone (Russia only) it works 50% faster.":
    'Будує дрони вашої сторони. Готовий дрон доставляється до найближчого місця запуску: розвідувальні — на аеродром, ударні — на пусковий майданчик (малі там також можна завантажити на пікап). У зоні Алабуги (лише Росія) працює на 50% швидше.',
  'Ammo Factory': 'Завод боєприпасів',
  'Turns metal into ammunition (6/s) in its own store. Trucks carry the ammo to depots near the front. Needs metal delivered and energy.':
    'Перетворює метал на боєприпаси (6/с) у власному сховищі. Вантажівки везуть БК на склади біля фронту. Потребує підвезеного металу й енергії.',
  'Ammo Depot': 'Склад БК',
  'Field ammunition store (6,000). Your units within 18.75 km refill their rounds from it (up to 10 a second each; a tank shell costs 4 ammo, an artillery shell 6, an anti-tank missile 3). Can be set up inside your grey zones, even behind the enemy line, and stands as long as the grey zone does. Keep it stocked by truck from an ammo factory.':
    'Польовий склад боєприпасів (6 000). Ваші війська в радіусі 18,75 км поповнюють з нього набої (до 10 за секунду кожен; танковий снаряд коштує 4 БК, артилерійський — 6, протитанкова ракета — 3). Можна ставити у ваших сірих зонах, навіть за лінією ворога; стоїть, доки існує сіра зона. Поповнюйте його вантажівкою із заводу боєприпасів.',
  'Missile Factory': 'Ракетний завод',
  "Builds your side's missiles: Iskander-M and Kh-101 for Russia, Neptune and Flamingo for Ukraine. A finished missile is delivered to the nearest Launch Site and launched from there. Metal and fuel come from the factory's own store.":
    'Будує ракети вашої сторони: «Іскандер-М» і Х-101 для Росії, «Нептун» і «Фламінго» для України. Готова ракета доставляється на найближчий пусковий майданчик і запускається звідти. Метал і пальне беруться з власного сховища заводу.',
  'Launch Site': 'Пусковий майданчик',
  'Launch pad for strike drones and missiles: they wait here after being built and take off from here at your order (select the site, Launch at…, click the target).':
    'Пусковий майданчик для ударних дронів і ракет: після виготовлення вони чекають тут і злітають за вашим наказом (виберіть майданчик, «Запустити по…», клацніть ціль).',
  Airfield: 'Аеродром',
  'Base for recon drones: new recon drones wait here and take off from here (launch them from this panel), and refuel here (within 12 km) from its fuel tank (20,000). Sees 20 km.':
    'База розвідувальних дронів: нові розвідувальні дрони чекають тут і злітають звідси (запускайте з цієї панелі), а також заправляються тут (у радіусі 12 км) з його резервуара (20 000). Бачить на 20 км.',
  'Aircraft Plant': 'Авіазавод',
  'Factory for manned aircraft and helicopters. Not in the game yet: this site is ready for a coming update.': 'Завод пілотованих літаків і гелікоптерів. У грі ще немає: майданчик готовий до наступного оновлення.',

  // ranks, terrain, resources
  Recruit: 'Новобранець', Regular: 'Боєць', Veteran: 'Ветеран', Elite: 'Еліта', Guards: 'Гвардія',
  'Open field': 'Відкрите поле', Forest: 'Ліс', 'Urban area': 'Міська забудова', Water: 'Вода', Hills: 'Пагорби', Mountains: 'Гори',
  Money: 'Гроші', Energy: 'Енергія', People: 'Люди', Ore: 'Руда', Metal: 'Метал', Fuel: 'Пальне', Ammo: 'БК',
  money: 'гроші', energy: 'енергія', people: 'люди', ore: 'руда', metal: 'метал', fuel: 'пальне', ammo: 'БК',
};
