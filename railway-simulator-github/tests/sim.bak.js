// ================= ЯДРО СИМУЛЯЦИИ =================
const TRAIN_TYPES = {
  express:   { label: 'Скорый',       vmax: 160, acc: 0.45, dec: 0.80, len: 350, mass: 800,  prio: 3, dwell: 60 },
  passenger: { label: 'Пассажирский', vmax: 120, acc: 0.50, dec: 0.75, len: 300, mass: 700,  prio: 2, dwell: 120 },
  suburban:  { label: 'Пригородный',  vmax: 110, acc: 0.80, dec: 0.90, len: 220, mass: 450,  prio: 2, dwell: 45 },
  freight:   { label: 'Грузовой',     vmax: 80,  acc: 0.18, dec: 0.40, len: 750, mass: 4500, prio: 1, dwell: 0 },
};
const STATION_LEN = 900, JUNCTION_LEN = 120, BLOCK_LEN = 1800, SIGNAL_MARGIN = 25;
const _tr = (x) => (typeof TR === 'function' ? TR(x) : x);
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
    this.edgeMap = new Map();
    for (const e of this.net.edges) {
      e.nBlocks = Math.max(1, Math.round(e.len / BLOCK_LEN));
      e.blockLen = e.len / e.nBlocks;
      e.inF = new Set(); e.inR = new Set();
      e.closedUntil = 0; e.tsr = null; e.tsrUntil = 0; e.absFailUntil = 0;
      this.edgeMap.set(e.id, e);
    }
    this.res = new Map();
    this.t = 0;
    this.trains = [];
    this.trainMap = new Map();
    this.events = [];
    this.assistLog = [];
    this.assistant = opts.assistant || null;
    this.assistInterval = 1;
    this.nextAssist = 0;
    this.memory = {};
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
  edgeV(e) {
    let v = e.vmax;
    if (e.tsr && this.t < e.tsrUntil) v = Math.min(v, e.tsr);
    if (this.t < e.absFailUntil) v = Math.min(v, 20);
    return v;
  }
  resV(tr, i) {
    const r = tr.seq[i];
    if (r.kind === 'node') return r.vmax / 3.6;
    return this.edgeV(this.edgeMap.get(r.edgeId)) / 3.6;
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
      seq.push({ kind: 'node', nodeId: n.id, key: 'N:' + n.id, cap: st ? Math.max(1, n.tracks | 0) : 1,
        len: st ? STATION_LEN : JUNCTION_LEN, vmax: st ? (stop ? 60 : 100) : 80, stop, station: st, pi: i });
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

  stopPos(tr, i) { return tr.starts[i] + tr.seq[i].len - SIGNAL_MARGIN; }
  nextStopIdx(tr) {
    for (let i = tr.lastDep + 1; i < tr.seq.length; i++) if (tr.seq[i].kind === 'node' && tr.seq[i].stop) return i;
    return -1;
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
      let ok = true;
      for (let j = 1; j <= take; j++) {
        const why = this.blockedReason(tr, tr.seq[tr.resIdx + j]);
        if (why) { ok = false; break; }
      }
      if (!ok) break;
      for (let j = 1; j <= take; j++) {
        const q = tr.seq[tr.resIdx + 1];
        if (q.kind === 'block' && q.first) (q.dir === 'f' ? this.edgeMap.get(q.edgeId).inF : this.edgeMap.get(q.edgeId).inR).add(tr.id);
        this.getRes(q.key, q.cap).occ.add(tr.id);
        tr.resIdx++;
        tr.resAt[tr.resIdx] = this.t;
      }
    }
  }

  blockedReason(tr, nx) {
    const r = this.getRes(nx.key, nx.cap);
    if (nx.kind === 'block' && nx.first) {
      const e = this.edgeMap.get(nx.edgeId);
      if (this.t < e.closedUntil) { tr.waitReason = `перегон ${this.edgeName(e)} закрыт`; tr.waitFor = []; return 1; }
      const same = nx.dir === 'f' ? e.inF : e.inR, opp = nx.dir === 'f' ? e.inR : e.inF;
      if (!e.double && opp.size > 0) {
        tr.waitReason = 'встречный поезд на однопутном перегоне'; tr.waitFor = [...opp]; tr.waitMode = 'and'; return 1;
      }
      if (this.t < e.absFailUntil && (same.size > 0 || (!e.double && opp.size > 0))) {
        tr.waitReason = 'отказ автоблокировки: по перегону только один поезд'; tr.waitFor = [...same]; tr.waitMode = 'and'; return 1;
      }
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
    const res = this.res.get(r.key);
    if (res) res.occ.delete(tr.id);
    if (r.kind === 'block' && r.last) {
      const e = this.edgeMap.get(r.edgeId);
      (r.dir === 'f' ? e.inF : e.inR).delete(tr.id);
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
    let target = tr.starts[tr.resIdx] + tr.seq[tr.resIdx].len - SIGNAL_MARGIN;
    const ns = this.nextStopIdx(tr);
    if (ns !== -1 && ns <= tr.resIdx) target = Math.min(target, this.stopPos(tr, ns));
    let vlim = Math.min(ty.vmax, tr.speedCap ?? Infinity, tr.manualCap ?? Infinity) / 3.6;
    for (let i = tr.tailIdx; i <= tr.headIdx; i++) vlim = Math.min(vlim, this.resV(tr, i));
    let vAhead = Infinity;
    for (let i = tr.headIdx + 1; i <= tr.resIdx; i++) {
      const d = tr.starts[i] - tr.s;
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
  closeEdge(id, min) {
    const e = this.edgeMap.get(id); if (!e) return;
    e.closedUntil = this.t + min * 60;
    this.ev(`Перегон ${this.edgeName(e)} закрыт на ${min} мин`, 'bad');
  }
  speedRestrict(id, kmh, min) {
    const e = this.edgeMap.get(id); if (!e) return;
    e.tsr = kmh; e.tsrUntil = this.t + min * 60;
    this.ev(`Предупреждение: ${this.edgeName(e)} — ${kmh} км/ч на ${min} мин`, 'warn');
  }
  absFail(id, min) {
    const e = this.edgeMap.get(id); if (!e) return;
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
      const o = { id: n.id, name: _tr(n.name), type: n.type, tracks: n.type === 'station' ? n.tracks : 1,
        trains: r ? [...r.occ] : [], inbound: [] };
      o.free = o.tracks - o.trains.length;
      nodes.push(o); byId.nodes[n.id] = o;
    }
    for (const e of this.net.edges) {
      const o = { id: e.id, a: e.a, b: e.b, name: _tr(this.edgeName(e)), lengthKm: e.len / 1000, vmax: this.edgeV(e),
        double: !!e.double, closed: this.t < e.closedUntil, closedForSec: Math.max(0, e.closedUntil - this.t),
        absFail: this.t < e.absFailUntil, trainsAB: [...e.inF], trainsBA: [...e.inR] };
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
        nextEdge = { id: e.id, toNode: nb.dir === 'f' ? e.b : e.a, double: !!e.double };
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
    }
    return out.sort((a, b) => b.sev - a.sev);
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
        if (kmh == null) { tr.speedCap = null; tr.capReason = null; return true; }
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
      log(msg) { self.alog(String(msg).slice(0, 200)); },
    };
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    try {
      this.assistant(state, api);
    } catch (err) {
      this.m.errors++;
      this.alog('Ошибка в коде ассистента: ' + (err && err.message ? err.message : err), 'error');
    }
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
    if (this.t - this.lastDeadCheck >= 5) { this.lastDeadCheck = this.t; this.detectDeadlocks(); }
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
    };
  }
}

if (typeof module !== 'undefined') module.exports = { Sim, TRAIN_TYPES, findPath, fmtClock };
