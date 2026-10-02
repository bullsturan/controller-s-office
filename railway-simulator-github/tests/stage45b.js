// Эффект советов по скорости: продвинутый шаблон с советами против того же шаблона без них
const { Sim } = require('./sim.js'); const { SCENARIOS, ASSIST_TEMPLATES } = require('./scen.js');
const compile = (c) => new Function('"use strict";' + c + '\n;return decide;')();
const adv = ASSIST_TEMPLATES.advanced.code;
const off = adv.replace('function speedAdvice(tr, state, api) {', 'function speedAdvice(tr, state, api) { return null;');
for (const sk of ['single', 'double', 'hub', 'kz']) {
  const row = [];
  for (const [k, code] of [['без советов', off], ['с советами', adv]]) {
    const sc = SCENARIOS[sk].build(); const s = new Sim(sc.net, sc.trains, { assistant: compile(code) });
    for (let i = 0; i < 4 * 3600 * 2; i++) s.step(0.5);
    const m = s.summary();
    row.push(`${k}: прибыло ${m.completed}/${m.total}, опозд ${m.avgDelay.toFixed(1)} мин, вынужд. остановок ${m.unplanned}, энергия ${Math.round(m.energy)} кВт·ч, советов ${m.advices}`);
  }
  console.log(sk + '\n  ' + row.join('\n  '));
}
