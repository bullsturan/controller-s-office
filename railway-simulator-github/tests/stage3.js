const fs = require('fs'); const { Sim } = require('./sim.js'); const { SCENARIOS, ASSIST_TEMPLATES } = require('./scen.js');
const compile = (c) => new Function('"use strict";' + c + '\n;return decide;')();
const AS = { none: null, advanced: ASSIST_TEMPLATES.advanced.code, 'assistant.js': fs.readFileSync('/mnt/user-data/uploads/assistant.js', 'utf8') };
for (const sk of ['single', 'double', 'hub', 'kz']) for (const [an, code] of Object.entries(AS)) {
  const sc = SCENARIOS[sk].build(); const s = new Sim(sc.net, sc.trains, { assistant: code ? compile(code) : null });
  const V = { throat: 0, junction: 0, trackOcc: 0, overCap: 0 }; let parJ = 0, throatWaitT = 0; const reasons = new Set();
  for (let i = 0; i < 4 * 3600 * 2; i++) {
    s.step(0.5);
    for (const n of s.net.nodes) {
      for (const side of ['W', 'E']) { const L = n.throat[side]; for (let a = 0; a < L.length; a++) for (let b = a + 1; b < L.length; b++) if (L[a].tr !== L[b].tr && s.routesConflict(L[a], L[b])) V.throat++; }
      const J = n.jroutes || []; for (let a = 0; a < J.length; a++) for (let b = a + 1; b < J.length; b++) if (s.jConflict(J[a], J[b])) V.junction++;
      if (J.length >= 2) parJ++;
      if (n.trackOcc) { const r = s.res.get('N:' + n.id); const cnt = n.trackOcc.filter((x) => x !== null).length; if ((r ? r.occ.size : 0) !== cnt) V.trackOcc++; }
    }
    for (const [, r] of s.res) if (r.occ.size > r.cap) V.overCap++;
    for (const t of s.trains) if (t.waitReason && t.waitReason.includes('враждебный')) { throatWaitT++; if (reasons.size < 3) reasons.add(t.waitReason); }
  }
  const m = s.summary();
  console.log(`${sk} | ${an} | прибыло ${m.completed}/${m.total} | опозд ${m.avgDelay.toFixed(1)} | тупиков ${m.deadlocks}, в тупике ${m.stuck} | ожиданий «враждебный маршрут» (тактов) ${throatWaitT} | параллельно на посту (тактов) ${parJ} | нарушения ${JSON.stringify(V)}`);
  if (reasons.size) console.log('   пример: ' + [...reasons][0]);
}
