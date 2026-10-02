// ================= СЦЕНАРИИ =================
function mkStation(id, name, x, y, tracks = 2) { return { id, name, x, y, type: 'station', tracks }; }
function mkJunction(id, name, x, y) { return { id, name, x, y, type: 'junction', tracks: 1 }; }
function mkEdge(id, a, b, km, vmax, double) { return { id, a, b, len: km * 1000, vmax, double: !!double }; }
const hm = (h, m) => (h - 6) * 3600 + m * 60;

function serviceTrains(list) {
  const out = []; let n = 0;
  for (const g of list) {
    for (let i = 0; i < g.count; i++) {
      const num = g.num + i * (g.step || 2);
      out.push({ id: 'T' + (++n) + '_' + num, name: `№${num}`, type: g.type, from: g.from, to: g.to,
        dep: g.dep + i * g.every, stops: g.stops || (g.type === 'freight' || g.type === 'express' ? 'ends' : 'all') });
    }
  }
  return out;
}

const SCENARIOS = {
  single: {
    title: 'Однопутная линия: скрещения',
    note: 'Пять станций на однопутке, поезда идут навстречу друг другу. Без ассистента станции быстро заполняются и возникает тупик.',
    build() {
      const nodes = [
        mkStation('A', 'Северск', 80, 300, 3), mkStation('B', 'Берёзки', 300, 230, 2),
        mkStation('C', 'Озёрная', 520, 300, 2), mkStation('D', 'Каменка', 740, 230, 2), mkStation('E', 'Южный', 960, 300, 3),
      ];
      const edges = [mkEdge('AB', 'A', 'B', 9, 100), mkEdge('BC', 'B', 'C', 11, 100), mkEdge('CD', 'C', 'D', 10, 100), mkEdge('DE', 'D', 'E', 9, 100)];
      const trains = serviceTrains([
        { num: 6001, type: 'passenger', from: 'A', to: 'E', dep: hm(6, 2), every: 2700, count: 4 },
        { num: 6002, type: 'passenger', from: 'E', to: 'A', dep: hm(6, 5), every: 2700, count: 4 },
        { num: 2101, type: 'freight', from: 'A', to: 'E', dep: hm(6, 14), every: 3000, count: 3 },
        { num: 2102, type: 'freight', from: 'E', to: 'A', dep: hm(6, 0), every: 3000, count: 3 },
        { num: 71, type: 'express', from: 'A', to: 'E', dep: hm(6, 35), every: 3600, count: 1 },
        { num: 72, type: 'express', from: 'E', to: 'A', dep: hm(6, 50), every: 3600, count: 1 },
      ]);
      return { net: { nodes, edges }, trains };
    },
  },
  double: {
    title: 'Двухпутная магистраль: обгоны',
    note: 'Грузовые поезда идут впереди скорых. Без ассистента скорые плетутся за грузовыми; ассистент организует обгоны на станциях.',
    build() {
      const nodes = [
        mkStation('A', 'Москва-Сорт.', 60, 300, 4), mkStation('B', 'Лесная', 280, 300, 3), mkStation('C', 'Узловая', 500, 300, 3),
        mkStation('D', 'Заречье', 720, 300, 3), mkStation('E', 'Тверская', 940, 300, 4),
      ];
      const edges = [mkEdge('AB', 'A', 'B', 18, 140, 1), mkEdge('BC', 'B', 'C', 22, 140, 1), mkEdge('CD', 'C', 'D', 20, 140, 1), mkEdge('DE', 'D', 'E', 18, 140, 1)];
      const trains = serviceTrains([
        { num: 2001, type: 'freight', from: 'A', to: 'E', dep: hm(6, 0), every: 1500, count: 4 },
        { num: 751, type: 'express', from: 'A', to: 'E', dep: hm(6, 9), every: 1500, count: 4 },
        { num: 6101, type: 'suburban', from: 'A', to: 'E', dep: hm(6, 16), every: 1500, count: 3 },
        { num: 2002, type: 'freight', from: 'E', to: 'A', dep: hm(6, 3), every: 1800, count: 3 },
        { num: 752, type: 'express', from: 'E', to: 'A', dep: hm(6, 12), every: 1800, count: 3 },
      ]);
      return { net: { nodes, edges }, trains };
    },
  },
  hub: {
    title: 'Узел: магистраль, ветка и обход',
    note: 'Двухпутная магистраль с однопутной веткой и обходной линией. Попробуйте закрыть перегон — ассистент может пустить поезда в объезд.',
    build() {
      const nodes = [
        mkStation('W', 'Западная', 60, 360, 4), mkJunction('J1', 'Пост 12 км', 260, 360), mkStation('M', 'Центральная', 470, 360, 4),
        mkJunction('J2', 'Пост 41 км', 680, 360), mkStation('E', 'Восточная', 900, 360, 4),
        mkStation('N', 'Северная', 320, 140, 2), mkStation('R', 'Рябиновка', 600, 140, 2), mkStation('S', 'Сосновка', 470, 560, 2),
      ];
      const edges = [
        mkEdge('WJ1', 'W', 'J1', 10, 120, 1), mkEdge('J1M', 'J1', 'M', 12, 120, 1), mkEdge('MJ2', 'M', 'J2', 12, 120, 1), mkEdge('J2E', 'J2', 'E', 11, 120, 1),
        mkEdge('J1N', 'J1', 'N', 12, 80), mkEdge('NR', 'N', 'R', 14, 80), mkEdge('RJ2', 'R', 'J2', 12, 80),
        mkEdge('J1S', 'J1', 'S', 14, 90), mkEdge('SJ2', 'S', 'J2', 14, 90),
      ];
      const trains = serviceTrains([
        { num: 7001, type: 'suburban', from: 'W', to: 'E', dep: hm(6, 0), every: 1200, count: 6 },
        { num: 7002, type: 'suburban', from: 'E', to: 'W', dep: hm(6, 4), every: 1200, count: 6 },
        { num: 2201, type: 'freight', from: 'W', to: 'E', dep: hm(6, 10), every: 2400, count: 3 },
        { num: 2202, type: 'freight', from: 'E', to: 'W', dep: hm(6, 18), every: 2400, count: 3 },
        { num: 81, type: 'express', from: 'W', to: 'E', dep: hm(6, 25), every: 2400, count: 2 },
        { num: 6301, type: 'passenger', from: 'W', to: 'R', dep: hm(6, 6), every: 2400, count: 3 },
        { num: 6302, type: 'passenger', from: 'R', to: 'W', dep: hm(6, 8), every: 2400, count: 3 },
        { num: 6401, type: 'passenger', from: 'N', to: 'E', dep: hm(6, 14), every: 3000, count: 2 },
        { num: 6402, type: 'passenger', from: 'E', to: 'N', dep: hm(6, 20), every: 3000, count: 2 },
      ]);
      return { net: { nodes, edges }, trains };
    },
  },
  kz: {
    title: 'Казахстан: сеть КТЖ',
    note: 'Основные магистрали Казахстана: Турксиб, транзит Китай — Европа через Достык и Алтынколь, выход к Каспию через Бейнеу. Расстояния в модели сокращены в 10 раз, чтобы поезда проходили сеть за смену; на схеме подписаны реальные километры. Число путей и скорости упрощены.',
    build() {
      // проекция: долгота/широта → координаты схемы
      const K = 30, px = (lon) => Math.round((lon - 46) * K), py = (lat) => Math.round((55.8 - lat) * K * 1.45);
      const S = (id, name, lon, lat, tr) => mkStation(id, name, px(lon), py(lat), tr);
      const nodes = [
        S('ALA', 'Алматы', 76.9, 43.25, 4), S('ZTG', 'Жетыген', 77.6, 43.85, 2), S('ALT', 'Алтынколь', 80.3, 44.15, 3),
        S('USH', 'Уштобе', 77.98, 45.25, 3), S('AKT', 'Актогай', 79.65, 46.95, 4), S('DOS', 'Достык', 82.48, 45.25, 4),
        S('AYA', 'Аягоз', 80.43, 47.96, 2), S('SEM', 'Семей', 80.23, 50.41, 3), S('SHU', 'Шу', 73.76, 43.6, 3),
        S('TAR', 'Тараз', 71.38, 42.9, 3), S('SHY', 'Шымкент', 70.1, 42.2, 3), S('ARS', 'Арысь', 68.5, 42.75, 3),
        S('TUR', 'Туркестан', 67.9, 43.75, 3), S('KZO', 'Кызылорда', 65.5, 44.85, 3), S('KAZ', 'Казалинск', 62.9, 45.6, 3),
        S('ARL', 'Аральск', 61.67, 46.55, 3), S('SAK', 'Саксаульская', 60.6, 47.35, 3), S('SHL', 'Шалкар', 59.6, 47.95, 3),
        S('EMB', 'Эмба', 58.15, 48.83, 3), S('KND', 'Кандыагаш', 57.5, 49.45, 3), S('AKB', 'Актобе', 57.2, 50.3, 3),
        S('MAK', 'Макат', 53.33, 47.65, 3), S('ATY', 'Атырау', 51.92, 47.1, 3), S('KUL', 'Кульсары', 54.0, 46.85, 3),
        S('BEY', 'Бейнеу', 55.2, 45.32, 3), S('SHE', 'Шетпе', 52.6, 44.4, 3), S('MAN', 'Мангышлак', 51.4, 43.75, 3),
        S('MOI', 'Мойынты', 73.37, 47.2, 3), S('SSH', 'Сарышаган', 76.0, 46.4, 3), S('KAR', 'Караганда', 73.1, 49.8, 4),
        S('ZHE', 'Жезказган', 67.7, 47.8, 2), S('AST', 'Астана', 71.43, 51.17, 4), S('KOK', 'Кокшетау', 69.4, 53.28, 3),
        S('PET', 'Петропавловск', 69.15, 54.87, 3), S('EKI', 'Экибастуз', 75.3, 51.73, 3), S('PAV', 'Павлодар', 76.95, 52.29, 3),
        S('ESL', 'Есиль', 66.4, 51.95, 2), S('KOS', 'Костанай', 63.6, 53.2, 3),
      ];
      // реальная длина, км; в модели — в 10 раз короче
      const E = (a, b, km, v, dbl) => ({ ...mkEdge(a + b, a, b, Math.max(4, Math.round(km / 10)), v, dbl), real: km });
      const edges = [
        E('ALA', 'SHU', 280, 120, 1), E('ALA', 'ZTG', 60, 100), E('ZTG', 'ALT', 293, 100), E('ZTG', 'USH', 230, 100),
        E('USH', 'AKT', 320, 100), E('AKT', 'DOS', 310, 100, 1), E('AKT', 'AYA', 250, 90), E('AYA', 'SEM', 300, 90),
        E('AKT', 'SSH', 280, 100), E('SSH', 'MOI', 250, 100), E('SHU', 'MOI', 470, 100, 1), E('MOI', 'KAR', 210, 100, 1),
        E('KAR', 'AST', 220, 120, 1), E('KAR', 'ZHE', 520, 80), E('ZHE', 'SAK', 517, 80),
        E('AST', 'KOK', 300, 120, 1), E('KOK', 'PET', 190, 120, 1), E('AST', 'EKI', 360, 100, 1), E('EKI', 'PAV', 130, 100),
        E('AST', 'ESL', 260, 100), E('ESL', 'KOS', 400, 100),
        E('SHU', 'TAR', 260, 120, 1), E('TAR', 'SHY', 200, 120, 1), E('SHY', 'ARS', 70, 100, 1), E('ARS', 'TUR', 160, 100),
        E('TUR', 'KZO', 280, 100), E('KZO', 'KAZ', 230, 100), E('KAZ', 'ARL', 190, 100), E('ARL', 'SAK', 90, 100),
        E('SAK', 'SHL', 190, 100), E('SHL', 'EMB', 230, 100), E('EMB', 'KND', 120, 100), E('KND', 'AKB', 100, 100, 1),
        E('KND', 'MAK', 470, 80), E('MAK', 'ATY', 120, 80), E('MAK', 'KUL', 100, 80), E('KUL', 'BEY', 280, 80),
        E('SHL', 'BEY', 471, 80), E('BEY', 'SHE', 230, 80), E('SHE', 'MAN', 110, 80),
      ];
      const P = (pts) => pts.map(([lon, lat]) => [px(lon), py(lat)]);
      const outline = P([[49.2, 46.4], [47.3, 46.6], [46.6, 48.4], [47.3, 49.4], [46.9, 50.0], [48.6, 50.7], [50.5, 51.7], [52.6, 51.5],
        [55.0, 50.7], [57.0, 51.1], [59.0, 50.6], [61.3, 51.0], [61.0, 52.4], [61.4, 53.8], [63.0, 54.1], [65.2, 54.6], [68.0, 55.0],
        [69.2, 55.4], [71.0, 54.2], [73.5, 54.0], [76.3, 54.3], [77.0, 53.5], [78.5, 52.7], [80.0, 51.0], [82.0, 50.8], [83.5, 51.0],
        [85.0, 50.0], [87.3, 49.15], [85.7, 48.3], [85.6, 47.1], [83.0, 47.2], [82.4, 45.5], [79.9, 44.9], [80.4, 43.9], [80.2, 42.8],
        [78.0, 42.6], [76.0, 43.0], [74.2, 43.2], [72.6, 42.7], [71.0, 42.2], [70.2, 41.5], [68.6, 40.6], [68.0, 41.1], [66.5, 41.9],
        [66.0, 42.9], [64.0, 43.6], [62.0, 43.5], [58.6, 45.6], [56.0, 45.0], [56.0, 41.3], [54.2, 42.3], [52.9, 42.1], [52.6, 42.6],
        [51.3, 43.2], [50.3, 44.4], [51.3, 45.2], [53.0, 45.3], [53.2, 46.6], [51.2, 47.0], [49.2, 46.4]]);
      const water = [
        P([[49.2, 46.4], [51.2, 47.0], [53.2, 46.6], [53.0, 45.3], [51.3, 45.2], [50.3, 44.4], [51.3, 43.2], [52.6, 42.6], [52.9, 42.1],
          [52.8, 41.0], [51.5, 41.0], [49.5, 42.5], [48.4, 44.6], [47.3, 45.6], [47.3, 46.6]]),
        P([[74.0, 46.5], [75.0, 46.2], [77.0, 46.0], [79.2, 46.4], [78.5, 46.8], [76.5, 46.6], [75.0, 46.9], [74.0, 46.9]]),
        P([[58.6, 45.6], [59.4, 46.4], [60.8, 46.4], [61.6, 45.3], [60.2, 44.4], [58.7, 44.6]]),
      ];
      const labels = [
        { x: px(50.2), y: py(43.9), t: 'Каспийское море' }, { x: px(76.2), y: py(45.75), t: 'оз. Балхаш' },
        { x: px(60.1), y: py(45.25), t: 'Аральское море' }, { x: px(62), y: py(55.3), t: 'Россия' }, { x: px(84.6), y: py(45.6), t: 'Китай' },
        { x: px(62.5), y: py(42.3), t: 'Узбекистан' }, { x: px(75.5), y: py(42.0), t: 'Кыргызстан' },
      ];
      const trains = serviceTrains([
        { num: 1, type: 'express', from: 'ALA', to: 'AST', dep: hm(6, 0), every: 5400, count: 2, stops: ['SHU', 'MOI', 'KAR'] },
        { num: 2, type: 'express', from: 'AST', to: 'ALA', dep: hm(6, 5), every: 5400, count: 2, stops: ['KAR', 'MOI', 'SHU'] },
        { num: 9, type: 'passenger', from: 'ALA', to: 'SHY', dep: hm(6, 15), every: 4800, count: 2 },
        { num: 10, type: 'passenger', from: 'SHY', to: 'ALA', dep: hm(6, 20), every: 4800, count: 2 },
        { num: 23, type: 'passenger', from: 'SHY', to: 'AKB', dep: hm(6, 10), every: 7200, count: 2 },
        { num: 24, type: 'passenger', from: 'AKB', to: 'SHY', dep: hm(6, 0), every: 7200, count: 2 },
        { num: 41, type: 'passenger', from: 'ALA', to: 'SEM', dep: hm(6, 30), every: 7200, count: 1 },
        { num: 42, type: 'passenger', from: 'SEM', to: 'ALA', dep: hm(6, 10), every: 7200, count: 1 },
        { num: 6501, type: 'suburban', from: 'AST', to: 'KOK', dep: hm(6, 12), every: 3600, count: 3 },
        { num: 6502, type: 'suburban', from: 'KOK', to: 'AST', dep: hm(6, 8), every: 3600, count: 3 },
        { num: 61, type: 'passenger', from: 'AST', to: 'PAV', dep: hm(6, 40), every: 7200, count: 1 },
        { num: 62, type: 'passenger', from: 'PAV', to: 'AST', dep: hm(6, 25), every: 7200, count: 1 },
        { num: 71, type: 'passenger', from: 'AST', to: 'KOS', dep: hm(6, 50), every: 7200, count: 1 },
        { num: 3001, type: 'freight', from: 'DOS', to: 'PET', dep: hm(6, 0), every: 2700, count: 4 },
        { num: 3002, type: 'freight', from: 'PET', to: 'DOS', dep: hm(6, 20), every: 3600, count: 2 },
        { num: 3101, type: 'freight', from: 'ALT', to: 'ARS', dep: hm(6, 5), every: 3000, count: 3 },
        { num: 3102, type: 'freight', from: 'ARS', to: 'ALT', dep: hm(6, 30), every: 3600, count: 2 },
        { num: 3201, type: 'freight', from: 'MAN', to: 'KZO', dep: hm(6, 0), every: 3600, count: 3 },
        { num: 3202, type: 'freight', from: 'KZO', to: 'MAN', dep: hm(6, 15), every: 3600, count: 3 },
        { num: 3301, type: 'freight', from: 'EKI', to: 'PET', dep: hm(6, 0), every: 2400, count: 4 },
        { num: 3401, type: 'freight', from: 'ATY', to: 'AKB', dep: hm(6, 10), every: 3600, count: 2 },
        { num: 3402, type: 'freight', from: 'AKB', to: 'ATY', dep: hm(6, 25), every: 3600, count: 2 },
        { num: 3501, type: 'freight', from: 'ZHE', to: 'KAR', dep: hm(6, 0), every: 4800, count: 2 },
        { num: 3601, type: 'freight', from: 'KOS', to: 'AST', dep: hm(6, 20), every: 4800, count: 2 },
        { num: 3701, type: 'freight', from: 'ARS', to: 'AKB', dep: hm(6, 0), every: 1800, count: 4 },
        { num: 3702, type: 'freight', from: 'AKB', to: 'ARS', dep: hm(6, 5), every: 1800, count: 4 },
        { num: 3801, type: 'freight', from: 'DOS', to: 'MOI', dep: hm(6, 10), every: 3600, count: 2 },
        { num: 3802, type: 'freight', from: 'MOI', to: 'DOS', dep: hm(6, 0), every: 3600, count: 2 },
      ]);
      return { net: { nodes, edges, compact: true, outline, water, labels }, trains };
    },
  },
  empty: {
    title: 'Пустой полигон',
    note: 'Две станции и перегон. Добавляйте станции, пути и поезда в режиме «Конструктор».',
    build() {
      return {
        net: { nodes: [mkStation('S1', 'Станция 1', 200, 300, 2), mkStation('S2', 'Станция 2', 700, 300, 2)], edges: [mkEdge('E1', 'S1', 'S2', 15, 100)] },
        trains: [],
      };
    },
  },
};

// ================= ШАБЛОНЫ КОДА АССИСТЕНТА =================
const ASSIST_TEMPLATES = {
  advanced: { title: 'Продвинутый: тупики, приоритеты, обгоны, объезды', code: `// ИИ-ассистент поездного диспетчера.
// decide(state, api) вызывается каждую секунду модельного времени.
// Ассистент не переключает сигналы сам: он даёт команды (задержать,
// отпустить, сменить маршрут, приоритет), а блокировка (СЦБ) всё равно
// проверяет безопасность каждого движения.

function decide(state, api) {
  for (const tr of state.trains) {
    if (tr.status === 'done' || tr.status === 'pending') continue;
    const reason = shouldHold(tr, state, api);
    if (reason) api.hold(tr.id, reason);
    else api.release(tr.id);
    // совет машинисту: плавное снижение скорости вместо остановки у красного
    const adv = speedAdvice(tr, state, api);
    if (adv) api.limitSpeed(tr.id, adv.kmh, adv.reason);
    else if (tr.speedCap) api.limitSpeed(tr.id, null);
  }
}

// Совет машинисту по скорости.
// Если впереди сигнал закрыт и откроется не скоро, выгоднее подъехать
// к нему медленнее и успеть к открытию: без остановки, без повторного
// разгона тяжёлого состава и с меньшим расходом энергии.
function speedAdvice(tr, state, api) {
  if (tr.status !== 'running' || !tr.nextStation) return null;
  const st = tr.nextStation;
  if (st.stop || st.distM < 1200) return null;      // там и так стоянка или уже поздно
  const i = tr.route.indexOf(st.id);
  const after = i >= 0 ? state.byId.edges[tr.routeEdges[i]] : null;
  let clear = 0, why = null;
  // 1) за станцией однопутный перегон занят встречным поездом
  if (after && !after.double) {
    for (const id of [...after.trainsAB, ...after.trainsBA]) {
      const o = state.byId.trains[id];
      if (!o || o.id === tr.id || o.route.indexOf(st.id) < o.routePos) continue;
      if (o.capReason && o.capReason.includes(tr.name)) continue;   // он уже подстраивается под нас
      const eta = api.eta(o.id, st.id);
      if (eta != null && eta + 60 > clear) { clear = eta + 60; why = o; }
    }
  }
  // не тормозить, если за нами вплотную идёт другой поезд: задержим и его
  if (why && state.trains.some((o) => o.blockedBy && o.blockedBy.includes(tr.id))) why = null;
  if (why) {
    const tFree = st.distM / (tr.maxSpeed / 3.6);      // сколько ехать без ограничений
    if (clear <= tFree + 20) return null;             // успеем и так
    if (clear - tFree > 360) return null;             // ждать долго: снижением не спасти
    const kmh = Math.min(tr.maxSpeed, (st.distM / clear) * 3.6);
    if (kmh >= tr.maxSpeed - 5 || kmh < tr.maxSpeed * 0.35) return null;
    return { kmh: Math.round(kmh / 5) * 5, reason: 'встречный ' + why.name + ' освободит перегон через ~' + Math.ceil(clear / 60) + ' мин' };
  }
  // 2) впереди медленный поезд в попутном направлении: идти за ним с его скоростью
  if (tr.blocked && tr.blockedBy.length === 1) {
    const lead = state.byId.trains[tr.blockedBy[0]];
    if (lead && lead.status === 'running' && lead.speed > 15 && lead.speed < tr.maxSpeed - 10)
      return { kmh: Math.round(lead.speed / 5) * 5, reason: 'впереди ' + lead.name + ' идёт ' + lead.speed + ' км/ч' };
  }
  return null;
}

// Поедет ли поезд o по перегону edgeId, отправляясь со станции fromNode?
function willUse(o, edgeId, fromNode) {
  for (let p = o.routePos; p < o.routeEdges.length; p++)
    if (o.routeEdges[p] === edgeId && o.route[p] === fromNode) return true;
  return false;
}

function shouldHold(tr, state, api) {
  const { trains, nodes, edges } = state.byId;
  // Сторож: поезд, который ждёт по решению ассистента больше 20 минут,
  // отпускаем — лучше опоздание, чем «зависший» участок.
  if (tr.held && tr.waitingSec > 1200 && !tr.holdReason.startsWith('нет')) return null;
  const here = tr.frontierNode && nodes[tr.frontierNode];
  if (!here || here.type !== 'station' || !tr.nextEdge) return null;
  const edge = edges[tr.nextEdge.id];
  const next = nodes[tr.nextEdge.toNode];

  // 1. Перегон закрыт: объезд, если он быстрее ожидания
  if (edge.closed) {
    const alt = api.findPath(here.id, tr.to, { avoid: [edge.id] });
    if (alt) {
      const direct = api.pathTime(api.findPath(here.id, tr.to), tr.id);
      if (api.pathTime(alt, tr.id) < direct + edge.closedForSec && api.reroute(tr.id, alt)) return null;
    }
    return 'перегон закрыт, ждём открытия';
  }

  if (!edge.double) {
    // 2. Защита от тупика: на станции впереди должен остаться путь для нас,
    //    не считая поездов, которые ждут выхода на этот же перегон навстречу.
    if (next.type === 'station') {
      const facing = next.trains.filter(id => trains[id] && trains[id].nextEdge && trains[id].nextEdge.id === edge.id).length;
      const inbound = next.inbound.filter(id => id !== tr.id).length;
      if (next.tracks - facing - inbound < 1) return 'нет гарантированного пути на ст. ' + next.name;

      // 3. Один путь всегда оставляем для скрещения: не больше (путей − 1)
      //    поездов на станции могут ждать выхода в одну сторону однопутки.
      const k = tr.route.indexOf(next.id, tr.routePos);
      const e2 = edges[tr.routeEdges[k]];
      if (e2 && !e2.double) {
        const far = e2.a === next.id ? e2.b : e2.a;
        const sameWay = [...next.trains, ...next.inbound]
          .filter(id => id !== tr.id && trains[id] && willUse(trains[id], e2.id, next.id)).length;
        const opposite = state.trains.some(o => o.status !== 'done' && willUse(o, e2.id, far));
        if (opposite && sameWay + 1 > next.tracks - 1) return 'держим путь для скрещения на ст. ' + next.name;
      }
    }
    // 4. Пропуск встречного поезда более высокого приоритета
    for (const o of state.trains) {
      if (o.id === tr.id || o.status === 'done' || o.held) continue;
      if (o.priority > tr.priority && o.frontierNode === next.id && o.nextEdge &&
          o.nextEdge.id === edge.id && o.departIn < 240)
        return 'пропуск встречного ' + o.name;
    }
  } else if (here.tracks >= 2) {
    // 5. Обгон на двухпутке: если быстрый поезд догонит нас на перегоне,
    //    пропускаем его вперёд по соседнему станционному пути.
    const myTime = api.pathTime([here.id, next.id], tr.id);
    for (const o of state.trains) {
      if (o.id === tr.id || o.status === 'done' || o.held || o.priority <= tr.priority) continue;
      if (o.maxSpeed <= tr.maxSpeed + 10 || !willUse(o, edge.id, here.id)) continue;
      const eta = api.eta(o.id, here.id);
      if (eta === null) continue;
      const catches = eta + api.pathTime([here.id, next.id], o.id) < myTime + 120;
      // быстрому поезду должен найтись путь на станции, иначе ждать бессмысленно
      const others = here.inbound.filter(id => id !== o.id).length;
      const hasTrack = here.trains.includes(o.id) || here.free - others > 0;
      if (catches && hasTrack) return 'обгон: пропускаем ' + o.name;
    }
  }
  return null;
}
` },
  basic: { title: 'Базовый: только защита от тупиков', code: `// Простейший ассистент: не выпускает поезд на однопутный перегон,
// если на станции впереди для него не будет свободного пути.

function decide(state, api) {
  const { nodes } = state.byId;
  const sent = {};
  for (const tr of state.trains) {
    if (tr.status === 'done' || tr.status === 'pending') continue;
    let reason = null;
    if (tr.frontierNode && tr.nextEdge && !tr.nextEdge.double) {
      const next = nodes[tr.nextEdge.toNode];
      if (next.type === 'station') {
        // занятые пути + поезда, уже идущие на станцию + допущенные в этом такте
        const busy = next.trains.length + next.inbound.filter(id => id !== tr.id).length + (sent[next.id] || 0);
        if (next.tracks - busy < 1) reason = 'нет пути на ст. ' + next.name;
        else sent[next.id] = (sent[next.id] || 0) + 1;
      }
    }
    if (reason) api.hold(tr.id, reason); else api.release(tr.id);
  }
}
` },
  empty: { title: 'Пустой шаблон', code: `// Напишите свою логику. Пример:
// api.hold(id, 'причина'), api.release(id), api.reroute(id, [узлы]),
// api.setPriority(id, 1..5), api.limitSpeed(id, км/ч), api.log('текст')

function decide(state, api) {
  // for (const tr of state.trains) { ... }
}
` },
};

if (typeof module !== 'undefined') module.exports = { SCENARIOS, ASSIST_TEMPLATES };
