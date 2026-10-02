// Сценарии закрытия одного пути двухпутного перегона Лесная – Узловая (BC) и проверка правил на каждом такте.
const { Sim } = require('./sim.js'); const { SCENARIOS, ASSIST_TEMPLATES } = require('./scen.js');
const compile = (c) => new Function('"use strict";' + c + '\n;return decide;')();
function run(name, { bidir = false, order = false, noCross = null, tpl = null, closeMin = 60 }) {
  const sc = SCENARIOS.double.build();
  const net = JSON.parse(JSON.stringify(sc.net));
  if (bidir) net.edges.find((e) => e.id === 'BC').bidir = true;
  if (noCross) net.nodes.find((n) => n.id === noCross).crossovers = false;
  const s = new Sim(net, sc.trains, { assistant: tpl ? compile(ASSIST_TEMPLATES[tpl].code) : null });
  const e = s.edgeMap.get('BC');
  const V = { opp: 0, overCap: 0, wrongNoOrder: 0, oneTrain: 0, noConsent: 0, inviteSpeed: 0, closedEntry: 0 };
  let wrongEntries = 0, maxWrongFollow = 0, orderRes = null, waitedNoOrder = 0, reasons = new Set();
  const seenWrong = new Set(); let onIbefore = null;
  for (let i = 0; i < 4 * 3600 * 2; i++) {
    if (i === 2400) { s.closeEdge('BC', closeMin, 'f'); onIbefore = new Set(e.trk.f.users.f); }
    if (order && i === 2401) orderRes = s.orderWrongLine('BC', 'r', bidir ? null : 60);
    s.step(0.5);
    const kr = e.trk.r, kf = e.trk.f;
    if (kr.users.f.size && kr.users.r.size) V.opp++;
    if (kf.users.f.size && kf.users.r.size) V.opp++;
    for (const [, r] of s.res) if (r.occ.size > r.cap) V.overCap++;
    if (kr.users.f.size && !kr.order && s.trackClosed(e, 'f')) {
      // поезд мог выйти по приказу до его снятия; новых выходов без приказа быть не должно
      for (const id of kr.users.f) if (!seenWrong.has(id)) V.wrongNoOrder++;
    }
    if (!kr.bidir && kr.users.f.size > 1) V.oneTrain++;
    if (onIbefore && s.trackClosed(e, 'f')) for (const id of e.trk.f.users.f) if (!onIbefore.has(id)) V.closedEntry++;
    maxWrongFollow = Math.max(maxWrongFollow, kr.users.f.size);
    for (const id of kr.users.f) if (!seenWrong.has(id)) {
      seenWrong.add(id); wrongEntries++;
      const tr = s.trainMap.get(id);
      const first = tr.seq.findIndex((q) => q.kind === 'block' && q.edgeId === 'BC' && q.first);
      const arrQ = tr.seq[first + tr.seq[first].n];
      if (!kr.bidir && !(s.res.get(arrQ.key) && s.res.get(arrQ.key).occ.has(id))) V.noConsent++;
    }
    for (const tr of s.trains) {
      if (tr.state !== 'running') continue;
      const h = tr.seq[tr.headIdx];
      if (h.kind === 'node' && h.invite && tr.v > 20 / 3.6 + 0.05) V.inviteSpeed++;

      if (tr.waitReason && tr.waitReason.includes('не организовано')) { waitedNoOrder++; reasons.add(tr.waitReason); }
      else if (tr.waitReason && (tr.waitReason.includes('неправильн') || tr.waitReason.includes('согласия') || tr.waitReason.includes('съезда') || tr.waitReason.includes('направление сменят'))) reasons.add(tr.waitReason);
    }
  }
  // новые входы на закрытый путь I: блоки пути I после закрытия не должны бронироваться поездами, вошедшими позже
  const m = s.summary();
  console.log(`\n== ${name}${tpl ? ' [' + tpl + ']' : ' [без ассистента]'}`);
  console.log(`   приказ: ${orderRes ? JSON.stringify(orderRes) : '—'}; выходов по пути II в направлении I: ${wrongEntries}; макс. попутно по неправ. пути: ${maxWrongFollow}; тактов ожидания «не организовано»: ${waitedNoOrder}`);
  console.log(`   прибыло ${m.completed}/${m.total}, ср. опоздание ${m.avgDelay.toFixed(1)} мин, тупиков ${m.deadlocks}, в тупике ${m.stuck}`);
  console.log(`   нарушения: ${JSON.stringify(V)}`);
  console.log(`   события приказа: ${s.events.filter((x) => /Приказ|открыт: движение/.test(x.text)).map((x) => x.text).join(' | ')}`);
  console.log(`   причины ожидания: ${[...reasons].slice(0, 4).join(' | ')}`);
}
run('C1 закрыт путь I, приказа нет', {});
run('C2 закрыт путь I + приказ, путь II без двусторонней АБ, 60 км/ч', { order: true });
run('C2 закрыт путь I + приказ, путь II без двусторонней АБ, 60 км/ч', { order: true, tpl: 'advanced' });
run('C3 закрыт путь I + приказ, путь II с двусторонней АБ', { order: true, bidir: true });
run('C4 приказ, но на ст. Узловая нет съезда', { order: true, noCross: 'C' });
run('C5 закрытие на 20 мин + приказ: приказ снимается после открытия', { order: true, closeMin: 20 });
