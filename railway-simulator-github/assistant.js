const V_MIN = 35;
const MIN_DIST_M = 1200;
const MARGIN_SEC = 60;
const MAX_SLOWDOWN_SEC = 360;
const MAX_HOLD_SEC = 1200;
const MEET_WINDOW_SEC = 240;
const OVERTAKE_GAP_SEC = 120;

function decide(state, api) {
  const freed = api.memory.freed || (api.memory.freed = {});

  for (const tr of state.trains) {
    if (tr.status === 'done' || tr.status === 'pending') continue;

    const reason = holdReason(tr, state, api, freed);
    if (reason) api.hold(tr.id, reason);
    else if (tr.held) api.release(tr.id);

    const adv = speedAdvice(tr, state, api);
    if (adv) api.limitSpeed(tr.id, adv.kmh, adv.reason);
    else if (tr.speedCap) api.limitSpeed(tr.id, null);
  }
}

function holdReason(tr, state, api, freed) {
  const h = checkHold(tr, state, api);
  if (!h) return null;
  if (h.safety) return h.text;
  if (freed[tr.id] === tr.frontierNode) return null;
  if (tr.held && tr.waitingSec > MAX_HOLD_SEC) {
    freed[tr.id] = tr.frontierNode;
    return null;
  }
  return h.text;
}

function checkHold(tr, state, api) {
  const { trains, nodes, edges } = state.byId;
  const here = tr.frontierNode && nodes[tr.frontierNode];
  if (!here || here.type !== 'station' || !tr.nextEdge) return null;

  const edge = edges[tr.nextEdge.id];
  const next = nodes[tr.nextEdge.toNode];

  if (edge.closed) {
    if (tryDetour(tr, here, edge, api)) return null;
    return { text: 'перегон закрыт, ждём открытия' };
  }

  if (edge.double) {
    return here.tracks >= 2 ? overtake(tr, here, next, edge, state, api) : null;
  }

  if (next.type === 'station') {
    const facing = next.trains.filter((id) => trains[id] && trains[id].nextEdge && trains[id].nextEdge.id === edge.id).length;
    const inbound = next.inbound.filter((id) => id !== tr.id).length;
    if (next.tracks - facing - inbound < 1) {
      return { text: 'нет гарантированного пути на ст. ' + next.name, safety: true };
    }
    if (needMeetTrack(tr, next, state)) {
      return { text: 'держим путь для скрещения на ст. ' + next.name, safety: true };
    }
  }

  for (const o of state.trains) {
    if (o.id === tr.id || o.status === 'done' || o.held) continue;
    const opposing = o.frontierNode === next.id && o.nextEdge && o.nextEdge.id === edge.id;
    if (opposing && o.priority > tr.priority && o.departIn < MEET_WINDOW_SEC) {
      return { text: 'пропуск встречного ' + o.name };
    }
  }
  return null;
}

function needMeetTrack(tr, next, state) {
  const { trains, edges } = state.byId;
  const k = tr.route.indexOf(next.id, tr.routePos);
  const e2 = edges[tr.routeEdges[k]];
  if (!e2 || e2.double) return false;

  const far = e2.a === next.id ? e2.b : e2.a;
  const sameWay = [...next.trains, ...next.inbound]
    .filter((id) => id !== tr.id && trains[id] && willUse(trains[id], e2.id, next.id)).length;
  const opposite = state.trains.some((o) => o.status !== 'done' && willUse(o, e2.id, far));
  return opposite && sameWay + 1 > next.tracks - 1;
}

function tryDetour(tr, here, edge, api) {
  const alt = api.findPath(here.id, tr.to, { avoid: [edge.id] });
  const direct = api.findPath(here.id, tr.to);
  if (!alt || !direct) return false;
  const faster = api.pathTime(alt, tr.id) < api.pathTime(direct, tr.id) + edge.closedForSec;
  return faster && api.reroute(tr.id, alt);
}

function overtake(tr, here, next, edge, state, api) {
  const myTime = api.pathTime([here.id, next.id], tr.id);
  for (const o of state.trains) {
    if (o.id === tr.id || o.status === 'done' || o.held || o.priority <= tr.priority) continue;
    if (o.maxSpeed <= tr.maxSpeed + 10 || !willUse(o, edge.id, here.id)) continue;

    const eta = api.eta(o.id, here.id);
    if (eta === null) continue;

    const catches = eta + api.pathTime([here.id, next.id], o.id) < myTime + OVERTAKE_GAP_SEC;
    const others = here.inbound.filter((id) => id !== o.id).length;
    const hasTrack = here.trains.includes(o.id) || here.free - others > 0;
    if (catches && hasTrack) return { text: 'обгон: пропускаем ' + o.name };
  }
  return null;
}

function speedAdvice(tr, state, api) {
  if (tr.status !== 'running' || !tr.nextStation) return null;
  return meetAhead(tr, state, api) || followLeader(tr, state);
}

function meetAhead(tr, state, api) {
  const st = tr.nextStation;
  if (st.stop || st.distM < MIN_DIST_M) return null;

  const i = tr.route.indexOf(st.id);
  const after = i >= 0 ? state.byId.edges[tr.routeEdges[i]] : null;
  if (!after || after.double) return null;

  let clearSec = 0;
  let other = null;
  for (const id of [...after.trainsAB, ...after.trainsBA]) {
    const o = state.byId.trains[id];
    if (!o || o.id === tr.id || o.route.indexOf(st.id) < o.routePos) continue;
    if (o.capReason && o.capReason.includes(tr.name)) continue;
    const eta = api.eta(o.id, st.id);
    if (eta != null && eta + MARGIN_SEC > clearSec) {
      clearSec = eta + MARGIN_SEC;
      other = o;
    }
  }
  if (!other) return null;

  if (state.trains.some((o) => o.blockedBy && o.blockedBy.includes(tr.id))) return null;

  const freeRunSec = st.distM / (tr.maxSpeed / 3.6);
  if (clearSec <= freeRunSec + 20) return null;
  if (clearSec - freeRunSec > MAX_SLOWDOWN_SEC) return null;

  const kmh = Math.round(((st.distM / clearSec) * 3.6) / 5) * 5;
  if (kmh < V_MIN || kmh >= tr.maxSpeed - 5) return null;

  return {
    kmh,
    reason: 'встречный ' + other.name + ' освободит перегон через ~' + Math.ceil(clearSec / 60) + ' мин',
  };
}

function followLeader(tr, state) {
  if (!tr.blocked || tr.blockedBy.length !== 1) return null;
  const lead = state.byId.trains[tr.blockedBy[0]];
  if (!lead || lead.status !== 'running') return null;
  if (lead.speed < V_MIN || lead.speed >= tr.maxSpeed - 10) return null;
  return {
    kmh: Math.round(lead.speed / 10) * 10,
    reason: 'впереди ' + lead.name + ' идёт ' + lead.speed + ' км/ч',
  };
}

function willUse(o, edgeId, fromNode) {
  for (let p = o.routePos; p < o.routeEdges.length; p++) {
    if (o.routeEdges[p] === edgeId && o.route[p] === fromNode) return true;
  }
  return false;
}
