// Пункт 2: независимость путей двухпутного перегона и сбои на отдельном пути.
const { Sim } = require('./sim.js'); const { SCENARIOS } = require('./scen.js');
function base(sk) { const sc = SCENARIOS[sk].build(); return new Sim(sc.net, sc.trains, {}); }
const T = 4 * 3600 * 2;
// A. Встречные на разных путях: одновременное движение и ни одного ожидания из-за встречного
for (const sk of ['double', 'hub', 'kz']) {
  const s = base(sk); let both = 0, oppWait = 0, laneMix = 0;
  for (let i = 0; i < T; i++) {
    s.step(0.5);
    for (const e of s.net.edges) if (e.double) {
      if (e.trk.f.users.f.size && e.trk.r.users.r.size) both++;
      if (e.trk.f.users.r.size || e.trk.r.users.f.size) laneMix++;
    }
    for (const t of s.trains) if (t.waitReason && /встречн/.test(t.waitReason)) {
      const q = t.seq[t.resIdx + 1]; if (q && q.kind === 'block' && s.edgeMap.get(q.edgeId).double) oppWait++;
    }
  }
  console.log(`A ${sk}: тактов со встречными на обоих путях ${both}; ожиданий «встречный» на двухпутке ${oppWait}; поездов не на своём пути ${laneMix}`);
}
// B. Ограничение скорости только на пути I: скорость поездов пути II не ограничивается
{
  const s = base('double'); let maxI = 0, maxII = 0;
  for (let i = 0; i < T; i++) {
    if (i === 600) s.speedRestrict('BC', 40, 240, 'f');
    s.step(0.5);
    for (const t of s.trains) { const h = t.seq[t.headIdx]; if (t.state !== 'running' || h.kind !== 'block' || h.edgeId !== 'BC') continue;
      if (t.tailIdx === t.headIdx) { if (h.lane === 'f') maxI = Math.max(maxI, t.v * 3.6); else maxII = Math.max(maxII, t.v * 3.6); } }
  }
  console.log(`B ТВС 40 км/ч на пути I: макс. скорость целиком на пути I ${maxI.toFixed(1)} км/ч, на пути II ${maxII.toFixed(1)} км/ч`);
}
// C. Отказ АБ только на пути II: по пути II — один поезд и ≤20 км/ч, путь I работает как обычно
{
  const s = base('double'); let maxUsersII = 0, maxUsersI = 0, vII = 0;
  for (let i = 0; i < T; i++) {
    if (i === 600) s.absFail('BC', 120, 'r');
    s.step(0.5);
    if (s.t < s.edgeMap.get('BC').trk.r.absFailUntil) {
      const e = s.edgeMap.get('BC'); maxUsersII = Math.max(maxUsersII, e.trk.r.users.r.size); maxUsersI = Math.max(maxUsersI, e.trk.f.users.f.size);
      for (const t of s.trains) { if (t.state !== "running") continue; const h = t.seq[t.headIdx]; if (t.tailIdx === t.headIdx && h.kind === 'block' && h.edgeId === 'BC' && h.lane === 'r') vII = Math.max(vII, t.v * 3.6); }
    }
  }
  console.log(`C отказ АБ на пути II: поездов на пути II одновременно макс. ${maxUsersII}, скорость макс. ${vII.toFixed(1)} км/ч; на пути I одновременно до ${maxUsersI} поездов`);
}
