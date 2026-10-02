const { Sim, fmtClock } = require('./sim.js'); const S = require('./scen.js');
const compile = (c) => new Function('"use strict";' + c + '\n;return decide;')();
function run(withAI, depF) {
  if (depF != null) S.SCENARIOS.demo._f = depF;
  const sc = S.SCENARIOS.demo.build();
  if (depF != null) sc.trains.find(t => t.id === 'G2401').dep = depF;
  const s = new Sim(sc.net, sc.trains, { assistant: withAI ? compile(S.ASSIST_TEMPLATES.advanced.code) : null });
  const g = () => s.trainMap.get('G2401');
  let stopAtB = 0, adv = null, passB = null, arrC = null;
  for (let i = 0; i < 2 * 3600 * 2; i++) {
    s.step(0.5);
    const t = g();
    if (t.state === 'running' && t.v === 0 && t.seq[t.headIdx].kind === 'node' && t.seq[t.headIdx].nodeId === 'B') stopAtB += 0.5;
    if (!adv && t.speedCap != null) adv = { t: s.t, kmh: t.speedCap, info: t.capInfo };
    const bi = t.seq.findIndex(q => q.kind === 'node' && q.nodeId === 'B');
    if (t.state !== 'pending' && passB == null && t.s > s.stopPos(t, bi) + 5) passB = s.t;
    if (t.state === 'done' && arrC == null) arrC = s.t;
  }
  const m = s.summary();
  return { stopAtB, adv, passB, arrC, E: Math.round(g().energy), unpl: m.unplanned, delay: m.avgDelay.toFixed(1), recs: m.recs };
}
for (const dep of [0, 1, 2, 3, 4, 5].map(x => 21600 - 21600 + x * 60)) {
  const a = run(false, dep), b = run(true, dep);
  console.log(`отпр. грузового 06:${String(dep/60).padStart(2,'0')}: без ИИ стоит у сигнала ${a.stopAtB} с, проход B ${fmtClock(a.passB)}, прибытие ${fmtClock(a.arrC)}, ${a.E} кВт·ч | с ИИ: стоит ${b.stopAtB} с, совет ${b.adv ? b.adv.kmh + ' км/ч в ' + fmtClock(b.adv.t) : '—'}, проход B ${fmtClock(b.passB)}, прибытие ${fmtClock(b.arrC)}, ${b.E} кВт·ч`);
}
