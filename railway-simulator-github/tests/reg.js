// Регрессия: эталонное ядро (sim.bak.js, до пункта 1) против текущего (sim.js) без сбоев на путях.
// Сравниваются итоговые метрики и траектории всех поездов (каждые 60 с модельного времени).
const fs = require('fs'), crypto = require('crypto');
const A = require('./sim.bak.js'), B = require('./sim.js');
const { SCENARIOS, ASSIST_TEMPLATES } = require('./scen.js');
const compile = (code) => new Function('"use strict";' + code + '\n;return typeof decide==="function"?decide:null;')();
const user = fs.readFileSync('/mnt/user-data/uploads/assistant.js', 'utf8');
const OLD = require('./scen.bak.js').ASSIST_TEMPLATES; // эталонные шаблоны: сравниваем ядра на одинаковом коде ассистента
const assistants = { none: null, basic: OLD.basic.code, 'advanced (эталон)': OLD.advanced.code, 'assistant.js': user };
function run(Sim, sk, code, events) {
  const sc = SCENARIOS[sk].build();
  if (process.env.IL && Sim !== A.Sim) sc.net.interlocking = process.env.IL;
  const s = new Sim(sc.net, sc.trains, { assistant: code ? compile(code) : null });
  const h = crypto.createHash('sha1');
  for (let i = 0; i < 4 * 3600 * 2; i++) {
    if (events) events(s, i);
    s.step(0.5);
    if (i % 120 === 0) for (const t of s.trains) h.update(`${t.id}|${t.state}|${t.headIdx}|${t.s.toFixed(3)}|${t.v.toFixed(4)};`);
  }
  const m = s.summary();
  return { done: m.completed, total: m.total, avgDelay: +m.avgDelay.toFixed(3), wDelay: +m.wDelay.toFixed(3), deadlocks: m.deadlocks,
    stuck: m.stuck, unplanned: m.unplanned, energy: Math.round(m.energy), holds: m.holds, reroutes: m.reroutes, advices: m.advices ?? 0,
    errors: m.errors, events: s.events.length, traj: h.digest('hex').slice(0, 12) };
}
module.exports = { run, assistants, SCENARIOS };
if (require.main === module) {
  const keys = ['done', 'avgDelay', 'wDelay', 'deadlocks', 'stuck', 'unplanned', 'energy', 'holds', 'reroutes', 'advices', 'errors', 'traj'];
  let same = 0, diff = 0;
  console.log('scenario | assistant | ' + keys.join(' | ') + ' | match');
  for (const sk of ['single', 'double', 'hub', 'kz']) for (const [an, code] of Object.entries(assistants)) {
    const a = run(A.Sim, sk, code), b = run(B.Sim, sk, code);
    const bad = keys.filter((k) => a[k] !== b[k]);
    bad.length ? diff++ : same++;
    console.log(`${sk} | ${an} | ` + keys.map((k) => (a[k] === b[k] ? String(b[k]) : `${a[k]}→${b[k]}`)).join(' | ') + ' | ' + (bad.length ? 'DIFF: ' + bad.join(',') : 'OK'));
  }
  console.log(`\nсовпало: ${same}, отличается: ${diff}`);
}
