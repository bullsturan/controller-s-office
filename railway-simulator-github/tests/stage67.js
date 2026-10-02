// Пункты 6–7: режим подтверждения. Диспетчер-«робот»: принимает все предложения (A), отклоняет все (B), не реагирует (C).
const { Sim } = require('./sim.js'); const { SCENARIOS, ASSIST_TEMPLATES } = require('./scen.js');
const compile = (c) => new Function('"use strict";' + c + '\n;return decide;')();
const adv = ASSIST_TEMPLATES.advanced.code;
for (const sk of ['single', 'double', 'kz']) {
  const out = [];
  for (const [label, approval, policy] of [['auto', 'auto', null], ['confirm+принять через 20 с', 'confirm', 'accept'], ['confirm+отклонять', 'confirm', 'reject'], ['confirm+не отвечать', 'confirm', 'none']]) {
    const sc = SCENARIOS[sk].build(); const s = new Sim(sc.net, sc.trains, { assistant: compile(adv), approval });
    for (let i = 0; i < 4 * 3600 * 2; i++) {
      s.step(0.5);
      if (policy && i % 10 === 0) for (const r of s.recs) if (r.status === 'pending' && s.t - r.createdAt >= 20) { if (policy === 'accept') s.recDecide(r.id, true); if (policy === 'reject') s.recDecide(r.id, false); }
    }
    const m = s.summary();
    out.push(`  ${label}: ${m.completed}/${m.total}, опозд ${m.avgDelay.toFixed(1)}, тупиков ${m.deadlocks}, в тупике ${m.stuck}, остановок ${m.unplanned} | рекомендаций: предложено ${m.recs.proposed}, принято ${m.recs.accepted}, отклонено ${m.recs.rejected}, истекло ${m.recs.expired}, авто ${m.recs.auto}; прогнозов «без остановки» сверено ${m.recs.forecasts}, сбылось ${m.recs.forecastOk}`);
  }
  console.log(sk + '\n' + out.join('\n'));
}
