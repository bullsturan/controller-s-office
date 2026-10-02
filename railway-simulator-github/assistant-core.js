// ---- core.js ----
// ============================================================================
//  AI DISPATCHER CORE — ассистент поездного диспетчера
//  Не зависит ни от симулятора, ни от реальной системы: работает только с
//  нормализованной моделью мира (см. adapter-interface.js), которую строит адаптер.
//  Память (memory) — любой объект с методами MemoryStore; без неё ядро работает без обучения.
// ============================================================================

const CORE_CONFIG = {
  horizonSec: 1500,          // горизонт прогноза
  planEverySec: 5,           // плановый перерасчёт (и немедленно — при изменении обстановки)
  beamWidth: 24,             // ширина поиска при совместном планировании конфликтов
  maxConflicts: 14,          // сколько ближайших конфликтов планировать совместно
  minSavingCost: 30,         // минимальный выигрыш (в единицах стоимости), ради которого стоит вмешиваться
  minConfidence: 0.6,        // ниже — только информирование, без действий
  minAdviceKmh: 25,          // ниже этой скорости совет не даётся
  dwellDefaultSec: 60,       // стоянка по умолчанию, если адаптер не знает точную
  clearanceSec: 20,          // запас на освобождение участка хвостом и задание маршрута (если физика недоступна)
  followHeadwaySec: 120,     // интервал попутного следования
  rejectCooldownSec: 300,    // отклонённый диспетчером вариант не предлагать столько времени
  maxHoldSec: 900,           // самое долгое удержание, которое ассистент предлагает
  enable: { speed: true, hold: true, swap: true, overtake: true, reroute: true },  // какие виды действий разрешены
  // веса стоимости (единица — секунда задержки поезда низшей категории)
  w: { delayByPriority: [0, 1, 1.6, 2.2, 3], stop: 90, energyKWh: 0.4, occupationSec: 0.15, instability: 40, knockOn: 0.8 },
  // обучение
  adaptEveryPlans: 50,       // как часто пересматривать пороги
  adaptWindow: 100,          // по скольким последним исходам
  adaptMinSamples: 5,        // меньше — не адаптируемся
};

// границы, в которых обучение может двигать параметры
const ADAPT_BOUNDS = { minSavingCost: [10, 120], minConfidence: [0.4, 0.8], instability: [10, 200], trust: [0.5, 1.2], kindMult: [0.5, 3] };

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lim = (x, [lo, hi]) => Math.max(lo, Math.min(hi, x));
const fmtMin = (sec) => (sec >= 90 ? Math.round(sec / 60) + ' мин' : Math.round(sec) + ' с');

class RailwayDispatcherAI {
  constructor(config = CORE_CONFIG, memory = null) {
    this.base = config;
    this.cfg = { ...config, w: { ...config.w }, enable: { ...config.enable } };
    this.memory = memory;
    this.world = null;
    this.applied = new Map();    // действия, отданные в исполнение/на подтверждение: поезд → действие
    this.rejected = new Map();   // ключ варианта → время отклонения
    this.outcomes = [];          // прогноз против факта (текущая сессия)
    this.watch = new Map();      // действия под наблюдением
    this.history = new Map();    // история прогноза конфликта (для уверенности)
    this.lastPlanAt = -1e9; this.lastSignature = '';
    this.lastConflicts = []; this.lastPlan = []; this.lastSafety = [];
    this.stats = { plans: 0, replansOnChange: 0, conflictsSeen: new Set(), firstSeen: new Map(), obsolete: 0, rejectedSeen: 0 };
    this.newOutcomes = 0;
    this.loadParams();
  }

  // вызов метода памяти, если память подключена и умеет это
  mem(name, ...args) { const m = this.memory; return m && typeof m[name] === 'function' ? m[name](...args) : undefined; }

  // ---------- 0. ПАМЯТЬ: адаптивные параметры ----------
  loadParams() {
    const b = this.base;
    this.params = { minSavingCost: b.minSavingCost, minConfidence: b.minConfidence, instability: b.w.instability, trust: {}, kindMult: {}, ...(this.mem('getParams') || {}) };
    this.cfg.minSavingCost = this.params.minSavingCost;
    this.cfg.minConfidence = this.params.minConfidence;
    this.cfg.w.instability = this.params.instability;
  }

  // Простое обучение на ошибках. Сравнивает прогнозный выигрыш с фактическим и
  // учитывает отклонения диспетчером; двигает пороги в пределах ADAPT_BOUNDS.
  adapt() {
    const cfg = this.cfg, P = { ...this.params, trust: { ...this.params.trust }, kindMult: { ...this.params.kindMult } }, B = ADAPT_BOUNDS;
    const recent = (this.mem('recentOutcomes', cfg.adaptWindow) || []).filter((o) => o.predictedSaving > 0);
    if (recent.length < cfg.adaptMinSamples) return null;
    // медиана отношения факт/прогноз, обрезанного в [0; 1.5]: один шумный исход не сдвигает обучение
    const ratio = (list) => {
      const r = list.map((o) => Math.max(0, Math.min(1.5, o.actualSaving / o.predictedSaving))).sort((a, b) => a - b);
      return r[r.length >> 1];
    };
    const byType = {};
    for (const o of recent) (byType[o.conflict] = byType[o.conflict] || []).push(o);
    // 1. доверие к прогнозу по типу конфликта (множитель уверенности)
    for (const [type, list] of Object.entries(byType)) if (list.length >= 3)
      P.trust[type] = lim(0.7 * (P.trust[type] ?? 1) + 0.3 * ratio(list), B.trust);
    // 2. общие пороги: прогноз завышает выигрыш или сильно ошибается → вмешиваемся осторожнее, и наоборот
    const r = ratio(recent), meanErr = recent.reduce((s, o) => s + Math.abs(o.error || 0), 0) / recent.length;
    if (r < 0.6) { P.minSavingCost *= 1.1; P.minConfidence += 0.02; }
    else if (r > 0.9 && meanErr < 30) { P.minSavingCost *= 0.95; P.minConfidence -= 0.01; }
    // 3. виды действий, которые диспетчер часто отклоняет, требуют большего выигрыша
    const st = this.mem('stats') || {}, applied = st.applied || {}, rejected = st.rejected || {};
    for (const kind of Object.keys(applied)) {
      const n = applied[kind]; if (n < 5) continue;
      const target = 1 + 2 * Math.max(0, (rejected[kind] || 0) / n - 0.2);
      P.kindMult[kind] = lim(0.7 * (P.kindMult[kind] ?? 1) + 0.3 * target, B.kindMult);
    }
    // 4. вес нестабильности: решения часто отзываются → дороже менять план
    const churn = this.stats.obsolete / Math.max(1, this.stats.plans);
    if (churn > 0.3) P.instability *= 1.1; else if (churn < 0.05) P.instability *= 0.97;
    P.minSavingCost = Math.round(lim(P.minSavingCost, B.minSavingCost) * 10) / 10;
    P.minConfidence = Math.round(lim(P.minConfidence, B.minConfidence) * 1000) / 1000;
    P.instability = Math.round(lim(P.instability, B.instability) * 10) / 10;
    P.samples = recent.length; P.savingRatio = Math.round(r * 100) / 100; P.meanErrorSec = Math.round(meanErr);
    P.updatedAt = new Date().toISOString();
    this.mem('saveParams', P);
    this.params = P;
    this.loadParams();
    return P;
  }

  // ---------- 1. СОСТОЯНИЕ ----------
  update(world) { this.world = world; }

  // ---------- 2. АНАЛИЗ СОСТОЯНИЯ ----------
  analyze() {
    const W = this.world;
    const A = { trains: new Map() };
    for (const t of W.trains) {
      if (!t.active) continue;
      const legs = [];
      for (let k = t.posIndex; k < t.route.length - 1; k++) {
        const e = W.edges.get(t.routeEdges[k]); if (!e) break;
        legs.push({ k, edge: e, from: t.route[k], to: t.route[k + 1], inSection: k === t.posIndex && t.onEdge === e.id });
      }
      A.trains.set(t.id, { t, legs });
    }
    this.analysis = A;
    return A;
  }

  // ---------- 3. ПРОГНОЗ ----------
  forecast() {
    const W = this.world, H = this.cfg.horizonSec, F = { trains: new Map() };
    for (const [id, a] of this.analysis.trains) {
      const t = a.t, windows = [];
      for (const L of a.legs) {
        const tIn = L.inSection ? 0 : W.eta(id, L.from);
        const tOut = W.eta(id, L.to);
        if (tIn == null || tOut == null) break;
        if (tIn > H) break;
        const stopAtFrom = !L.inSection && W.isPlannedStop(t, L.from);
        const dep = L.inSection ? 0 : tIn + (stopAtFrom ? this.cfg.dwellDefaultSec : 0);
        windows.push({ ...L, tIn, tDep: Math.max(dep, tIn), tOut });
      }
      F.trains.set(id, { t, windows });
    }
    this.fc = F;
    return F;
  }

  // ---------- 4. ОБНАРУЖЕНИЕ БУДУЩИХ КОНФЛИКТОВ ----------
  detectConflicts(F) {
    const W = this.world, cfg = this.cfg, out = [];
    // 4.1 Встречные на однопутном участке. Встречные на разных путях двухпутки — не конфликт (edge.single = false).
    const bySection = new Map();
    for (const [id, f] of F.trains) for (const w of f.windows) {
      if (!w.edge.single || w.edge.closed) continue;
      if (!bySection.has(w.edge.id)) bySection.set(w.edge.id, []);
      bySection.get(w.edge.id).push({ id, w, t: f.t });
    }
    for (const [eid, L] of bySection) {
      for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
        const A = L[i], B = L[j];
        if (A.w.from === B.w.from) continue;
        const overlap = A.w.tDep < B.w.tOut && B.w.tDep < A.w.tOut;
        if (!overlap) continue;
        let first = A, second = B;
        if (B.w.inSection || (!A.w.inSection && B.w.tDep < A.w.tDep)) { first = B; second = A; }
        if (first.w.inSection && second.w.inSection) continue;
        let clearAt = first.w.tOut + cfg.clearanceSec, source = 'eta';
        if (first.w.inSection) {
          const ct = W.clearTime(eid, first.w.to);
          if (ct && ct.inSec != null) { clearAt = ct.inSec; source = 'physics'; }
        }
        const arrive = second.w.tIn;
        const wait = Math.max(0, clearAt - arrive);
        const waitBeyondDwell = W.isPlannedStop(second.t, second.w.from) ? Math.max(0, wait - cfg.dwellDefaultSec) : wait;
        if (waitBeyondDwell < 5) continue;
        out.push({ id: `meet|${eid}|${first.id}|${second.id}`, type: 'meet', edge: eid, station: second.w.from,
          first: first.id, second: second.id, trains: [first.id, second.id], tConflict: arrive, wait: waitBeyondDwell, clearAt,
          firstInSection: first.w.inSection, firstWin: first.w, secondWin: second.w, source,
          secondStops: !W.isPlannedStop(second.t, second.w.from) });
      }
    }
    // 4.2 Попутное следование: быстрый поезд догоняет медленный на одном пути
    for (const [id, f] of F.trains) for (const w of f.windows) {
      if (w.edge.closed) continue;
      for (const [oid, g] of F.trains) {
        if (oid === id) continue;
        const v = g.windows.find((x) => x.edge.id === w.edge.id && x.from === w.from);
        if (!v || v.tDep > w.tDep) continue;
        const catchUp = w.tOut < v.tOut + cfg.followHeadwaySec;
        if (!catchUp || w.tDep - v.tDep > cfg.horizonSec) continue;
        const loss = Math.max(0, v.tOut + cfg.followHeadwaySec - w.tOut);
        if (loss < 15) continue;
        out.push({ id: `follow|${w.edge.id}|${oid}|${id}`, type: 'follow', edge: w.edge.id, station: w.from, exitNode: w.to, leader: oid, follower: id,
          trains: [oid, id], tConflict: w.tDep, wait: loss, source: 'eta' });
      }
    }
    // 4.3 Конфликт маршрутов в горловине: поезд ждёт, а мешает ему маршрут другого поезда в горловине
    //     станции впереди (приём) или станции, где он стоит (отправление)
    for (const t of W.trains) {
      if (!t.active || !t.blocked || !t.blockedBy.length) continue;
      let node = null, hostile = [];
      for (const nid of [t.atStationNode, t.frontierNode, t.nextNode]) {
        const n = nid && W.nodes.get(nid); if (!n || !n.routes.length) continue;
        const h = n.routes.filter((r) => t.blockedBy.includes(r.train) && r.train !== t.id);
        if (h.length) { node = n; hostile = h; break; }
      }
      if (!node) continue;
      out.push({ id: `route|${node.id}|${t.id}`, type: 'route', station: node.id, trains: [t.id, ...hostile.map((r) => r.train)], subject: t.id,
        tConflict: 0, wait: t.waitingSec || 30, hostile, source: 'state' });
    }
    // 4.4 Закрытие участка/пути по маршруту в горизонте прогноза
    for (const [id, f] of F.trains) for (const w of f.windows) {
      const e = w.edge;
      if (!(e.closed || e.oneTrackClosedNoOrder) || w.inSection) continue;
      const wait = e.closed ? e.closedForSec - w.tIn : e.oneTrackClosedForSec - w.tIn;
      if (wait <= 0) continue;
      out.push({ id: `closure|${e.id}|${id}`, type: 'closure', edge: e.id, station: w.from, trains: [id], subject: id, tConflict: w.tIn, wait, source: 'state', partial: !e.closed });
    }
    // 4.5 Отказ автоблокировки по маршруту: пониженная скорость
    for (const [id, f] of F.trains) for (const w of f.windows) {
      if (!w.edge.absFail || w.inSection) continue;
      const extra = Math.max(0, w.edge.lengthM / (20 / 3.6) - (w.tOut - w.tDep));
      if (extra < 30) continue;
      out.push({ id: `abs|${w.edge.id}|${id}`, type: 'failure', edge: w.edge.id, station: w.from, trains: [id], subject: id, tConflict: w.tIn, wait: extra, source: 'eta' });
    }
    for (const c of out) {
      c.confidence = this.confidence(c);
      c.timeToConflict = Math.round(c.tConflict);
      if (!this.stats.firstSeen.has(c.id)) this.stats.firstSeen.set(c.id, { at: W.now, tAbs: W.now + c.tConflict });
      this.stats.conflictsSeen.add(c.id);
    }
    for (const c of out) c.dependsOn = out.filter((d) => d !== c && d.trains.some((x) => c.trains.includes(x))).map((d) => d.id);
    out.sort((a, b) => a.tConflict - b.tConflict);
    this.lastConflicts = out;
    return out;
  }

  // Уверенность: источник прогноза, состояние участников, горизонт, устойчивость прогноза во времени,
  // выученное доверие к прогнозам этого типа конфликта
  confidence(c) {
    const W = this.world;
    let p = c.source === 'physics' ? 0.95 : c.source === 'state' ? 0.9 : 0.8;
    for (const id of c.trains) {
      const t = W.trainById(id); if (!t) continue;
      if (t.broken) p *= 0.4;
      else if (t.held) p *= 0.75;
      else if (t.status === 'stopped' && t.blocked) p *= 0.8;
      if (t.status === 'pending') p *= 0.85;
    }
    p *= Math.exp(-Math.max(0, c.tConflict) / 2400);
    p *= Math.pow(0.95, Math.max(0, c.trains.length - 2));
    const h = this.history.get(c.id) || [];
    h.push(W.now + c.tConflict); if (h.length > 6) h.shift(); this.history.set(c.id, h);
    if (h.length >= 3) {
      const m = h.reduce((x, y) => x + y, 0) / h.length;
      const sd = Math.sqrt(h.reduce((x, y) => x + (y - m) * (y - m), 0) / h.length);
      p *= Math.exp(-sd / 300);
    }
    p *= this.params.trust[c.type] ?? 1;
    return Math.round(clamp01(p) * 100) / 100;
  }

  // ---------- 5–6. ПОСЛЕДСТВИЯ И ВАРИАНТЫ (эффект = доп. задержка относительно хода без помех) ----------
  generateOptions(conflicts) {
    const W = this.world, cfg = this.cfg;
    for (const c of conflicts) {
      const opts = [];
      opts.push({ kind: 'none', conflict: c.id, effects: this.noActionEffects(c), label: 'без вмешательства' });
      if (c.type === 'meet') {
        const second = W.trainById(c.second), first = W.trainById(c.first);
        // A. Режим подхода второго поезда (физика адаптера)
        if (second && second.status === 'running' && second.nextStation === c.station) {
          const p = W.planApproach(second.id, c.station);
          if (p && p.advice && !p.noConflict && (!p.needStop || p.keep)) {
            opts.push({ kind: 'speed', conflict: c.id, train: second.id, kmh: p.advice.kmh, untilNode: c.station, approach: p,
              label: `снизить скорость ${second.label} до ${p.advice.kmh} км/ч`,
              effects: { [second.id]: { delay: Math.max(0, this.noActionWait(c) - (p.savedSec || 0)), stops: p.needStop && c.secondStops ? 1 : 0, energy: -(p.savedKWh || 0),
                occupation: Math.max(0, p.advice.passInSec - (p.without ? p.without.passInSec : p.advice.passInSec)) } },
              confidenceFactor: p.uncertain ? 0.7 : 1 });
          }
        }
        // B. Задержать второй поезд на станции, где он и так стоит, — вместо остановки у сигнала
        if (second && c.secondStops) {
          const here = second.atStationNode;
          if (here && here !== c.station && second.status !== 'running' && second.route.indexOf(here) < second.route.indexOf(c.station)) {
            const travel = W.eta(second.id, c.station) - (second.departIn || 0);
            const holdFor = Math.max(0, c.clearAt - travel - (second.departIn || 0));
            if (holdFor > 0 && holdFor <= cfg.maxHoldSec) opts.push({ kind: 'hold', conflict: c.id, train: second.id, station: here, holdFor, releaseAt: W.now + holdFor,
              label: `задержать отправление ${second.label} на ${fmtMin(holdFor)}`,
              effects: { [second.id]: { delay: holdFor, stops: 0, energy: 0, occupation: 0 } } });
          }
        }
        // C. Изменить порядок пропуска: первый ещё не вошёл на участок — придержать его
        if (first && !c.firstInSection && first.frontierNode === c.firstWin.from && first.status !== 'broken') {
          const secondRun = Math.max(0, c.secondWin.tOut - c.secondWin.tIn);
          const firstWait = Math.max(0, c.secondWin.tOut + cfg.clearanceSec - c.firstWin.tDep);
          const firstStops = W.isPlannedStop(first, c.firstWin.from) ? 0 : 1;
          if (secondRun > 0 && firstWait <= cfg.maxHoldSec) opts.push({ kind: 'swap', conflict: c.id, train: first.id, station: c.firstWin.from, holdUntilPassed: second.id, releaseAt: W.now + c.secondWin.tOut + cfg.clearanceSec,
            label: `изменить порядок: ${second.label} первым, ${first.label} ждёт`,
            effects: { [first.id]: { delay: firstWait, stops: firstStops, energy: 0, occupation: firstWait }, [second.id]: { delay: 0, stops: 0, energy: 0, occupation: 0 } } });
        }
      } else if (c.type === 'follow') {
        const fol = W.trainById(c.follower), lead = W.trainById(c.leader);
        if (fol && lead && fol.status === 'running' && fol.blocked && fol.blockedBy.includes(lead.id) && lead.speed > cfg.minAdviceKmh && lead.speed < fol.maxSpeed - 10) {
          const kmh = Math.round(lead.speed / 5) * 5;
          opts.push({ kind: 'speed', conflict: c.id, train: fol.id, kmh, label: `${fol.label} следовать за ${lead.label} со скоростью ${kmh} км/ч`,
            effects: { [fol.id]: { delay: c.wait, stops: 0, energy: 0, occupation: 0 } } });
        }
        // обгон: ведущий ещё не вышел со станции — придержать его, пропустить быстрый
        const st = lead && W.nodes.get(c.station);
        const leadBefore = lead && lead.onEdge !== c.edge && lead.frontierNode === c.station;
        if (st && st.type === 'station' && leadBefore && st.free >= 1 && lead.priority < (fol ? fol.priority : 0)) {
          const runFol = fol ? Math.max(0, (W.eta(fol.id, st.id) || 0)) : 0;
          opts.push({ kind: 'hold', conflict: c.id, train: lead.id, station: st.id, holdFor: runFol + cfg.followHeadwaySec, releaseAt: W.now + runFol + cfg.followHeadwaySec, holdUntilPassed: fol.id,
            label: `обгон: придержать ${lead.label}, пропустить ${fol.label}`,
            effects: { [lead.id]: { delay: runFol + cfg.followHeadwaySec, stops: 0, energy: 0, occupation: runFol }, [fol.id]: { delay: 0, stops: 0, energy: 0, occupation: 0 } } });
        }
      } else if (c.type === 'closure' || c.type === 'failure') {
        const t = W.trainById(c.subject);
        if (t && t.frontierNode && W.nodes.get(t.frontierNode) && W.nodes.get(t.frontierNode).type === 'station') {
          const alt = W.findPath(t.frontierNode, t.to, { avoid: [c.edge] }), direct = W.findPath(t.frontierNode, t.to);
          if (alt && direct) {
            const extra = Math.max(0, W.pathTime(alt, t.id) - W.pathTime(direct, t.id));
            opts.push({ kind: 'reroute', conflict: c.id, train: t.id, path: alt, label: `объезд для ${t.label}`,
              effects: { [t.id]: { delay: extra, stops: 0, energy: 0, occupation: 0 } } });
          }
        }
      }
      c.options = opts;
    }
    return conflicts;
  }

  // ожидание без вмешательства: по физике адаптера, если она доступна, иначе по окнам прогноза
  noActionWait(c) {
    if (c._naw != null) return c._naw;
    const W = this.world, sec = W.trainById(c.second);
    const ap = sec && sec.status === 'running' && sec.nextStation === c.station ? W.planApproach(sec.id, c.station) : null;
    c._ap = ap;
    c._naw = ap && ap.without && !ap.noConflict ? Math.max(ap.without.stopSec || 0, 0) : c.wait;
    if (ap && ap.noConflict) c._naw = 0;
    return c._naw;
  }
  noActionEffects(c) {
    if (c.type === 'meet') {
      const wait = this.noActionWait(c);
      return { [c.second]: { delay: wait, stops: c.secondStops && wait > 0 ? 1 : 0, energy: 0, occupation: wait } };
    }
    if (c.type === 'follow') return { [c.follower]: { delay: c.wait, stops: 1, energy: 0, occupation: c.wait } };
    if (c.type === 'route') return { [c.subject]: { delay: c.wait, stops: 0, energy: 0, occupation: c.wait } };
    return { [c.subject]: { delay: c.wait, stops: c.type === 'closure' ? 1 : 0, energy: 0, occupation: c.wait } };
  }

  // ---------- 7. SAFETY LAYER: жёсткий фильтр, не вес ----------
  safetyCheck(o) {
    const W = this.world;
    if (o.kind === 'none') return null;
    const t = W.trainById(o.train);
    if (!t || !t.active) return 'поезд не в движении';
    if (t.broken) return 'поезд неисправен';
    if (t.deadlock) return 'поезд в тупике — нужен ручной разбор';
    if (o.kind === 'speed') {
      if (!(o.kmh >= this.cfg.minAdviceKmh)) return 'скорость ниже допустимой для совета';
      if (o.kmh > t.maxSpeed) return 'выше конструкционной скорости';
      if (t.manualCap != null && o.kmh > t.manualCap) return 'противоречит ограничению диспетчера';
      return null;
    }
    if (o.kind === 'hold' || o.kind === 'swap') {
      const st = W.nodes.get(o.station);
      if (!st || st.type !== 'station') return 'удерживать можно только на станции';
      if (t.frontierNode !== st.id && t.atStationNode !== st.id) return 'поезду уже задан маршрут дальше станции';
      const inboundOthers = st.inbound.filter((x) => x !== t.id).length;
      const occupiesHere = st.trains.includes(t.id) ? 0 : 1;
      if (st.free - occupiesHere < inboundOthers) return 'станция не сможет принять поезда, идущие на неё';
      if (o.kind === 'swap') {
        const e = W.edges.get(t.nextEdge);
        if (e && (e.trainsAB.includes(t.id) || e.trainsBA.includes(t.id))) return 'поезд уже вошёл на участок';
        const sec = W.trainById(o.holdUntilPassed);
        if (!sec) return 'нет второго поезда';
        if (st.free - occupiesHere - inboundOthers < 1 && !st.inbound.includes(sec.id)) return 'для встречного нет свободного пути на станции скрещения';
      }
      return null;
    }
    if (o.kind === 'reroute') {
      if (!o.path || o.path.length < 2 || o.path[0] !== t.frontierNode) return 'маршрут не начинается с текущей станции';
      for (let i = 0; i < o.path.length - 1; i++) {
        const e = W.edgeBetween(o.path[i], o.path[i + 1]);
        if (!e) return 'нет перегона между узлами маршрута';
        if (e.closed) return 'маршрут проходит по закрытому перегону';
      }
      return null;
    }
    return 'неизвестное действие';
  }
  validateSafety(conflicts) {
    for (const c of conflicts) {
      c.rejectedOptions = [];
      const en = this.cfg.enable || {};
      c.options = c.options.filter((o) => {
        const kindKey = o.kind === 'hold' && o.holdUntilPassed && c.type === 'follow' ? 'overtake' : o.kind;
        if (o.kind !== 'none' && en[kindKey] === false) return false;
        const why = this.safetyCheck(o);
        if (why) { c.rejectedOptions.push({ label: o.label, why }); return false; }
        const r = this.rejected.get(this.optionKey(o));
        if (r != null && this.world.now - r < this.cfg.rejectCooldownSec) { c.rejectedOptions.push({ label: o.label, why: 'отклонено диспетчером' }); return false; }
        return true;
      });
    }
    return conflicts;
  }
  optionKey(o) { return `${o.kind}|${o.train || ''}|${o.conflict}`; }

  // Обязательные меры безопасности (каждый такт): защита от взаимной блокировки на однопутке и закрытый участок
  mandatorySafety() {
    const W = this.world, out = [];
    for (const t of W.trains) {
      if (!t.active || !t.frontierNode || !t.nextEdge) continue;
      const here = W.nodes.get(t.frontierNode), e = W.edges.get(t.nextEdge);
      if (!here || here.type !== 'station' || !e) continue;
      if (e.closed) { out.push({ train: t.id, reason: `участок ${e.label} закрыт`, expect: 'поезд не выйдет на закрытый участок' }); continue; }
      if (!e.single) continue;
      const next = W.nodes.get(t.nextEdgeTo);
      if (!next || next.type !== 'station') continue;
      const facing = next.trains.filter((id) => { const o = W.trainById(id); return o && o.nextEdge === e.id; }).length;
      const inbound = next.inbound.filter((id) => id !== t.id).length;
      if (next.tracks - facing - inbound < 1) { out.push({ train: t.id, reason: `нет гарантированного пути на ст. ${next.label}`, expect: 'исключается взаимная блокировка поездов на однопутке' }); continue; }
      const k = t.route.indexOf(next.id, t.posIndex), e2 = W.edges.get(t.routeEdges[k]);
      if (e2 && e2.single) {
        const far = e2.a === next.id ? e2.b : e2.a;
        const sameWay = [...next.trains, ...next.inbound].filter((id) => id !== t.id && W.willUse(id, e2.id, next.id)).length;
        const opposite = W.trains.some((o) => o.active && W.willUse(o.id, e2.id, far));
        if (opposite && sameWay + 1 > next.tracks - 1) out.push({ train: t.id, reason: `держим путь для скрещения на ст. ${next.label}`, expect: 'на станции останется путь для встречного' });
      }
    }
    this.lastSafety = out;
    return out;
  }

  // ---------- 8–9. СТОИМОСТЬ ----------
  costOf(effects) {
    const W = this.world, w = this.cfg.w;
    const parts = { delay: 0, stops: 0, energy: 0, occupation: 0 };
    for (const [id, e] of Object.entries(effects)) {
      const t = W.trainById(id); const pr = t ? Math.max(1, Math.min(4, t.priority | 0)) : 1;
      parts.delay += (e.delay || 0) * w.delayByPriority[pr];
      parts.stops += (e.stops || 0) * w.stop;
      parts.energy += (e.energy || 0) * w.energyKWh;
      parts.occupation += (e.occupation || 0) * w.occupationSec;
    }
    return { cost: parts.delay + parts.stops + parts.energy + parts.occupation, parts };
  }

  // ---------- 10–11. СИСТЕМНЫЙ ПЛАН ДЛЯ НЕСКОЛЬКИХ КОНФЛИКТОВ ----------
  optimize(conflicts) {
    const cfg = this.cfg;
    const C = conflicts.filter((c) => c.options && c.options.length).slice(0, cfg.maxConflicts);
    let beam = [{ picks: [], actions: new Map(), shift: new Map(), cost: 0 }];
    for (const c of C) {
      const next = [];
      for (const b of beam) for (const o of c.options) {
        if (o.kind !== 'none' && b.actions.has(o.train) && this.optionKey(b.actions.get(o.train)) !== this.optionKey(o)) continue;
        const eff = this.shiftedEffects(c, o, b.shift);
        let { cost } = this.costOf(eff);
        if (o.kind !== 'none') {
          const conf = c.confidence * (o.confidenceFactor || 1);
          const base = this.costOf(this.shiftedEffects(c, c.options[0], b.shift)).cost;
          cost = base + (cost - base) * conf;
          if (conf < cfg.minConfidence) cost = base + 1;
          const prev = this.applied.get(o.train);
          if (prev && this.optionKey(prev) !== this.optionKey(o)) cost += cfg.w.instability;
          if (prev && o.kind === 'speed' && o.untilNode && this.optionKey(prev) === this.optionKey(o)) cost -= cfg.w.instability;
        }
        let knock = 0;
        for (const [tid, e] of Object.entries(eff)) if ((e.delay || 0) > 0)
          for (const d of C) if (d !== c && d.type === 'meet' && d.first === tid && d.tConflict > c.tConflict) knock += e.delay * cfg.w.knockOn;
        const shift = new Map(b.shift);
        for (const [tid, e] of Object.entries(eff)) shift.set(tid, (shift.get(tid) || 0) + Math.max(0, e.delay || 0) * (o.kind === 'none' ? 0 : 1));
        const actions = new Map(b.actions); if (o.kind !== 'none') actions.set(o.train, o);
        next.push({ picks: [...b.picks, { c, o, eff }], actions, shift, cost: b.cost + cost + knock });
      }
      next.sort((x, y) => x.cost - y.cost);
      beam = next.slice(0, cfg.beamWidth);
    }
    const best = beam[0];
    const plan = [];
    for (const p of best.picks) {
      if (p.o.kind === 'none') continue;
      const before = this.costOf(this.shiftedEffects(p.c, p.c.options[0], new Map())).cost;
      const after = this.costOf(p.eff).cost;
      const prev = this.applied.get(p.o.train), continuing = prev && p.o.kind === 'speed' && p.o.untilNode && this.optionKey(prev) === this.optionKey(p.o);
      const minSaving = cfg.minSavingCost * (this.params.kindMult[p.o.kind] || 1);   // выученный порог по виду действия
      if (before - after < (continuing ? 1 : minSaving)) continue;
      plan.push({ ...p.o, conflictObj: p.c, costBefore: Math.round(before), costAfter: Math.round(after), saving: Math.round(before - after) });
    }
    const greedy = C.map((c) => c.options.reduce((m, o) => (this.costOf(o.effects).cost < this.costOf(m.effects).cost ? o : m), c.options[0]));
    this.stats.differsFromGreedy = (this.stats.differsFromGreedy || 0) + (greedy.some((g, i) => this.optionKey(g) !== this.optionKey(best.picks[i].o)) ? 1 : 0);
    this.lastPlan = plan;
    return plan;
  }
  shiftedEffects(c, o, shift) {
    if (c.type !== 'meet') return o.effects;
    const ds = (shift.get(c.second) || 0) - (shift.get(c.first) || 0);
    if (!ds) return o.effects;
    const k = c.wait > 0 ? clamp01((c.wait - ds) / c.wait) : 1;
    const eff = {};
    for (const [id, e] of Object.entries(o.effects)) eff[id] = { ...e, delay: (e.delay || 0) * (id === c.second || o.kind !== 'none' ? k : 1), stops: k > 0 ? e.stops : 0 };
    return eff;
  }

  // ---------- 12. ПЕРЕПЛАНИРОВАНИЕ ----------
  needsReplan() {
    const sig = this.world.signature;
    const changed = sig !== this.lastSignature;
    const due = this.world.now - this.lastPlanAt >= this.cfg.planEverySec;
    if (changed && this.lastSignature) this.stats.replansOnChange++;
    this.lastSignature = sig;
    return changed || due;
  }
  plan() {
    this.analyze();
    const conflicts = this.detectConflicts(this.forecast());
    this.generateOptions(conflicts);
    this.validateSafety(conflicts);
    const plan = this.optimize(conflicts);
    this.lastPlanAt = this.world.now; this.stats.plans++;
    if (this.newOutcomes >= this.cfg.adaptMinSamples && this.stats.plans % this.cfg.adaptEveryPlans === 0 && this.adapt()) this.newOutcomes = 0;
    return plan;
  }

  // ---------- 14. ОБЪЯСНЕНИЕ ----------
  explain(a) {
    const W = this.world, c = a.conflictObj;
    const names = c.trains.map((id) => (W.trainById(id) || { label: id }).label).join(', ');
    const st = W.nodes.get(c.station);
    const where = st ? `ст. ${st.label}` : '';
    const why = c.type === 'meet' ? `встреча ${names} на однопутном участке ${W.edges.get(c.edge).label}: участок освободится через ~${fmtMin(c.clearAt)}`
      : c.type === 'follow' ? `${W.trainById(c.follower).label} догоняет ${W.trainById(c.leader).label} на участке ${W.edges.get(c.edge).label}`
      : c.type === 'closure' ? `участок ${W.edges.get(c.edge).label} закрыт ещё ~${fmtMin(c.wait + c.tConflict)}`
      : c.type === 'failure' ? `отказ автоблокировки на участке ${W.edges.get(c.edge).label}: +${fmtMin(c.wait)} хода`
      : `враждебный маршрут в горловине ${where}`;
    const none = c.options[0].effects;
    const mine = Object.entries(none).map(([id, e]) => `${W.trainById(id).label}: +${fmtMin(e.delay)}${e.stops > 0 ? ', остановка' : ''}`).join('; ');
    const pred = Object.entries(a.effects).map(([id, e]) => `${W.trainById(id).label}: +${fmtMin(Math.max(0, e.delay))}${e.stops > 0 ? ', остановка' : ', без остановки'}`).join('; ');
    const alts = c.options.filter((o) => o.kind !== 'none' && this.optionKey(o) !== this.optionKey(a)).map((o) => ({ label: o.label, cost: Math.round(this.costOf(o.effects).cost) }));
    const savingSec = Math.round(Object.values(none).reduce((x, e) => x + (e.delay || 0), 0) - Object.values(a.effects).reduce((x, e) => x + (e.delay || 0), 0));
    const savingKWh = Math.round(-Object.values(a.effects).reduce((x, e) => x + (e.energy || 0), 0));
    return {
      action: a.label, target: (W.trainById(a.train) || {}).label, conflict: c.type, conflictId: c.id, timeToConflict: c.timeToConflict,
      reason: why, noActionOutcome: mine, predictedOutcome: pred, alternatives: alts, confidence: c.confidence,
      costBefore: a.costBefore, costAfter: a.costAfter, estimatedSaving: a.saving,
      // краткие поля для интерфейса диспетчера
      expect: `${pred} (уверенность ${Math.round(c.confidence * 100)}%)`, without: `${mine}${where ? ' — ' + where : ''}`,
      savingSec: Math.max(0, savingSec), savingKWh: Math.max(0, savingKWh), untilNode: a.kind === 'speed' ? a.untilNode : undefined,
    };
  }

  // ---------- 13. ИСПОЛНЕНИЕ ЧЕРЕЗ АДАПТЕР (confirm/auto решает среда) ----------
  execute(plan, adapter) {
    const W = this.world;
    const safety = this.mandatorySafety();
    const want = new Map();
    for (const s of safety) want.set(s.train, { kind: 'safetyHold', train: s.train, info: { reason: s.reason, expect: s.expect, safety: true } });
    // устойчивость: начатый совет подхода продолжается, если свежий физический расчёт его подтверждает
    for (const [tid, prev] of this.applied) {
      if (prev.kind !== 'speed' || !prev.untilNode || plan.some((a) => a.train === tid)) continue;
      const c = this.lastConflicts.find((x) => x.id === prev.conflict);
      const fresh = c && c.options && c.options.find((o) => o.kind === 'speed' && o.train === tid);
      if (fresh && !this.safetyCheck(fresh)) plan = plan.concat([{ ...fresh, conflictObj: c, costBefore: prev.costBefore, costAfter: prev.costAfter, saving: prev.saving }]);
    }
    for (const a of plan) {
      if (want.has(a.train)) continue;       // безопасность важнее оптимизации
      if ((a.kind === 'hold' || a.kind === 'swap') && a.releaseAt != null && W.now >= a.releaseAt) continue;
      if (a.holdUntilPassed && W.passed(a.holdUntilPassed, a.station)) continue;
      want.set(a.train, { ...a, info: this.explain(a) });
    }
    // отзыв устаревших решений
    for (const [tid, prev] of this.applied) {
      const now = want.get(tid);
      if (now && now.kind === prev.kind && (now.kind !== 'speed' || now.kmh === prev.kmh)) continue;
      if (prev.kind === 'speed') adapter.clearSpeed(tid);
      if (prev.kind === 'hold' || prev.kind === 'swap' || prev.kind === 'safetyHold') adapter.release(tid);
      this.applied.delete(tid); this.stats.obsolete++;
    }
    for (const [tid, a] of want) {
      let r;
      if (a.kind === 'safetyHold') r = adapter.hold(tid, a.info, true);
      else if (a.kind === 'speed') r = adapter.limitSpeed(tid, a.kmh, a.info);
      else if (a.kind === 'hold' || a.kind === 'swap') r = adapter.hold(tid, a.info, false);
      else if (a.kind === 'reroute') r = adapter.reroute(tid, a.path);
      if (r === false) { this.reject(a, 'adapter'); continue; }
      const isNew = !this.applied.has(tid);
      this.applied.set(tid, a);
      if (isNew && a.kind !== 'safetyHold' && a.info) { this.startWatch(a); this.mem('addApplied', a.kind); }
    }
    // решения диспетчера: отклонённое исключается на время, план пересчитывается
    for (const rec of W.recommendations) if (rec.status === 'rejected' && !this.rejectedSeen(rec.id)) {
      this.stats.rejectedSeen++;
      for (const [tid, a] of this.applied) if (tid === rec.train && a.kind !== 'safetyHold') { this.reject(a, 'dispatcher'); this.applied.delete(tid); this.forceReplan = true; }
    }
  }
  rejectedSeen(id) { this._rs = this._rs || new Set(); if (this._rs.has(id)) return true; this._rs.add(id); return false; }
  reject(a, source) {
    const key = this.optionKey(a);
    this.rejected.set(key, this.world.now);
    this.mem('addRejected', { key, kind: a.kind, conflict: a.conflictObj ? a.conflictObj.type : null, train: a.train, label: a.label, source, simTime: this.world.now });
  }

  // ---------- 15. ПРОГНОЗ ПРОТИВ ФАКТА ----------
  // Сверка по измеримому: сколько поезд простоял у сигнала в зоне конфликта (без стоянок по графику
  // и удержаний диспетчера) и когда проследовал точку конфликта.
  startWatch(a) {
    const W = this.world, c = a.conflictObj;
    const subject = a.kind === 'swap' ? c.second : (a.kind === 'hold' && c.type === 'follow' ? c.follower : a.train);
    const none = c.options[0].effects[subject] || { delay: 0, stops: 0 };
    const ap = a.kind === 'speed' ? a.approach : null;
    this.watch.set(a.train + '|' + c.id, { subject, edge: c.edge, station: c.station, endNode: c.type === 'follow' ? c.exitNode : c.station,
      waitNone: c.type === 'meet' ? this.noActionWait(c) : (none.delay || 0), waitWith: 0,   // по плану решение устраняет простой у сигнала
      passPred: ap && ap.advice ? W.now + ap.advice.passInSec : null, stoppedSec: 0, action: a.label, kind: a.kind, conflict: c.type,
      confidence: c.confidence, predictedCostSaving: a.saving });
  }
  evaluateOutcomes() {
    const W = this.world;
    for (const [k, w] of this.watch) {
      const t = W.trainById(w.subject);
      if (!t) { this.watch.delete(k); continue; }
      const inZone = t.onEdge === w.edge || t.nextStation === w.endNode || t.atStationNode === w.endNode;
      if (inZone && t.status === 'stopped' && !t.held && t.blocked) w.stoppedSec += W.dt;
      if (W.passed(w.subject, w.endNode) || t.status === 'done') {
        const predictedSaving = w.waitNone - w.waitWith, actualSaving = w.waitNone - w.stoppedSec;
        const o = { action: w.action, kind: w.kind, conflict: w.conflict, confidence: w.confidence,
          predictedWaitNoAction: Math.round(w.waitNone), predictedWait: Math.round(w.waitWith), actualWait: Math.round(w.stoppedSec),
          predictedSaving: Math.round(predictedSaving), actualSaving: Math.round(actualSaving), error: Math.round(w.stoppedSec - w.waitWith),
          passError: w.passPred != null ? Math.round(W.now - w.passPred) : null, predictedCostSaving: w.predictedCostSaving };
        this.outcomes.push(o);
        this.mem('addOutcome', o);
        this.newOutcomes++;
        this.watch.delete(k);
      }
    }
  }

  // ---------- главный такт ----------
  tick(adapter) {
    this.update(adapter.getState());
    this.evaluateOutcomes();
    if (this.forceReplan || this.needsReplan()) { this.forceReplan = false; this.plan(); }
    this.execute(this.lastPlan, adapter);
  }
}


// ---- adapters/simulator.js ----
// ============================================================================
//  АДАПТЕР к API учебного симулятора — единственное место, знающее его формат.
//  createSimulatorAdapter(state, api, prevTime) → IWorldAdapter (см. adapter-interface.js)
//
//  api — функции симулятора (eta, planApproach, clearTime, findPath, pathTime, hold, release,
//  limitSpeed, reroute, log). Чего нет — заменяется грубой оценкой по самому state
//  (offlineApi), поэтому адаптер работает и с JSON-снимком состояния, пришедшим по HTTP.
// ============================================================================

function createSimulatorAdapter(state, api = {}, prevTime = null) {
  const real = api, fallback = offlineApi(state);
  api = {};
  for (const k of Object.keys(fallback)) api[k] = typeof real[k] === 'function' ? real[k].bind(real) : fallback[k];
  const nodes = new Map(), edges = new Map(), trains = [], tById = new Map();
  for (const n of state.nodes) nodes.set(n.id, {
    id: n.id, label: n.name, type: n.type, tracks: n.tracks, free: n.free, trains: n.trains || [], inbound: n.inbound || [],
    routes: n.throat ? [...n.throat.W, ...n.throat.E].map((r) => ({ train: r.train, kind: r.kind })) : [],
  });
  for (const e of state.edges) {
    const tI = e.tracks && e.tracks.I, tII = e.tracks && e.tracks.II;
    const oneClosed = !!(tI && tII && (tI.closed !== tII.closed));
    const order = oneClosed && ((tI.closed && tII.wrongLineOrder) || (tII.closed && tI.wrongLineOrder));
    edges.set(e.id, {
      id: e.id, a: e.a, b: e.b, label: e.name, lengthM: e.lengthKm * 1000, vmax: e.vmax,
      // «однопутный» для встречных: физически однопутный или двухпутка, работающая по одному пути
      single: !e.double, closed: !!e.closed, closedForSec: e.closedForSec || 0, absFail: !!e.absFail,
      oneTrackClosedNoOrder: oneClosed && !order, oneTrackClosedForSec: oneClosed ? Math.max(tI.closedForSec, tII.closedForSec) : 0,
      trainsAB: e.trainsAB || [], trainsBA: e.trainsBA || [],
    });
  }
  for (const t of state.trains) {
    const active = t.status !== 'done';
    let posIndex = t.routePos || 0;
    if (t.atNode) posIndex = Math.max(0, t.route.indexOf(t.atNode));
    else if (t.onEdge) { const k = t.routeEdges.indexOf(t.onEdge, Math.max(0, (t.routePos || 0) - 3)); if (k >= 0) posIndex = k; }
    const n = {
      id: t.id, label: t.name, type: t.type, priority: t.priority, status: t.status, active, broken: t.status === 'broken', deadlock: t.deadlock,
      speed: t.speed, maxSpeed: t.maxSpeed, lengthM: t.lengthM, route: t.route, routeEdges: t.routeEdges, posIndex, to: t.to,
      onEdge: t.onEdge, atStationNode: t.atNode && nodes.get(t.atNode) && nodes.get(t.atNode).type === 'station' ? t.atNode : null,
      frontierNode: t.frontierNode, nextEdge: t.nextEdge ? t.nextEdge.id : null, nextEdgeTo: t.nextEdge ? t.nextEdge.toNode : null,
      nextNode: t.nextStation ? t.nextStation.id : t.frontierNode, nextStation: t.nextStation ? t.nextStation.id : null,
      blocked: !!t.blocked, blockedBy: t.blockedBy || [], held: !!t.held, manualCap: t.manualCap, speedCap: t.speedCap,
      departIn: t.departIn, waitingSec: t.waitingSec, delaySec: (t.delayMin || 0) * 60, nextStop: t.nextStop,
    };
    trains.push(n); tById.set(t.id, n);
  }
  // признак изменения обстановки: закрытия, отказы, задержки, отправления, решения диспетчера
  const sig = [
    state.edges.map((e) => `${e.closed ? 1 : 0}${e.absFail ? 1 : 0}${e.double ? 1 : 0}`).join(''),
    state.trains.map((t) => `${t.status[0]}${Math.round((t.delayMin || 0) / 2)}${Math.round((t.departIn || 0) / 120)}${t.manualCap || ''}`).join(''),
    (state.recommendations || []).filter((r) => r.status === 'rejected').length,
  ].join('|');
  const passed = (tid, nodeId) => {
    const t = tById.get(tid); if (!t) return true;
    const k = t.route.indexOf(nodeId); return k >= 0 && t.posIndex > k && !(t.atStationNode === nodeId);
  };
  const W = {
    now: state.time, dt: prevTime != null ? Math.max(0, state.time - prevTime) : 1, trains, nodes, edges, signature: sig, recommendations: state.recommendations || [],
    trainById: (id) => tById.get(id),
    eta: (id, node) => api.eta(id, node),
    clearTime: (edge, node) => api.clearTime(edge, node),
    planApproach: (id, node) => api.planApproach(id, node),
    findPath: (a, b, o) => api.findPath(a, b, o), pathTime: (p, id) => api.pathTime(p, id),
    edgeBetween: (a, b) => { const e = api.edgeBetween(a, b); return e ? edges.get(e.id) : null; },
    isPlannedStop: (t, nodeId) => t.nextStop === nodeId || t.to === nodeId,
    trainAtStation: (t, nodeId) => t.atStationNode === nodeId,
    willUse: (id, edgeId, fromNode) => { const t = tById.get(id); if (!t) return false;
      for (let p = t.posIndex; p < t.routeEdges.length; p++) if (t.routeEdges[p] === edgeId && t.route[p] === fromNode) return true; return false; },
    passed,
  };
  return {
    getState: () => W,
    hold: (id, info, safety) => api.hold(id, info, { safety: !!safety }),
    release: (id) => api.release(id),
    limitSpeed: (id, kmh, info) => api.limitSpeed(id, kmh, info),
    clearSpeed: (id) => api.limitSpeed(id, null),
    reroute: (id, path) => api.reroute(id, path),
    log: (m) => api.log(m),
  };
}

// Оценки по одному только снимку состояния (если симулятор их не дал).
// state.etas = { trainId: { nodeId: sec } } — если передан, используется как есть.
function offlineApi(state) {
  const E = new Map(state.edges.map((e) => [e.id, e])), T = new Map(state.trains.map((t) => [t.id, t]));
  const runSec = (e, t) => (e.lengthKm * 1000) / (Math.max(5, Math.min(e.vmax || 80, (t && t.maxSpeed) || 80)) / 3.6);
  const edgeBetween = typeof state.edgeBetween === 'function' ? (a, b) => state.edgeBetween(a, b) : ((a, b) => state.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a)) || null);
  const eta = (id, node) => {
    if (state.etas && state.etas[id] && state.etas[id][node] != null) return state.etas[id][node];
    const t = T.get(id); if (!t || !t.route) return null;
    if (t.atNode === node) return 0;
    let k = t.atNode ? t.route.indexOf(t.atNode) : t.routeEdges.indexOf(t.onEdge);
    if (k < 0) k = t.routePos || 0;
    let sec = t.atNode ? t.departIn || 0 : 0;
    for (; k < t.route.length - 1; k++) {
      const e = E.get(t.routeEdges[k]); if (!e) return null;
      const full = runSec(e, t);
      sec += !t.atNode && t.routeEdges[k] === t.onEdge ? full * (1 - (t.edgeProgress ?? 0.5)) : full;
      if (t.route[k + 1] === node) return sec;
    }
    return null;
  };
  // Дейкстра по времени хода, без закрытых и избегаемых перегонов
  const findPath = (from, to, { avoid = [] } = {}) => {
    const dist = new Map([[from, 0]]), prev = new Map(), open = new Set([from]);
    while (open.size) {
      let u = null; for (const x of open) if (u == null || dist.get(x) < dist.get(u)) u = x;
      open.delete(u);
      if (u === to) break;
      for (const e of state.edges) {
        if (e.closed || avoid.includes(e.id) || (e.a !== u && e.b !== u)) continue;
        const v = e.a === u ? e.b : e.a, d = dist.get(u) + runSec(e);
        if (!dist.has(v) || d < dist.get(v)) { dist.set(v, d); prev.set(v, u); open.add(v); }
      }
    }
    if (!dist.has(to)) return null;
    const p = [to]; while (p[0] !== from) p.unshift(prev.get(p[0]));
    return p;
  };
  const pathTime = (p, id) => { let s = 0; for (let i = 0; i < p.length - 1; i++) { const e = edgeBetween(p[i], p[i + 1]); if (e) s += runSec(e, T.get(id)); } return s; };
  const noop = () => undefined;
  return { eta, findPath, pathTime, edgeBetween, clearTime: () => null, planApproach: () => null,
    hold: noop, release: noop, limitSpeed: noop, reroute: noop, log: noop };
}

// api, записывающий команды вместо исполнения (для POST /tick и тестов)
function recordingApi(actions, logs = []) {
  return {
    hold: (train, info, o) => { actions.push({ do: 'hold', train, safety: !!(o && o.safety), info }); },
    release: (train) => { actions.push({ do: 'release', train }); },
    limitSpeed: (train, kmh, info) => { actions.push(kmh == null ? { do: 'clearSpeed', train } : { do: 'limitSpeed', train, kmh, info }); },
    reroute: (train, path) => { actions.push({ do: 'reroute', train, path }); },
    log: (m) => { logs.push(m); },
  };
}


// ---- memory-remote.js ----
// Память через HTTP API сервера (для ядра, работающего внутри браузерного симулятора).
// Тот же интерфейс, что у MemoryStore; запись — fire-and-forget, чтение — из локального кэша.
class RemoteMemory {
  constructor(baseUrl, params = null) {
    this.url = baseUrl.replace(/\/$/, '');
    this.data = { params, outcomes: [], stats: { applied: {}, rejected: {} } };
    this.onLoad = null;
    if (typeof fetch === 'function') fetch(this.url + '/memory/state?recent=500').then((r) => r.json())
      .then((d) => { this.data = { ...d, params: d.params || this.data.params }; if (this.onLoad) this.onLoad(); }).catch(() => {});
  }
  post(p, body) { if (typeof fetch === 'function') fetch(this.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); }
  getParams() { return this.data.params; }
  saveParams(p) { this.data.params = p; this.post('/memory/params', p); }
  addOutcome(o) { this.data.outcomes.push(o); this.post('/memory/outcome', o); }
  addRejected(r) { const s = this.data.stats.rejected; s[r.kind] = (s[r.kind] || 0) + 1; this.post('/memory/rejected', r); }
  addApplied(kind) { const s = this.data.stats.applied; s[kind] = (s[kind] || 0) + 1; this.post('/memory/applied', { kind }); }
  recentOutcomes(n = 100) { return this.data.outcomes.slice(-n); }
  stats() { return this.data.stats; }
}


// ---- sim-entry.js ----
// Точка входа внутри симулятора. Не запускается в Node: `npm run build` склеивает
// core.js + adapters/simulator.js + memory-remote.js + этот файл в dist/sim-script.js.
const MEMORY_URL = 'http://localhost:3000';
const LEARNED_PARAMS = {"minSavingCost":30,"minConfidence":0.52,"instability":24,"trust":{"meet":1,"follow":0.85,"route":1,"closure":1,"failure":1},"kindMult":{},"trainedGainMin":35.77,"updatedAt":"2026-10-01T21:31:15.419Z"};   // build.js подставляет параметры, выученные в train.js (data/memory.json)

function decide(state, api) {
  const mem = api.memory;
  if (!mem.core) {
    const store = new RemoteMemory(MEMORY_URL, LEARNED_PARAMS);
    mem.core = new RailwayDispatcherAI(CORE_CONFIG, store);
    store.onLoad = () => mem.core.loadParams();
    mem.lastLogged = new Set(); mem.outLogged = 0;
  }
  const core = mem.core;
  const adapter = createSimulatorAdapter(state, api, mem.prevTime);
  mem.prevTime = state.time;
  core.tick(adapter);
  for (const a of core.lastPlan) {
    const k = core.optionKey(a);
    if (!mem.lastLogged.has(k)) { mem.lastLogged.add(k); api.log(`План: ${a.label} — выигрыш ${a.saving}, уверенность ${Math.round(a.conflictObj.confidence * 100)}%`); }
  }
  while (core.outcomes.length > mem.outLogged) {
    const o = core.outcomes[mem.outLogged++];
    api.log(`Факт: ${o.action} — прогноз выигрыша ${o.predictedSaving} с, факт ${o.actualSaving} с, ошибка ${o.error} с`);
  }
}
