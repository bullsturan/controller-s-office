// ================= ИНТЕРФЕЙС =================
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

const App = {
  scen: 'single', net: null, specs: [], simA: null, simB: null, view: 'A', running: false, speed: 30,
  mode: 'sim', tool: 'select', sel: null, edgeFrom: null, cam: { x: 500, y: 300, z: 1 },
  assistFn: null, assistOn: true, idc: 1, tab: 'live', sit: null, hover: null, extraN: 1,
};

const TYPE_COLOR = { express: '--c-express', passenger: '--c-passenger', suburban: '--c-suburban', freight: '--c-freight' };
let C = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['--map', '--grid', '--track', '--track-dim', '--ink', '--muted', '--panel', '--panel-2', '--line', '--ai', '--ai-soft',
    '--sig-r', '--sig-y', '--sig-g', '--c-express', '--c-passenger', '--c-suburban', '--c-freight', '--reserve', '--bad', '--warn', '--good', '--land', '--water', '--border'])
    C[k] = cs.getPropertyValue(k).trim();
}
readColors();
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); }); } catch (e) {}

// ---------- ассистент ----------
function compileAssistant(code) {
  const f = new Function('"use strict";\n' + code + '\n;return typeof decide === "function" ? decide : null;');
  const fn = f();
  if (!fn) throw new Error('В коде нет функции decide(state, api)');
  return fn;
}
const assistWrapper = (state, api) => { if (App.assistFn) App.assistFn(state, api); };

function setStatus(text, ok) {
  const el = $('#codeStatus'); el.textContent = text; el.className = 'status ' + (ok ? 'ok' : 'err');
}
function applyCode(restart) {
  const code = $('#code').value;
  try {
    App.assistFn = compileAssistant(code);
    store.set('rail.code', code);
    setStatus(restart ? 'Код применён, моделирование начато заново' : 'Код применён к работающей модели', true);
    if (restart) resetSims();
  } catch (err) {
    let line = '';
    const m = String(err.stack || '').match(/<anonymous>:(\d+):(\d+)/);
    if (m) line = ` (строка ${Math.max(1, +m[1] - 3)})`;
    setStatus('Ошибка: ' + err.message + line, false);
  }
}

// ---------- сценарий и модели ----------
function loadScenario(key) {
  App.scen = key;
  const sc = SCENARIOS[key].build();
  App.net = sc.net; App.specs = sc.trains;
  App.sel = null; App.edgeFrom = null; App.userCam = false;
  // демо: рекомендации подтверждает диспетчер, пауза при новой рекомендации (сохранённые настройки не меняются)
  const demo = !!SCENARIOS[key].demo;
  if (App.approval !== undefined) {
    App.approval = demo ? 'confirm' : store.get('rail.approval') || 'auto';
    App.pauseOnRec = demo ? true : store.get('rail.pauseRec') !== '0';
    const a = $('#apprOn'), p = $('#pauseRec'); if (a) a.checked = App.approval === 'confirm'; if (p) p.checked = App.pauseOnRec;
  }
  if (demo) App.tab = 'live';
  resetSims(); fitView(); renderAll();
}
function resetSims() {
  App.simA = new Sim(App.net, App.specs, { assistant: App.assistOn ? assistWrapper : null, label: 'A',
    approval: App.approval || 'auto', onRec: onNewRec });
  App.simB = new Sim(App.net, App.specs, { label: 'B' });
  App.acc = 0;
  renderAll();
}
const sim = () => (App.view === 'A' ? App.simA : App.simB);
// новая рекомендация, ждущая диспетчера: пауза (если включена) и переход к «Обстановке»
function onNewRec(r) {
  if (App.fastRun) return;
  if (App.pauseOnRec && App.running) { App.running = false; updatePlay(); }
  App.view = 'A';
  if (App.tab !== 'live') { App.tab = 'live'; renderSide(); }
  App.recFlash = performance.now();
  setTimeout(() => { liveUpdate(); renderCard(); }, 0);
}
function decideRec(id, ok) {
  App.simA.recDecide(id, ok);
  if (ok && App.pauseOnRec && !App.running) { App.running = true; updatePlay(); }
  liveUpdate(); renderCard();
}
function both(fn) { fn(App.simA); fn(App.simB); }
function markDirty() { App.running = false; resetSims(); }

// ---------- камера ----------
const stage = $('#stage'), canvas = $('#map'), ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() {
  const r = stage.getBoundingClientRect();
  W = r.width; H = r.height; DPR = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
}
new ResizeObserver(() => { resize(); if (!App.userCam && App.net) fitView(); }).observe(stage);
const P = (x, y) => [(x - App.cam.x) * App.cam.z + W / 2, (y - App.cam.y) * App.cam.z + H / 2];
const WP = (sx, sy) => [(sx - W / 2) / App.cam.z + App.cam.x, (sy - H / 2) / App.cam.z + App.cam.y];
function fitView() {
  resize();
  const ns = App.net.nodes;
  if (!ns.length) { App.cam = { x: 500, y: 300, z: 1 }; return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of ns) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
  const pad = 90;
  const z = Math.min((W - pad * 2) / Math.max(60, x1 - x0), (H - pad * 2) / Math.max(60, y1 - y0), 2.6);
  App.cam = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: Math.max(0.3, z) };
}
function zoomAt(f, sx = W / 2, sy = H / 2) {
  App.userCam = true;
  const [wx, wy] = WP(sx, sy);
  App.cam.z = Math.min(4, Math.max(0.25, App.cam.z * f));
  const [nx, ny] = WP(sx, sy);
  App.cam.x += wx - nx; App.cam.y += wy - ny;
}

// ---------- геометрия ----------
function edgeGeom(s, e) {
  const a = s.nodeMap.get(e.a), b = s.nodeMap.get(e.b);
  const A = P(a.x, a.y), B = P(b.x, b.y);
  const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1;
  return { A, B, ux: dx / L, uy: dy / L, nx: -dy / L, ny: dx / L, L };
}
// расстояние между осями путей двухпутки на экране (px): видно два пути при любом масштабе
function laneW() { return Math.max(4.5, Math.min(9, 7 * App.cam.z)); }
function laneOff(e, dir) { return e.double ? (dir === 'f' ? laneW() : -laneW()) : 0; }
function pointOnEdge(s, e, frac, dir) {
  const g = edgeGeom(s, e);
  const o = laneOff(e, dir);
  return [g.A[0] + (g.B[0] - g.A[0]) * frac + g.nx * o, g.A[1] + (g.B[1] - g.A[1]) * frac + g.ny * o];
}
function posAt(s, tr, pos) {
  let i = tr.tailIdx;
  while (i < tr.resIdx && pos > tr.starts[i] + tr.seq[i].len) i++;
  while (i > 0 && pos < tr.starts[i]) i--;
  const r = tr.seq[i];
  if (r.kind === 'node') { const n = s.nodeMap.get(r.nodeId); return P(n.x, n.y); }
  const e = s.edgeMap.get(r.edgeId);
  const loc = Math.min(1, Math.max(0, (pos - tr.starts[i]) / r.len));
  const f = r.dir === 'f' ? (r.ord + loc) / r.n : 1 - (r.ord + loc) / r.n;
  return pointOnEdge(s, e, f, r.lane || r.dir);
}
function trainPts(s, tr) {
  const head = tr.s, tail = Math.max(0, tr.s - tr.ty.len);
  const pts = [posAt(s, tr, tail)];
  for (let i = tr.tailIdx; i <= tr.headIdx; i++) {
    const b = tr.starts[i] + tr.seq[i].len;
    if (b > tail && b < head) pts.push(posAt(s, tr, b - 0.01), posAt(s, tr, b + 0.01));
  }
  pts.push(posAt(s, tr, head));
  return pts;
}
function stationBox(n) {
  const [x, y] = P(n.x, n.y);
  if (n.type !== 'station') return { x: x - 7, y: y - 7, w: 14, h: 14, cx: x, cy: y };
  const cp = App.net && App.net.compact;
  if (cp && App.cam.z < 0.32) return { x: x - 5, y: y - 5, w: 10, h: 10, cx: x, cy: y, tiny: true };
  const w = cp ? 10 + n.tracks * 7 : 22 + n.tracks * 11, h = cp ? 14 : 20;
  return { x: x - w / 2, y: y - h / 2, w, h, cx: x, cy: y };
}

// ---------- отрисовка ----------
function rr(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
function draw(now) {
  const s = sim();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = C['--map']; ctx.fillRect(0, 0, W, H);
  // контур карты (для географических сценариев)
  const geo = s.net.outline;
  if (geo) {
    const poly = (pts) => { ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); };
    poly(geo); ctx.fillStyle = C['--land']; ctx.fill(); ctx.strokeStyle = C['--border']; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
    for (const w of s.net.water || []) { poly(w); ctx.fillStyle = C['--water']; ctx.fill(); }
    ctx.font = 'italic 500 12px ' + getFont(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = C['--muted'];
    for (const l of s.net.labels || []) { const [x, y] = P(l.x, l.y); ctx.fillText(TR(l.t), x, y); }
  }
  // сетка-миллиметровка
  const step = 50 * App.cam.z;
  if (step > 14 && !geo) {
    ctx.strokeStyle = C['--grid']; ctx.lineWidth = 1; ctx.beginPath();
    const [ox, oy] = P(0, 0);
    for (let x = ((ox % step) + step) % step; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = ((oy % step) + step) % step; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }
  const z = App.cam.z, t = s.t;
  const blink = Math.floor(now / 400) % 2 === 0;
  // перегоны
  for (const e of s.net.edges) {
    const g = edgeGeom(s, e);
    const sel = App.sel && App.sel.kind === 'edge' && App.sel.id === e.id;
    const lanes = e.double ? ['f', 'r'] : ['s'];
    const closed = t < e.closedUntil, abs = t < e.absFailUntil, tsr = e.tsr && t < e.tsrUntil;
    const kOf = (ln) => (e.double && e.trk && e.trk[ln]) || null;
    if (sel || (App.hover && App.hover.kind === 'edge' && App.hover.id === e.id)) {
      ctx.strokeStyle = C['--ai-soft']; ctx.lineWidth = e.double ? 22 : 16; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(...g.A); ctx.lineTo(...g.B); ctx.stroke();
    }
    for (const ln of lanes) {
      const o = ln === 'f' ? laneW() : ln === 'r' ? -laneW() : 0;
      const k = kOf(ln);
      const lClosed = closed || (k && t < k.closedUntil), lAbs = abs || (k && t < k.absFailUntil);
      const ax = g.A[0] + g.nx * o, ay = g.A[1] + g.ny * o, bx = g.B[0] + g.nx * o, by = g.B[1] + g.ny * o;
      // занятость блок-участков
      for (let k = 0; k < e.nBlocks; k++) {
        const key = e.double ? `B:${e.id}:${ln}:${k}` : `B:${e.id}:s:${k}`;
        const r = s.res.get(key);
        if (r && r.occ.size) {
          const f0 = k / e.nBlocks, f1 = (k + 1) / e.nBlocks;
          ctx.strokeStyle = C['--reserve']; ctx.lineWidth = e.double ? Math.max(3, laneW() - 1) : 7; ctx.lineCap = 'butt';
          ctx.beginPath(); ctx.moveTo(ax + (bx - ax) * f0, ay + (by - ay) * f0); ctx.lineTo(ax + (bx - ax) * f1, ay + (by - ay) * f1); ctx.stroke();
        }
      }
      ctx.strokeStyle = lClosed ? C['--bad'] : C['--track']; ctx.lineWidth = e.double ? 2.2 : 3; ctx.lineCap = 'round';
      ctx.setLineDash(lClosed ? [6, 5] : lAbs ? [2, 4] : []);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]);
      // направление движения по пути двухпутки: шевроны и номер пути
      if (e.double && z > 0.5 && g.L > 120) {
        const dirSign = ln === 'f' ? 1 : -1;
        ctx.strokeStyle = lClosed ? C['--bad'] : C['--muted']; ctx.lineWidth = 1.3; ctx.globalAlpha = 0.75;
        const nCh = Math.max(1, Math.floor(g.L / 140));
        for (let c = 0; c < nCh; c++) {
          const f = (c + 0.5) / nCh, px = ax + (bx - ax) * f, py = ay + (by - ay) * f;
          const ux = g.ux * dirSign, uy = g.uy * dirSign;
          ctx.beginPath(); ctx.moveTo(px - ux * 4 + g.nx * 2.5, py - uy * 4 + g.ny * 2.5); ctx.lineTo(px, py); ctx.lineTo(px - ux * 4 - g.nx * 2.5, py - uy * 4 - g.ny * 2.5); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (z > 0.8) {
          const f = ln === 'f' ? 0.12 : 0.88, px = ax + (bx - ax) * f + g.nx * o * 1.1, py = ay + (by - ay) * f + g.ny * o * 1.1;
          ctx.font = '600 9.5px ' + getFont(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = C['--muted'];
          ctx.fillText(ln === 'f' ? 'I' : 'II', px + g.nx * (ln === 'f' ? 7 : -7), py + g.ny * (ln === 'f' ? 7 : -7));
        }
      }
      // границы блок-участков
      ctx.strokeStyle = C['--track']; ctx.lineWidth = 1.2;
      for (let k = 1; Math.hypot(bx - ax, by - ay) / e.nBlocks >= 8 && k < e.nBlocks; k++) {
        const f = k / e.nBlocks, px = ax + (bx - ax) * f, py = ay + (by - ay) * f;
        ctx.beginPath(); ctx.moveTo(px - g.nx * 3, py - g.ny * 3); ctx.lineTo(px + g.nx * 3, py + g.ny * 3); ctx.stroke();
      }
    }
    // светофоры автоблокировки
    if (z > 0.75) drawSignals(s, e, g);
    // подписи
    const mx = (g.A[0] + g.B[0]) / 2, my = (g.A[1] + g.B[1]) / 2;
    ctx.font = '500 11px ' + getFont(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lab = [];
    if (closed) lab.push('ЗАКРЫТ');
    if (abs) lab.push('отказ АБ 20');
    if (tsr) lab.push('огр. ' + e.tsr);
    if (e.double && e.trk && !closed) for (const ln of ['f', 'r']) {
      const k = e.trk[ln], N = ln === 'f' ? 'I' : 'II';
      if (t < k.closedUntil) lab.push(`путь ${N} закрыт`);
      if (t < k.absFailUntil) lab.push(`путь ${N}: отказ АБ`);
      if (k.tsr && t < k.tsrUntil) lab.push(`путь ${N}: огр. ${k.tsr}`);
      if (k.order) lab.push(`путь ${N}: в обе стороны`);
    }
    const info = `${e.real ? e.real : (e.len / 1000).toFixed(1).replace('.0', '')} км, ${e.vmax}${e.double ? '' : ', однопут.'}`;
    const off = e.double ? 18 : 16;
    const lx = mx + g.nx * off, ly = my + g.ny * off;
    if (z > (s.net.compact ? 1.3 : 0.6) || App.mode === 'edit') { ctx.fillStyle = C['--muted']; ctx.fillText(TR(info), lx, ly); }
    if (lab.length) {
      const tx = lab.map((x) => TR(x)).join(', ');
      const tw = ctx.measureText(tx).width + 10;
      const qx = mx - g.nx * (off + 2), qy = my - g.ny * (off + 2);
      ctx.fillStyle = closed || lab.some((x) => x.endsWith('закрыт')) ? C['--bad'] : C['--warn']; rr(qx - tw / 2, qy - 8, tw, 16, 4); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(tx, qx, qy);
    }
  }
  // поезда
  const labels = [];
  if (App.mode === 'sim' || s.t > 0) {
    for (const tr of s.trains) {
      if (tr.state === 'pending' || tr.state === 'done' || tr.state === 'invalid') continue;
      const pts = trainPts(s, tr);
      const col = C[TYPE_COLOR[tr.type]];
      const head = pts[pts.length - 1];
      const sel = App.sel && App.sel.kind === 'train' && App.sel.id === tr.id;
      const pendRec = s === App.simA && s.recs && s.recs.some((r) => r.status === 'pending' && r.train === tr.id);
      const halo = tr.deadlock ? (blink ? C['--bad'] : null) : t < tr.brokenUntil ? (blink ? C['--warn'] : null) : pendRec ? (blink ? C['--ai'] : null) : tr.hold ? C['--ai'] : sel ? C['--ink'] : null;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const hr = tr.seq[tr.headIdx];
      const onDbl = hr.kind === 'block' && s.edgeMap.get(hr.edgeId).double;
      const bw = onDbl ? Math.max(3.5, laneW() * 0.75) : 6;
      if (halo) { ctx.strokeStyle = halo; ctx.globalAlpha = 0.45; ctx.lineWidth = bw + 7; polyline(pts); ctx.globalAlpha = 1; }
      ctx.strokeStyle = C['--panel']; ctx.lineWidth = bw + 2.5; polyline(pts);
      ctx.strokeStyle = col; ctx.lineWidth = bw; polyline(pts);
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(head[0], head[1], 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = C['--panel']; ctx.lineWidth = 1.5; ctx.stroke();
      tr._head = head;
      if ((z > 0.55 && tr.seq[tr.headIdx].kind === 'block') || sel) labels.push([tr, head, col, sel]);
    }
  }
    // станции и узлы
  for (const n of s.net.nodes) {
    const b = stationBox(n);
    const r = s.res.get('N:' + n.id);
    const occ = r ? [...r.occ] : [];
    const sel = App.sel && App.sel.kind === 'node' && App.sel.id === n.id;
    const from = App.edgeFrom === n.id;
    if (n.type === 'station') {
      ctx.fillStyle = C['--panel']; ctx.strokeStyle = sel || from ? C['--ai'] : C['--track']; ctx.lineWidth = sel || from ? 2.5 : 1.5;
      rr(b.x, b.y, b.w, b.h, 6); ctx.fill(); ctx.stroke();
      const sn = s.nodeMap.get(n.id);
      const tOcc = sn && sn.trackOcc ? sn.trackOcc : null;
      // поезд ждёт из-за враждебного маршрута в горловине этой станции — подсветка
      if (s.routeMode && blink && s.trains.some((t) => t.waitReason && t.waitReason.includes('враждебный') && t.waitReason.includes(' ' + n.name + ' ('))) {
        ctx.strokeStyle = C['--warn']; ctx.lineWidth = 2.5; rr(b.x - 3, b.y - 3, b.w + 6, b.h + 6, 8); ctx.stroke();
      }
      for (let i = 0; !b.tiny && i < n.tracks; i++) {
        const cp = App.net && App.net.compact, sp = cp ? 7 : 11, hw = cp ? 2.5 : 4, hh = cp ? 4 : 6;
        const tx = b.x + (cp ? 8.5 : 11) + i * sp, ty = b.cy;
        const id = tOcc ? tOcc[i] : occ[i];
        if (id) {
          const tr = s.trainMap.get(id);
          ctx.fillStyle = C[TYPE_COLOR[tr.type]]; rr(tx - hw, ty - hh, hw * 2, hh * 2, 2); ctx.fill();
          if (tr.hold) { ctx.strokeStyle = C['--ai']; ctx.lineWidth = 2; rr(tx - 5.5, ty - 7.5, 11, 15, 3); ctx.stroke(); }
          if (tr.deadlock && blink) { ctx.strokeStyle = C['--bad']; ctx.lineWidth = 2; rr(tx - 5.5, ty - 7.5, 11, 15, 3); ctx.stroke(); }
        } else { ctx.strokeStyle = C['--track-dim']; ctx.lineWidth = 1; rr(tx - hw, ty - hh, hw * 2, hh * 2, 2); ctx.stroke(); }
      }
      ctx.font = (App.net && App.net.compact ? '600 11px ' : '600 12.5px ') + getFont(); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = C['--ink'];
      if (!(App.net && App.net.compact && z < 0.32) || sel) ctx.fillText(TR(n.name), b.cx, b.y - 4);
    } else {
      ctx.save(); ctx.translate(b.cx, b.cy); ctx.rotate(Math.PI / 4);
      ctx.fillStyle = occ.length ? C['--sig-y'] : C['--panel']; ctx.strokeStyle = sel || from ? C['--ai'] : C['--track']; ctx.lineWidth = 1.8;
      ctx.fillRect(-5, -5, 10, 10); ctx.strokeRect(-5, -5, 10, 10); ctx.restore();
      if (z > 0.6) { ctx.font = '500 11px ' + getFont(); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = C['--muted']; ctx.fillText(TR(n.name), b.cx, b.cy + 10); }
    }
  }

  for (const [tr, head, col, sel] of labels) {
      {
        const v = Math.round(tr.v * 3.6);
        const cap = Math.min(tr.speedCap ?? Infinity, tr.manualCap ?? Infinity);
        const label = tr.name + (v > 0 ? ` ${v}` : '') + (cap < Infinity ? ` ⇣${cap}` : '');
        ctx.font = '600 11px ' + getFont(); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const w = ctx.measureText(label).width + 8;
        const lx = head[0] + 7, ly = head[1] - 13;
        ctx.fillStyle = col; rr(lx, ly - 8, w, 16, 4); ctx.fill();
        if (cap < Infinity) { ctx.strokeStyle = tr.speedCap != null ? C['--ai'] : C['--warn']; ctx.lineWidth = 2; ctx.stroke(); }
        ctx.fillStyle = '#fff'; ctx.fillText(label, lx + 4, ly);
      }
    }
}
let _font = null;
function getFont() { return _font || (_font = getComputedStyle(document.body).fontFamily); }
function polyline(pts) { ctx.beginPath(); ctx.moveTo(...pts[0]); for (let i = 1; i < pts.length; i++) ctx.lineTo(...pts[i]); if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.1, pts[0][1]); ctx.stroke(); }
function drawSignals(s, e, g) {
  const n = e.nBlocks;
  const occ = (dirKey, k) => { const r = s.res.get(e.double ? `B:${e.id}:${dirKey}:${k}` : `B:${e.id}:s:${k}`); return r && r.occ.size > 0; };
  if (Math.hypot(g.B[0] - g.A[0], g.B[1] - g.A[1]) / Math.max(1, n) < 14) return; // слишком мелко — не рисуем
  const dirs = e.double ? ['f', 'r'] : ['f', 'r'];
  for (const d of dirs) {
    const lane = e.double ? d : 's';
    const side = d === 'f' ? 1 : -1;
    const o = laneOff(e, d) + side * 6;
    for (let ord = 0; ord < n; ord++) {
      const k = d === 'f' ? ord : n - 1 - ord;
      const f = d === 'f' ? k / n : (k + 1) / n;
      if (ord === 0) continue; // входной сигнал — на станции
      const k2 = d === 'f' ? k + 1 : k - 1;
      let col = C['--sig-g'];
      const kk = e.double && e.trk ? e.trk[d] : null;
      if (kk && (s.t < kk.closedUntil || kk.users[d === 'f' ? 'r' : 'f'].size)) col = C['--sig-r'];
      else if (occ(lane, k) || (!e.double && (d === 'f' ? e.inR.size : e.inF.size))) col = C['--sig-r'];
      else if (k2 >= 0 && k2 < n && occ(lane, k2)) col = C['--sig-y'];
      const x = g.A[0] + (g.B[0] - g.A[0]) * f + g.nx * o, y = g.A[1] + (g.B[1] - g.A[1]) * f + g.ny * o;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
    }
  }
}

// ---------- попадание курсором ----------
function hitTest(sx, sy) {
  const s = sim();
  if (App.mode === 'sim') {
    let best = null, bd = COARSE ? 22 : 12;
    for (const tr of s.trains) {
      if (!tr._head || tr.state === 'pending' || tr.state === 'done' || tr.state === 'invalid') continue;
      const pts = trainPts(s, tr);
      for (let i = 0; i < pts.length; i++) {
        const d = i ? segDist(sx, sy, pts[i - 1], pts[i]) : Math.hypot(sx - pts[0][0], sy - pts[0][1]);
        if (d < bd) { bd = d; best = { kind: 'train', id: tr.id }; }
      }
    }
    if (best) return best;
  }
  for (const n of s.net.nodes) {
    const b = stationBox(n);
    if (sx >= b.x - 4 && sx <= b.x + b.w + 4 && sy >= b.y - 4 && sy <= b.y + b.h + 4) return { kind: 'node', id: n.id };
  }
  let best = null, bd = 9;
  for (const e of s.net.edges) {
    const g = edgeGeom(s, e);
    const d = segDist(sx, sy, g.A, g.B);
    if (d < bd) { bd = d; best = { kind: 'edge', id: e.id }; }
  }
  return best;
}
function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / L; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t));
}

// ---------- указатель ----------
const COARSE = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } })();
const pointers = new Map();
let drag = null, pinch = null;
canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  const r = canvas.getBoundingClientRect(); const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
  pointers.set(ev.pointerId, [sx, sy]);
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; drag = null; return; }
  const hit = hitTest(sx, sy);
  drag = { sx, sy, cam: { ...App.cam }, moved: false, hit, node: null };
  if (App.mode === 'edit' && App.tool === 'select' && hit && hit.kind === 'node') drag.node = App.net.nodes.find((n) => n.id === hit.id);
});
canvas.addEventListener('pointermove', (ev) => {
  const r = canvas.getBoundingClientRect(); const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, [sx, sy]);
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    zoomAt(d / pinch.d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); pinch.d = d; return;
  }
  if (!drag) { const h = hitTest(sx, sy); App.hover = h; canvas.style.cursor = h ? 'pointer' : (App.mode === 'edit' && App.tool !== 'select' ? 'crosshair' : 'grab'); return; }
  const dx = sx - drag.sx, dy = sy - drag.sy;
  if (Math.hypot(dx, dy) > 4) drag.moved = true;
  if (!drag.moved) return;
  if (drag.node) {
    const [wx, wy] = WP(sx, sy); drag.node.x = Math.round(wx); drag.node.y = Math.round(wy);
    for (const s of [App.simA, App.simB]) { const n = s.nodeMap.get(drag.node.id); if (n) { n.x = drag.node.x; n.y = drag.node.y; } }
  } else {
    App.cam.x = drag.cam.x - dx / App.cam.z; App.cam.y = drag.cam.y - dy / App.cam.z; App.userCam = true;
  }
});
const endPtr = (ev) => {
  pointers.delete(ev.pointerId);
  if (pinch) { if (pointers.size < 2) pinch = null; drag = null; return; }
  if (!drag) return;
  const d = drag; drag = null;
  if (d.node && d.moved) { renderSide(); return; }
  if (d.moved) return;
  onClick(d.sx, d.sy, d.hit);
};
canvas.addEventListener('pointerup', endPtr);
canvas.addEventListener('pointercancel', (ev) => { pointers.delete(ev.pointerId); drag = null; pinch = null; });
canvas.addEventListener('wheel', (ev) => { ev.preventDefault(); const r = canvas.getBoundingClientRect(); zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top); }, { passive: false });

function newId(prefix) { let id; do { id = prefix + (App.idc++); } while (App.net.nodes.some((n) => n.id === id) || App.net.edges.some((e) => e.id === id)); return id; }
function onClick(sx, sy, hit) {
  if (App.mode === 'edit') {
    const [wx, wy] = WP(sx, sy);
    if (App.tool === 'station' || App.tool === 'junction') {
      if (hit && hit.kind === 'node') { App.sel = hit; renderAll(); return; }
      const st = App.tool === 'station';
      const cnt = App.net.nodes.filter((n) => n.type === App.tool).length + 1;
      const id = newId(st ? 'S' : 'J');
      App.net.nodes.push(st ? mkStation(id, 'Станция ' + cnt, Math.round(wx), Math.round(wy), 2) : mkJunction(id, 'Пост ' + cnt, Math.round(wx), Math.round(wy)));
      App.sel = { kind: 'node', id }; markDirty(); return;
    }
    if (App.tool === 'single' || App.tool === 'double') {
      if (!hit || hit.kind !== 'node') { App.edgeFrom = null; updateHint(); return; }
      if (!App.edgeFrom) { App.edgeFrom = hit.id; updateHint(); return; }
      if (App.edgeFrom === hit.id) { App.edgeFrom = null; updateHint(); return; }
      const a = App.net.nodes.find((n) => n.id === App.edgeFrom), b = App.net.nodes.find((n) => n.id === hit.id);
      const km = Math.max(2, Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 0.045 * 2) / 2);
      const id = newId('E');
      App.net.edges.push(mkEdge(id, a.id, b.id, km, App.tool === 'double' ? 140 : 100, App.tool === 'double'));
      App.edgeFrom = hit.id; App.sel = { kind: 'edge', id };
      markDirty(); updateHint(); return;
    }
    if (App.tool === 'delete') {
      if (!hit) return;
      if (hit.kind === 'node') {
        App.net.nodes = App.net.nodes.filter((n) => n.id !== hit.id);
        App.net.edges = App.net.edges.filter((e) => e.a !== hit.id && e.b !== hit.id);
        App.specs = App.specs.filter((t) => t.from !== hit.id && t.to !== hit.id);
      } else if (hit.kind === 'edge') App.net.edges = App.net.edges.filter((e) => e.id !== hit.id);
      App.sel = null; markDirty(); return;
    }
  }
  App.sel = hit; renderAll();
}

// ---------- карточка выбранного объекта ----------
const STATUS = { pending: 'ожидает отправления', running: 'в пути', dwell: 'стоянка', done: 'прибыл', invalid: 'нет маршрута' };
function renderCard() {
  const el = $('#card');
  const s = sim();
  if (!App.sel) { el.hidden = true; return; }
  let h = '<button class="x" data-act="close" aria-label="Закрыть">✕</button>';
  if (App.sel.kind === 'train') {
    const tr = s.trainMap.get(App.sel.id); if (!tr) { el.hidden = true; return; }
    const route = tr.pathNodes.map((id) => s.nodeMap.get(id).name).join(' → ');
    const delay = Math.round(s.liveDelay(tr) / 60);
    const ns = s.nextStopIdx(tr);
    let st = STATUS[tr.state];
    if (tr.state === 'running' && tr.v === 0) st = 'стоит';
    if (s.t < tr.brokenUntil) st = 'неисправен';
    h += `<h3>${esc(tr.name)}</h3><div class="sub">${esc(tr.ty.label)}, приоритет ${tr.prio}</div>
      <dl class="kv"><dt>Маршрут</dt><dd>${esc(route)}</dd><dt>Состояние</dt><dd>${st}</dd>
      <dt>Скорость</dt><dd>${Math.round(tr.v * 3.6)} из ${Math.min(tr.ty.vmax, tr.speedCap ?? 999, tr.manualCap ?? 999)} км/ч</dd>
      <dt>Опоздание</dt><dd>${delay > 0 ? delay + ' мин' : 'по графику'}</dd>
      ${ns !== -1 && tr.state !== 'done' ? `<dt>Следующая</dt><dd>ст. ${esc(s.nodeMap.get(tr.seq[ns].nodeId).name)} по графику ${fmtClock(tr.arr[ns], false)}</dd>` : ''}
      ${(() => { const q = tr.seq && tr.seq[tr.headIdx]; if (!s.routeMode || !q || q.kind !== 'node' || q.track == null) return ''; const n = s.nodeMap.get(q.nodeId); return `<dt>Путь</dt><dd>ст. ${esc(n.name)}, путь ${n.trackName[q.track]}</dd>`; })()}
      <dt>Состав</dt><dd>${tr.ty.len} м, ${tr.ty.mass} т</dd><dt>Энергия</dt><dd>${tr.energy.toFixed(0)} кВт·ч</dd></dl>`;
    if (tr.deadlock) h += `<div class="why bad">В тупике: ни этот поезд, ни те, кого он ждёт, не могут двинуться.</div>`;
    if (tr.speedCap != null && s === App.simA) h += `<div class="why ai"><b>Совет машинисту</b><br><span>не выше ${tr.speedCap} км/ч</span>${tr.capReason ? `<br><span>${esc(tr.capReason)}</span>` : ''}</div>`;
    if (tr.hold) h += `<div class="why ai"><b>Совет диспетчеру</b><br><span>${esc(tr.hold.reason)}</span></div>`;
    if (s === App.simA) for (const r of s.recs.filter((x) => x.status === 'pending' && x.train === tr.id))
      h += `<div class="why ai"><b>${esc(r.action)}</b>${recDetails(r, s)}<div class="rb"><button class="btn small primary" data-act="rec" data-rec="${r.id}" data-ok="1">Принять</button><button class="btn small" data-act="rec" data-rec="${r.id}" data-ok="0">Отклонить</button></div></div>`;
    else if (tr.waitReason && (tr.v === 0 || tr.state === 'pending')) h += `<div class="why">${esc(tr.waitReason)}</div>`;
    if (tr.state !== 'done' && tr.state !== 'invalid') h += `<div class="spd"><div class="spd-l">Ограничить скорость вручную</div><div class="seg" role="group" aria-label="Ограничить скорость вручную">${[0, 80, 60, 40, 20].filter((v) => !v || v < tr.ty.vmax).map((v) => `<button data-act="cap" data-v="${v}" aria-pressed="${(tr.manualCap || 0) === v}">${v ? v : 'Нет'}</button>`).join('')}</div></div><div class="row">
      <button class="btn small" data-act="break">Неисправность 15 мин</button>
      <button class="btn small" data-act="delay">Задержать +10 мин</button></div>`;
  } else if (App.sel.kind === 'node') {
    const n = (App.mode === 'edit' ? App.net.nodes : s.net.nodes).find((x) => x.id === App.sel.id); if (!n) { el.hidden = true; return; }
    const r = s.res.get('N:' + n.id); const occ = r ? [...r.occ].map((id) => s.trainMap.get(id).name) : [];
    if (App.mode === 'edit') {
      h += `<h3>${n.type === 'station' ? 'Станция' : 'Стрелочный пост'}</h3><div class="form" style="margin-top:8px">
        <label class="full">Название<input type="text" data-f="name" value="${esc(n.name)}"></label>
        ${n.type === 'station' ? `<label>Приёмо-отправочных путей<input type="number" min="1" max="8" data-f="tracks" value="${n.tracks}"></label><label>Полезная длина путей, м<input type="number" min="400" max="2000" step="50" data-f="usefulLen" value="${n.usefulLen || 1050}"></label>` : ''}
        <label>Тип<select data-f="type"><option value="station"${n.type === 'station' ? ' selected' : ''}>Станция</option><option value="junction"${n.type === 'junction' ? ' selected' : ''}>Стрелочный пост</option></select></label>
        <label class="full">Съезды между главными путями<select data-f="crossovers"><option value="1"${n.crossovers !== false ? ' selected' : ''}>есть — можно перейти на соседний путь</option><option value="0"${n.crossovers === false ? ' selected' : ''}>нет</option></select></label>
        ${n.type === 'station' ? `<label class="full">Приём с неправильного пути<select data-f="wrongEntry"><option value="invite"${(n.wrongEntry || 'invite') === 'invite' ? ' selected' : ''}>по пригласительному сигналу (не более 20 км/ч)</option><option value="signal"${n.wrongEntry === 'signal' ? ' selected' : ''}>по входному светофору</option></select></label>` : ''}</div>`;
    } else {
      h += `<h3>${esc(n.name)}</h3><div class="sub">${n.type === 'station' ? `станция, ${n.tracks} пут.` : 'стрелочный пост, пропуск без остановки'}</div>
        <dl class="kv"><dt>Занято</dt><dd>${occ.length} из ${n.type === 'station' ? n.tracks : 1}</dd><dt>Поезда</dt><dd>${esc(occ.join(', ') || 'нет')}</dd>
        ${stationTracks(s, n.id)}
        <dt>Съезды</dt><dd>${n.crossovers !== false ? 'есть' : 'нет'}</dd>${n.type === 'station' ? `<dt>Приём с неправ. пути</dt><dd>${n.wrongEntry === 'signal' ? 'по входному светофору' : 'по пригласительному'}</dd>` : ''}</dl>`;
    }
  } else if (App.sel.kind === 'edge') {
    const e = (App.mode === 'edit' ? App.net.edges : s.net.edges).find((x) => x.id === App.sel.id); if (!e) { el.hidden = true; return; }
    const nm = (id) => App.net.nodes.find((n) => n.id === id)?.name;
    if (App.mode === 'edit') {
      h += `<h3>Перегон</h3><div class="sub">${esc(nm(e.a))} – ${esc(nm(e.b))}</div><div class="form">
        <label>Длина, км<input type="number" min="1" max="200" step="0.5" data-f="len" value="${e.len / 1000}"></label>
        <label>Скорость, км/ч<input type="number" min="20" max="250" step="10" data-f="vmax" value="${e.vmax}"></label>
        ${e.double ? `<label class="full">Автоблокировка на путях<select data-f="bidir"><option value="0"${e.bidir ? '' : ' selected'}>односторонняя (по неправильному пути — один поезд)</option><option value="1"${e.bidir ? ' selected' : ''}>двусторонняя</option></select></label>` : ''}
        <label class="full">Путей<select data-f="double"><option value="0"${e.double ? '' : ' selected'}>Однопутный (движение по очереди)</option><option value="1"${e.double ? ' selected' : ''}>Двухпутный (по пути в каждую сторону)</option></select></label></div>
        <p class="note">Блок-участков: ${Math.max(1, Math.round(e.len / BLOCK_LEN))} по ~${(e.len / Math.max(1, Math.round(e.len / BLOCK_LEN)) / 1000).toFixed(1)} км</p>`;
    } else {
      const se = s.edgeMap.get(e.id);
      h += `<h3>${esc(nm(e.a))} – ${esc(nm(e.b))}</h3><div class="sub">${e.double ? 'двухпутный' : 'однопутный'}, ${e.real || e.len / 1000} км, ${se.nBlocks} блок-уч., до ${e.vmax} км/ч</div>
        ${e.double ? trackRows(s, se) : `<dl class="kv"><dt>В сторону ${esc(nm(e.b))}</dt><dd>${[...se.inF].map((id) => s.trainMap.get(id).name).join(', ') || 'свободно'}</dd>
        <dt>В сторону ${esc(nm(e.a))}</dt><dd>${[...se.inR].map((id) => s.trainMap.get(id).name).join(', ') || 'свободно'}</dd></dl>`}
        ${e.double ? `<div class="row"><button class="btn small" data-act="closeI">Закрыть путь I на 30 мин</button><button class="btn small" data-act="closeII">Закрыть путь II на 30 мин</button></div>${orderButtons(s, se)}` : ''}
        <div class="row"><button class="btn small" data-act="close30">${e.double ? 'Закрыть оба пути на 30 мин' : 'Закрыть на 30 мин'}</button><button class="btn small" data-act="tsr">Ограничение 40 км/ч</button>
        <button class="btn small" data-act="abs">Отказ АБ 20 мин</button>${e.double ? '' : '<button class="btn small" data-act="meet">Пустить встречные</button>'}</div>`;
    }
  }
  el.innerHTML = h; el.hidden = false;
}
// станционные пути и установленные маршруты в горловинах
function stationTracks(s, nodeId) {
  const n = s.nodeMap.get(nodeId);
  if (!s.routeMode) return '';
  const nameOf = (id) => (id ? s.trainMap.get(id).name : null);
  let h = '';
  if (n.trackOcc) h += `<dt>Пути</dt><dd>${n.trackOcc.map((id, k) => `${n.trackName[k]}${n.trackMain[k] ? ' (гл.)' : ''}: ${nameOf(id) || 'свободен'}`).join('<br>')}</dd>`;
  const sideName = { W: 'Горловина (запад)', E: 'Горловина (восток)' };
  for (const side of ['W', 'E']) {
    const L = (n.throat && n.throat[side]) || [];
    if (L.length) h += `<dt>${sideName[side]}</dt><dd>${L.map((r) => `${r.kind === 'in' ? 'приём' : 'отправление'} ${s.trainMap.get(r.tr).name}${n.trackName ? ` — путь ${n.trackName[n.trackPos.indexOf(r.q)]}` : ''}`).join('<br>')}</dd>`;
  }
  if (n.jroutes && n.jroutes.length) h += `<dt>Маршруты</dt><dd>${n.jroutes.map((r) => `проследование ${s.trainMap.get(r.tr).name}`).join('<br>')}</dd>`;
  return h;
}
// кнопки приказа о движении по соседнему пути (только когда один путь закрыт)
function orderButtons(s, se) {
  const out = [];
  for (const ln of ['f', 'r']) {
    const o = ln === 'f' ? 'r' : 'f', N = ln === 'f' ? 'I' : 'II';
    if (se.trk[ln].order) out.push(`<button class="btn small" data-act="wlCancel" data-lane="${ln}">Отменить приказ по пути ${N}</button>`);
    else if (s.trackClosed(se, o) && !s.trackClosed(se, ln)) out.push(`<button class="btn small" data-act="wlForm">Приказ: движение по пути ${N} в обе стороны…</button>`);
  }
  return out.length ? `<div class="row">${out.join('')}</div>` : '';
}
// состояние каждого пути двухпутного перегона
function trackRows(s, se) {
  const t = s.t;
  const nm = (id) => s.nodeMap.get(id).name;
  return `<dl class="kv">${['f', 'r'].map((ln) => {
    const k = se.trk[ln];
    const to = ln === 'f' ? se.b : se.a;
    const st = [];
    if (t < se.closedUntil || t < k.closedUntil) st.push('закрыт');
    if (t < se.absFailUntil || t < k.absFailUntil) st.push('отказ АБ');
    if (k.tsr && t < k.tsrUntil) st.push(`огр. ${k.tsr} км/ч`);
    if (k.order) st.push(k.bidir ? 'в обе стороны по сигналам АБ' : `в обе стороны, один поезд, ≤ ${k.order.vmax} км/ч`);
    const names = (set) => [...set].map((id) => s.trainMap.get(id).name);
    const own = names(k.users[ln]), wrong = names(k.users[ln === 'f' ? 'r' : 'f']);
    const occ = own.join(', ') + (wrong.length ? (own.length ? ', ' : '') + wrong.join(', ') + ' (по неправильному пути)' : '');
    return `<dt>Путь ${ln === 'f' ? 'I' : 'II'} → ${esc(nm(to))}<br><span class="note">${k.bidir ? 'двусторонняя АБ' : 'односторонняя АБ'}</span></dt><dd>${st.length ? `<b>${st.join(', ')}</b>${occ ? '; ' : ''}` : ''}${occ || (st.length ? '' : 'свободен')}</dd>`;
  }).join('')}</dl>`;
}
$('#card').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, id = App.sel && App.sel.id;
  if (a === 'close') { App.sel = null; renderCard(); return; }
  if (a === 'break') both((s) => s.breakTrain(id, 15));
  if (a === 'cap') both((s) => s.setManualCap(id, +b.dataset.v || null));
  if (a === 'rec') { decideRec(b.dataset.rec, b.dataset.ok === '1'); return; }
  if (a === 'delay') both((s) => s.delayTrain(id, 10));
  if (a === 'close30') both((s) => s.closeEdge(id, 30));
  if (a === 'closeI') both((s) => s.closeEdge(id, 30, 'f'));
  if (a === 'wlForm') { App.tab = 'conf'; App.sit = 'wl'; App.sitEdge = id; App.sitMsg = ''; renderSide(); renderConf(); return; }
  if (a === 'wlCancel') both((s) => s.cancelWrongLine(id, b.dataset.lane));
  if (a === 'closeII') both((s) => s.closeEdge(id, 30, 'r'));
  if (a === 'tsr') both((s) => s.speedRestrict(id, 40, 30));
  if (a === 'abs') both((s) => s.absFail(id, 20));
  if (a === 'meet') addMeet(id);
  renderAll();
});
$('#card').addEventListener('change', (ev) => {
  const f = ev.target.dataset.f; if (!f || !App.sel) return;
  const v = ev.target.value;
  if (App.sel.kind === 'node') {
    const n = App.net.nodes.find((x) => x.id === App.sel.id);
    if (f === 'name') n.name = v.trim() || n.name;
    if (f === 'tracks') n.tracks = Math.max(1, Math.min(8, +v || 1));
    if (f === 'type') { n.type = v; if (v === 'station' && !n.tracks) n.tracks = 2; }
    if (f === 'crossovers') n.crossovers = v === '1';
    if (f === 'usefulLen') n.usefulLen = Math.max(400, Math.min(2000, +v || 1050));
    if (f === 'wrongEntry') n.wrongEntry = v;
  } else {
    const e = App.net.edges.find((x) => x.id === App.sel.id);
    if (f === 'len') e.len = Math.max(1, +v || 1) * 1000;
    if (f === 'vmax') e.vmax = Math.max(20, Math.min(250, +v || 80));
    if (f === 'double') e.double = v === '1';
    if (f === 'bidir') e.bidir = v === '1';
  }
  markDirty();
});

// ---------- конфликты ----------
function addExtra(type, from, to, delayMin = 1) {
  const n = App.extraN++;
  const num = 9000 + n;
  const t0 = App.simA.t;
  const spec = { id: 'X' + n, name: `№${num}`, type, from, to, dep: t0 + delayMin * 60, stops: type === 'passenger' || type === 'suburban' ? 'all' : 'ends' };
  both((s) => { s.addTrain({ ...spec }); s.ev(`Назначен внеплановый поезд ${spec.name}`, 'warn'); });
  return spec;
}
function addMeet(edgeId) {
  const e = App.net.edges.find((x) => x.id === edgeId); if (!e) return;
  const st = (id) => App.net.nodes.find((n) => n.id === id).type === 'station';
  if (!st(e.a) || !st(e.b)) { alertSide('Встречные поезда можно пустить только по перегону между двумя станциями.'); return; }
  addExtra('freight', e.a, e.b, 1); addExtra('freight', e.b, e.a, 1);
}
function alertSide(text) { const el = $('#confMsg'); if (el) { el.textContent = text; } }

// ---------- боковая панель ----------
function trainOptions(s, onlyActive) {
  return s.trains.filter((t) => t.state !== 'done' && t.state !== 'invalid' && (!onlyActive || t.state !== 'pending'))
    .map((t) => `<option value="${t.id}"${App.sel && App.sel.id === t.id ? ' selected' : ''}>${esc(t.name)} (${esc(t.ty.label.toLowerCase())})</option>`).join('');
}
function edgeOptions(onlySingle) {
  const nm = (id) => App.net.nodes.find((n) => n.id === id).name;
  return App.net.edges.filter((e) => !onlySingle || !e.double)
    .map((e) => `<option value="${e.id}"${App.sel && App.sel.id === e.id ? ' selected' : ''}>${esc(nm(e.a))} – ${esc(nm(e.b))}${e.double ? '' : ' (однопут.)'}</option>`).join('');
}
function stationOptions(sel) {
  return App.net.nodes.filter((n) => n.type === 'station').map((n) => `<option value="${n.id}"${n.id === sel ? ' selected' : ''}>${esc(n.name)}</option>`).join('');
}
const typeOptions = (sel) => Object.entries(TRAIN_TYPES).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${v.label}</option>`).join('');

const SITS = [
  ['break', '🔧', 'Поломка локомотива', 'Поезд встанет там, где находится'],
  ['close', '⛔', 'Закрыть перегон', 'Окно для ремонта пути'],
  ['meet', '⇄', 'Встречные поезда', 'Два поезда навстречу по однопутке'],
  ['tsr', '🐢', 'Ограничить скорость', 'Временное предупреждение'],
  ['wl', '⇆', 'Движение по соседнему пути', 'Приказ при закрытии одного пути'],
  ['abs', '🚦', 'Отказ сигналов', 'Автоблокировка погасла'],
  ['delay', '⏱', 'Задержать поезд', 'Поезд опоздает с отправлением'],
  ['cap', '🎚', 'Скорость поезда', 'Диспетчер ограничивает скорость'],
  ['extra', '＋', 'Внеплановый поезд', 'Добавить поезд в график'],
];
// форма приказа: движение по одному пути двухпутки в обе стороны
function wlForm(s) {
  const nm = (id) => App.net.nodes.find((n) => n.id === id)?.name || '?';
  const cand = s.net.edges.filter((e) => e.double && (s.trackClosed(e, 'f') !== s.trackClosed(e, 'r')));
  if (!cand.length) return '<p class="note" style="margin:0">Приказ нужен, когда на двухпутном перегоне закрыт один путь. Сейчас таких перегонов нет: сначала закройте путь в ситуации «Закрыть перегон».</p>';
  const pick = cand.find((e) => e.id === App.sitEdge) || cand[0];
  const ln = s.trackClosed(pick, 'f') ? 'r' : 'f';
  const k = pick.trk[ln];
  const opts = cand.map((e) => `<option value="${e.id}"${e.id === pick.id ? ' selected' : ''}>${esc(nm(e.a))} – ${esc(nm(e.b))}</option>`).join('');
  const N = ln === 'f' ? 'I' : 'II', M = ln === 'f' ? 'II' : 'I';
  return `<label>Перегон<select id="cfWlE" data-wl="1">${opts}</select></label>
    <p class="note" style="margin:0">Путь ${M} закрыт. По пути ${N} поезда пойдут в обе стороны.</p>
    <p class="note" style="margin:0">${k.bidir ? 'На пути двусторонняя автоблокировка: после смены направления поезда идут попутно по сигналам АБ.' : 'На пути односторонняя автоблокировка: по неправильному пути — один поезд на перегоне, отправление только при свободном пути на станции приёма.'}</p>
    ${k.bidir ? '' : '<label>Скорость по приказу, км/ч<input type="number" id="cfWlV" value="60" min="10" max="120" step="5"></label>'}
    <button class="btn primary go" data-c="wl" data-e="${pick.id}" data-lane="${ln}">Отдать приказ</button>`;
}
$('#pane-conf').addEventListener('change', (ev) => { if (ev.target.dataset.wl) { App.sitEdge = ev.target.value; renderConf(); } });
// выбор пути двухпутного перегона в формах «Ситуаций»
function trackOpts(edgeId) {
  const nm = (id) => App.net.nodes.find((n) => n.id === id)?.name || '?';
  const e = App.net.edges.find((x) => x.id === edgeId);
  if (!e || !e.double) return '<option value="">весь перегон (однопутный)</option>';
  return `<option value="">оба пути</option><option value="f">путь I → ${esc(nm(e.b))}</option><option value="r">путь II → ${esc(nm(e.a))}</option>`;
}
function trackSel(id, edgeSelId) {
  const first = App.net.edges.find((e) => App.sel && App.sel.id === e.id) || App.net.edges[0];
  return `<label>Какой путь<select id="${id}">${trackOpts(first && first.id)}</select></label>`;
}
$('#pane-conf').addEventListener('change', (ev) => {
  const t = ev.target.dataset.trk; if (!t) return;
  const box = $('#' + t); if (box) box.innerHTML = trackOpts(ev.target.value);
});
function renderConf() {
  const s = sim();
  const el = $('#pane-conf');
  const sts = App.net.nodes.filter((n) => n.type === 'station');
  const toast = `<div class="toast" id="confMsg" role="status">${esc(App.sitMsg || '')}</div>`;
  if (!App.sit) {
    el.innerHTML = `${toast}<p class="cap">Устройте сбой и посмотрите, как диспетчер и ассистент с ним справятся. Сбой происходит сразу в обеих моделях — с ассистентом и без.</p>
      <div class="tiles">${SITS.map(([k, ic, t, d]) => `<button class="tile" data-sit="${k}"><i aria-hidden="true">${ic}</i><b>${t}</b><span>${d}</span></button>`).join('')}</div>
      <p class="note" style="margin-top:12px">Подсказка: щёлкните поезд или перегон на карте — там есть те же действия.</p>`;
    return;
  }
  const [k, ic, t, d] = SITS.find((x) => x[0] === App.sit);
  const mins = (id, v, max) => `<label>На сколько минут<input type="number" id="${id}" value="${v}" min="1" max="${max}"></label>`;
  const f = {
    break: `<label>Поезд<select id="cfBrT">${trainOptions(s, true) || '<option value="">нет поездов в пути</option>'}</select></label>${mins('cfBrM', 15, 240)}<button class="btn primary go" data-c="break">Применить</button>`,
    close: `<label>Перегон<select id="cfClE" data-trk="cfClK">${edgeOptions()}</select></label>${trackSel('cfClK', 'cfClE')}${mins('cfClM', 30, 480)}<button class="btn primary go" data-c="close">Закрыть</button>`,
    meet: `<label>Перегон<select id="cfMeetE">${edgeOptions(true) || '<option value="">нет однопутных перегонов</option>'}</select></label><button class="btn primary go" data-c="meet">Пустить</button>`,
    wl: wlForm(s),
    tsr: `<label>Перегон<select id="cfTsE" data-trk="cfTsK">${edgeOptions()}</select></label>${trackSel('cfTsK', 'cfTsE')}<label>Скорость, км/ч<input type="number" id="cfTsV" value="40" min="10" max="120" step="5"></label><button class="btn primary go" data-c="tsr">Выдать</button>`,
    abs: `<p class="note" style="margin:0">Сигналы погасли: по перегону один поезд, не быстрее 20 км/ч.</p><label>Перегон<select id="cfAbE" data-trk="cfAbK">${edgeOptions()}</select></label>${trackSel('cfAbK', 'cfAbE')}${mins('cfAbM', 20, 240)}<button class="btn primary go" data-c="abs">Применить</button>`,
    cap: `<label>Поезд<select id="cfCpT">${trainOptions(s, true) || '<option value="">нет поездов в пути</option>'}</select></label><label>Не выше, км/ч<select id="cfCpV"><option value="0">без ограничения</option>${[100, 80, 60, 40, 20].map((v) => `<option value="${v}"${v === 60 ? ' selected' : ''}>${v}</option>`).join('')}</select></label><button class="btn primary go" data-c="cap">Применить</button>`,
    delay: `<label>Поезд<select id="cfDlT">${trainOptions(s, false)}</select></label>${mins('cfDlM', 10, 180)}<button class="btn primary go" data-c="delay">Задержать</button>`,
    extra: `<label>Категория<select id="cfXT">${typeOptions('freight')}</select></label><label>Откуда<select id="cfXF">${stationOptions(sts[0]?.id)}</select></label><label>Куда<select id="cfXTo">${stationOptions(sts[sts.length - 1]?.id)}</select></label><button class="btn primary go" data-c="extra">Назначить</button>`,
  }[k];
  el.innerHTML = `<button class="back" data-sit="">← Все ситуации</button>
    <h2 style="margin-top:0"><span aria-hidden="true">${ic}</span> ${t}</h2><p class="cap">${d}</p>
    <div class="sitform">${f}</div>`;
}
$('#pane-live').addEventListener('click', (ev) => {
  const rb = ev.target.closest('[data-rec]');
  if (rb) { decideRec(rb.dataset.rec, rb.dataset.ok === '1'); return; }
  const rl = ev.target.closest('li[data-trr]');
  if (rl && !ev.target.closest('button')) { focusTrain(rl.dataset.trr); return; }
  if (ev.target.closest('[data-act=help-ok]')) { store.set('rail.help', '1'); renderLive(); return; }
  const li = ev.target.closest('li[data-tr]');
  if (!li) return;
  if (li.dataset.tr) focusTrain(li.dataset.tr);
  else if (li.dataset.e) { App.sel = { kind: 'edge', id: li.dataset.e }; renderCard(); }
});
function renderLive() {
  const el = $('#pane-live');
  const help = SCENARIOS[App.scen] && SCENARIOS[App.scen].demo ? `<div class="help"><h3>Демонстрация</h3><ol>
    <li>Нажмите «▶ Пуск». Через минуту ИИ предложит машинисту грузового №2401 снизить скорость — модель встанет на паузу.</li>
    <li>Прочитайте причину, прогноз и экономию и нажмите «Принять».</li>
    <li>Переключите карту на «Без ассистента»: там №2401 останавливается у выходного сигнала разъезда и ждёт скорого №11.</li>
    <li>Во вкладке «Итоги» сравните остановки и расход энергии; в карточке рекомендации — прогноз и факт.</li></ol></div>`
    : store.get('rail.help') ? '' : `<div class="help"><h3>Как начать</h3><ol>
    <li>Нажмите «▶ Пуск» — поезда пойдут по графику.</li>
    <li>Во вкладке «Ситуации» устройте сбой: поломку, закрытие перегона, встречные поезда.</li>
    <li>Во вкладке «Итоги» посмотрите, помог ли ИИ-ассистент.</li></ol>
    <button class="btn small" data-act="help-ok">Понятно</button></div>`;
  el.innerHTML = `${help}<div id="liveBanner"></div><div class="kpis3" id="kpis"></div>
    <div id="issues"></div>
    <h2>Последние события</h2><ul class="recent" id="recent"></ul>
    <details class="logd" id="logd"${App.logOpen ? ' open' : ''}><summary>Весь журнал</summary><div id="logBox"></div></details>`;
  $('#logd').addEventListener('toggle', (e) => { App.logOpen = e.target.open; if (App.logOpen) renderLog(); });
  updateLive();
}
// где сейчас поезд: станция или перегон
function trainPlace(s, tr) {
  const r = tr.seq && tr.seq[tr.headIdx];
  if (!r || tr.state === 'pending') return '';
  if (r.kind === 'node') return s.nodeMap.get(r.nodeId).name;
  return s.edgeName(s.edgeMap.get(r.edgeId));
}
function focusTrain(id) {
  const s = sim(), tr = s.trainMap.get(id); if (!tr || !tr.seq) return;
  const r = tr.seq[tr.headIdx];
  let x, y;
  if (r.kind === 'node') { const n = s.nodeMap.get(r.nodeId); x = n.x; y = n.y; }
  else { const e = s.edgeMap.get(r.edgeId), a = s.nodeMap.get(e.a), b = s.nodeMap.get(e.b); x = (a.x + b.x) / 2; y = (a.y + b.y) / 2; }
  App.cam.z = Math.max(App.cam.z, App.net.compact ? 0.9 : 1.2); App.cam.x = x - (W > 700 ? 150 / App.cam.z : 0); App.cam.y = y + (W <= 700 ? (H * 0.22) / App.cam.z : 0); App.userCam = true;
  App.sel = { kind: 'train', id }; renderCard();
}
function recDetails(r, s) {
  const i = r.info || {}, out = [];
  if (i.reason) out.push(`<div class="rr"><span class="rk">Причина</span><span>${esc(i.reason)}</span></div>`);
  if (i.expect) out.push(`<div class="rr"><span class="rk">Ожидаемый результат</span><span>${esc(i.expect)}</span></div>`);
  if (i.without) out.push(`<div class="rr"><span class="rk">Без вмешательства</span><span>${esc(i.without)}</span></div>`);
  const sv = [];
  if (i.savingSec > 0) sv.push(`~${Math.max(1, Math.round(i.savingSec / 60))} мин`);
  if (i.savingKWh > 0) sv.push(`~${i.savingKWh} кВт·ч`);
  if (sv.length) out.push(`<div class="rr"><span class="rk">Экономия</span><span>${sv.join(', ')}</span></div>`);
  if (r.forecast && r.outcome) {
    const f = r.forecast, o = r.outcome;
    out.push(`<div class="rr"><span class="rk">Прогноз / факт</span><span>${f.stop ? 'с остановкой' : 'без остановки'}, ${fmtClock(f.passAt, false)} / ${o.stopped ? 'с остановкой' : 'без остановки'}, ${fmtClock(o.passAt, false)}</span></div>`);
  } else if (r.forecast && (r.status === 'active')) out.push(`<div class="rr"><span class="rk">Прогноз</span><span>${r.forecast.stop ? 'с остановкой' : 'без остановки'}, ${fmtClock(r.forecast.passAt, false)}</span></div>`);
  return out.join('');
}
function renderRecs(s) {
  if (!s || !s.assistant) return '';
  const pend = s.recs.filter((r) => r.status === 'pending');
  const recent = s.recs.filter((r) => !r.safety && r.status !== 'pending' && r.status !== 'replaced' && (r.forecast || s.t - r.createdAt < 1800)).slice(-4).reverse();
  const confirm = s.approval === 'confirm';
  const stLabel = { active: 'исполняется', done: 'исполнено', rejected: 'отклонено', expired: 'неактуально' };
  let h = `<details class="grp ai" open><summary><span aria-hidden="true">💡</span> <span>${confirm ? 'Рекомендации ИИ — ждут решения ({0})'.replace('{0}', pend.length) : 'Рекомендации ИИ — исполняются автоматически'}</span></summary><ul>`;
  for (const r of pend) h += `<li class="rec" data-trr="${r.train}"><div class="r1"><b>${esc(r.action)}</b></div>${recDetails(r, s)}
    <div class="rb"><button class="btn small primary" data-rec="${r.id}" data-ok="1">Принять</button><button class="btn small" data-rec="${r.id}" data-ok="0">Отклонить</button></div></li>`;
  if (!pend.length && confirm) h += '<li class="none"><span>Новых рекомендаций нет.</span></li>';
  for (const r of recent) h += `<li class="rec done" data-trr="${r.train}"><div class="r1"><span>${esc(r.action)}</span><span class="mn">${stLabel[r.status] || ''}</span></div>${recDetails(r, s)}</li>`;
  if (!pend.length && !recent.length && !confirm) h += '<li class="none"><span>Пока нет.</span></li>';
  return h + '</ul></details>';
}
function updateLive() {
  const s = sim(), m = s.summary();
  const ban = $('#liveBanner'); if (!ban) return;
  const iss = s.issues();
  const dl = iss.find((x) => x.type === 'deadlock');
  const waiting = iss.filter((x) => x.type === 'waiting');
  const held = iss.filter((x) => x.type === 'held');
  const faults = iss.filter((x) => ['breakdown', 'closed', 'absfail', 'tsr'].includes(x.type));
  const viewName = App.view === 'A' ? 'Показана модель с ассистентом' : 'Показана модель без ассистента';
  let cls, title, text, tip = '';
  if (s.t < 1 && !App.running) { cls = 'idle'; title = 'Движение не запущено'; text = 'Нажмите «▶ Пуск», чтобы поезда пошли по графику.'; }
  else if (dl) {
    cls = 'bad'; title = 'Тупик: движение встало';
    text = `${dl.trains.length} поезд(ов) ждут друг друга и сами не разъедутся.`;
    if (!App.assistOn) tip = 'Включите ИИ-ассистента — он не выпускает поезда туда, где они застрянут.';
    else if (App.view === 'B' && !App.simA.trains.some((t) => t.deadlock)) tip = 'В модели с ассистентом тупика нет — переключите карту на «С ассистентом».';
    else if (App.view === 'A') tip = 'Ассистент не уберёг от тупика. Попробуйте другой шаблон в окне кода.';
  } else if (faults.length || waiting.length) {
    cls = 'warn'; title = 'Есть помехи движению';
    text = waiting.length ? `${waiting.length} поезд(ов) ждут, сбоев: ${faults.length}. Подробности ниже.` : `Действуют ограничения или сбои: ${faults.length}. Поезда идут. Подробности ниже.`;
  } else { cls = 'good'; title = 'Движение идёт по графику'; text = 'Сбоев нет, поезда идут без задержек.'; }
  const np = App.simA && App.simA.recs ? App.simA.recs.filter((r) => r.status === 'pending').length : 0;
  if (np && cls !== 'bad') tip = `Ожидает решения диспетчера: ${np} рекомендац. ИИ — ниже.`;
  const icon = { idle: '⏸', bad: '⛔', warn: '⚠', good: '✓' }[cls];
  const bh = `<div class="banner ${cls}"><div class="bi" aria-hidden="true">${icon}</div><div><div class="bt">${esc(title)}</div><div class="bx">${esc(text)}</div>${tip ? `<div class="bx tip">${esc(tip)}</div>` : ''}<div class="bv">${viewName}</div></div></div>`;
  if (ban._h !== bh) { ban.innerHTML = bh; ban._h = bh; }

  const moving = s.trains.filter((t) => t.state === 'running' || t.state === 'dwell').length;
  const k = [[String(moving), 'В пути'], [`${m.completed} из ${m.total}`, 'Прибыло'], [m.completed ? `${m.avgDelay.toFixed(1)} мин` : '—', 'Ср. опоздание']];
  const kh = k.map(([v, l]) => `<div class="kpi"><b>${esc(v)}</b><span>${l}</span></div>`).join('');
  const kb = $('#kpis'); if (kb._h !== kh) { kb.innerHTML = kh; kb._h = kh; }

  // группы: тупик, сбои, ожидание, решения ассистента
  const wmin = (tr) => (tr.waitSince != null ? Math.round((s.t - tr.waitSince) / 60) : null);
  const trRow = (id, reason) => {
    const tr = s.trainMap.get(id); if (!tr) return '';
    const mins = wmin(tr);
    return `<li data-tr="${id}"><div class="r1"><b>${esc(tr.name)}</b><span class="ty">${esc(tr.ty.label.toLowerCase())}</span>${mins != null ? `<span class="mn">${mins} мин</span>` : ''}</div>
      <div class="r2"><span>${esc(trainPlace(s, tr))}</span></div>${reason ? `<div class="r3"><span>${esc(reason)}</span></div>` : ''}</li>`;
  };
  const groups = [];
  // рекомендации ИИ (только модель с ассистентом)
  const recHtml = renderRecs(App.simA);
  if (dl) groups.push(['bad', '⛔', 'Заблокированы в тупике ({0})', dl.trains.length, dl.trains.map((id) => trRow(id, s.trainMap.get(id).waitReason)).join('')]);
  if (faults.length) groups.push(['warn', '🔧', 'Сбои на линии ({0})', faults.length, faults.map((x) => `<li ${x.trains ? `data-tr="${x.trains[0]}"` : `data-tr="" data-e="${x.edge}"`}><div class="r1"><span>${esc(x.text)}</span></div></li>`).join('')]);
  if (waiting.length) groups.push(['warn', '🔴', 'Ждут у красного сигнала ({0})', waiting.length, waiting.map((x) => trRow(x.trains[0], s.trainMap.get(x.trains[0]).waitReason)).join('')]);
  const drv = s === App.simA ? s.trains.filter((t) => t.speedCap != null && t.state === 'running') : [];
  const disp = s.trains.filter((t) => t.hold && t.state !== 'done');
  const advRow = (tr, what, why) => `<li data-tr="${tr.id}"><div class="r1"><b>${esc(tr.name)}</b><span class="ty">${esc(tr.ty.label.toLowerCase())}</span><span class="mn">${esc(what)}</span></div>${why ? `<div class="r3"><span>${esc(why)}</span></div>` : ''}</li>`;
  if (drv.length) groups.push(['ai', '🎚', 'Советы машинистам ({0})', drv.length, drv.map((tr) => advRow(tr, `≤ ${tr.speedCap} км/ч`, tr.capReason)).join('')]);
  if (disp.length) groups.push(['ai', '🗂', 'Советы диспетчеру ({0})', disp.length, disp.map((tr) => advRow(tr, 'задержать', tr.hold.reason)).join('')]);
  App.grpOpen = App.grpOpen || {};
  const gh = groups.length
    ? groups.map(([c, ic, t, n, items], gi) => `<details class="grp ${c}" data-g="${t}"${(App.grpOpen[t] ?? gi === 0) ? ' open' : ''}><summary><span aria-hidden="true">${ic}</span> <span>${t.replace('{0}', n)}</span></summary><ul>${items}</ul></details>`).join('') +
      '<p class="note">Нажмите на поезд, чтобы найти его на карте.</p>'
    : '';
  const ib = $('#issues');
  const gh2 = recHtml + gh;
  if (ib._h !== gh2) {
    const gh = gh2;
    ib.innerHTML = gh; ib._h = gh;
    ib.querySelectorAll('details.grp').forEach((d) => d.addEventListener('toggle', () => { App.grpOpen[d.dataset.g] = d.open; }));
  }
  // последние события
  const ev = s.events.slice(-5).reverse();
  const rh = ev.length ? ev.map((x) => `<li class="${x.kind}"><time>${fmtClock(x.t, false)}</time><span>${esc(x.text)}</span></li>`).join('') : '<li class="none"><span>Событий пока нет.</span></li>';
  const rb = $('#recent'); if (rb._h !== rh) { rb.innerHTML = rh; rb._h = rh; }
  if (App.logOpen) renderLog();
}
function renderIssues() {
  const box = $('#issues'); if (!box) return;
  const s = sim();
  const list = s.issues();
  box.innerHTML = list.length
    ? `<ul class="list click">${list.slice(0, 30).map((x) => `<li class="sev${x.sev}" data-tr="${x.trains ? x.trains[0] || '' : ''}" data-e="${x.edge || ''}"><span class="grow">${esc(x.text)}</span></li>`).join('')}</ul>`
    : '<div class="empty">Нарушений нет: все поезда идут или стоят по графику.</div>';
}
$('#pane-conf').addEventListener('click', (ev) => {
  const st = ev.target.closest('[data-sit]');
  if (st) { App.sit = st.dataset.sit || null; App.sitMsg = ''; renderConf(); return; }
  const li = ev.target.closest('li[data-tr]');
  if (li) { if (li.dataset.tr) App.sel = { kind: 'train', id: li.dataset.tr }; else if (li.dataset.e) App.sel = { kind: 'edge', id: li.dataset.e }; renderCard(); return; }
  const b = ev.target.closest('[data-c]'); if (!b) return;
  const c = b.dataset.c, v = (id) => $('#' + id).value;
  const msg = (t) => { App.sitMsg = t; };
  if (c === 'meet') { if (!v('cfMeetE')) return; addMeet(v('cfMeetE')); msg('Назначены два встречных грузовых поезда.'); }
  if (c === 'wl') {
    const res = [App.simA, App.simB].map((s) => s.orderWrongLine(b.dataset.e, b.dataset.lane, +(($('#cfWlV') || {}).value || 0)));
    msg(res[0].ok ? 'Приказ отдан. Он действует, пока соседний путь закрыт.' : 'Приказ не принят: ' + res[0].why);
  }
  if (c === 'cap') { if (!v('cfCpT')) return; both((s) => s.setManualCap(v('cfCpT'), +v('cfCpV') || null)); msg('Ограничение передано машинисту.'); }
  if (c === 'break') { if (!v('cfBrT')) return; both((s) => s.breakTrain(v('cfBrT'), +v('cfBrM') || 15)); msg('Поезд остановлен.'); }
  if (c === 'close') { both((s) => s.closeEdge(v('cfClE'), +v('cfClM') || 30, v('cfClK'))); msg(v('cfClK') ? 'Путь закрыт. Поезда этого направления будут ждать, пока диспетчер не организует движение по соседнему пути (ситуация «Движение по соседнему пути»).' : 'Перегон закрыт. Поезда, уже вышедшие на него, доедут.'); }
  if (c === 'tsr') { both((s) => s.speedRestrict(v('cfTsE'), +v('cfTsV') || 40, 40, v('cfTsK'))); msg('Ограничение действует 40 минут.'); }
  if (c === 'abs') { both((s) => s.absFail(v('cfAbE'), +v('cfAbM') || 20, v('cfAbK'))); msg('Автоблокировка отключена.'); }
  if (c === 'delay') { if (!v('cfDlT')) return; both((s) => s.delayTrain(v('cfDlT'), +v('cfDlM') || 10)); msg('Задержка назначена.'); }
  if (c === 'extra') {
    if (v('cfXF') === v('cfXTo')) { msg('Выберите разные станции.'); return; }
    const sp = addExtra(v('cfXT'), v('cfXF'), v('cfXTo'), 1); msg(`Поезд ${sp.name} отправится через минуту.`);
  }
  if (App.sitMsg !== 'Выберите разные станции.') App.sit = null;
  if (!App.running) { App.running = true; updatePlay(); }
  renderAll();
});

function renderNet() {
  const el = $('#pane-net');
  const nm = (id) => App.net.nodes.find((n) => n.id === id)?.name || '?';
  const sts = App.net.nodes.filter((n) => n.type === 'station');
  const tools = [['select', '↖', 'Выбор'], ['station', '▭', 'Станция'], ['junction', '◇', 'Стрел. пост'], ['single', '─', 'Однопутка'], ['double', '═', 'Двухпутка'], ['delete', '✕', 'Удалить']];
  el.innerHTML = `
    <div class="seg" role="group" aria-label="Режим" style="margin-bottom:12px"><button id="modeSim" aria-pressed="${App.mode === 'sim'}">Движение</button><button id="modeEdit" aria-pressed="${App.mode === 'edit'}">Редактировать схему</button></div>
    <h2>${esc(SCENARIOS[App.scen].title)}</h2><p class="note">${esc(SCENARIOS[App.scen].note)}</p>
    <h2>Инструменты конструктора</h2>
    ${App.mode !== 'edit' ? '<p class="note">Чтобы изменить схему, нажмите «Редактировать схему». Любое изменение начинает моделирование заново.</p>' : ''}
    <div class="tools">${tools.map(([k, i, l]) => `<button data-tool="${k}" aria-pressed="${App.mode === 'edit' && App.tool === k}" ${App.mode !== 'edit' ? 'disabled' : ''}><span style="font-size:16px">${i}</span>${l}</button>`).join('')}</div>
    <h2>График движения (${App.specs.length})</h2>
    ${App.specs.length ? `<ul class="list">${App.specs.map((t) => `<li><span class="sw" style="background:var(${TYPE_COLOR[t.type]})"></span><span class="grow">${esc(t.name)} <span class="t2">${esc(TRAIN_TYPES[t.type].label)}, ${esc(nm(t.from))} → ${esc(nm(t.to))}, отпр. ${fmtClock(t.dep, false)}</span></span><button data-del="${t.id}" aria-label="Удалить поезд">✕</button></li>`).join('')}</ul>` : '<div class="empty">Поездов нет. Добавьте нитку графика ниже.</div>'}
    <h2>Добавить поезда в график</h2>
    <div class="form">
      <label>Категория<select id="nfType">${typeOptions('passenger')}</select></label>
      <label>Остановки<select id="nfStops"><option value="all">На всех станциях</option><option value="ends">Только конечные</option></select></label>
      <label>Откуда<select id="nfFrom">${stationOptions(sts[0]?.id)}</select></label>
      <label>Куда<select id="nfTo">${stationOptions(sts[sts.length - 1]?.id)}</select></label>
      <label>Первое отправление<input type="time" id="nfDep" value="06:10"></label>
      <label>Номер первого<input type="number" id="nfNum" value="${8000 + App.specs.length * 2}"></label>
      <label>Сколько поездов<input type="number" id="nfCount" value="1" min="1" max="30"></label>
      <label>Интервал, мин<input type="number" id="nfEvery" value="30" min="3" max="240"></label>
    </div>
    <div class="row" style="margin-top:8px"><button class="btn primary small" id="nfAdd">Добавить в график</button><button class="btn small danger" id="nfClear">Очистить график</button></div>
    <p class="note" id="nfMsg" role="status"></p>
    <details style="margin-top:14px"><summary>Схема в формате JSON</summary>
      <p class="note">Скопируйте текст, чтобы сохранить полигон, или вставьте свой и нажмите «Загрузить».</p>
      <textarea id="jsonBox" style="width:100%;height:140px;font:12px var(--mono);border:1px solid var(--line);border-radius:8px;background:var(--panel-2);padding:6px"></textarea>
      <div class="row" style="margin-top:6px"><button class="btn small" id="jsonShow">Показать текущую</button><button class="btn small" id="jsonLoad">Загрузить</button></div>
    </details>`;
}
$('#pane-net').addEventListener('click', (ev) => {
  const tb = ev.target.closest('[data-tool]');
  if (tb) { App.tool = tb.dataset.tool; App.edgeFrom = null; renderNet(); updateHint(); return; }
  const del = ev.target.closest('[data-del]');
  if (del) { App.specs = App.specs.filter((t) => t.id !== del.dataset.del); markDirty(); return; }
  const id = ev.target.id;
  if (id === 'nfAdd') {
    const type = $('#nfType').value, from = $('#nfFrom').value, to = $('#nfTo').value;
    if (!from || !to || from === to) { $('#nfMsg').textContent = 'Выберите две разные станции.'; return; }
    if (!findPath(App.net, from, to)) { $('#nfMsg').textContent = 'Между станциями нет пути. Соедините их перегонами.'; return; }
    const [h, m] = ($('#nfDep').value || '06:10').split(':').map(Number);
    let dep = (h * 3600 + m * 60) - START_CLOCK; if (dep < 0) dep += 86400;
    const count = Math.max(1, Math.min(30, +$('#nfCount').value || 1)), every = Math.max(3, +$('#nfEvery').value || 30) * 60;
    const num0 = +$('#nfNum').value || 8000;
    for (let i = 0; i < count; i++) App.specs.push({ id: 'U' + (App.idc++), name: `№${num0 + i * 2}`, type, from, to, dep: dep + i * every, stops: $('#nfStops').value });
    App.specs.sort((a, b) => a.dep - b.dep);
    markDirty(); return;
  }
  if (id === 'nfClear') { App.specs = []; markDirty(); return; }
  if (id === 'jsonShow') { $('#jsonBox').value = JSON.stringify({ net: App.net, trains: App.specs }, null, 1); return; }
  if (id === 'jsonLoad') {
    try {
      const d = JSON.parse($('#jsonBox').value);
      if (!d.net || !Array.isArray(d.net.nodes) || !Array.isArray(d.net.edges)) throw new Error('нет net.nodes или net.edges');
      App.net = d.net; App.specs = Array.isArray(d.trains) ? d.trains : []; App.sel = null; markDirty(); fitView();
    } catch (err) { alert(TR('Не удалось загрузить: ' + err.message)); }
  }
});

function renderCmp() {
  const a = App.simA.summary(), b = App.simB.summary();
  const f1 = (x) => (x == null ? '—' : x.toFixed(1));
  const pct = (x) => (x == null ? '—' : Math.round(x) + '%');
  const rows = [
    ['Прибыло поездов', `${b.completed} из ${b.total}`, `${a.completed} из ${a.total}`],
    ['Среднее опоздание, мин', f1(b.avgDelay), f1(a.avgDelay)],
    ['Опоздание с учётом категорий, мин', f1(b.wDelay), f1(a.wDelay)],
    ['Прибыли вовремя (до 5 мин)', pct(b.punctual), pct(a.punctual)],
    ['Тупиковых ситуаций', b.deadlocks, a.deadlocks],
    ['Поездов в тупике сейчас', b.stuck, a.stuck],
    ['Стоят дольше 10 мин', b.longStops, a.longStops],
    ['Вынужденных остановок', b.unplanned, a.unplanned],
    ['Расход энергии, МВт·ч', (b.energy / 1000).toFixed(2), (a.energy / 1000).toFixed(2)],
    ['Решений ассистента', '—', `${a.holds} задерж., ${a.reroutes} маршр.`],
    ['Советов машинистам по скорости', '—', String(a.advices)],
    ['Рекомендации: принято / отклонено / неактуально', '—', a.recs.proposed ? `${a.recs.accepted} / ${a.recs.rejected} / ${a.recs.expired}` : `${a.recs.auto} (автоматически)`],
    ['Прогноз «без остановки» сбылся', '—', a.recs.forecasts ? `${a.recs.forecastOk} из ${a.recs.forecasts}` : '—'],
  ];
  let verdict;
  if (!App.assistOn) verdict = 'Ассистент выключен: обе модели работают одинаково. Включите его в окне кода.';
  else if (App.simA.t < 600) verdict = 'Запустите движение: сравнение появится через несколько минут модельного времени.';
  else {
    const parts = [];
    if (a.completed !== b.completed) parts.push(`с ассистентом прибыло ${a.completed} поездов, без него ${b.completed}`);
    if (b.stuck > a.stuck) parts.push(`без ассистента в тупике ${b.stuck} поезд(ов), с ассистентом ${a.stuck}`);
    const d = b.avgDelay - a.avgDelay;
    if (Math.abs(d) >= 0.3) parts.push(d > 0 ? `ассистент сократил среднее опоздание на ${d.toFixed(1)} мин` : `с ассистентом среднее опоздание больше на ${(-d).toFixed(1)} мин: проверьте, не слишком ли часто он задерживает поезда`);
    else parts.push('по опозданиям модели пока идут вровень');
    if (a.unplanned !== b.unplanned) parts.push(`вынужденных остановок с ассистентом ${a.unplanned}, без него ${b.unplanned}`);
    const ep = b.energy > 0 ? Math.round((1 - a.energy / b.energy) * 100) : 0;
    if (Math.abs(ep) >= 3) parts.push(ep > 0 ? `расход энергии меньше на ${ep}%` : `расход энергии больше на ${-ep}%`);
    if (a.errors) parts.push(`в коде ассистента ${a.errors} ошибок, смотрите консоль`);
    verdict = parts.map((p) => TR(p)).join('; ') + '.';
    verdict = verdict[0].toUpperCase() + verdict.slice(1);
  }
  const busy = App.fastRun;
  const wasOpen = $('#pane-cmp details.more')?.open;
  $('#pane-cmp').innerHTML = `<h2>Помог ли ассистент?</h2><div class="verdict">${esc(verdict)}</div>
    <p><button class="btn" id="btnFast" ${busy ? 'disabled' : ''}>${busy ? 'Идёт расчёт… ' + fmtClock(App.simA.t, false) : 'Прогнать обе модели до конца смены (4 ч)'}</button></p>
    <table class="cmp"><thead><tr><th></th><th>Без ассистента</th><th>С ассистентом</th></tr></thead>
    <tbody>${[0, 1, 4, 7, 8].map((i) => rows[i]).map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td class="a">${r[2]}</td></tr>`).join('')}</tbody></table>
    <details class="more" style="margin-top:10px"><summary>Подробнее</summary>
    <table class="cmp"><tbody>${[2, 3, 5, 6, 9, 10, 11, 12].map((i) => rows[i]).map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td class="a">${r[2]}</td></tr>`).join('')}</tbody></table></details>
    <h2>Среднее опоздание по времени</h2><div class="chartbox"><canvas id="chart"></canvas>
    <div class="chartkey"><span><span class="sw" style="background:var(--track-dim)"></span> без ассистента</span><span><span class="sw" style="background:var(--ai)"></span> с ассистентом</span></div></div>
    <p class="note">Опоздание с учётом категорий: скорые весят втрое, пассажирские вдвое больше грузовых, как при оценке работы участка диспетчером.</p>`;
  if (wasOpen) $('#pane-cmp details.more').open = true;
  drawChart();
  const fb = $('#btnFast'); if (fb) fb.onclick = fastRun;
}
function fastRun() {
  if (App.fastRun) return;
  App.fastRun = true; App.running = false; updatePlay();
  App.fastPrevApproval = App.simA.approval; App.simA.approval = 'auto'; // без диспетчера: рекомендации исполняются сразу
  const END = 4 * 3600;
  const chunk = () => {
    const t0 = performance.now();
    while (performance.now() - t0 < 40 && App.simA.t < END) { App.simA.step(0.5); App.simB.step(0.5); }
    renderCmp();
    if (App.simA.t < END) setTimeout(chunk, 0);
    else { App.fastRun = false; App.simA.approval = App.fastPrevApproval || 'auto'; renderCmp(); liveUpdate(); }
  };
  renderCmp(); setTimeout(chunk, 0);
}
function drawChart() {
  const cv = $('#chart'); if (!cv) return;
  const r = cv.getBoundingClientRect(); const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, h = r.height, pl = 30, pb = 18, pt = 6;
  const A = App.simA.m.hist, B = App.simB.m.hist;
  g.clearRect(0, 0, w, h);
  const tMax = Math.max(1800, App.simA.t);
  const yMax = Math.max(5, ...A.map((x) => x.avgDelay), ...B.map((x) => x.avgDelay)) * 1.1;
  g.font = '11px ' + getFont(); g.fillStyle = C['--muted']; g.strokeStyle = C['--line']; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pt + (h - pt - pb) * (1 - i / 4);
    g.beginPath(); g.moveTo(pl, y); g.lineTo(w, y); g.stroke();
    g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(Math.round((yMax * i) / 4), pl - 4, y);
  }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let i = 0; i <= 4; i++) g.fillText(fmtClock((tMax * i) / 4, false), pl + ((w - pl - 10) * i) / 4, h - pb + 3);
  const line = (arr, col) => {
    g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
    arr.forEach((p, i) => { const x = pl + ((w - pl - 10) * p.t) / tMax, y = pt + (h - pt - pb) * (1 - p.avgDelay / yMax); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  };
  line(B, C['--track-dim']); line(A, C['--ai']);
}

function renderLog() {
  const box = $('#logBox'); if (!box) return;
  const s = sim();
  const ev = s.events.slice(-120).reverse();
  const al = App.simA.assistLog.slice(-120).reverse();
  const li = (x) => `<li><time>${fmtClock(x.t)}</time><span class="${x.kind}">${esc(x.text)}</span></li>`;
  const html = `<h2>Решения ассистента</h2>${al.length ? `<ul class="log">${al.map(li).join('')}</ul>` : '<div class="empty">Ассистент пока не принимал решений.</div>'}
    <h2>События участка (${App.view === 'A' ? 'с ассистентом' : 'без ассистента'})</h2>${ev.length ? `<ul class="log">${ev.map(li).join('')}</ul>` : '<div class="empty">Событий пока нет.</div>'}`;
  if (box._h !== html) { box.innerHTML = html; box._h = html; }
}

function renderLegend() {
  $('#legend').innerHTML = '<details><summary>Обозначения</summary><div class="lg">' + Object.entries(TRAIN_TYPES).map(([k, v]) => `<span><span class="sw" style="background:var(${TYPE_COLOR[k]})"></span>${v.label}</span>`).join('') +
    `<span><span class="sw" style="background:var(--reserve)"></span>заданный маршрут</span><span><span class="dot" style="background:var(--sig-r)"></span><span class="dot" style="background:var(--sig-y)"></span><span class="dot" style="background:var(--sig-g)"></span>сигналы</span><span><span class="sw" style="background:var(--ai);opacity:.6"></span>задержан ассистентом</span></div></details>`;
}

function renderSide() {
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', b.dataset.tab === App.tab);
  for (const k of ['live', 'conf', 'cmp', 'net']) $('#pane-' + k).hidden = k !== App.tab;
  if (App.tab === 'live') renderLive();
  if (App.tab === 'net') renderNet();
  if (App.tab === 'conf') renderConf();
  if (App.tab === 'cmp') renderCmp();
}
function renderAll() { renderSide(); renderCard(); updateHint(); updatePlay(); }
document.querySelector('.side .tabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tab]'); if (b) { App.tab = b.dataset.tab; renderSide(); } });

// живое обновление панели без потери фокуса
function liveUpdate() {
  if (App.tab === 'live') updateLive();
  if (App.tab === 'conf') {
    // обновить списки поездов, если в фокусе не они
    const act = document.activeElement;
    for (const [id, only] of [['cfBrT', true], ['cfDlT', false]]) {
      const sel = $('#' + id); if (!sel || act === sel) continue;
      const v = sel.value; const html = trainOptions(sim(), only);
      if (sel._h !== html) { sel.innerHTML = html || '<option value="">нет поездов</option>'; sel._h = html; if ([...sel.options].some((o) => o.value === v)) sel.value = v; }
    }
  }
  if (App.tab === 'cmp') renderCmp();
  if (App.sel && !$('#card').contains(document.activeElement)) renderCard();
  renderConsole();
}

// ---------- верхняя панель ----------
function updatePlay() {
  $('#btnPlay').textContent = App.running ? '⏸ Пауза' : '▶ Пуск';
  $('#btnPlay').classList.toggle('on', App.running);
  const me = $('#modeEdit'), ms = $('#modeSim');
  if (me) me.setAttribute('aria-pressed', App.mode === 'edit');
  if (ms) ms.setAttribute('aria-pressed', App.mode === 'sim');
  $('#viewA').setAttribute('aria-pressed', App.view === 'A');
  $('#viewB').setAttribute('aria-pressed', App.view === 'B');
  $('#btnPlay').disabled = App.mode === 'edit';
}
function updateHint() {
  const h = $('#hint');
  let t = '';
  if (App.mode === 'edit') {
    t = { select: 'Перетаскивайте станции, щёлкните объект, чтобы изменить его свойства.', station: 'Щёлкните на пустом месте, чтобы поставить станцию.', junction: 'Щёлкните на пустом месте, чтобы поставить стрелочный пост.',
      single: App.edgeFrom ? 'Теперь щёлкните вторую станцию.' : 'Щёлкните первую станцию будущего однопутного перегона.', double: App.edgeFrom ? 'Теперь щёлкните вторую станцию.' : 'Щёлкните первую станцию будущего двухпутного перегона.',
      delete: 'Щёлкните станцию или перегон, чтобы удалить.' }[App.tool];
  }
  h.textContent = t; h.hidden = !t;
  $('#card').style.top = t ? '52px' : '10px';
}
$('#zBig').onclick = () => { $('.main').classList.toggle('mapbig'); setTimeout(() => { resize(); if (!App.userCam) fitView(); }, 30); };
$('#btnPlay').onclick = () => { App.running = !App.running; updatePlay(); };
$('#btnReset').onclick = () => { App.running = false; resetSims(); };
$('#speed').onchange = (e) => { App.speed = +e.target.value; };
const modeEditFn = () => { App.mode = 'edit'; App.running = false; App.tool = 'select'; App.tab = 'net'; App.sel = null; resetSims(); };
const modeSimFn = () => { App.mode = 'sim'; App.edgeFrom = null; App.sel = null; renderAll(); };
document.addEventListener('click', (ev) => {
  if (ev.target.closest('#modeEdit')) modeEditFn();
  else if (ev.target.closest('#modeSim')) modeSimFn();
  const pop = $('#settings');
  if (ev.target.closest('#btnSettings')) { pop.hidden = !pop.hidden; $('#btnSettings').setAttribute('aria-expanded', !pop.hidden); }
  else if (!ev.target.closest('#settings')) { pop.hidden = true; $('#btnSettings').setAttribute('aria-expanded', false); }
  if (ev.target.closest('#btnHelp')) { store.set('rail.help', ''); pop.hidden = true; App.tab = 'live'; renderSide(); }
});
$('#aiSwitch').onchange = (e) => { $('#aiOn').checked = e.target.checked; $('#aiOn').onchange({ target: $('#aiOn') }); };
$('#viewA').onclick = () => { App.view = 'A'; renderAll(); };
$('#viewB').onclick = () => { App.view = 'B'; renderAll(); };
$('#zIn').onclick = () => zoomAt(1.25); $('#zOut').onclick = () => zoomAt(0.8); $('#zFit').onclick = () => { App.userCam = false; fitView(); };
const scenSel = $('#scen');
scenSel.innerHTML = Object.entries(SCENARIOS).sort((a, b) => (b[0] === 'kz') - (a[0] === 'kz')).map(([k, v]) => `<option value="${k}">${esc(v.title)}</option>`).join('');
scenSel.onchange = () => { App.running = false; loadScenario(scenSel.value); };
document.addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, textarea, select')) return;
  if (ev.code === 'Space') { ev.preventDefault(); if (App.mode === 'sim') { App.running = !App.running; updatePlay(); } }
  if (ev.key === 'Escape') { App.sel = null; App.edgeFrom = null; renderCard(); updateHint(); }
});

// ---------- окно кода ----------
const win = $('#win'), code = $('#code'), gutter = $('#gutter');
$('#btnCode').onclick = () => { win.hidden = !win.hidden; if (!win.hidden) { placeWin(); code.setSelectionRange(0, 0); code.focus({ preventScroll: true }); code.scrollTop = 0; updGutter(); } };
$('#winClose').onclick = () => { win.hidden = true; };
function placeWin() {
  if (innerWidth <= 900) return;
  const r = win.getBoundingClientRect();
  if (r.right > innerWidth || r.left < 0 || r.top < 0) { win.style.left = Math.max(8, innerWidth - 380 - r.width) + 'px'; win.style.top = '70px'; win.style.right = 'auto'; }
}
(() => {
  let d = null;
  $('#winHead').addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('button') || innerWidth <= 900) return;
    const r = win.getBoundingClientRect(); d = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    $('#winHead').setPointerCapture(ev.pointerId);
  });
  $('#winHead').addEventListener('pointermove', (ev) => {
    if (!d) return;
    win.style.left = Math.max(0, Math.min(innerWidth - 80, ev.clientX - d.x)) + 'px';
    win.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - d.y)) + 'px'; win.style.right = 'auto';
  });
  $('#winHead').addEventListener('pointerup', () => { d = null; });
})();
function updGutter() {
  const n = code.value.split('\n').length;
  if (gutter._n !== n) { gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); gutter._n = n; }
  gutter.scrollTop = code.scrollTop;
}
code.addEventListener('input', updGutter);
code.addEventListener('scroll', () => { gutter.scrollTop = code.scrollTop; });
code.addEventListener('keydown', (ev) => {
  if (ev.key === 'Tab') { ev.preventDefault(); const s = code.selectionStart, e = code.selectionEnd; code.setRangeText('  ', s, e, 'end'); updGutter(); }
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); applyCode(false); }
});
$('#tpl').innerHTML = Object.entries(ASSIST_TEMPLATES).map(([k, v]) => `<option value="${k}">${esc(v.title)}</option>`).join('');
$('#tplLoad').onclick = () => { code.value = tplCode(ASSIST_TEMPLATES[$('#tpl').value].code); updGutter(); applyCode(true); };
$('#applyLive').onclick = () => applyCode(false);
$('#applyRestart').onclick = () => applyCode(true);
App.approval = store.get('rail.approval') || 'auto';
App.pauseOnRec = store.get('rail.pauseRec') !== '0';
$('#apprOn').checked = App.approval === 'confirm';
$('#pauseRec').checked = App.pauseOnRec;
$('#apprOn').onchange = (e) => { App.approval = e.target.checked ? 'confirm' : 'auto'; store.set('rail.approval', App.approval); App.simA.approval = App.approval; liveUpdate(); };
$('#pauseRec').onchange = (e) => { App.pauseOnRec = e.target.checked; store.set('rail.pauseRec', e.target.checked ? '1' : '0'); };
$('#aiOn').onchange = (e) => { App.assistOn = e.target.checked; $('#aiSwitch').checked = App.assistOn; App.simA.assistant = App.assistOn ? assistWrapper : null; if (!App.assistOn) for (const t of App.simA.trains) t.hold = null; renderAll(); };
$('#ftConsole').onclick = () => { $('#console').hidden = false; $('#apiRef').hidden = true; $('#ftConsole').setAttribute('aria-pressed', true); $('#ftApi').setAttribute('aria-pressed', false); };
$('#ftApi').onclick = () => { $('#console').hidden = true; $('#apiRef').hidden = false; $('#ftConsole').setAttribute('aria-pressed', false); $('#ftApi').setAttribute('aria-pressed', true); };
API_REF.ru = `<p>Ассистент — функция <code>decide(state, api)</code>. Модель вызывает её раз в секунду модельного времени. Команды ассистента проходят через блокировку: столкновение он устроить не может, а тупик — может.</p>
<dl>
<dt><code>state.trains[]</code></dt><dd>id, name, type, priority, maxSpeed, status (pending, running, dwell, stopped, broken, done), speed, from, to, route[], routeEdges[], routePos, atNode, onEdge, frontierNode — станция, до которой задан маршрут, nextEdge {id, toNode, double} — перегон за ней, committed[] — станции, куда поезд уже обязан прибыть, nextStop, delayMin, waitReason, waitingSec, deadlock, held, holdReason, departIn, nextStation {id, distM, stop} — ближайшая станция впереди, stopDist, blocked, blockedBy[], speedCap, capReason, manualCap — ограничение, заданное диспетчером</dd>
<dt><code>state.nodes[]</code></dt><dd>id, name, type (station, junction), tracks, trains[] — кто стоит, inbound[] — кто едет сюда по заданному маршруту, free</dd>
<dt><code>state.edges[]</code></dt><dd>id, a, b, name, lengthKm, vmax, double, closed, closedForSec, absFail, trainsAB[], trainsBA[]</dd>
<dt><code>state.byId.trains / nodes / edges</code>, <code>state.edgeBetween(a, b)</code>, <code>state.conflicts[]</code>, <code>state.time</code>, <code>state.clock</code></dt><dd>Быстрый доступ и текущие конфликты.</dd>
<dt><code>api.hold(id, причина)</code>, <code>api.release(id)</code></dt><dd>Не отправлять поезд со станции, до которой задан его маршрут / разрешить отправление. Задержка действует, пока её не снимут.</dd>
<dt><code>api.reroute(id, [узлы])</code></dt><dd>Новый маршрут от frontierNode до конечной. Возвращает true, если принят.</dd>
<dt><code>api.findPath(откуда, куда, {avoid: [перегоны]})</code>, <code>api.pathTime(узлы, id)</code>, <code>api.eta(id, узел)</code></dt><dd>Поиск пути, время хода в секундах, прогноз прибытия поезда в узел.</dd>
<dt><code>api.setPriority(id, 1–5)</code></dt><dd>Очерёдность при задании маршрутов.</dd>
<dt><code>api.limitSpeed(id, км/ч | null, причина)</code></dt><dd>Совет машинисту: ехать не быстрее заданной скорости, чтобы подойти к сигналу, когда он откроется, без остановки. Причина показывается машинисту и диспетчеру. <code>null</code> снимает совет.</dd>
<dt><code>api.log(текст)</code>, <code>api.memory</code></dt><dd>Запись в консоль и объект, который сохраняется между вызовами.</dd>
<dt><code>api.clearTime(перегон, узел)</code></dt><dd>Физический прогноз: через сколько секунд хвост последнего встречного освободит перегон в сторону узла (с учётом горловины и попутной очереди).</dd>
<dt><code>api.planApproach(id, станция)</code></dt><dd>Режим подхода к станции: что будет без вмешательства (стоянка у сигнала), рекомендуемая скорость без остановки, точка начала торможения, экономия времени и энергии.</dd>
<dt><code>api.hold(id, причина | {reason, expect, without}, {safety})</code>, <code>api.limitSpeed(id, км/ч, причина | {reason, expect, without, savingSec, savingKWh, untilNode})</code></dt><dd>Объяснение рекомендации. Если диспетчер подтверждает рекомендации, команда становится предложением и исполняется после «Принять»; <code>safety: true</code> исполняется сразу. <code>state.recommendations</code> — статусы предложений.</dd>
</dl>`;
function renderApiRef() { $('#apiRef').innerHTML = API_REF[I18N.lang] || API_REF.ru; }
renderApiRef();
let conN = -1;
function renderConsole() {
  if (win.hidden) return;
  const L = App.simA.assistLog;
  const key = L.length + ':' + (L[L.length - 1]?.t || 0);
  if (conN === key) return; conN = key;
  const box = $('#console');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  box.innerHTML = L.length ? L.slice(-80).map((x) => `<div class="${x.kind}">[${fmtClock(x.t)}] ${esc(x.text)}</div>`).join('') : '<div>Здесь будут сообщения ассистента и ошибки кода.</div>';
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---------- цикл ----------
let lastT = performance.now(), lastUI = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  if (App.running && App.mode === 'sim') {
    App.acc = (App.acc || 0) + dt * App.speed;
    let n = 0;
    while (App.acc >= 0.5 && n < 500) { App.simA.step(0.5); App.simB.step(0.5); App.acc -= 0.5; n++; }
    if (n >= 500) App.acc = 0;
  }
  $('#clock').textContent = fmtClock(sim().t);
  draw(now);
  if (now - lastUI > 400) { lastUI = now; liveUpdate(); }
  requestAnimationFrame(frame);
}

// ---------- тема ----------
function setTheme(t) {
  if (!['auto', 'light', 'dark'].includes(t)) t = 'auto';
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  store.set('rail.theme', t);
  $('#theme').value = t;
  readColors();
  if (App.tab === 'cmp') renderCmp();
}
$('#theme').onchange = (e) => setTheme(e.target.value);
setTheme(store.get('rail.theme') || 'auto');

// ---------- язык ----------
function setLang(lang, first) {
  const prev = I18N.lang;
  I18N.lang = LANGS[lang] ? lang : 'ru';
  store.set('rail.lang', I18N.lang);
  document.documentElement.lang = I18N.lang;
  document.title = TR('Диспетчерская: симулятор железной дороги с ИИ-ассистентом');
  $('#lang').value = I18N.lang;
  if (!first) {
    // если в редакторе нетронутый шаблон — показать его на новом языке
    for (const t of Object.values(ASSIST_TEMPLATES)) if (code.value === tplCode(t.code, prev)) { code.value = tplCode(t.code); updGutter(); applyCode(false); break; }
  }
  renderApiRef();
  i18nWalk(document.body);
  i18nAttrs(code);
  if (!first) { renderAll(); renderLegend(); liveUpdate(); }
}
$('#lang').innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('#lang').onchange = (e) => setLang(e.target.value);
(() => {
  let l = store.get('rail.lang');
  if (!l) { const n = (navigator.language || 'ru').slice(0, 2).toLowerCase(); l = n === 'kk' ? 'kk' : n === 'en' ? 'en' : 'ru'; }
  setLang(l, true);
})();

// ---------- старт ----------
let saved = store.get('rail.code');
// старая версия продвинутого шаблона (без советов по скорости) — обновляем
if (saved && !saved.includes('speedAdvice') && saved.includes('function shouldHold(tr, state, api)')) { saved = null; store.set('rail.code', ''); }
code.value = saved || tplCode(ASSIST_TEMPLATES.advanced.code);
try { App.assistFn = compileAssistant(code.value); setStatus('Код загружен', true); }
catch (e) { code.value = tplCode(ASSIST_TEMPLATES.advanced.code); App.assistFn = compileAssistant(code.value); }
updGutter();
renderLegend();
resize();
loadScenario('kz'); scenSel.value = 'kz';
requestAnimationFrame(frame);
