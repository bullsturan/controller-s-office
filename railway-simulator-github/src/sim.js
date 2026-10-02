// ================= ЯДРО СИМУЛЯЦИИ =================
const TRAIN_TYPES = {
  express:   { label: 'Скорый',       vmax: 160, acc: 0.45, dec: 0.80, len: 350, mass: 800,  prio: 3, dwell: 60 },
  passenger: { label: 'Пассажирский', vmax: 120, acc: 0.50, dec: 0.75, len: 300, mass: 700,  prio: 2, dwell: 120 },
  suburban:  { label: 'Пригородный',  vmax: 110, acc: 0.80, dec: 0.90, len: 220, mass: 450,  prio: 2, dwell: 45 },
  freight:   { label: 'Грузовой',     vmax: 80,  acc: 0.18, dec: 0.40, len: 750, mass: 4500, prio: 1, dwell: 0 },
};
const STATION_LEN = 900, JUNCTION_LEN = 120, BLOCK_LEN = 1800, SIGNAL_MARGIN = 25;
const _tr = (x) => (typeof TR === 'function' ? TR(x) : x);
// Двухпутный перегон: путь I ведёт от a к b, путь II — от b к a (правостороннее движение).
// Закрытие пути и движение по соседнему пути — разные действия:
//  1) закрытие (closeEdge с track) только запрещает занимать путь;
//  2) движение по соседнему пути в обе стороны организует диспетчер приказом (orderWrongLine).
// Условия приказа задаются инфраструктурой, а не правилами «по умолчанию»:
//  - trk[l].bidir — на пути есть двусторонняя автоблокировка: после смены направления
//    поезда идут по сигналам АБ попутно с интервалом блок-участков;
//    без неё весь перегон по неправильному пути — один поезд, и отправление возможно
//    только с согласия станции приёма (её путь бронируется заранее);
//  - node.crossovers — на станции есть съезд между главными путями
//    (нужен на станции отправления и на станции приёма);
//  - node.wrongEntry — как станция принимает с неправильного пути: 'signal' (входной
//    светофор для этого направления) или 'invite' (по пригласительному, не более 20 км/ч);
//  - скорость по неправильному пути без АБ указывается в приказе (order.vmax).
const TRACK_NAME = { f: 'I', r: 'II' };
// Горловины (net.interlocking = 'routes', по умолчанию; 'pool' — прежняя модель «станция = пул путей»).
// У каждой станции/поста две горловины (запад/восток). Пути перегонов и станционные пути имеют
// поперечную координату в горловине. Маршрут — отрезок [вход, путь]; два маршрута враждебны, если
// используют одну стрелочную секцию входа или их отрезки пересекаются/перекрываются (лестница стрелок).
// Параллельные маршруты (каждый по своему главному пути) не враждебны.
const THROAT_LEN = 200; // длина горловины, м: маршрут приёма размыкается, когда хвост её прошёл
// Горизонт совета по скорости: дальше прогноз встречного становится ненадёжным
const PLAN_MAX_DIST = 15000, PLAN_MAX_CLEAR = 900;
const USEFUL_LEN = 1050; // полезная длина приёмо-отправочного пути по умолчанию, м (node.usefulLen)
const INVITE_VMAX = 20; // ПТЭ: проследование пригласительного сигнала — не более 20 км/ч
const START_CLOCK = 6 * 3600;

function fmtClock(t, sec = true) {
  const s = Math.floor(START_CLOCK + t) % 86400;
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return sec ? `${p(h)}:${p(m)}:${p(ss)}` : `${p(h)}:${p(m)}`;
}

function findPath(net, from, to, avoid = []) {
  if (from === to) return { nodes: [from], edges: [] };
  const av = new Set(avoid);
  const adj = new Map();
  for (const n of net.nodes) adj.set(n.id, []);
  for (const e of net.edges) {
    if (av.has(e.id) || !adj.has(e.a) || !adj.has(e.b)) continue;
    const w = e.len / (e.vmax / 3.6);
    adj.get(e.a).push([e.b, w, e]);
    adj.get(e.b).push([e.a, w, e]);
  }
  const dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
  while (true) {
    let u = null, best = Infinity;
    for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; u = k; }
    if (u === null) return null;
    if (u === to) break;
    done.add(u);
    for (const [v, w, e] of adj.get(u) || []) {
      const nd = best + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, [u, e]); }
    }
  }
  const nodes = [to], edges = [];
  let c = to;
  while (c !== from) { const [p, e] = prev.get(c); nodes.unshift(p); edges.unshift(e); c = p; }
  return { nodes, edges };
}

class Sim {
  constructor(net, specs, opts = {}) {
    this.net = JSON.parse(JSON.stringify(net));
    this.nodeMap = new Map(this.net.nodes.map((n) => [n.id, n]));
    for (const n of this.net.nodes) {
      if (n.crossovers === undefined) n.crossovers = true;
      if (n.wrongEntry === undefined) n.wrongEntry = n.type === 'station' ? 'invite' : 'signal';
    }
    this.routeMode = (this.net.interlocking || 'routes') === 'routes';
    this.edgeMap = new Map();
    for (const e of this.net.edges) {
      e.nBlocks = Math.max(1, Math.round(e.len / BLOCK_LEN));
      e.blockLen = e.len / e.nBlocks;
      e.inF = new Set(); e.inR = new Set();
      e.closedUntil = 0; e.tsr = null; e.tsrUntil = 0; e.absFailUntil = 0;
      // предупреждение, действующее с начала смены (например, путевые работы): { kmh, min }
      if (e.tsrInit) { e.tsr = e.tsrInit.kmh; e.tsrUntil = e.tsrInit.min * 60; }
      if (e.double) {
        const bd = (l) => (typeof e.bidir === 'object' && e.bidir ? !!e.bidir[l] : !!e.bidir);
        const mk = (l) => ({ closedUntil: 0, tsr: null, tsrUntil: 0, absFailUntil: 0, bidir: bd(l), order: null, users: { f: new Set(), r: new Set() } });
        e.trk = { f: mk('f'), r: mk('r') };
      }
      this.edgeMap.set(e.id, e);
    }
    this.res = new Map();
    if (this.routeMode) this.setupThroats();
    this.t = 0;
    this.trains = [];
    this.trainMap = new Map();
    this.events = [];
    this.assistLog = [];
    this.assistant = opts.assistant || null;
    this.assistInterval = 1;
    this.nextAssist = 0;
    this.memory = {};
    // Рекомендации ассистента: 'auto' — исполняются сразу (как раньше), 'confirm' — ждут решения диспетчера.
    // Удержания с пометкой safety (защита от тупика, закрытый перегон) исполняются сразу в любом режиме.
    this.approval = opts.approval || 'auto';
    this.recs = []; this.recByKey = new Map(); this.recSeq = 1; this.onRec = opts.onRec || null;
    this.label = opts.label || '';
    this.m = { deadlocks: 0, unplanned: 0, energy: 0, completed: 0, onTime: 0, arrDelaySum: 0,
      holds: 0, reroutes: 0, advices: 0, errors: 0, redWait: 0, hist: [] };
    this.deadSigs = new Set();
    this.ord = 0;
    this.lastDeadCheck = 0; this.lastHist = -999;
    for (const sp of specs) this.addTrain(sp);
  }

  ev(text, kind = 'info') {
    this.events.push({ t: this.t, text, kind });
    if (this.events.length > 400) this.events.shift();
  }
  alog(text, kind = 'info') {
    const last = this.assistLog[this.assistLog.length - 1];
    if (last && last.text === text && this.t - last.t < 30) return;
    this.assistLog.push({ t: this.t, text, kind });
    if (this.assistLog.length > 400) this.assistLog.shift();
  }
  getRes(key, cap) {
    let r = this.res.get(key);
    if (!r) { r = { cap, occ: new Set() }; this.res.set(key, r); }
    return r;
  }
  edgeV(e, lane, dir) {
    let v = e.vmax;
    if (e.tsr && this.t < e.tsrUntil) v = Math.min(v, e.tsr);
    if (this.t < e.absFailUntil) v = Math.min(v, 20);
    if (e.double && lane && e.trk[lane]) {
      const k = e.trk[lane];
      if (k.tsr && this.t < k.tsrUntil) v = Math.min(v, k.tsr);
      if (this.t < k.absFailUntil) v = Math.min(v, 20);
      if (dir && lane !== dir && k.order && k.order.vmax) v = Math.min(v, k.order.vmax);
    }
    return v;
  }
  resV(tr, i) {
    const r = tr.seq[i];
    if (r.kind === 'node') return (r.invite ? Math.min(r.vmax, INVITE_VMAX) : r.vmax) / 3.6;
    return this.edgeV(this.edgeMap.get(r.edgeId), r.lane || r.dir, r.dir) / 3.6;
  }
  trackClosed(e, lane) { return this.t < e.closedUntil || (e.double && this.t < e.trk[lane].closedUntil); }
  // какой путь двухпутного перегона займёт поезд: свой, а если он закрыт — соседний
  chooseLane(e, dir) {
    this.laneWhy = null;
    if (!e.double) return 's';
    if (!this.trackClosed(e, dir)) return dir;
    const o = dir === 'f' ? 'r' : 'f';
    const N = TRACK_NAME[dir], M = TRACK_NAME[o];
    if (this.trackClosed(e, o)) { this.laneWhy = `оба пути перегона ${this.edgeName(e)} закрыты`; return null; }
    const k = e.trk[o];
    if (!k.order) { this.laneWhy = `путь ${N} закрыт; движение по пути ${M} в обе стороны не организовано (нет приказа)`; return null; }
    const dep = this.nodeMap.get(dir === 'f' ? e.a : e.b), arr = this.nodeMap.get(dir === 'f' ? e.b : e.a);
    if (!dep.crossovers) { this.laneWhy = `на ст. ${dep.name} нет съезда для выхода на путь ${M}`; return null; }
    if (!arr.crossovers) { this.laneWhy = `на ст. ${arr.name} нет съезда для приёма с пути ${M}`; return null; }
    return o;
  }
  laneOf(tr, q) {
    if (q.lane) return q.lane;
    const e = this.edgeMap.get(q.edgeId);
    if (!e.double) return 's';
    if (q.first) return this.chooseLane(e, q.dir);
    // остальные блоки — тот же путь, что выбран на входе в перегон
    for (let i = tr.seq.indexOf(q) - 1; i >= 0; i--) { const p = tr.seq[i]; if (p.kind !== 'block' || p.pi !== q.pi) break; if (p.lane) return p.lane; }
    return q.dir;
  }
  keyOf(tr, q) {
    if (q.kind !== 'block') return q.key;
    const e = this.edgeMap.get(q.edgeId);
    if (!e.double) return q.key;
    const lane = this.laneOf(tr, q) || q.dir;
    return `B:${e.id}:${lane}:${q.phys}`;
  }

  // ---------- поезда ----------
  addTrain(sp) {
    const ty = TRAIN_TYPES[sp.type] || TRAIN_TYPES.passenger;
    const tr = {
      id: sp.id, name: sp.name, type: sp.type, ty, spec: sp, from: sp.from, to: sp.to,
      dep: sp.dep, prio: ty.prio, state: 'pending', v: 0, s: 0, hold: null, speedCap: null, capReason: null, manualCap: null,
      brokenUntil: 0, extraDelay: 0, extraDwell: 0, stopFlag: false, waitReason: null, waitFor: [],
      waitSince: null, deadlock: false, energy: 0, ord: this.ord++, lastDep: -1, stopIdx: -1,
      dwellUntil: 0, unplanned: 0, arrDelay: null, finalArrived: false, resAt: [],
    };
    const p = findPath(this.net, sp.from, sp.to);
    if (!p || p.nodes.length < 2) { tr.state = 'invalid'; this.ev(`${sp.name}: маршрут не найден`, 'warn'); }
    else this.setPath(tr, p, 0, null);
    this.trains.push(tr); this.trainMap.set(tr.id, tr);
    return tr;
  }

  buildSeq(tr, nodes, edges) {
    const seq = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = this.nodeMap.get(nodes[i]);
      const st = n.type === 'station';
      const last = i === nodes.length - 1;
      const stop = st && (i === 0 || last || tr.spec.stops === 'all');
      seq.push({ kind: 'node', nodeId: n.id, key: 'N:' + n.id, cap: st ? Math.max(1, n.tracks | 0) : (this.routeMode ? 16 : 1),
        len: st ? (this.routeMode ? (n.usefulLen || USEFUL_LEN) + 2 * THROAT_LEN : STATION_LEN) : JUNCTION_LEN, vmax: st ? (stop ? 60 : 100) : 80, stop, station: st, pi: i });
      if (!last) {
        const e = edges[i];
        const dir = e.a === n.id ? 'f' : 'r';
        for (let k = 0; k < e.nBlocks; k++) {
          const phys = dir === 'f' ? k : e.nBlocks - 1 - k;
          seq.push({ kind: 'block', edgeId: e.id, dir, phys, ord: k, n: e.nBlocks,
            key: e.double ? `B:${e.id}:${dir}:${phys}` : `B:${e.id}:s:${phys}`, cap: 1,
            len: e.blockLen, vmax: e.vmax, first: k === 0, last: k === e.nBlocks - 1, pi: i });
        }
      }
    }
    return seq;
  }

  // ---------- прогноз движения (та же физика, что в advance) ----------
  // Прогон одного поезда вперёд без влияния других поездов.
  //  opt.openAt — момент, когда откроется сигнал в конце заданного сейчас маршрута (null — не откроется);
  //  opt.cap, opt.capEndS — ограничение скорости, км/ч, пока голова не прошла координату capEndS;
  //  opt.toS — до какой координаты считать; opt.marks — [{s}] точки, для которых нужно время прохода.
  predict(tr, opt = {}) {
    const ty = tr.ty, dt = 0.5;
    let s = tr.s, v = tr.v, t = this.t, E = 0;
    if (tr.state === 'pending' || tr.state === 'done') return null;
    let after = tr.lastDep;
    if (tr.state === 'dwell') { t += Math.max(0, tr.dwellUntil - this.t); after = tr.stopIdx; v = 0; }
    let ns = -1;
    for (let i = after + 1; i < tr.seq.length; i++) if (tr.seq[i].kind === 'node' && tr.seq[i].stop) { ns = i; break; }
    const stopS = ns !== -1 ? this.stopPos(tr, ns) : Infinity;
    // «стена» до момента открытия: точка конфликта (если задана), иначе конец заданного маршрута
    const authEnd = opt.wallS != null ? opt.wallS : this.stopPos(tr, tr.resIdx);
    const toS = Math.min(opt.toS ?? authEnd + 3000, stopS);
    const marks = (opt.marks || []).map((m) => ({ s: m.s, t: m.s <= s ? t : null }));
    let stopSec = 0, minV = Infinity, hi = tr.headIdx;
    const H = (opt.horizon || 3600) / dt;
    for (let k = 0; k < H && s < toS - 0.5; k++) {
      const open = opt.openAt != null && t >= opt.openAt;
      const target = Math.min(open ? Infinity : authEnd, stopS, toS + 5000);
      while (hi < tr.seq.length - 1 && s > tr.starts[hi] + tr.seq[hi].len) hi++;
      // собственный действующий совет поезда учитывается, если прогноз не задаёт другой
      const ownCap = opt.cap == null && tr.speedCap != null && (tr.capEndS == null || s < tr.capEndS) ? tr.speedCap : Infinity;
      let vlim = Math.min(ty.vmax, tr.manualCap ?? Infinity, ownCap, opt.cap && s < (opt.capEndS ?? Infinity) ? opt.cap : Infinity) / 3.6;
      for (let i = hi; i >= 0 && tr.starts[i] + tr.seq[i].len > s - ty.len; i--) vlim = Math.min(vlim, this.resV(tr, i));
      let vAhead = Infinity;
      for (let i = hi + 1; i < tr.seq.length && tr.starts[i] - s < 6000; i++) {
        const d = tr.starts[i] - s - (tr.seq[i].invite ? 10 : 0), vr = this.resV(tr, i);
        vAhead = Math.min(vAhead, Math.sqrt(vr * vr + 2 * ty.dec * Math.max(0, d)));
      }
      const d = target - s, vStop = d > 0 ? Math.sqrt(2 * ty.dec * 0.9 * d) : 0;
      const vt = Math.min(vlim, vAhead, vStop), v0 = v;
      if (v < vt) v = Math.min(vt, v + ty.acc * Math.max(0.25, 1 - v / ((ty.vmax / 3.6) * 1.15)) * dt);
      else v = Math.max(vt, v - ty.dec * 1.3 * dt);
      let ds = ((v0 + v) / 2) * dt;
      if (s + ds >= target - 0.3) { ds = Math.max(0, target - s); v = 0; }
      if (v > v0) E += (ty.mass * 1000 * (v * v - v0 * v0)) / 2 / 0.85 / 3.6e6;
      E += (ty.mass * 1000 * 0.0022 * 9.81 * ds) / 0.85 / 3.6e6;
      s += ds; t += dt;
      if (v === 0 && target < stopS) { stopSec += dt; if (!open && opt.openAt == null) break; }
      if (opt.minVUntil != null && s < opt.minVUntil) minV = Math.min(minV, v);
      for (const m of marks) if (m.t === null && s >= m.s) m.t = t;
    }
    return { t, s, stopSec, E, marks, minV: minV === Infinity ? null : minV * 3.6, reached: s >= toS - 0.5 };
  }
  // Когда освободится однопутный перегон (или путь при движении в обе стороны) в сторону узла nodeId:
  // по моменту, когда ХВОСТ последнего встречного поезда сойдёт с последнего блок-участка.
  clearTime(edgeId, nodeId) {
    const e = this.edgeMap.get(edgeId); if (!e) return null;
    const towardF = e.b === nodeId; // встречные идут к nodeId
    const set = towardF ? e.inF : e.inR;
    const res = { clearAt: this.t, trains: [] };
    // встречные по порядку: ближний к узлу первым; следующий за ним не войдёт на станцию,
    // пока передний не освободит горловину (интервал попутного следования)
    const list = [];
    for (const id of set) {
      const o = this.trainMap.get(id); if (!o || o.state === 'done') continue;
      let j = -1;
      for (let i = o.seq.length - 1; i >= 0; i--) { const q = o.seq[i]; if (q.kind === 'block' && q.edgeId === edgeId && q.last) { j = i; break; } }
      if (j < 0) continue;
      // точка освобождения: хвост сошёл с последнего блок-участка, а в режиме горловин — прошёл и горловину приёма
      const nq = o.seq[j + 1];
      const extra = this.routeMode && nq && nq.kind === 'node' ? THROAT_LEN : 0;
      const tailClearS = o.starts[j] + o.seq[j].len + extra + o.ty.len;
      list.push({ o, tailClearS, left: tailClearS - o.s });
    }
    list.sort((x, y) => x.left - y.left);
    let prev = this.t;
    for (const { o, tailClearS } of list) {
      const p = this.predict(o, { openAt: prev, toS: tailClearS + 1, marks: [{ s: tailClearS }], horizon: 5400 });
      const tt = p && p.marks[0].t;
      // прогноз ненадёжен, если встречный стоит (ждёт сигнала), задержан или неисправен
      const uncertain = !!(o.hold || this.t < o.brokenUntil || (o.v < 1 && o.waitReason && prev === this.t));
      res.trains.push({ id: o.id, at: tt, uncertain });
      if (tt == null) { res.clearAt = null; break; }
      res.clearAt = Math.max(res.clearAt, tt);
      prev = tt;
    }
    return res;
  }
  // Режим подхода к станции nodeId: можно ли, снизив скорость, подойти к выходному сигналу к моменту
  // освобождения перегона за ней и не останавливаться. Результат кешируется на 10 с.
  planApproach(tr, nodeId) {
    this.planCache = this.planCache || new Map();
    const ck = tr.id + '|' + nodeId, c = this.planCache.get(ck);
    if (c && this.t - c.t < 10) return c.r;
    const r = this._planApproach(tr, nodeId);
    this.planCache.set(ck, { t: this.t, r });
    return r;
  }
  _planApproach(tr, nodeId) {
    if (tr.state !== 'running') return null;
    let i = -1;
    for (let k = tr.headIdx + 1; k < tr.seq.length; k++) if (tr.seq[k].kind === 'node' && tr.seq[k].nodeId === nodeId) { i = k; break; }
    if (i < 0 || tr.seq[i].stop || i >= tr.seq.length - 1) return null;
    const nb = tr.seq[i + 1]; if (nb.kind !== 'block') return null;
    const e = this.edgeMap.get(nb.edgeId);
    const single = !e.double || this.trackClosed(e, 'f') || this.trackClosed(e, 'r');
    if (!single) return null;
    const ct = this.clearTime(e.id, nodeId);
    if (!ct || !ct.trains.length) return null;
    if (ct.clearAt == null) return { nodeId, conflict: e.id, clearAt: null, trains: ct.trains, needStop: true };
    // прогноз надёжен, только если встречный идёт свободно, а до сигнала недалеко
    const far = this.stopPos(tr, i) - tr.s > PLAN_MAX_DIST || ct.clearAt - this.t > PLAN_MAX_CLEAR;
    const curAdv = tr.speedCap != null && tr.capInfo && tr.capInfo.untilNode === nodeId;
    if (!curAdv && (far || ct.trains.some((x) => x.uncertain))) return { nodeId, conflict: e.id, clearAt: ct.clearAt, trains: ct.trains, needStop: false, uncertain: true };
    const P = this.stopPos(tr, i), Q = P + 2000;
    const clearAt = ct.clearAt; // маршрут отправления задаётся сразу после освобождения (время приготовления маршрута в модели не учитывается)
    const base = this.predict(tr, { openAt: clearAt, wallS: P, toS: Q, marks: [{ s: P }, { s: Q }] });
    const out = { nodeId, conflict: e.id, P, distM: Math.round(P - tr.s), clearAt, trains: ct.trains,
      base: { passP: base.marks[0].t, tQ: base.marks[1].t, stopSec: base.stopSec, E: base.E } };
    // совет уже выполняется: сохраняем его, пока он ведёт к проследованию без остановки
    const cur = tr.speedCap != null && tr.capInfo && tr.capInfo.untilNode === nodeId ? tr.speedCap : null;
    if (cur != null) {
      const keep = this.predict(tr, { openAt: clearAt, wallS: P, cap: cur, capEndS: P, toS: Q, marks: [{ s: P }, { s: Q }], minVUntil: P });
      if (keep.stopSec === 0) {
        out.needStop = false; out.best = { kmh: cur, passP: keep.marks[0].t, tQ: keep.marks[1].t, E: keep.E, minV: keep.minV };
        out.savedSec = Math.max(0, Math.round(base.marks[1].t - keep.marks[1].t)); out.savedKWh = Math.round(base.E - keep.E);
        out.brakeStartM = Math.round(P - (cur / 3.6) ** 2 / (2 * tr.ty.dec) - tr.s); out.keep = true;
        return out;
      }
    }
    if (base.stopSec === 0 && cur == null) { out.needStop = false; out.noConflict = true; return out; }
    const vNow = Math.min(tr.ty.vmax, tr.manualCap ?? Infinity, cur ?? Infinity);
    let best = null;
    for (let vc = Math.floor(vNow / 5) * 5 - 5; vc >= 25; vc -= 5) {
      const p = this.predict(tr, { openAt: clearAt, wallS: P, cap: vc, capEndS: P, toS: Q, marks: [{ s: P }, { s: Q }], minVUntil: P });
      if (p.stopSec > 0) continue;
      if (p.marks[0].t - base.marks[0].t > 600) continue; // недопустимо долгое движение с пониженной скоростью
      if (!best || p.marks[1].t < best.tQ - 0.01) best = { kmh: vc, passP: p.marks[0].t, tQ: p.marks[1].t, E: p.E, minV: p.minV };
    }
    if (!best) {
      out.needStop = true;
      // совет уже выполняется, а остановки не избежать: продолжаем пониженную скорость —
      // стоянка у сигнала будет короче, а лишнего разгона перед ней не будет
      if (cur != null) {
        const keep = this.predict(tr, { openAt: clearAt, wallS: P, cap: cur, capEndS: P, toS: Q, marks: [{ s: P }, { s: Q }], minVUntil: P });
        out.best = { kmh: cur, passP: keep.marks[0].t, tQ: keep.marks[1].t, E: keep.E, minV: keep.minV, stopSec: keep.stopSec };
        out.keep = true; out.savedSec = Math.round(base.marks[1].t - keep.marks[1].t); out.savedKWh = Math.round(base.E - keep.E);
      }
      return out;
    }
    out.needStop = false; out.best = best;
    out.savedSec = Math.round(base.marks[1].t - best.tQ);
    out.savedKWh = Math.round(base.E - best.E);
    // если сигнал не откроется к этой точке — торможение до остановки (тормозной путь со скорости совета)
    out.brakeStartM = Math.round(P - (best.kmh / 3.6) ** 2 / (2 * tr.ty.dec) - tr.s);
    return out;
  }
  // Показание ближайшего сигнала по ходу: по числу свободных блок-участков в заданном маршруте
  aspect(tr) {
    if (tr.state !== 'running' && tr.state !== 'dwell') return null;
    if (tr.resIdx >= tr.seq.length - 1) return 'green';
    let free = 0;
    for (let i = tr.headIdx + 1; i <= tr.resIdx; i++) if (tr.seq[i].kind === 'block') free++;
    return free >= 2 ? 'green' : free === 1 ? 'yellow' : 'red';
  }

  // keep: число элементов seq, которые сохраняются (при перемаршрутизации)
  setPath(tr, p, keepCount, keepNodes) {
    const ty = tr.ty;
    let nodes = p.nodes, edges = p.edges;
    let seq;
    if (keepCount > 0) {
      const kept = tr.seq.slice(0, keepCount);
      const fresh = this.buildSeq(tr, nodes, edges);
      const lastKept = kept[kept.length - 1];
      fresh[0] = { ...fresh[0], stop: lastKept.stop };
      const offset = lastKept.pi;
      for (const r of fresh) r.pi += offset;
      seq = kept.concat(fresh.slice(1));
      tr.pathNodes = keepNodes.concat(nodes.slice(1));
      tr.pathEdges = tr.pathEdges.slice(0, offset).concat(edges.map((e) => e.id));
    } else {
      seq = this.buildSeq(tr, nodes, edges);
      tr.pathNodes = nodes.slice();
      tr.pathEdges = edges.map((e) => e.id);
    }
    tr.seq = seq;
    tr.starts = [];
    let acc = 0;
    for (const r of seq) { tr.starts.push(acc); acc += r.len; }
    // график (идеальное время хода + 6% запас)
    const oldFinal = tr.schedArr ? tr.schedArr[tr.schedArr.length - 1] : null;
    const tS = new Array(seq.length), tE = new Array(seq.length), arr = new Array(seq.length);
    let T;
    const from = keepCount > 0 ? keepCount - 1 : 0;
    if (keepCount > 0) {
      for (let i = 0; i < keepCount; i++) { tS[i] = tr.tS[i]; tE[i] = tr.tE[i]; arr[i] = tr.arr[i]; }
      T = tE[from];
    } else {
      tS[0] = tr.dep - 180; tE[0] = tr.dep; arr[0] = tr.dep; T = tr.dep + 40;
    }
    for (let i = from + 1; i < seq.length; i++) {
      const r = seq[i];
      const v = Math.min(ty.vmax, r.vmax) / 3.6;
      const run = (r.len / v) * 1.06;
      tS[i] = T;
      if (r.kind === 'node' && r.stop) {
        arr[i] = T + run + 30;
        tE[i] = arr[i] + (i === seq.length - 1 ? 0 : ty.dwell || 60);
        T = tE[i] + 40;
      } else { tE[i] = T + run; T = tE[i]; }
    }
    if (keepCount > 0 && oldFinal != null) arr[seq.length - 1] = Math.max(oldFinal, Math.min(arr[seq.length - 1], oldFinal));
    tr.tS = tS; tr.tE = tE; tr.arr = arr;
    tr.schedArr = arr.filter((x, i) => seq[i].kind === 'node' && seq[i].stop);
    tr.schedFinal = arr[seq.length - 1];
  }

  // остановка у выходного сигнала: в режиме горловин он стоит перед выходной горловиной
  stopPos(tr, i) { const q = tr.seq[i]; return tr.starts[i] + q.len - SIGNAL_MARGIN - (this.routeMode && q.kind === 'node' && q.station ? THROAT_LEN : 0); }
  nextStopIdx(tr) {
    for (let i = tr.lastDep + 1; i < tr.seq.length; i++) if (tr.seq[i].kind === 'node' && tr.seq[i].stop) return i;
    return -1;
  }

  // ---------- горловины ----------
  setupThroats() {
    const P = (id) => this.nodeMap.get(id);
    for (const n of this.net.nodes) { n.ends = {}; n.throat = { W: [], E: [] }; }
    for (const e of this.net.edges) {
      const A = P(e.a), B = P(e.b);
      const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1, ny = dx / L;
      for (const [n, o] of [[A, B], [B, A]]) {
        const side = o.x < n.x || (o.x === n.x && o.y < n.y) ? 'W' : 'E';
        const base = Math.max(-1, Math.min(1, (o.y - n.y) / Math.max(1, Math.abs(o.x - n.x)))) * 3;
        n.ends[e.id] = { side, base, sgn: ny >= 0 ? 1 : -1 };
      }
    }
    for (const n of this.net.nodes) {
      if (n.type !== 'station') continue;
      const dbl = this.net.edges.find((e) => e.double && (e.a === n.id || e.b === n.id));
      const T = Math.max(1, n.tracks | 0);
      n.trackPos = []; n.trackName = []; n.trackMain = [];
      if (dbl) {
        const pI = 0.5 * n.ends[dbl.id].sgn, pII = -pI;
        for (let k = 0; k < T; k++) {
          if (k === 0) n.trackPos.push(pI); else if (k === 1) n.trackPos.push(pII);
          else { const lvl = Math.floor(k / 2); n.trackPos.push(k % 2 === 0 ? pI + Math.sign(pI) * lvl : pII + Math.sign(pII) * lvl); }
          n.trackName.push(k === 0 ? 'I' : k === 1 ? 'II' : String(k + 1));
          n.trackMain.push(k === 0 ? 'f' : k === 1 ? 'r' : null);
        }
        n.mainDirEdge = dbl.id;
      } else {
        for (let k = 0; k < T; k++) { n.trackPos.push(k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.ceil(k / 2)); n.trackName.push(String(k + 1)); n.trackMain.push(k === 0 ? 's' : null); }
      }
      n.trackOcc = new Array(T).fill(null);
    }
  }
  // поперечная координата пути перегона в горловине узла
  lanePos(n, e, lane) {
    const end = n.ends[e.id];
    return end.base + (lane === 'f' ? 0.5 : lane === 'r' ? -0.5 : 0) * end.sgn;
  }
  routesConflict(A, B) {
    if (A.p === B.p) return true;
    const a0 = Math.min(A.p, A.q), a1 = Math.max(A.p, A.q), b0 = Math.min(B.p, B.q), b1 = Math.max(B.p, B.q);
    if (Math.max(a0, b0) < Math.min(a1, b1)) return true;
    if (a0 === a1 && a0 > b0 && a0 < b1) return true;
    if (b0 === b1 && b0 > a0 && b0 < a1) return true;
    return false;
  }
  // маршрут через стрелочную зону без съезда не может переходить через встречный главный путь того же перегона
  crossesOtherMain(n, side, p, q) {
    if (n.crossovers !== false) return false;
    for (const e of this.net.edges) {
      if (!e.double || !n.ends[e.id] || n.ends[e.id].side !== side) continue;
      for (const ln of ['f', 'r']) { const x = this.lanePos(n, e, ln); if (x !== p && x > Math.min(p, q) && x < Math.max(p, q)) return true; }
    }
    return false;
  }
  throatBlockers(n, side, R, self) {
    const out = [];
    for (const o of n.throat[side]) if (o.tr !== self && this.routesConflict(R, o)) out.push(o);
    return out;
  }
  // съезд/вход на станцию с предыдущего блока: координата входа
  entryInfo(tr, i) {
    const n = this.nodeMap.get(tr.seq[i].nodeId);
    const pb = tr.seq[i - 1];
    if (!pb || pb.kind !== 'block') return null;
    const e = this.edgeMap.get(pb.edgeId);
    return { side: n.ends[e.id].side, p: this.lanePos(n, e, pb.lane || this.laneOf(tr, pb) || pb.dir) };
  }
  exitInfo(tr, i) {
    const n = this.nodeMap.get(tr.seq[i].nodeId);
    const nb = tr.seq[i + 1];
    if (!nb || nb.kind !== 'block') return null;
    const e = this.edgeMap.get(nb.edgeId);
    const lane = nb.lane || (e.double ? this.chooseLane(e, nb.dir) || nb.dir : 's');
    return { side: n.ends[e.id].side, p: this.lanePos(n, e, lane) };
  }
  // выбор станционного пути для приёма: свободный, с невраждебным маршрутом, без лишних пересечений
  pickTrack(tr, i, forSpawn) {
    const q = tr.seq[i], n = this.nodeMap.get(q.nodeId);
    const inn = forSpawn ? null : this.entryInfo(tr, i), out = this.exitInfo(tr, i);
    const through = !q.stop;
    let best = null, bestCost = Infinity, blockers = [], anyFree = false;
    const pref = tr.prefTrack && tr.prefTrack.node === n.id ? tr.prefTrack.track : null;
    for (let k = 0; k < n.trackPos.length; k++) {
      if (n.trackOcc[k] !== null && n.trackOcc[k] !== tr.id) continue;
      anyFree = true;
      const qp = n.trackPos[k];
      if (inn && this.crossesOtherMain(n, inn.side, inn.p, qp)) continue;
      if (out && this.crossesOtherMain(n, out.side, out.p, qp)) continue;
      let cost = (inn ? Math.abs(qp - inn.p) : 0) + (out ? Math.abs(qp - out.p) : 0);
      const main = n.trackMain[k] !== null;
      if (through && !main) cost += 1.5;
      if (!through && main && tr.type === 'freight') cost += 1.5;
      if (pref === k) cost -= 100;
      if (inn) {
        const bl = this.throatBlockers(n, inn.side, { p: inn.p, q: qp }, tr.id);
        if (bl.length) { blockers.push(...bl); continue; }
      }
      if (cost < bestCost) { bestCost = cost; best = k; }
    }
    return { track: best, blockers, anyFree, n, inn };
  }
  routeName(o) { return `${o.kind === 'in' ? 'приём' : o.kind === 'out' ? 'отправление' : 'проследование'} ${this.trainMap.get(o.tr).name}`; }
  throatWait(tr, n, blockers, what) {
    const uniq = [...new Map(blockers.map((b) => [b.tr, b])).values()];
    tr.waitReason = `${what}: враждебный маршрут в горловине ${n.type === 'station' ? 'ст.' : 'поста'} ${n.name} (${uniq.map((b) => this.routeName(b)).join(', ')})`;
    tr.waitFor = uniq.map((b) => b.tr); tr.waitMode = 'and';
    return 1;
  }
  // проверка маршрута через узел (вызов из blockedReason для узла)
  nodeRouteCheck(tr, nx) {
    const i = tr.seq.indexOf(nx), n = this.nodeMap.get(nx.nodeId);
    if (n.type === 'station') {
      const r = this.pickTrack(tr, i, false);
      if (r.track !== null) { nx._pick = r.track; return 0; }
      if (r.blockers.length) return this.throatWait(tr, n, r.blockers, 'приём');
      if (r.anyFree) { tr.waitReason = `свободные пути ст. ${n.name} недоступны без съезда`; tr.waitFor = []; return 1; }
      return 0; // нет свободных путей — сработает обычная проверка вместимости
    }
    // стрелочный пост: маршрут от входа до выхода
    const inn = this.entryInfo(tr, i), out = this.exitInfo(tr, i);
    if (!inn || !out) return 0;
    const R = this.jRoute(inn, out);
    if (n.crossovers === false && this.crossesOtherMainJ(n, inn, out)) { tr.waitReason = `на посту ${n.name} нет съезда для перехода на другой путь`; tr.waitFor = []; return 1; }
    const bl = (n.jroutes || []).filter((o) => o.tr !== tr.id && this.jConflict(R, o));
    if (bl.length) return this.throatWait(tr, n, bl, 'проследование');
    nx._jr = R; return 0;
  }
  jRoute(inn, out) { const W = inn.side === 'W' ? inn.p : out.p, E = inn.side === 'W' ? out.p : inn.p; return { pW: W, pE: E }; }
  jConflict(A, B) { return A.pW === B.pW || A.pE === B.pE || (A.pW - B.pW) * (A.pE - B.pE) < 0; }
  crossesOtherMainJ(n, inn, out) { return Math.abs(inn.p - out.p) === 1 && Math.abs(Math.round(inn.p * 2)) === 1 && Math.abs(Math.round(out.p * 2)) === 1; }
  // маршрут отправления со станционного пути (вызов при задании первого блока после станции)
  departCheck(tr, nx) {
    const i = tr.seq.indexOf(nx) - 1, q = tr.seq[i];
    if (!q || q.kind !== 'node' || q.track == null) return 0;
    const n = this.nodeMap.get(q.nodeId);
    if (n.type !== 'station') return 0;
    const out = this.exitInfo(tr, i);
    if (!out) return 0;
    const qp = n.trackPos[q.track];
    if (this.crossesOtherMain(n, out.side, out.p, qp)) { tr.waitReason = `с пути ${n.trackName[q.track]} ст. ${n.name} нет съезда на нужный путь перегона`; tr.waitFor = []; return 1; }
    const bl = this.throatBlockers(n, out.side, { p: out.p, q: qp }, tr.id);
    if (bl.length) return this.throatWait(tr, n, bl, 'отправление');
    nx._out = { side: out.side, p: out.p, q: qp };
    return 0;
  }
  commitNode(tr, q) {
    const n = this.nodeMap.get(q.nodeId), i = tr.seq.indexOf(q);
    if (n.type === 'station') {
      const k = q._pick != null ? q._pick : this.pickTrack(tr, i, false).track;
      if (k == null) return;
      q.track = k; n.trackOcc[k] = tr.id;
      const inn = this.entryInfo(tr, i);
      if (inn) { q.inRoute = { tr: tr.id, kind: 'in', side: inn.side, p: inn.p, q: n.trackPos[k] }; n.throat[inn.side].push(q.inRoute); }
    } else if (q._jr) {
      q.jr = { tr: tr.id, kind: 'pass', ...q._jr }; (n.jroutes || (n.jroutes = [])).push(q.jr);
    }
  }
  commitDepart(tr, nx) {
    const q = tr.seq[tr.seq.indexOf(nx) - 1];
    if (!nx._out || !q) return;
    const n = this.nodeMap.get(q.nodeId);
    q.outRoute = { tr: tr.id, kind: 'out', ...nx._out }; n.throat[nx._out.side].push(q.outRoute);
  }
  dropRoute(n, R) { if (!R) return; const L = n.throat[R.side]; const j = L.indexOf(R); if (j >= 0) L.splice(j, 1); }
  releaseNodeRoutes(tr, q) {
    const n = this.nodeMap.get(q.nodeId);
    if (n.type === 'station') {
      this.dropRoute(n, q.inRoute); q.inRoute = null;
      this.dropRoute(n, q.outRoute); q.outRoute = null;
      if (q.track != null && n.trackOcc[q.track] === tr.id) n.trackOcc[q.track] = null;
    } else if (q.jr && n.jroutes) { const j = n.jroutes.indexOf(q.jr); if (j >= 0) n.jroutes.splice(j, 1); q.jr = null; }
  }

  trySpawn(tr) {
    const departT = tr.dep + tr.extraDelay;
    if (this.t < Math.max(0, departT - 180)) return;
    const r0 = tr.seq[0];
    const res = this.getRes(r0.key, r0.cap);
    let inbound = 0;
    for (const o of this.trains) {
      if (o.state !== 'running' && o.state !== 'dwell') continue;
      const f = o.seq[o.resIdx];
      if (f.kind === 'block' && o.pathNodes[f.pi + 1] === r0.nodeId) inbound++;
    }
    if (res.occ.size + inbound >= res.cap) {
      tr.waitReason = `нет свободного пути на ст. отправления`;
      tr.waitFor = [...res.occ]; tr.waitMode = 'or';
      return;
    }
    if (this.routeMode && r0.station) {
      const pk = this.pickTrack(tr, 0, true);
      if (pk.track == null) { tr.waitReason = `нет свободного пути на ст. отправления`; tr.waitFor = [...res.occ]; tr.waitMode = 'or'; return; }
      r0.track = pk.track; pk.n.trackOcc[pk.track] = tr.id;
    }
    res.occ.add(tr.id);
    tr.headIdx = tr.tailIdx = tr.resIdx = 0;
    tr.resAt = [this.t];
    tr.s = this.stopPos(tr, 0);
    tr.state = 'dwell'; tr.stopIdx = 0; tr.lastDep = -1;
    tr.dwellUntil = Math.max(this.t + 60, departT);
    tr.waitReason = null; tr.waitFor = [];
    this.ev(`${tr.name} подан на ст. ${this.nodeMap.get(tr.from).name}`);
  }

  acquire(tr) {
    const ty = tr.ty;
    const need = (tr.v * tr.v) / (2 * ty.dec) + 2500;
    tr.waitReason = null; tr.waitFor = [];
    while (tr.resIdx < tr.seq.length - 1) {
      const cur = tr.seq[tr.resIdx];
      const endRes = tr.starts[tr.resIdx] + cur.len;
      if (endRes - tr.s > need) break;
      if (cur.kind === 'node') {
        if (cur.stop && tr.lastDep < tr.resIdx) break; // маршрут отправления задаётся после стоянки
        if (cur.station && tr.hold) { tr.waitReason = 'задержан ассистентом: ' + tr.hold.reason; break; }
        if (cur.station && this.assistant && this.t - (tr.resAt[tr.resIdx] ?? 0) < this.assistInterval + 0.01) break;
      }
      // маршрут через стрелочный пост задаётся целиком: на посту останавливаться нельзя
      const nx = tr.seq[tr.resIdx + 1];
      let take = 1;
      if (nx.kind === 'node' && !nx.station && tr.resIdx + 2 < tr.seq.length) take = 2;
      // неправильный путь без двусторонней АБ: перегон и путь приёма задаются сразу целиком
      if (nx.kind === 'block' && nx.first) {
        const e = this.edgeMap.get(nx.edgeId);
        if (e.double) {
          const ln = this.chooseLane(e, nx.dir);
          if (ln && ln !== nx.dir && !e.trk[ln].bidir && tr.resIdx + nx.n + 1 < tr.seq.length) take = nx.n + 1;
        }
      }
      let ok = true;
      for (let j = 1; j <= take; j++) {
        const q = tr.seq[tr.resIdx + j];
        // внутри цельного маршрута по неправильному пути путь уже выбран на входе
        const why = j > 1 && q.kind === 'block' && take > 2 ? (this.getRes(`B:${q.edgeId}:${this.chooseLane(this.edgeMap.get(q.edgeId), q.dir)}:${q.phys}`, 1).occ.size ? 1 : 0) : this.blockedReason(tr, q);
        if (why) { ok = false; break; }
      }
      if (!ok) break;
      for (let j = 1; j <= take; j++) {
        const q = tr.seq[tr.resIdx + 1];
        if (q.kind === 'block') {
          const e = this.edgeMap.get(q.edgeId);
          q.lane = this.laneOf(tr, q) || q.dir;
          q.useKey = this.keyOf(tr, q);
          if (q.first) {
            (q.dir === 'f' ? e.inF : e.inR).add(tr.id);
            if (e.double) {
              e.trk[q.lane].users[q.dir].add(tr.id);
              if (q.lane !== q.dir) this.ev(`${tr.name}: отправлен по пути ${TRACK_NAME[q.lane]} перегона ${this.edgeName(e)} по неправильному пути (${e.trk[q.lane].bidir ? 'по сигналам двусторонней АБ' : 'один поезд на перегоне'})`, 'warn');
            }
          }
          // приём с неправильного пути по пригласительному сигналу
          if (q.last && e.double && q.lane !== q.dir) {
            const nq = tr.seq[tr.resIdx + 2];
            if (nq && nq.kind === 'node' && this.nodeMap.get(nq.nodeId).wrongEntry === 'invite') nq.invite = true;
          }
        } else if (q.invite === undefined) q.invite = false;
        this.getRes(q.useKey || q.key, q.cap).occ.add(tr.id);
        if (this.routeMode) { if (q.kind === 'node') this.commitNode(tr, q); else if (q.first) this.commitDepart(tr, q); }
        tr.resIdx++;
        tr.resAt[tr.resIdx] = this.t;
      }
    }
  }

  blockedReason(tr, nx) {
    const r = this.getRes(this.keyOf(tr, nx), nx.cap);
    if (nx.kind === 'block' && nx.first && this.edgeMap.get(nx.edgeId).double) {
      const e = this.edgeMap.get(nx.edgeId);
      if (this.t < e.closedUntil) { tr.waitReason = `перегон ${this.edgeName(e)} закрыт`; tr.waitFor = []; return 1; }
      const lane = this.chooseLane(e, nx.dir);
      if (!lane) { tr.waitReason = this.laneWhy; tr.waitFor = []; return 1; }
      const k = e.trk[lane], od = nx.dir === 'f' ? 'r' : 'f';
      const wrong = lane !== nx.dir;
      const M = TRACK_NAME[lane];
      if (k.users[od].size > 0) {
        // путь занят поездами другого направления: смена направления невозможна, пока путь не свободен
        tr.waitReason = wrong
          ? `путь ${M} занят поездом правильного направления; направление сменят после его освобождения`
          : `по пути ${M} идёт поезд по неправильному пути`;
        tr.waitFor = [...k.users[od]]; tr.waitMode = 'and'; return 1;
      }
      if (wrong && !k.bidir) {
        // без двусторонней АБ — один поезд на перегоне и только с согласия станции приёма
        if (k.users[nx.dir].size > 0) {
          tr.waitReason = `путь ${M} без двусторонней АБ: по неправильному пути — один поезд на перегоне`;
          tr.waitFor = [...k.users[nx.dir]]; tr.waitMode = 'and'; return 1;
        }
        const ai = tr.seq.indexOf(nx) + nx.n;
        const arrQ = tr.seq[ai];
        if (arrQ && arrQ.kind === 'node') {
          const ar = this.getRes(arrQ.key, arrQ.cap);
          if (ar.occ.size >= ar.cap && !ar.occ.has(tr.id)) {
            tr.waitReason = `нет согласия ст. ${this.nodeMap.get(arrQ.nodeId).name} на приём по пути ${M}: нет свободного пути`;
            tr.waitFor = [...ar.occ]; tr.waitMode = ar.cap > 1 ? 'or' : 'and'; return 1;
          }
        }
      }
      if (this.t < k.absFailUntil && k.users[nx.dir].size > 0) {
        tr.waitReason = `отказ автоблокировки на пути ${TRACK_NAME[lane]}: по перегону только один поезд`;
        tr.waitFor = [...k.users[nx.dir]]; tr.waitMode = 'and'; return 1;
      }
    }
    if (nx.kind === 'block' && nx.first) {
      const e = this.edgeMap.get(nx.edgeId);
      if (this.t < e.closedUntil) { tr.waitReason = `перегон ${this.edgeName(e)} закрыт`; tr.waitFor = []; return 1; }
      const same = nx.dir === 'f' ? e.inF : e.inR, opp = nx.dir === 'f' ? e.inR : e.inF;
      if (!e.double && opp.size > 0) {
        tr.waitReason = 'встречный поезд на однопутном перегоне'; tr.waitFor = [...opp]; tr.waitMode = 'and'; return 1;
      }
      if (this.t < e.absFailUntil && ((e.double ? e.trk[this.chooseLane(e, nx.dir) || nx.dir].users[nx.dir].size : same.size) > 0 || (!e.double && opp.size > 0))) {
        tr.waitReason = 'отказ автоблокировки: по перегону только один поезд'; tr.waitFor = [...same]; tr.waitMode = 'and'; return 1;
      }
    }
    if (this.routeMode && !(r.occ.size >= r.cap && !r.occ.has(tr.id))) {
      if (nx.kind === 'node' && this.nodeRouteCheck(tr, nx)) return 1;
      if (nx.kind === 'block' && nx.first && this.departCheck(tr, nx)) return 1;
    }
    if (r.occ.size >= r.cap && !r.occ.has(tr.id)) {
      tr.waitFor = [...r.occ]; tr.waitMode = r.cap > 1 ? 'or' : 'and';
      tr.waitReason = nx.kind === 'node'
        ? (nx.station ? `нет свободного пути на ст. ${this.nodeMap.get(nx.nodeId).name}` : 'стрелочный пост занят')
        : 'впереди занят блок-участок (красный сигнал)';
      return 1;
    }
    return 0;
  }


  releaseIdx(tr, i) {
    const r = tr.seq[i];
    if (this.routeMode && r.kind === 'node') this.releaseNodeRoutes(tr, r);
    const res = this.res.get(r.useKey || r.key);
    if (res) res.occ.delete(tr.id);
    if (r.kind === 'block' && r.last) {
      const e = this.edgeMap.get(r.edgeId);
      (r.dir === 'f' ? e.inF : e.inR).delete(tr.id);
      if (e.double) for (const ln of ['f', 'r']) e.trk[ln].users[r.dir].delete(tr.id);
    }
  }
  finish(tr) {
    for (let i = tr.tailIdx; i <= tr.resIdx; i++) this.releaseIdx(tr, i);
    tr.state = 'done'; tr.v = 0; tr.hold = null;
    this.ev(`${tr.name} прибыл на конечную ст. ${this.nodeMap.get(tr.to).name}`);
  }

  advance(tr, dt) {
    const ty = tr.ty, t = this.t;
    const broken = t < tr.brokenUntil;
    if (tr.state === 'dwell' && t >= tr.dwellUntil && !broken) {
      if (tr.finalArrived) { this.finish(tr); return; }
      tr.state = 'running'; tr.lastDep = tr.stopIdx;
    }
    this.acquire(tr);
    let target = this.stopPos(tr, tr.resIdx);
    const ns = this.nextStopIdx(tr);
    if (ns !== -1 && ns <= tr.resIdx) target = Math.min(target, this.stopPos(tr, ns));
    if (tr.capEndS != null && tr.s > tr.capEndS) { tr.speedCap = null; tr.capReason = null; tr.capEndS = null; }
    let vlim = Math.min(ty.vmax, tr.speedCap ?? Infinity, tr.manualCap ?? Infinity) / 3.6;
    for (let i = tr.tailIdx; i <= tr.headIdx; i++) vlim = Math.min(vlim, this.resV(tr, i));
    let vAhead = Infinity;
    for (let i = tr.headIdx + 1; i <= tr.resIdx; i++) {
      // перед пригласительным сигналом — запас 10 м, чтобы на светофоре скорость уже была не выше 20 км/ч
      const d = tr.starts[i] - tr.s - (tr.seq[i].invite ? 10 : 0);
      const vr = this.resV(tr, i);
      vAhead = Math.min(vAhead, Math.sqrt(vr * vr + 2 * ty.dec * Math.max(0, d)));
    }
    const d = target - tr.s;
    const vStop = d > 0 ? Math.sqrt(2 * ty.dec * 0.9 * d) : 0;
    let vt = Math.min(vlim, vAhead, vStop);
    if (broken || tr.state === 'dwell') vt = 0;
    const v0 = tr.v;
    if (tr.v < vt) {
      const a = ty.acc * Math.max(0.25, 1 - tr.v / ((ty.vmax / 3.6) * 1.15));
      tr.v = Math.min(vt, tr.v + a * dt);
    } else {
      tr.v = Math.max(vt, tr.v - ty.dec * (broken ? 1.5 : 1.3) * dt);
    }
    let ds = ((v0 + tr.v) / 2) * dt;
    if (tr.state !== 'dwell' && tr.s + ds >= target - 0.3) { ds = Math.max(0, target - tr.s); tr.v = 0; }
    tr.s += ds;
    // энергия: кинетическая + сопротивление движению
    if (tr.v > v0) tr.energy += (ty.mass * 1000 * (tr.v * tr.v - v0 * v0)) / 2 / 0.85 / 3.6e6;
    tr.energy += (ty.mass * 1000 * 0.0022 * 9.81 * ds) / 0.85 / 3.6e6;
    while (tr.headIdx < tr.resIdx && tr.s > tr.starts[tr.headIdx] + tr.seq[tr.headIdx].len) tr.headIdx++;
    const tail = tr.s - ty.len;
    while (tr.tailIdx < tr.headIdx && tail > tr.starts[tr.tailIdx] + tr.seq[tr.tailIdx].len) {
      this.releaseIdx(tr, tr.tailIdx); tr.tailIdx++;
    }
    if (this.routeMode) for (let i = tr.tailIdx; i <= tr.headIdx; i++) {
      const q = tr.seq[i];
      if (q.kind === 'node' && q.inRoute && tail > tr.starts[i] + THROAT_LEN) { this.dropRoute(this.nodeMap.get(q.nodeId), q.inRoute); q.inRoute = null; }
    }
    // прибытие на остановку
    if (tr.state === 'running' && ns !== -1 && tr.headIdx === ns && tr.v === 0 && Math.abs(tr.s - this.stopPos(tr, ns)) < 0.6) {
      tr.state = 'dwell'; tr.stopIdx = ns; tr.stopFlag = false;
      const delay = t - tr.arr[ns];
      tr.arrDelay = delay;
      const st = this.nodeMap.get(tr.seq[ns].nodeId);
      if (ns === tr.seq.length - 1) {
        tr.finalArrived = true;
        tr.dwellUntil = t + 120;
        this.m.completed++;
        this.m.arrDelaySum += Math.max(0, delay);
        if (delay <= 300) this.m.onTime++;
      } else {
        tr.dwellUntil = Math.max(t + (ty.dwell || 60), tr.tE[ns]) + tr.extraDwell;
        tr.extraDwell = 0;
      }
      if (delay > 300) this.ev(`${tr.name} прибыл на ст. ${st.name} с опозданием ${Math.round(delay / 60)} мин`, 'warn');
    }
    // учёт ожидания / вынужденных остановок
    if (tr.state === 'running' && tr.v === 0) {
      if (tr.waitSince == null) tr.waitSince = t;
      if (!tr.stopFlag && !broken) {
        tr.stopFlag = true; tr.unplanned++; this.m.unplanned++;
      }
    } else if (tr.v > 0.5) { tr.stopFlag = false; tr.waitSince = null; }
    else if (tr.state === 'dwell') tr.waitSince = null;
  }

  liveDelay(tr) {
    if (tr.state === 'pending') return Math.max(0, this.t - (tr.dep + 0)) ;
    if (tr.state === 'done' || tr.state === 'invalid') return Math.max(0, tr.arrDelay || 0);
    const i = tr.headIdx;
    const r = tr.seq[i];
    const frac = Math.min(1, Math.max(0, (tr.s - tr.starts[i]) / r.len));
    let sched = tr.tS[i] + frac * (tr.tE[i] - tr.tS[i]);
    if (tr.state === 'dwell') sched = tr.tE[i];
    if (tr.finalArrived) return Math.max(0, tr.arrDelay);
    return Math.max(0, this.t - sched);
  }

  edgeName(e) { return `${this.nodeMap.get(e.a).name} – ${this.nodeMap.get(e.b).name}`; }

  eta(tr, nodeId) {
    if (tr.state === 'done' || tr.state === 'invalid') return null;
    const startIdx = tr.state === 'pending' ? 0 : tr.headIdx;
    let j = -1;
    for (let i = startIdx; i < tr.seq.length; i++) if (tr.seq[i].kind === 'node' && tr.seq[i].nodeId === nodeId) { j = i; break; }
    if (j === -1) return null;
    let T = tr.state === 'pending' ? Math.max(0, tr.dep + tr.extraDelay - this.t) : 0;
    if (tr.state === 'dwell') T += Math.max(0, tr.dwellUntil - this.t);
    if (tr.state !== 'pending' && j === tr.headIdx) return T;
    const s0 = tr.state === 'pending' ? 0 : tr.s;
    for (let i = startIdx; i < j; i++) {
      const r = tr.seq[i];
      const a = Math.max(tr.starts[i], s0), b = tr.starts[i] + r.len;
      if (b <= a) continue;
      const v = (Math.min(tr.ty.vmax, r.vmax) / 3.6) * 0.92;
      T += (b - a) / v;
      if (r.kind === 'node' && r.stop && i > tr.lastDep && i > startIdx) T += tr.ty.dwell || 60;
    }
    return T;
  }

  reroute(tr, nodes) {
    if (!Array.isArray(nodes) || nodes.length < 2) return false;
    if (tr.state === 'done' || tr.state === 'invalid') return false;
    const edges = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const e = this.net.edges.find((x) => (x.a === nodes[i] && x.b === nodes[i + 1]) || (x.b === nodes[i] && x.a === nodes[i + 1]));
      if (!e || !this.nodeMap.has(nodes[i + 1])) return false;
      edges.push(e);
    }
    if (nodes[nodes.length - 1] !== tr.to) return false;
    if (tr.state === 'pending') {
      if (nodes[0] !== tr.from) return false;
      this.setPath(tr, { nodes, edges }, 0, null);
    } else {
      const fr = tr.seq[tr.resIdx];
      if (fr.kind !== 'node' || fr.nodeId !== nodes[0]) return false;
      const same = tr.pathNodes.slice(fr.pi).join(',') === nodes.join(',');
      if (same) return false;
      this.setPath(tr, { nodes, edges }, tr.resIdx + 1, tr.pathNodes.slice(0, fr.pi + 1));
    }
    this.m.reroutes++;
    return true;
  }

  // ---------- конфликты ----------
  breakTrain(id, min) {
    const tr = this.trainMap.get(id); if (!tr || tr.state === 'done') return;
    tr.brokenUntil = this.t + min * 60;
    this.ev(`Неисправность: ${tr.name} остановлен на ${min} мин`, 'bad');
  }
  setManualCap(id, kmh) {
    const tr = this.trainMap.get(id); if (!tr || tr.state === 'done') return;
    tr.manualCap = kmh ? +kmh : null;
    this.ev(kmh ? `Диспетчер: ${tr.name} — не выше ${kmh} км/ч` : `Диспетчер снял ограничение скорости ${tr.name}`, 'warn');
  }
  delayTrain(id, min) {
    const tr = this.trainMap.get(id); if (!tr || tr.state === 'done') return;
    if (tr.state === 'pending') tr.extraDelay += min * 60;
    else if (tr.state === 'dwell') tr.dwellUntil += min * 60;
    else tr.extraDwell += min * 60;
    this.ev(`Задержка: ${tr.name} +${min} мин`, 'warn');
  }
  // track: 'f' | 'r' — один путь двухпутного перегона; иначе весь перегон
  closeEdge(id, min, track) {
    const e = this.edgeMap.get(id); if (!e) return;
    if (e.double && (track === 'f' || track === 'r')) {
      e.trk[track].closedUntil = this.t + min * 60;
      const o = track === 'f' ? 'r' : 'f';
      this.ev(`Путь ${TRACK_NAME[track]} перегона ${this.edgeName(e)} закрыт на ${min} мин`, 'bad');
      return;
    }
    e.closedUntil = this.t + min * 60;
    this.ev(`Перегон ${this.edgeName(e)} закрыт на ${min} мин`, 'bad');
  }
  // приказ диспетчера: движение по пути lane в обе стороны (на время закрытия соседнего пути)
  orderWrongLine(id, lane, vmax) {
    const e = this.edgeMap.get(id);
    if (!e || !e.double || (lane !== 'f' && lane !== 'r')) return { ok: false, why: 'перегон не двухпутный' };
    const o = lane === 'f' ? 'r' : 'f';
    if (this.trackClosed(e, lane)) return { ok: false, why: `путь ${TRACK_NAME[lane]} закрыт` };
    if (!this.trackClosed(e, o)) return { ok: false, why: `путь ${TRACK_NAME[o]} не закрыт — приказ не нужен` };
    const k = e.trk[lane];
    const a = this.nodeMap.get(e.a), b = this.nodeMap.get(e.b);
    for (const n of [a, b]) if (!n.crossovers) return { ok: false, why: `на ст. ${n.name} нет съезда между главными путями` };
    if (!k.bidir && !(+vmax > 0)) return { ok: false, why: 'без двусторонней АБ в приказе нужно указать скорость' };
    k.order = { since: this.t, vmax: k.bidir ? null : +vmax };
    this.ev(`Приказ: движение по пути ${TRACK_NAME[lane]} перегона ${this.edgeName(e)} в обе стороны — ${k.bidir ? 'по сигналам двусторонней АБ' : `один поезд на перегоне${k.order.vmax ? `, не более ${k.order.vmax} км/ч` : ''}`}`, 'warn');
    return { ok: true };
  }
  cancelWrongLine(id, lane) {
    const e = this.edgeMap.get(id); if (!e || !e.double || !e.trk[lane] || !e.trk[lane].order) return;
    e.trk[lane].order = null;
    this.ev(`Приказ отменён: путь ${TRACK_NAME[lane]} перегона ${this.edgeName(e)} — только в правильном направлении`, 'info');
  }
  speedRestrict(id, kmh, min, track) {
    const e = this.edgeMap.get(id); if (!e) return;
    if (e.double && (track === 'f' || track === 'r')) {
      e.trk[track].tsr = kmh; e.trk[track].tsrUntil = this.t + min * 60;
      this.ev(`Предупреждение: путь ${TRACK_NAME[track]} ${this.edgeName(e)} — ${kmh} км/ч на ${min} мин`, 'warn');
      return;
    }
    e.tsr = kmh; e.tsrUntil = this.t + min * 60;
    this.ev(`Предупреждение: ${this.edgeName(e)} — ${kmh} км/ч на ${min} мин`, 'warn');
  }
  absFail(id, min, track) {
    const e = this.edgeMap.get(id); if (!e) return;
    if (e.double && (track === 'f' || track === 'r')) {
      e.trk[track].absFailUntil = this.t + min * 60;
      this.ev(`Отказ автоблокировки на пути ${TRACK_NAME[track]} ${this.edgeName(e)} на ${min} мин`, 'bad');
      return;
    }
    e.absFailUntil = this.t + min * 60;
    this.ev(`Отказ автоблокировки ${this.edgeName(e)} на ${min} мин`, 'bad');
  }

  detectDeadlocks() {
    // Тупик: множество стоящих поездов, ни один из которых не может двинуться,
    // пока стоят остальные (ожидание станционного пути — «любой освободит»,
    // блок-участка и встречного направления — «все должны освободить»).
    const D = new Set();
    for (const tr of this.trains) {
      if ((tr.state === 'running' || tr.state === 'pending') && tr.v === 0 && tr.waitFor.length &&
          !(tr.waitReason && tr.waitReason.startsWith('задержан')) && this.t >= tr.brokenUntil) D.add(tr.id);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...D]) {
        const tr = this.trainMap.get(id);
        const wf = tr.waitFor.filter((x) => x !== id);
        const free = tr.waitMode === 'or' ? wf.some((x) => !D.has(x)) : wf.every((x) => !D.has(x));
        if (free) { D.delete(id); changed = true; }
      }
    }
    this.deadSince = this.deadSince || new Map();
    const fresh = [];
    for (const tr of this.trains) {
      if (!D.has(tr.id)) { this.deadSince.delete(tr.id); tr.deadlock = false; continue; }
      if (!this.deadSince.has(tr.id)) this.deadSince.set(tr.id, this.t);
      const was = tr.deadlock;
      tr.deadlock = this.t - this.deadSince.get(tr.id) >= 15;
      if (tr.deadlock && !was) fresh.push(tr);
    }
    if (fresh.length) {
      const prevStuck = this.trains.some((t) => t.deadlock && !fresh.includes(t));
      if (!prevStuck) this.m.deadlocks++;
      this.ev(`ТУПИК: ${fresh.map((t) => t.name).join(', ')} — движение невозможно без вмешательства`, 'bad');
    }
  }

  // ---------- состояние для ассистента ----------
  snapshot() {
    const trains = [], nodes = [], edges = [];
    const byId = { trains: {}, nodes: {}, edges: {} };
    for (const n of this.net.nodes) {
      const r = this.res.get('N:' + n.id);
      const o = { id: n.id, name: _tr(n.name), type: n.type, tracks: n.type === 'station' ? n.tracks : 1, crossovers: n.crossovers, wrongEntry: n.wrongEntry,
        trackList: n.trackOcc ? n.trackOcc.map((id, k) => ({ index: k, name: n.trackName[k], main: n.trackMain[k], occupiedBy: id })) : null,
        throat: n.throat ? { W: n.throat.W.map((r) => ({ train: r.tr, kind: r.kind })), E: n.throat.E.map((r) => ({ train: r.tr, kind: r.kind })) } : null,
        trains: r ? [...r.occ] : [], inbound: [] };
      o.free = o.tracks - o.trains.length;
      nodes.push(o); byId.nodes[n.id] = o;
    }
    for (const e of this.net.edges) {
      const o = { id: e.id, a: e.a, b: e.b, name: _tr(this.edgeName(e)), lengthKm: e.len / 1000, vmax: this.edgeV(e),
        double: !!e.double, closed: this.t < e.closedUntil, closedForSec: Math.max(0, e.closedUntil - this.t),
        absFail: this.t < e.absFailUntil, trainsAB: [...e.inF], trainsBA: [...e.inR] };
      if (e.double) {
        const tv = (ln) => { const k = e.trk[ln]; return { name: TRACK_NAME[ln], dir: ln === 'f' ? 'AB' : 'BA',
          closed: this.trackClosed(e, ln), closedForSec: Math.max(0, Math.max(e.closedUntil, k.closedUntil) - this.t),
          absFail: this.t < k.absFailUntil || o.absFail, tsr: k.tsr && this.t < k.tsrUntil ? k.tsr : null,
          bidirectional: k.bidir, wrongLineOrder: k.order ? { vmax: k.order.vmax, since: k.order.since } : null,
          trainsAB: [...k.users.f], trainsBA: [...k.users.r] }; };
        o.tracks = { I: tv('f'), II: tv('r') };
        o.closed = o.tracks.I.closed && o.tracks.II.closed;
        o.closedForSec = o.closed ? Math.min(o.tracks.I.closedForSec, o.tracks.II.closedForSec) : 0;
        // однопутный режим — только когда один путь закрыт И по второму приказом организовано движение в обе стороны
        o.singleLineWorking = (o.tracks.I.closed && !!o.tracks.II.wrongLineOrder) || (o.tracks.II.closed && !!o.tracks.I.wrongLineOrder);
        // для логики ассистента перегон с одним закрытым путём работает как однопутный
        o.physicalDouble = true;
        if (o.singleLineWorking) o.double = false;
      }
      edges.push(o); byId.edges[e.id] = o;
    }
    for (const tr of this.trains) {
      if (tr.state === 'invalid') continue;
      const active = tr.state !== 'pending' && tr.state !== 'done';
      const head = active ? tr.seq[tr.headIdx] : null;
      const fr = active ? tr.seq[tr.resIdx] : tr.seq[0];
      let frontierNode = fr.kind === 'node' ? fr.nodeId : null;
      if (tr.state === 'done') frontierNode = null;
      let nextEdge = null;
      const lastIdx = active ? tr.resIdx : 0;
      if (frontierNode && lastIdx < tr.seq.length - 1) {
        const nb = tr.seq[lastIdx + 1];
        const e = this.edgeMap.get(nb.edgeId);
        const slw = e.double && ((this.trackClosed(e, 'f') && e.trk.r.order) || (this.trackClosed(e, 'r') && e.trk.f.order));
        nextEdge = { id: e.id, toNode: nb.dir === 'f' ? e.b : e.a, double: !!e.double && !slw };
      }
      const committed = [];
      if (active) {
        for (let i = tr.headIdx + 1; i <= tr.resIdx; i++) if (tr.seq[i].kind === 'node') committed.push(tr.seq[i].nodeId);
        const f = tr.seq[tr.resIdx];
        if (f.kind === 'block') committed.push(tr.pathNodes[f.pi + 1]);
      }
      for (const nid of committed) if (byId.nodes[nid]) byId.nodes[nid].inbound.push(tr.id);
      const routePos = active ? fr.pi : 0;
      const ns = this.nextStopIdx(tr);
      const status = tr.state === 'done' ? 'done' : tr.state === 'pending' ? 'pending'
        : this.t < tr.brokenUntil ? 'broken' : tr.state === 'dwell' ? 'dwell' : tr.v === 0 ? 'stopped' : 'running';
      // ближайшая станция впереди (независимо от заданного маршрута) и точка остановки
      let nextStation = null, stopDist = null, stopPlanned = false;
      if (active) {
        for (let i = tr.headIdx + 1; i < tr.seq.length; i++) {
          const q = tr.seq[i];
          if (q.kind === 'node' && q.station) { nextStation = { id: q.nodeId, distM: Math.round(this.stopPos(tr, i) - tr.s), stop: !!q.stop || i === tr.seq.length - 1 }; break; }
        }
        stopPlanned = ns !== -1 && ns <= tr.resIdx;
        stopDist = Math.round((stopPlanned ? this.stopPos(tr, ns) : this.stopPos(tr, tr.resIdx)) - tr.s);
      }
      const o = {
        id: tr.id, name: tr.name, type: tr.type, priority: tr.prio, maxSpeed: tr.ty.vmax, status,
        aspect: this.aspect(tr),
        nextStation, stopDist, stopPlanned, blocked: tr.state === 'running' && !!tr.waitReason, blockedBy: (tr.waitFor || []).slice(),
        speedCap: tr.speedCap, capReason: tr.capReason, manualCap: tr.manualCap, lengthM: tr.ty.len,
        speed: Math.round(tr.v * 3.6), from: tr.from, to: tr.to,
        route: tr.pathNodes.slice(), routeEdges: tr.pathEdges.slice(), routePos,
        atNode: head && head.kind === 'node' ? head.nodeId : null,
        onEdge: head && head.kind === 'block' ? head.edgeId : null,
        frontierNode, nextEdge, committed,
        nextStop: ns !== -1 ? tr.seq[ns].nodeId : null,
        delayMin: +(this.liveDelay(tr) / 60).toFixed(1),
        waitReason: tr.waitReason && _tr(tr.waitReason), waitingSec: tr.waitSince != null ? Math.round(this.t - tr.waitSince) : 0,
        deadlock: tr.deadlock, held: !!tr.hold, holdReason: tr.hold ? tr.hold.reason : null,
        departIn: tr.state === 'dwell' ? Math.max(0, tr.dwellUntil - this.t) : tr.state === 'pending' ? Math.max(0, tr.dep + tr.extraDelay - this.t) : 0,
      };
      trains.push(o); byId.trains[tr.id] = o;
    }
    const conflicts = this.issues().map((x) => ({ type: x.type, text: x.text, trains: x.trains || [], edge: x.edge || null }));
    return {
      time: this.t, clock: fmtClock(this.t), trains, nodes, edges, byId, conflicts,
      edgeBetween: (a, b) => edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a)) || null,
    };
  }

  // приказ действует, пока соседний путь закрыт; после открытия и ухода последнего поезда — снимается
  expireOrders() {
    for (const e of this.net.edges) {
      if (!e.double) continue;
      for (const ln of ['f', 'r']) {
        const k = e.trk[ln]; if (!k.order) continue;
        const o = ln === 'f' ? 'r' : 'f';
        if (!this.trackClosed(e, o) && k.users[o].size === 0) {
          k.order = null;
          this.ev(`Путь ${TRACK_NAME[o]} перегона ${this.edgeName(e)} открыт: движение по пути ${TRACK_NAME[ln]} — только в правильном направлении`, 'info');
        }
      }
    }
  }
  issues() {
    const out = [];
    const dl = this.trains.filter((tr) => tr.deadlock);
    if (dl.length) out.push({ type: 'deadlock', sev: 3, text: `Тупик: ${dl.map((t) => t.name).join(', ')}`, trains: dl.map((t) => t.id) });
    for (const tr of this.trains) {
      if (tr.state === 'done' || tr.state === 'invalid') continue;
      if (this.t < tr.brokenUntil) out.push({ type: 'breakdown', sev: 2, text: `${tr.name}: неисправность, ещё ${Math.ceil((tr.brokenUntil - this.t) / 60)} мин`, trains: [tr.id] });
      else if (!tr.deadlock && tr.waitSince != null && this.t - tr.waitSince > 120 && tr.waitReason)
        out.push({ type: tr.hold ? 'held' : 'waiting', sev: tr.hold ? 0 : 1, text: `${tr.name} стоит ${Math.round((this.t - tr.waitSince) / 60)} мин: ${tr.waitReason}`, trains: [tr.id] });
    }
    for (const e of this.net.edges) {
      if (this.t < e.closedUntil) out.push({ type: 'closed', sev: 2, text: `Закрыт перегон ${this.edgeName(e)} (ещё ${Math.ceil((e.closedUntil - this.t) / 60)} мин)`, edge: e.id });
      if (this.t < e.absFailUntil) out.push({ type: 'absfail', sev: 1, text: `Отказ АБ ${this.edgeName(e)}`, edge: e.id });
      if (e.tsr && this.t < e.tsrUntil) out.push({ type: 'tsr', sev: 1, text: `Ограничение ${e.tsr} км/ч: ${this.edgeName(e)}`, edge: e.id });
      if (e.double) for (const ln of ['f', 'r']) {
        const k = e.trk[ln], N = TRACK_NAME[ln];
        if (this.t < k.closedUntil) {
          out.push({ type: 'closed', sev: 2, text: `Закрыт путь ${N} перегона ${this.edgeName(e)} (ещё ${Math.ceil((k.closedUntil - this.t) / 60)} мин)`, edge: e.id });
          const o = ln === 'f' ? 'r' : 'f';
          if (!e.trk[o].order) {
            const w = this.trains.filter((t) => t.waitReason && t.waitReason.startsWith(`путь ${N} закрыт;`)).length;
            if (w) out.push({ type: 'closed', sev: 2, text: `${w} поезд(ов) ждут: движение по пути ${TRACK_NAME[o]} перегона ${this.edgeName(e)} в обе стороны не организовано`, edge: e.id });
          }
        }
        if (k.order) out.push({ type: 'tsr', sev: 1, text: `По пути ${N} перегона ${this.edgeName(e)} — движение в обе стороны по приказу`, edge: e.id });
        if (this.t < k.absFailUntil) out.push({ type: 'absfail', sev: 1, text: `Отказ АБ на пути ${N}: ${this.edgeName(e)}`, edge: e.id });
        if (k.tsr && this.t < k.tsrUntil) out.push({ type: 'tsr', sev: 1, text: `Ограничение ${k.tsr} км/ч на пути ${N}: ${this.edgeName(e)}`, edge: e.id });
      }
    }
    return out.sort((a, b) => b.sev - a.sev);
  }

  // ---------- рекомендации ----------
  recAction(type, tr, params) {
    const n = tr.capInfo && tr.capInfo.untilNode ? this.nodeMap.get(tr.capInfo.untilNode) : null;
    if (type === 'speed') return `Машинисту ${tr.name}: снизить скорость до ${params.kmh} км/ч`;
    if (type === 'hold') { const f = tr.seq && tr.seq[tr.resIdx]; const st = f && f.kind === 'node' ? this.nodeMap.get(f.nodeId).name : null; return st ? `Удержать ${tr.name} на ст. ${st}` : `Удержать ${tr.name}`; }
    if (type === 'route') return `Изменить маршрут ${tr.name}: ${params.nodes.map((x) => this.nodeMap.get(x).name).join(' → ')}`;
    return type;
  }
  recNew(type, tr, params, info, status, apply, safety) {
    const r = { id: 'R' + this.recSeq++, key: type + ':' + tr.id, type, train: tr.id, trainName: tr.name, params, info: info || {},
      status, auto: status !== 'pending', safety: !!safety, createdAt: this.t, updatedAt: this.t, decidedAt: status !== 'pending' ? this.t : null,
      action: this.recAction(type, tr, params), apply };
    this.recs.push(r); this.recByKey.set(r.key, r);
    if (this.recs.length > 400) this.recs.splice(0, this.recs.length - 400);
    if (status === 'active') this.recActivate(r);
    if (status === 'pending' && this.onRec) this.onRec(r);
    return r;
  }
  recRecord(type, tr, params, info) { this.recNew(type, tr, params, info, 'active', null, false).status = 'done'; }
  recPropose(type, tr, params, info, apply, safety) {
    const key = type + ':' + tr.id; this._touched && this._touched.add(key);
    let r = this.recByKey.get(key);
    const same = r && JSON.stringify(r.params) === JSON.stringify(params);
    const live = r && (r.status === 'active' || r.status === 'pending');
    if (this.approval === 'auto' || safety) {
      apply();
      if (!live || !same || r.status === 'pending') { if (r && r.status === 'pending') r.status = 'replaced'; this.recNew(type, tr, params, info, 'active', apply, safety); }
      else r.info = info;
      return true;
    }
    if (r && r.status === 'rejected' && same && this.t - r.decidedAt < 300) return false;
    if (r && r.status === 'active' && same) { r.info = info; apply(); return true; }
    if (r && r.status === 'pending' && same) { r.info = info; r.updatedAt = this.t; return 'pending'; }
    if (r && r.status === 'pending') r.status = 'replaced';
    this.recNew(type, tr, params, info, 'pending', apply, false);
    return 'pending';
  }
  recWithdraw(type, trainId) {
    const r = this.recByKey.get(type + ':' + trainId);
    if (!r) return;
    if (r.status === 'pending') { r.status = 'expired'; r.decidedAt = this.t; }
    else if (r.status === 'active') { r.status = 'done'; r.endedAt = this.t; }
  }
  recSweep() {
    for (const r of this.recs) if (r.status === 'pending' && !this._touched.has(r.key) && this.t - r.updatedAt > 3) { r.status = 'expired'; r.decidedAt = this.t; }
  }
  recDecide(id, accept) {
    const r = this.recs.find((x) => x.id === id); if (!r || r.status !== 'pending') return false;
    r.decidedAt = this.t;
    if (!accept) { r.status = 'rejected'; this.alog(`Диспетчер отклонил: ${r.action}`, 'info'); return true; }
    r.status = 'active'; if (r.apply) r.apply(); this.recActivate(r);
    this.alog(`Диспетчер принял: ${r.action}`, 'go');
    return true;
  }
  // прогноз в момент исполнения — потом он сравнивается с фактом
  recActivate(r) {
    const tr = this.trainMap.get(r.train);
    if (r.type === 'speed' && tr && r.info && r.info.untilNode) {
      const p = this.planApproach(tr, r.info.untilNode);
      if (p && p.best) r.forecast = { P: p.P, passAt: p.best.passP, stop: !!p.needStop, node: r.info.untilNode, withoutStopSec: p.base ? p.base.stopSec : null };
    }
  }
  recWatch() {
    for (const r of this.recs) {
      if (!r.forecast || r.outcome || (r.status !== 'active' && r.status !== 'done')) continue;
      const tr = this.trainMap.get(r.train); if (!tr) continue;
      if (tr.state === 'running' && tr.v === 0 && tr.s < r.forecast.P + 5) r.stopped = true;
      if (tr.s >= r.forecast.P + 5 || tr.state === 'done') {
        r.outcome = { passAt: this.t, stopped: !!r.stopped, errSec: Math.round(this.t - r.forecast.passAt) };
        if (r.status === 'active') r.status = 'done';
      }
    }
  }

  runAssistant() {
    const state = this.snapshot();
    const self = this;
    const api = {
      memory: this.memory,
      hold(id, reason = 'решение ассистента') {
        const tr = self.trainMap.get(id); if (!tr || tr.state === 'done') return false;
        reason = String(reason).slice(0, 120);
        if (!tr.hold) { self.m.holds++; self.alog(`Диспетчеру: задержать ${tr.name} — ${reason}`, 'hold'); }
        tr.hold = { reason, since: tr.hold ? tr.hold.since : self.t };
        return true;
      },
      release(id) {
        const tr = self.trainMap.get(id); if (!tr || !tr.hold) return false;
        self.alog(`Диспетчеру: отправить ${tr.name} (ждал ${Math.round((self.t - tr.hold.since) / 60)} мин)`, 'go');
        tr.hold = null; return true;
      },
      setPriority(id, p) { const tr = self.trainMap.get(id); if (tr && tr.prio !== +p) { tr.prio = +p; self.alog(`Приоритет ${tr.name} → ${p}`); } },
      limitSpeed(id, kmh, reason = '') {
        const tr = self.trainMap.get(id); if (!tr || tr.state === 'done') return false;
        let info = null;
        if (reason && typeof reason === 'object') { info = reason; reason = info.reason || ''; }
        if (kmh == null) { tr.speedCap = null; tr.capReason = null; tr.capEndS = null; return true; }
        if (info && info.untilNode) {
          const k = tr.seq.findIndex((q, j) => j > tr.headIdx && q.kind === 'node' && q.nodeId === info.untilNode);
          if (k > 0) tr.capEndS = self.stopPos(tr, k);
        }
        tr.capInfo = info;
        kmh = Math.round(Math.max(10, Math.min(tr.ty.vmax, +kmh)));
        const la = tr.lastAdv;
        if (!la || Math.abs(la.kmh - kmh) >= 10 || self.t - la.t > 300) {
          tr.lastAdv = { kmh, t: self.t };
          self.m.advices++;
          self.alog(`Машинисту ${tr.name}: не выше ${kmh} км/ч${reason ? ' — ' + String(reason).slice(0, 120) : ''}`, 'drv');
        }
        tr.speedCap = kmh; tr.capReason = reason ? String(reason).slice(0, 120) : null;
        return true;
      },
      reroute(id, nodes) {
        const tr = self.trainMap.get(id); if (!tr) return false;
        const ok = self.reroute(tr, nodes);
        if (ok) self.alog(`Новый маршрут ${tr.name}: ${nodes.map((n) => self.nodeMap.get(n).name).join(' → ')}`, 'route');
        return ok;
      },
      findPath(from, to, opt = {}) { const p = findPath(self.net, from, to, opt.avoid || []); return p ? p.nodes : null; },
      pathTime(nodes, trainId) {
        const tr = self.trainMap.get(trainId); const vt = tr ? tr.ty.vmax : 120; let T = 0;
        for (let i = 0; i < nodes.length - 1; i++) {
          const e = state.edgeBetween(nodes[i], nodes[i + 1]); if (!e) return Infinity;
          T += (e.lengthKm * 1000) / (Math.min(vt, e.vmax) / 3.6);
        }
        return T;
      },
      eta(id, nodeId) { const tr = self.trainMap.get(id); return tr ? self.eta(tr, nodeId) : null; },
      // физический прогноз: через сколько секунд хвост последнего встречного освободит перегон в сторону узла
      clearTime(edgeId, nodeId) {
        const r = self.clearTime(edgeId, nodeId); if (!r) return null;
        return { inSec: r.clearAt == null ? null : Math.round(r.clearAt - self.t), trains: r.trains.map((x) => ({ id: x.id, inSec: x.at == null ? null : Math.round(x.at - self.t), uncertain: x.uncertain })) };
      },
      // режим подхода к станции: рекомендуемая скорость, точка начала торможения, экономия
      planApproach(id, nodeId) {
        const tr = self.trainMap.get(id); if (!tr) return null;
        const p = self.planApproach(tr, nodeId); if (!p) return null;
        const rel = (x) => (x == null ? null : Math.round(x - self.t));
        return { nodeId: p.nodeId, conflictEdge: p.conflict, distM: p.distM, clearInSec: rel(p.clearAt), needStop: !!p.needStop, noConflict: !!p.noConflict,
          trains: p.trains.map((x) => x.id), uncertain: !!p.uncertain,
          without: p.base ? { stopSec: Math.round(p.base.stopSec), passInSec: rel(p.base.passP) } : null,
          advice: p.best ? { kmh: p.best.kmh, passInSec: rel(p.best.passP), minKmh: p.best.minV != null ? Math.round(p.best.minV) : null, brakeStartM: p.brakeStartM } : null,
          savedSec: p.savedSec ?? 0, savedKWh: p.savedKWh ?? 0, keep: !!p.keep };
      },
      log(msg) { self.alog(String(msg).slice(0, 200)); },
    };
    // слой рекомендаций поверх команд: в режиме 'auto' поведение прежнее
    const raw = { hold: api.hold, release: api.release, limitSpeed: api.limitSpeed, reroute: api.reroute };
    this._touched = new Set();
    api.hold = (id, reason = 'решение ассистента', opt = {}) => {
      const tr = self.trainMap.get(id); if (!tr || tr.state === 'done') return false;
      const info = typeof reason === 'object' && reason ? reason : { reason: String(reason) };
      const safety = !!(opt.safety || info.safety);
      return self.recPropose('hold', tr, {}, info, () => raw.hold(id, info.reason || 'решение ассистента'), safety);
    };
    api.release = (id) => { self.recWithdraw('hold', id); return raw.release(id); };
    api.limitSpeed = (id, kmh, reason = '') => {
      const tr = self.trainMap.get(id); if (!tr || tr.state === 'done') return false;
      if (kmh == null) { self.recWithdraw('speed', id); return raw.limitSpeed(id, null); }
      const info = typeof reason === 'object' && reason ? reason : { reason: String(reason || '') };
      const k = Math.round(Math.max(10, Math.min(tr.ty.vmax, +kmh)));
      return self.recPropose('speed', tr, { kmh: k }, info, () => raw.limitSpeed(id, k, reason));
    };
    api.reroute = (id, nodes) => {
      const tr = self.trainMap.get(id); if (!tr) return false;
      if (self.approval === 'auto') { const ok = raw.reroute(id, nodes); if (ok) self.recRecord('route', tr, { nodes }, { reason: 'объезд' }); return ok; }
      return self.recPropose('route', tr, { nodes }, { reason: 'объезд закрытого перегона' }, () => raw.reroute(id, nodes));
    };
    state.recommendations = this.recs.filter((r) => this.t - r.createdAt < 1800).map((r) => ({ id: r.id, type: r.type, train: r.train, status: r.status, params: r.params }));
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    try {
      this.assistant(state, api);
    } catch (err) {
      this.m.errors++;
      this.alog('Ошибка в коде ассистента: ' + (err && err.message ? err.message : err), 'error');
    }
    this.recSweep();
    const dt = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    if (dt > 80) this.alog(`Ассистент думал ${Math.round(dt)} мс — это замедляет симуляцию`, 'error');
  }

  step(dt) {
    this.t += dt;
    if (this.assistant && this.t >= this.nextAssist) { this.runAssistant(); this.nextAssist = this.t + this.assistInterval; }
    const act = this.trains.filter((tr) => tr.state !== 'done' && tr.state !== 'invalid')
      .sort((a, b) => b.prio - a.prio || a.ord - b.ord);
    for (const tr of act) {
      if (tr.state === 'pending') this.trySpawn(tr);
      else this.advance(tr, dt);
    }
    if (this.t - this.lastDeadCheck >= 5) { this.lastDeadCheck = this.t; this.detectDeadlocks(); this.expireOrders(); }
    if (this.recs.length) this.recWatch();
    if (this.t - this.lastHist >= 30) { this.lastHist = this.t; this.record(); }
  }

  record() {
    const live = this.trains.filter((t) => t.state !== 'invalid' && (t.state !== 'pending' || this.t > t.dep));
    let sum = 0; for (const t of live) sum += this.liveDelay(t);
    this.m.hist.push({ t: this.t, avgDelay: live.length ? sum / live.length / 60 : 0, done: this.m.completed });
    if (this.m.hist.length > 2000) this.m.hist.splice(0, this.m.hist.length - 2000);
  }

  summary() {
    const valid = this.trains.filter((t) => t.state !== 'invalid');
    const live = valid.filter((t) => t.state !== 'pending' || this.t > t.dep);
    let sum = 0; for (const t of live) sum += this.liveDelay(t);
    let energy = 0; for (const t of valid) energy += t.energy;
    let wsum = 0, wd = 0;
    for (const t of live) { const w = t.ty.prio; wsum += w; wd += w * this.liveDelay(t); }
    const longStops = valid.filter((t) => t.waitSince != null && this.t - t.waitSince > 600 && t.state !== 'done').length;
    return {
      total: valid.length, completed: this.m.completed,
      running: valid.filter((t) => t.state === 'running' || t.state === 'dwell').length,
      avgDelay: live.length ? sum / live.length / 60 : 0, wDelay: wsum ? wd / wsum / 60 : 0, longStops,
      punctual: this.m.completed ? (this.m.onTime / this.m.completed) * 100 : null,
      deadlocks: this.m.deadlocks, stuck: valid.filter((t) => t.deadlock).length,
      unplanned: this.m.unplanned, energy, holds: this.m.holds, reroutes: this.m.reroutes, advices: this.m.advices, errors: this.m.errors,
      recs: (() => { const c = { proposed: 0, accepted: 0, rejected: 0, expired: 0, auto: 0, forecasts: 0, forecastOk: 0 };
        for (const r of this.recs) { if (r.safety) continue; if (r.auto) c.auto++; else c.proposed++;
          if (!r.auto && (r.status === 'active' || r.status === 'done')) c.accepted++; if (r.status === 'rejected') c.rejected++; if (r.status === 'expired') c.expired++;
          if (r.outcome && r.forecast) { c.forecasts++; if (r.outcome.stopped === r.forecast.stop) c.forecastOk++; } }
        return c; })(),
    };
  }
}

if (typeof module !== 'undefined') module.exports = { Sim, TRAIN_TYPES, findPath, fmtClock, TRACK_NAME };
