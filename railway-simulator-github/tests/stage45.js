// Пункты 4–5: точность прогноза и эффект режима подхода.
const { Sim } = require('./sim.js'); const { SCENARIOS, ASSIST_TEMPLATES } = require('./scen.js');
const compile = (c) => new Function('"use strict";' + c + '\n;return decide;')();
// A. Точность predict(): свободный ход — прогноз прохода точки +3 км против факта
{
  const sc = SCENARIOS.double.build(); const s = new Sim(sc.net, sc.trains, {});
  const errs = []; const pend = [];
  for (let i = 0; i < 3 * 3600 * 2; i++) {
    s.step(0.5);
    if (i % 600 === 0) for (const t of s.trains) if (t.state === 'running' && !t.waitReason && t.v > 5) {
      const S = t.s + 3000; const p = s.predict(t, { openAt: s.t, toS: S + 1, marks: [{ s: S }] });
      if (p && p.marks[0].t) pend.push({ t, S, pt: p.marks[0].t });
    }
    for (let k = pend.length - 1; k >= 0; k--) { const x = pend[k]; if (x.t.s >= x.S) { if (!x.t._dist) errs.push(s.t - x.pt); pend.splice(k, 1); } }
  }
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  console.log(`A прогноз прохода точки +3 км (свободный ход): ${errs.length} прогнозов, медиана ошибки ${abs[abs.length >> 1].toFixed(1)} с, 90% ≤ ${abs[Math.floor(abs.length * 0.9)].toFixed(1)} с`);
}
// B. clearTime(): прогноз освобождения однопутного перегона хвостом против факта
{
  const sc = SCENARIOS.single.build(); const s = new Sim(sc.net, sc.trains, { assistant: compile(ASSIST_TEMPLATES.advanced.code) });
  const errs = []; const watch = new Map();
  for (let i = 0; i < 4 * 3600 * 2; i++) {
    s.step(0.5);
    for (const e of s.net.edges) for (const [set, node] of [[e.inF, e.b], [e.inR, e.a]]) {
      const key = e.id + node;
      if (set.size && !watch.has(key) && i % 20 === 0) { const r = s.clearTime(e.id, node); if (r && r.clearAt && !r.trains.some((x) => x.uncertain)) watch.set(key, { at: r.clearAt, made: s.t }); }
      if (!set.size && watch.has(key)) { const w = watch.get(key); errs.push(s.t - w.at); watch.delete(key); }
    }
  }
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  console.log(`B прогноз освобождения перегона по хвосту: ${errs.length} случаев, медиана ошибки ${abs[abs.length >> 1].toFixed(1)} с, 90% ≤ ${abs[Math.floor(abs.length * 0.9)].toFixed(1)} с`);
}
// C. Совет по скорости: прогноз проследования сигнала без остановки против факта
for (const sk of ['single', 'kz']) {
  const sc = SCENARIOS[sk].build(); const s = new Sim(sc.net, sc.trains, { assistant: compile(ASSIST_TEMPLATES.advanced.code) });
  const recs = new Map(); let ok = 0, stopped = 0; const terr = [], lerr = [], dists = [];
  for (let i = 0; i < 4 * 3600 * 2; i++) {
    s.step(0.5);
    for (const t of s.trains) {
      if (t.speedCap != null && t.capInfo && t.capInfo.untilNode && !recs.has(t.id)) {
        const p = s.planApproach(t, t.capInfo.untilNode);
        if (p && p.best) recs.set(t.id, { P: p.P, pass: p.best.passP, stop: false, node: t.capInfo.untilNode, last: p.best.passP, dist: p.P - t.s });
      }
      if (recs.has(t.id) && t.speedCap != null) { const p = s.planApproach(t, recs.get(t.id).node); if (p && p.best) recs.get(t.id).last = p.best.passP; }
      const r = recs.get(t.id);
      if (r) { if (t.state === "running" && t.v === 0 && t.s < r.P + 5) r.stop = true;
        if (t.s >= r.P + 5) { r.stop ? stopped++ : ok++; terr.push(s.t - r.pass); lerr.push(s.t - r.last); dists.push(r.dist); recs.delete(t.id); } }
    }
  }
  const abs = terr.map(Math.abs).sort((a, b) => a - b);
  const la = lerr.map(Math.abs).sort((a, b) => a - b);
  console.log(`C ${sk}: советов ${ok + stopped}: прошли сигнал без остановки ${ok}, остановились ${stopped}; ошибка времени прохода по первому прогнозу: медиана ${abs.length ? abs[abs.length >> 1].toFixed(0) : '—'} с, макс ${abs.length ? abs[abs.length - 1].toFixed(0) : '—'} с; по последнему: медиана ${la.length ? la[la.length >> 1].toFixed(0) : '—'} с; расстояние до сигнала при совете: медиана ${dists.length ? Math.round(dists.sort((a,b)=>a-b)[dists.length >> 1]) : '—'} м`);
}
