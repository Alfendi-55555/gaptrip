// 틈새 나들이 — 중간 MVP 목업
// 데이터: data/places.json, data/stations.json, data/meta.json — GitHub Actions(scripts/fetch-data.js)가 매일 갱신.
// 지도: 기본은 Leaflet + OpenStreetMap. config.js의 useKakaoMap이 true면 카카오 지도를 쓰고, 못 불러오면 OSM으로 자동 대체.
// 목업 확인용: ?map=leaflet 으로 대체 지도를 강제로 볼 수 있음.
'use strict';

const PLACES_URL = 'data/places.json';
const STATIONS_URL = 'data/stations.json';
const META_URL = 'data/meta.json';
const STORE_KEY = 'gaptrip.v1';

const WALK_KMH = 4.5;       // 걷는 속도
const DETOUR = 1.3;         // 직선거리 → 실제 길 보정
const TRANSIT_TIP_MIN = 20; // 편도 도보가 이보다 길면 대중교통 안내
const STALE_DAYS = 2;       // 데이터가 이만큼 지나면 경고
const FAV_NAME_MAX = 20;
const SEOUL = [37.5665, 126.978];
// 확인용 가정 위치: 주소에 ?at=hufs 를 붙이면 한국외대 서울캠퍼스를 현재 위치로 가정함
// (외대 밖에서 화면을 확인하거나 발표할 때용). 없으면 브라우저의 실제 위치를 씀.
const DEMO_HERE = { lat: 37.5972, lng: 127.0589, name: '한국외대 서울캠퍼스' };
const NEARBY_MIN = 30; // '딱히 없어요'와 홈 안내에서 '근처'로 보는 편도 도보 시간
const MIN_STAY = 10;   // 머물 수 있는 시간이 이보다 짧으면 결과에서 뺌
const MIN_WINDOW = 20; // 돌아올 시각까지 최소 이만큼은 남아야 찾아봄
const MAX_WAIT = 30;   // '딱히 없어요'일 때, 도착 후 이 안에 여는 곳까지만 포함
const COLORS = { event: '#8a2f6b', place: '#1f5c8a', me: '#1d1b18' };

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null && k !== false));
  return n;
};

const state = {
  places: [],
  stations: [],
  meta: null,
  isSample: false,
  dataOk: false,
  store: { favorites: [], records: [] },
  // 지금 떠나기 단계에서 고르는 값
  draft: { origin: null, dest: null, destMode: 'return' },
  here: null,       // 현재 위치 { lat, lng, demo } — 저장하지 않음
  hereState: 'pending', // pending | ok | fail
  flow: ['origin', 'time'],
  openEditor: 'deadline', // 시간 단계에서 펼쳐 둘 설정: depart | deadline | dest
  plan: null,       // { origin, dest, destMode, hasDeadline, deadlineMin, nowMin, routes }
  hereRoutes: null, // 현재 출발지 기준 길 계산 결과(홈 안내용)
  flowHasOrigin: false,
  noDeadline: false,   // '제한 없음'
  editing: false,      // 결과 화면 조건 칩에서 들어온 '조건 바꾸기' 중
  editSnap: null,
  recMonth: null,      // 기록 페이지에서 보는 달 'YYYY-MM'
  routeMemo: null,
  computed: null,   // 계산 결과(필터 전)
  view: 'start',
  detailFrom: 'start',
};

/* ---------- 시간 도우미 ---------- */

// 목업 확인용: ?now=14:00 으로 현재 시각을 가정할 수 있음 (실제 데이터 교체 후 제거)
function nowDate() {
  const d = new Date();
  const m = /^(\d{1,2}):(\d{2})$/.exec(new URLSearchParams(location.search).get('now') || '');
  if (m) d.setHours(+m[1], +m[2], 0, 0);
  return d;
}
const toMin = (d) => d.getHours() * 60 + d.getMinutes();
const pad = (n) => String(n).padStart(2, '0');
const fmtHM = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const todayStr = (d = nowDate()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseHM(v) {
  const m = /^(\d{2}):(\d{2})$/.exec(v || '');
  return m ? +m[1] * 60 + +m[2] : null;
}
function fmtDur(min) {
  if (min <= 0) return '거의 없음';
  if (min < 60) return `약 ${min}분`;
  const h = Math.floor(min / 60), r = min % 60;
  return r ? `약 ${h}시간 ${r}분` : `약 ${h}시간`;
}
const fmtDate = (s) => { const [, m, d] = s.split('-'); return `${+m}.${+d}`; };

/* ---------- 거리·시간 계산 ---------- */

function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// 길 데이터가 없을 때 쓰는 직선거리 어림값
const walkMin = (km) => Math.max(1, Math.round((km * DETOUR / WALK_KMH) * 60));
const ROUTE_MAX_KM = 6; // 직선거리가 이보다 멀면 길 계산 없이 어림값
const isOpenToday = (p) => p.kind !== 'event' || (p.startDate <= todayStr() && todayStr() <= p.endDate);

// 원본에서 휴관일을 따로 받지 못한 예전 데이터는 특이사항의 '휴관: ...'에서 읽음
const closedText = (p) => p.closed || (p.notes || []).find((n) => n.startsWith('휴관: '))?.slice(4) || '';

// 장소마다: 가는 시간, 오늘 운영 구간, 실제로 머물 수 있는 시간(도착~나와야 하는 시각/닫는 시각)
function compute(plan) {
  const date = nowDate();
  const out = [];
  for (const p of state.places) {
    if (!isOpenToday(p)) continue;
    const km = haversineKm(plan.origin, p);
    // 걷는 시간: 길 그래프로 계산, 범위 밖이면 직선거리 어림
    const goRoute = plan.routes && km <= ROUTE_MAX_KM ? plan.routes.go(p) : null;
    const go = goRoute ?? walkMin(km);
    let back = 0, backRoute = null;
    if (plan.hasDeadline) {
      const kmBack = haversineKm(p, plan.dest);
      backRoute = plan.routes && kmBack <= ROUTE_MAX_KM ? plan.routes.back(p) : null;
      back = backRoute ?? walkMin(kmBack);
    }
    const routed = goRoute != null && (!plan.hasDeadline || backRoute != null);
    const arrive = plan.nowMin + go;
    const leaveBy = plan.hasDeadline ? plan.deadlineMin - back : null;
    const sched = GapHours.todaySchedule({ hours: p.hours, closed: closedText(p) }, date);
    const r = { ...p, km, go, back, routed, arrive, leaveBy, sched, reachable: false };

    if (!plan.hasDeadline && go > NEARBY_MIN) { r.why = 'far'; out.push(r); continue; }
    if (plan.hasDeadline && leaveBy - arrive < MIN_STAY) { r.why = 'time'; out.push(r); continue; }
    if (sched.closedToday) { r.why = 'closed'; out.push(r); continue; }

    if (!sched.known) {
      // 운영시간을 못 읽음: 시간만으로 판단하고 '운영시간 확인 필요' 표시
      Object.assign(r, { from: arrive, until: leaveBy, limit: plan.hasDeadline ? 'deadline' : 'unknown', wait: 0 });
      r.stay = plan.hasDeadline ? leaveBy - arrive : null;
      r.reachable = r.stay == null || r.stay >= MIN_STAY;
      if (!r.reachable) r.why = 'time';
      out.push(r);
      continue;
    }

    let best = null;
    for (const w of sched.windows) {
      let from, until, limit, startOnly = false;
      if (w.end == null) {
        // 시작 시각만 아는 공연: 시작 전에 도착해야 함
        if (arrive > w.start) continue;
        from = w.start;
        startOnly = true;
        until = leaveBy;
        limit = plan.hasDeadline ? 'deadline' : 'unknown';
      } else {
        from = Math.max(arrive, w.start);
        if (plan.hasDeadline && leaveBy < w.end) { until = leaveBy; limit = 'deadline'; }
        else { until = w.end; limit = 'close'; }
      }
      const wait = from - arrive;
      if (!plan.hasDeadline && wait > MAX_WAIT) continue;
      const stay = until == null ? null : until - from;
      if (stay != null && stay < MIN_STAY) continue;
      const cand = { from, until, stay, limit, startOnly, wait };
      if (!best || (cand.stay ?? Infinity) > (best.stay ?? Infinity)) best = cand;
    }
    if (best) Object.assign(r, best, { reachable: true });
    else r.why = 'hours';
    out.push(r);
  }
  return out;
}

// 출발지(와 도착지)에서 길 그래프 최단 거리 계산. 범위 밖이거나 실패하면 null → 직선거리 어림.
// 현재 위치 좌표는 여기서 브라우저 안에서만 쓰임.
async function prepareRoutes(origin, dest) {
  if (!window.GapWalk) return null;
  try {
    const g = await GapWalk.graphFor(origin);
    const fromO = g?.from(origin);
    if (!fromO) return null;
    let fromD = fromO;
    if (dest && haversineKm(origin, dest) > 0.02) {
      const gd = await GapWalk.graphFor(dest);
      fromD = gd ? gd.from(dest) : null;
    }
    return {
      area: g.name,
      go: (p) => fromO.minutesTo(p),
      back: (p) => (fromD ? fromD.minutesTo(p) : null),
      goPath: (p) => fromO.pathTo(p),
      backPath: (p) => { const r = fromD ? fromD.pathTo(p) : null; return r ? r.slice().reverse() : null; },
    };
  } catch (e) {
    console.warn('길 계산 실패, 직선거리로 대신해요', e);
    return null;
  }
}

// 같은 출발지·도착지면 계산해 둔 것을 다시 씀 (시간을 바꿀 때마다 '이 조건이면 N곳'을 세므로)
async function cachedRoutes(origin, dest) {
  const key = `${originKey(origin)}|${dest ? originKey(dest) : ''}`;
  if (state.routeMemo?.key === key) return state.routeMemo.routes;
  const routes = await prepareRoutes(origin, dest);
  state.routeMemo = { key, routes };
  return routes;
}

// 머물 수 있는 시간 문구: { main, sub, unknown }
function stayText(c) {
  const subs = [];
  let main;
  if (c.startOnly) {
    main = `${fmtHM(c.from)} 시작`;
    if (c.stay != null) subs.push(`${fmtHM(c.until)}엔 나와야 해요 · 최대 ${fmtDur(c.stay)}`);
    else subs.push('끝나는 시각은 방문 전 확인');
  } else if (c.stay == null) {
    main = '머무는 시간은 자유';
  } else {
    main = `머물 수 있는 시간 ${fmtDur(c.stay)}`;
    if (c.wait > 0) subs.push(`${fmtHM(c.from)}에 열어요`);
    if (c.limit === 'close') subs.push(`${fmtHM(c.until)}에 닫아요`);
    if (c.limit === 'deadline') subs.push(`${fmtHM(c.until)}엔 나와야 해요`);
  }
  const unknown = !c.sched.known;
  if (unknown) subs.push('운영시간 확인 필요');
  return { main, sub: subs.join(' · '), unknown };
}

// 오늘 운영 정보 한 줄
function scheduleText(sched) {
  if (!sched.known) return '읽지 못했어요 · 방문 전 확인하세요';
  if (sched.closedToday) return sched.reason;
  return `오늘 ${sched.windows.map((w) => w.end == null ? `${fmtHM(w.start)} 시작` : `${fmtHM(w.start)}~${fmtHM(w.end)}`).join(', ')}`;
}

/* ---------- 저장 (localStorage) ---------- */

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return true;
    const s = JSON.parse(raw);
    state.store = {
      favorites: Array.isArray(s.favorites) ? s.favorites : [],
      records: Array.isArray(s.records) ? s.records : [],
    };
    return true;
  } catch (e) {
    return false;
  }
}
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.store));
    return true;
  } catch (e) {
    setStatus('error', '이 브라우저에 저장하지 못했어요.', '사생활 보호 모드이거나 저장 공간이 꺼져 있을 수 있어요. 일반 창에서 다시 해 주세요.');
    return false;
  }
}

/* ---------- 상태 안내 ---------- */

function statusBox() {
  return location.hash === '#/records' ? $('rec-status') : $('status');
}
function setStatus(kind, msg, todo) {
  const box = statusBox();
  box.className = `status ${kind}`;
  box.replaceChildren(el('p', { textContent: msg }));
  if (todo) box.append(el('p', { className: 'todo', textContent: todo }));
}
function clearStatus() {
  for (const box of [$('status'), $('rec-status')]) { box.className = 'status'; box.replaceChildren(); }
}

/* ---------- 입력 오류 표시 ---------- */

function showErr(errId, msg, inputId) {
  const err = $(errId);
  err.textContent = msg;
  err.hidden = false;
  if (inputId) $(inputId).setAttribute('aria-invalid', 'true');
}
function clearErr(errId, inputId) {
  const err = $(errId);
  err.textContent = '';
  err.hidden = true;
  if (inputId) $(inputId).removeAttribute('aria-invalid');
}

/* ---------- 패널 단계 이동 ---------- */

const VIEWS = ['start', 'origin', 'time', 'results', 'detail'];
const STEP_NAMES = { origin: '출발지', time: '시간·도착지' };

// 현재 위치를 이미 알면 출발지 단계를 건너뜀. 시간·도착지는 한 화면(문장)에서 고르고 바로 찾기
const hasDeadline = () => !state.noDeadline;
function computeFlow() {
  return [...(state.flowHasOrigin ? ['origin'] : []), 'time'];
}
function startFlow() {
  state.openEditor = 'deadline';
  state.flowHasOrigin = !state.draft.origin;
  state.flow = computeFlow();
  go(state.flow[0]);
}
function updateStepper(view) {
  const stepper = document.querySelector(`[data-view="${view}"] .stepper`);
  if (!stepper) return;
  if (state.editing) { stepper.textContent = '조건 바꾸기'; return; }
  const i = state.flow.indexOf(view);
  stepper.textContent = i < 0 ? '출발지 바꾸기' : state.flow.length === 1 ? STEP_NAMES[view] : `${i + 1} / ${state.flow.length} · ${STEP_NAMES[view]}`;
}
function goPrev() {
  const i = state.flow.indexOf(state.view);
  go(i > 0 ? state.flow[i - 1] : 'start');
}

function go(view, { focus = true } = {}) {
  state.view = view;
  if (['start', 'results'].includes(view)) state.editing = false;
  document.body.classList.toggle('editing', state.editing);
  if (view !== 'detail') clearRoute();
  for (const v of VIEWS) document.querySelector(`[data-view="${v}"]`).hidden = v !== view;
  if (view === 'start') {
    if (state.hereState !== 'fail') clearStatus();
    renderMapPlaces(state.places.filter(isOpenToday), { fit: false });
    if (state.here) panTo(state.here, 15);
  }
  if (view === 'origin') renderPicker('origin');
  updateStepper(view);
  if (view === 'time') { syncDestMode(); renderPicker('dest'); syncTimeUI(); openEditor(state.openEditor); }
  setSheet(view === 'start' ? 'normal' : 'expanded');
  $('panel-body').scrollTop = 0;
  if (focus) document.querySelector(`[data-view="${view}"] h2`)?.focus({ preventScroll: true });
}

function onNext(step) {
  if (step === 'origin') {
    clearErr('origin-pick-err');
    if (!state.draft.origin) {
      showErr('origin-pick-err', '출발지를 골라 주세요. 현재 위치, 즐겨찾기, 역 검색 중 하나로 고를 수 있어요.');
      $('origin-q').focus();
      return;
    }
    go('time');
  } else if (step === 'time') {
    if (!checkTime() || !checkDest()) return;
    runSearch();
  }
}

// 결과 화면 조건 칩 → 그 단계만 고치고 바로 다시 찾기
function snapshotDraft() {
  return { draft: { ...state.draft }, departMode: departIsNow() ? 'now' : 'set', depart: $('depart').value, deadline: $('deadline').value, noDeadline: state.noDeadline };
}
function restoreDraft(snap) {
  state.draft = { ...snap.draft };
  document.querySelector(`input[name="departMode"][value="${snap.departMode}"]`).checked = true;
  document.querySelector(`input[name="destMode"][value="${snap.draft.destMode}"]`).checked = true;
  $('depart').value = snap.depart;
  $('depart-box').hidden = snap.departMode === 'now';
  $('deadline').value = snap.deadline;
  state.noDeadline = snap.noDeadline;
  renderMapMe();
}
function startEdit(step) {
  state.editSnap = snapshotDraft();
  state.editing = true;
  if (step === 'origin') { go('origin'); return; }
  state.openEditor = step === 'dest' ? 'dest' : 'deadline';
  go('time');
}
function cancelEdit() {
  if (state.editSnap) restoreDraft(state.editSnap);
  state.editing = false;
  go('results', { focus: false });
  renderResults({ keepStatus: true });
  $('v-results-h').focus();
}
function applyEdit(step) {
  if (step === 'origin') {
    clearErr('origin-pick-err');
    if (!state.draft.origin) {
      showErr('origin-pick-err', '출발지를 골라 주세요. 현재 위치, 즐겨찾기, 역 검색 중 하나로 고를 수 있어요.');
      $('origin-q').focus();
      return;
    }
  }
  if (step === 'time' && (!checkTime() || !checkDest())) return;
  state.editing = false;
  runSearch();
}

// 돌아올 곳을 '다른 곳'으로 했는데 고르지 않았으면 안내하고 그 설정을 펼침
function checkDest() {
  clearErr('dest-pick-err');
  if (!hasDeadline() || state.draft.destMode !== 'other' || state.draft.dest) return true;
  openEditor('dest');
  showErr('dest-pick-err', '도착지를 골라 주세요. 즐겨찾기나 역 검색으로 고를 수 있어요.');
  $('dest-q').focus();
  return false;
}

// 문장의 버튼 하나만 강조하고, 그 설정만 아래에 펼침
const EDITORS = ['depart', 'deadline', 'dest'];
function openEditor(name) {
  if (name === 'dest' && !hasDeadline()) name = 'deadline';
  state.openEditor = name;
  for (const e of EDITORS) $(`${e}-editor`).hidden = e !== name;
  document.querySelectorAll('#time-sentence .tok').forEach((t) => t.setAttribute('aria-expanded', String(t.dataset.editor === name)));
  if (name === 'dest') renderPicker('dest');
}

function destOf(draft) {
  return draft.destMode === 'return' ? draft.origin : draft.dest;
}


/* ---------- 출발지·도착지 고르기 ---------- */

const pickers = {}; // target → { hits, pending }

function buildPicker(target) {
  const word = target === 'origin' ? '출발지' : '도착지';
  const root = $(`${target}-picker`);
  root.innerHTML = `
    <p class="picker-now">${word}: <strong data-role="label">아직 고르지 않았어요</strong></p>
    <ul class="picker-opts" data-role="opts" aria-label="${word} 빠르게 고르기"></ul>
    <p id="${target}-pick-err" class="field-err picker-err" hidden></p>
    <form class="picker-search" data-role="search" novalidate>
      <label for="${target}-q">역 이름으로 찾기</label>
      <div class="row">
        <input id="${target}-q" type="search" autocomplete="off" placeholder="예: 신촌" aria-describedby="${target}-q-err">
        <button type="submit" class="btn">검색</button>
      </div>
      <p id="${target}-q-err" class="field-err" hidden></p>
    </form>
    <ul class="station-results" data-role="hits" aria-label="역 검색 결과"></ul>
    <form class="fav-form" data-role="fav" novalidate hidden>
      <label for="${target}-fav"><span data-role="favname"></span>역을 즐겨찾기에 추가 (선택)</label>
      <div class="row">
        <input id="${target}-fav" type="text" maxlength="40" placeholder="예: 학교, 자취방 근처" aria-describedby="${target}-fav-err">
        <button type="submit" class="btn">추가</button>
      </div>
      <p id="${target}-fav-err" class="field-err" hidden></p>
    </form>`;
  pickers[target] = { hits: [], pending: null };
  root.querySelector('[data-role="search"]').addEventListener('submit', (e) => { e.preventDefault(); searchStation(target); });
  root.querySelector('[data-role="fav"]').addEventListener('submit', (e) => { e.preventDefault(); addFavorite(target); });
  $(`${target}-q`).addEventListener('input', () => clearErr(`${target}-q-err`, `${target}-q`));
  $(`${target}-fav`).addEventListener('input', () => clearErr(`${target}-fav-err`, `${target}-fav`));
}

function sameSel(a, b) {
  if (!a || !b) return false;
  if (a.type === 'geo' || b.type === 'geo') return a.type === b.type;
  return a.stationId === b.stationId && (a.favId || null) === (b.favId || null);
}

function renderPicker(target) {
  const root = $(`${target}-picker`);
  const sel = state.draft[target];
  root.querySelector('[data-role="label"]').textContent = sel ? sel.label : '아직 고르지 않았어요';

  const opts = root.querySelector('[data-role="opts"]');
  opts.replaceChildren();
  const addOpt = (label, value, onClick) => {
    const b = el('button', { type: 'button', className: 'chip', textContent: label });
    b.setAttribute('aria-pressed', String(sameSel(sel, value)));
    b.addEventListener('click', onClick);
    opts.append(el('li', {}, b));
  };
  if (target === 'origin') addOpt('📍 현재 위치', { type: 'geo' }, useGeolocation);
  for (const f of state.store.favorites) {
    const st = stationById(f.stationId);
    if (!st) continue;
    const value = stationSel(st, f);
    addOpt(`⭐ ${f.name} · ${st.name}`, value, () => select(target, value));
  }

  const hits = root.querySelector('[data-role="hits"]');
  hits.replaceChildren();
  for (const s of pickers[target].hits) {
    const value = stationSel(s);
    const b = el('button', { type: 'button', className: 'chip' }, `${s.name}역 `, el('small', { textContent: s.lines.join('·') }));
    b.setAttribute('aria-pressed', String(sameSel(sel, value)));
    b.addEventListener('click', () => { pickers[target].pending = s; select(target, value); showFavForm(target, s); });
    hits.append(el('li', {}, b));
  }
}

const stationById = (id) => state.stations.find((s) => s.id === id);
function stationSel(st, fav) {
  return fav
    ? { type: 'station', label: `${fav.name} (${st.name}역)`, lat: st.lat, lng: st.lng, stationId: st.id, favId: fav.id }
    : { type: 'station', label: `${st.name}역`, lat: st.lat, lng: st.lng, stationId: st.id };
}

function select(target, value) {
  state.draft[target] = value;
  clearErr(`${target}-pick-err`);
  if ($('status').classList.contains('error')) clearStatus();
  if (value.type !== 'station' || value.favId) $(`${target}-picker`).querySelector('[data-role="fav"]').hidden = true;
  renderPicker(target);
  renderMapMe();
  if (target === 'origin') renderHere();
  if (target === 'dest' && state.view === 'time') { renderSentence(); scheduleCount(); }
  if (target === 'origin' && value.type === 'station') panTo(value, 14);
}

const normName = (s) => s.replace(/\s+/g, '').replace(/역$/, '');

function searchStation(target) {
  const qId = `${target}-q`;
  clearErr(`${qId}-err`, qId);
  const root = $(`${target}-picker`);
  root.querySelector('[data-role="fav"]').hidden = true;
  const q = normName($(qId).value.trim());
  pickers[target].hits = [];
  if (!q) {
    renderPicker(target);
    showErr(`${qId}-err`, '찾을 역 이름을 입력해 주세요.', qId);
    $(qId).focus();
    return;
  }
  const hits = state.stations.filter((s) => s.name.includes(q)).slice(0, 8);
  pickers[target].hits = hits;
  renderPicker(target);
  if (!hits.length) {
    showErr(`${qId}-err`, '그런 역을 찾지 못했어요. 역 이름을 다시 확인해 주세요.', qId);
    $(qId).focus();
    return;
  }
  if (hits.length === 1) {
    pickers[target].pending = hits[0];
    select(target, stationSel(hits[0]));
    showFavForm(target, hits[0]);
  }
  root.querySelector('[data-role="hits"] button')?.focus();
}

function showFavForm(target, s) {
  const form = $(`${target}-picker`).querySelector('[data-role="fav"]');
  const already = state.store.favorites.some((f) => f.stationId === s.id);
  form.hidden = already;
  form.querySelector('[data-role="favname"]').textContent = s.name;
  $(`${target}-fav`).value = '';
  clearErr(`${target}-fav-err`, `${target}-fav`);
}

/* ---------- 즐겨찾기 ---------- */

function addFavorite(target) {
  const id = `${target}-fav`;
  clearErr(`${id}-err`, id);
  const s = pickers[target].pending;
  if (!s) return;
  const name = $(id).value.trim();
  let msg = null;
  if (!name) msg = '즐겨찾기 이름을 붙여 주세요. 예: 학교';
  else if (name.length > FAV_NAME_MAX) msg = `이름은 ${FAV_NAME_MAX}자 이하로 써 주세요. (지금 ${name.length}자)`;
  else if (state.store.favorites.some((f) => f.stationId === s.id)) msg = '이미 즐겨찾기에 있어요.';
  if (msg) {
    showErr(`${id}-err`, msg, id);
    $(id).focus();
    return;
  }
  const fav = { id: `fav_${Date.now()}`, name, stationId: s.id };
  state.store.favorites.push(fav);
  if (!saveStore()) { state.store.favorites.pop(); return; }
  pickers[target].hits = [];
  $(`${target}-q`).value = '';
  select(target, stationSel(s, fav));
  setStatus('ok', `‘${name}’을(를) 즐겨찾기에 추가했어요.`);
  $(`${target}-picker`).querySelector('[aria-pressed="true"]')?.focus();
}

function removeFavorite(id) {
  const before = state.store.favorites;
  state.store.favorites = before.filter((f) => f.id !== id);
  if (!saveStore()) { state.store.favorites = before; return; }
  for (const t of ['origin', 'dest']) {
    if (state.draft[t]?.favId === id) state.draft[t] = null;
  }
  renderRecordsPage();
  setStatus('ok', '즐겨찾기를 삭제했어요.');
  $('records-h').focus();
}

/* ---------- 현재 위치 ---------- */

const useDemoHere = () => new URLSearchParams(location.search).get('at') === 'hufs';

function hereSel() {
  const h = state.here;
  return { type: 'geo', label: h.demo ? `현재 위치 (가정: ${DEMO_HERE.name})` : '현재 위치', lat: h.lat, lng: h.lng };
}

// 홈을 열 때 한 번 위치를 찍고, 출발지로 자동 지정
function locateMe({ fromPicker = false } = {}) {
  if (state.here) { select('origin', hereSel()); return; }
  const ok = (lat, lng, demo) => {
    // 좌표는 계산에만 쓰고 저장하지 않음
    state.here = { lat, lng, demo };
    state.hereState = 'ok';
    if (fromPicker || !state.draft.origin) select('origin', hereSel());
    if ($('status').classList.contains('loading')) clearStatus();
    renderHere();
    renderMapMe();
    if (!fromPicker && state.view === 'start') panTo(state.here, 15);
  };
  if (useDemoHere()) { ok(DEMO_HERE.lat, DEMO_HERE.lng, true); return; }
  if (!('geolocation' in navigator)) { geoFailed('이 브라우저에서는 위치를 확인할 수 없어요.'); return; }
  setStatus('loading', '근처 정보를 불러오는 중이에요 · 현재 위치 확인 중');
  navigator.geolocation.getCurrentPosition(
    (pos) => ok(pos.coords.latitude, pos.coords.longitude, false),
    (err) => geoFailed(err.code === 1 ? '위치 권한이 꺼져 있어 현재 위치를 쓸 수 없어요.' : '위치를 확인할 수 없어요.'),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
  );
}
const useGeolocation = () => locateMe({ fromPicker: true });

function geoFailed(msg) {
  state.hereState = 'fail';
  if (state.draft.origin?.type === 'geo') { state.draft.origin = null; renderPicker('origin'); }
  renderHere();
  renderMapMe();
  // 공유받은 장소 상세를 보는 중이면 위치 오류로 가리지 않음 (홈 안내에는 그대로 표시)
  if (state.view !== 'detail') setStatus('error', msg, '즐겨찾기나 역 검색으로 출발지를 골라 주세요.');
  if (state.view === 'origin') $('origin-q').focus();
}

// 시작 화면의 '현재 위치' 안내와 근처 개수
function renderHere() {
  const line = $('here-line');
  const btn = $('btn-change-origin');
  const o = state.draft.origin;
  line.replaceChildren();
  if (o) {
    const st = nearestStation(o);
    const where = o.type === 'geo'
      ? (state.here?.demo ? `가정 위치 · ${DEMO_HERE.name}` : '지금 있는 곳')
      : o.label;
    line.append(o.type === 'geo' ? '📍 지금 여기서 출발해요' : `🚉 ${o.label}에서 출발해요`,
      el('small', { textContent: `${where}${st ? ` · ${st.name}역 걸어서 ${fmtDur(st.min)}` : ''}` }));
    btn.textContent = '출발지 바꾸기';
    const routes = state.hereRoutes?.key === originKey(o) ? state.hereRoutes.routes : null;
    const near = compute({ origin: o, hasDeadline: false, nowMin: toMin(nowDate()), routes }).filter((p) => p.reachable);
    if (!routes) refreshHereRoutes(o);
    const ev = near.filter((p) => p.kind === 'event').length;
    $('today-count').textContent = `걸어서 ${NEARBY_MIN}분 안에 지금 열려 있거나 곧 여는 곳이 ${near.length}곳(행사 ${ev} · 장소 ${near.length - ev}) 있어요. 언제까지 시간이 있는지 알려 주시면 그 안에 다녀올 곳만 골라 드려요.`;
  } else if (state.hereState === 'pending') {
    line.textContent = '📍 현재 위치를 확인하는 중…';
  } else {
    line.append('📍 현재 위치를 확인할 수 없어요', el('small', { textContent: '즐겨찾기나 역 검색으로 출발지를 골라 주세요.' }));
    btn.textContent = '출발지 고르기';
    $('today-count').textContent = '';
  }
}

const originKey = (o) => `${o.lat.toFixed(5)},${o.lng.toFixed(5)}`;
// 출발지가 바뀌면 길 계산을 한 번 해 두고 홈 안내를 다시 그림
async function refreshHereRoutes(o) {
  const key = originKey(o);
  if (state.hereRoutes?.key === key || state.hereRoutes?.pending === key) return;
  state.hereRoutes = { pending: key };
  const routes = await prepareRoutes(o, null);
  if (state.hereRoutes?.pending !== key) return;
  state.hereRoutes = { key, routes };
  if (routes && state.draft.origin && originKey(state.draft.origin) === key) renderHere();
}

function nearestStation(p) {
  let best = null;
  for (const s of state.stations) {
    const min = walkMin(haversineKm(p, s));
    if (!best || min < best.min) best = { name: s.name, min };
  }
  return best && best.min <= 40 ? best : null;
}

/* ---------- 도착지 모드 ---------- */

function syncDestMode() {
  const mode = document.querySelector('input[name="destMode"]:checked').value;
  state.draft.destMode = mode;
  $('dest-picker').hidden = mode !== 'other';
  clearErr('dest-pick-err');
  renderMapMe();
  if (state.view === 'time') { renderSentence(); scheduleCount(); }
}

/* ---------- 언제까지: 입력·검증 ---------- */

// '1시간 40분' (약 없이)
function fmtSpan(min) {
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60), r = min % 60;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
}
const LAST_MIN = 23 * 60 + 55; // 오늘 고를 수 있는 마지막 시각

// 출발 시각: 기본은 지금, 바꾸면 그 시각 기준으로 모든 계산
const departIsNow = () => document.querySelector('input[name="departMode"]:checked').value === 'now';
const departMin = () => (departIsNow() ? toMin(nowDate()) : parseHM($('depart').value));
const fromWord = () => (departIsNow() ? '지금부터' : '출발부터');

function syncDepartUI() {
  const now = departIsNow();
  $('depart-box').hidden = now;
  clearErr('depart-err', 'depart');
  if (!now && !$('depart').value) {
    // 처음 바꿀 때는 지금에서 10분 단위로 올린 시각을 채워 둠
    $('depart').value = fmtHM(Math.min(LAST_MIN, Math.ceil((toMin(nowDate()) + 1) / 10) * 10));
  }
  syncRange();
  renderSentence();
  scheduleCount();
}

function validateDepart() {
  if (departIsNow()) return null;
  const now = toMin(nowDate());
  const v = parseHM($('depart').value);
  if (v === null) return '출발 시각을 알려 주세요. 바로 출발하면 ‘지금’을 고르세요.';
  if (v < now) {
    if (now >= 18 * 60 && v < 6 * 60) return '오늘 안의 시각으로 골라 주세요. (자정 전까지만 찾을 수 있어요)';
    return '지금보다 이른 시각에는 출발할 수 없어요. 지금 이후로 골라 주세요.';
  }
  if (hasDeadline() && v > LAST_MIN - MIN_WINDOW) return '그 시각에 출발하면 오늘 안에 다녀오기 어려워요. 더 이른 시각을 골라 주세요.';
  return null;
}

// 출발 → 돌아오기 순서로 검사하고 첫 오류 칸으로 초점
function checkTime() {
  clearErr('depart-err', 'depart');
  const dErr = validateDepart();
  if (dErr) {
    openEditor('depart');
    showErr('depart-err', dErr, 'depart');
    $('depart').focus();
    return false;
  }
  return checkDeadline();
}

const DEFAULT_SPAN = 90; // 돌아올 시각을 비워 두면 출발부터 1시간 30분 뒤로 채움

function syncTimeUI() {
  const set = hasDeadline();
  if (set && !$('deadline').value) {
    const base = departMin() ?? toMin(nowDate());
    const target = Math.ceil((base + DEFAULT_SPAN) / 5) * 5;
    if (target <= LAST_MIN) $('deadline').value = fmtHM(target);
  }
  $('sent-deadline').hidden = !set;
  $('sent-none').hidden = set;
  $('nodeadline-hint').hidden = set;
  $('btn-custom').hidden = !set;
  if (!set) {
    toggleCustom(false);
    clearErr('deadline-err', 'deadline');
    if (state.openEditor === 'dest') openEditor('deadline');
  }
  state.flow = computeFlow();
  updateStepper('time');
  syncRange();
  renderSentence();
  scheduleCount();
}

// "지금 14:00에 출발해서 15:30까지 출발지로 돌아올게요"
function renderSentence() {
  const dep = departMin();
  $('tok-depart').textContent = departIsNow() ? `지금 ${fmtHM(toMin(nowDate()))}` : (dep === null ? '--:--' : fmtHM(dep));
  const dl = parseHM($('deadline').value);
  $('tok-deadline').textContent = dl === null ? '--:--' : fmtHM(dl);
  const d = state.draft;
  const other = d.destMode === 'other' && d.dest;
  $('tok-dest').textContent = other ? d.dest.label : '출발지로';
  $('sent-tail').textContent = other ? '에 도착할게요' : ' 돌아올게요';
  const set = hasDeadline();
  document.querySelectorAll('.span-chip[data-add]').forEach((b) => {
    b.setAttribute('aria-pressed', String(set && dl !== null && dep !== null && dl - dep === +b.dataset.add));
  });
  $('chip-none').setAttribute('aria-pressed', String(!set));
}

function toggleCustom(open) {
  $('deadline-box').hidden = !open;
  $('btn-custom').setAttribute('aria-expanded', String(open));
}

// 조건을 바꿀 때마다 몇 곳인지 미리 세기 (찾기 버튼을 누르기 전)
let countTimer = null, countSeq = 0;
function scheduleCount() {
  clearTimeout(countTimer);
  countTimer = setTimeout(updateCount, 150);
}
async function updateCount() {
  const out = $('time-count');
  const d = state.draft;
  if (state.view !== 'time' || !state.dataOk || !d.origin || validateDepart() || validateDeadline()) { out.replaceChildren(); return; }
  const seq = ++countSeq;
  const withDeadline = hasDeadline();
  const dest = withDeadline ? (destOf(d) || d.origin) : null;
  const plan = {
    origin: d.origin, dest, destMode: d.destMode, hasDeadline: withDeadline,
    deadlineMin: withDeadline ? parseHM($('deadline').value) : null, nowMin: departMin(),
  };
  plan.routes = await cachedRoutes(d.origin, dest);
  if (seq !== countSeq) return; // 그사이 조건이 또 바뀜
  const n = compute(plan).filter((p) => p.reachable).length;
  if (!n) {
    out.replaceChildren(withDeadline ? '이 조건으로는 다녀올 곳이 없어요. 시간을 늘려 보세요.' : '지금 열려 있는 곳이 근처에 없어요.');
    return;
  }
  out.replaceChildren(withDeadline ? '이 조건이면 ' : `${departIsNow() ? '지금' : '그때'} 갈 수 있는 곳 `,
    el('strong', { textContent: `${n}곳` }), withDeadline ? '에 다녀올 수 있어요' : '');
}

// 시각 입력칸 ↔ 막대 ↔ '지금부터 ○ 뒤' 맞추기
function syncRange() {
  const now = departMin() ?? toMin(nowDate());
  const range = $('deadline-range');
  const max = Math.floor((LAST_MIN - now) / 10) * 10;
  range.disabled = max < MIN_WINDOW;
  range.max = String(Math.max(MIN_WINDOW, max));
  const v = parseHM($('deadline').value);
  if (v !== null && v > now) {
    range.value = String(Math.min(max, Math.max(MIN_WINDOW, v - now)));
    $('deadline-left').textContent = `${fromWord()} ${fmtSpan(v - now)} 뒤`;
  } else {
    range.value = String(MIN_WINDOW);
    $('deadline-left').textContent = range.disabled ? '오늘은 시간이 얼마 안 남았어요' : '';
  }
  range.setAttribute('aria-valuetext', $('deadline-left').textContent || '시각을 고르지 않았어요');
}

function onRange() {
  const now = departMin() ?? toMin(nowDate());
  const target = Math.min(LAST_MIN, Math.ceil((now + +$('deadline-range').value) / 5) * 5);
  $('deadline').value = fmtHM(target);
  clearErr('deadline-err', 'deadline');
  syncRange();
  renderSentence();
  scheduleCount();
}

function validateDeadline() {
  if (!hasDeadline()) return null;
  const now = departMin();
  if (now === null) return null; // 출발 시각 오류가 먼저 안내됨
  const v = parseHM($('deadline').value);
  if (v === null) return '몇 시까지 시간이 있는지 알려 주세요. 정해진 시각이 없으면 ‘제한 없음’을 고르세요.';
  if (v <= now) {
    // 밤늦게 이른 새벽 시각을 고르면 '내일'을 뜻한 것으로 봄
    if (now >= 18 * 60 && v < 6 * 60) return '오늘 안의 시각으로 골라 주세요. (자정 전까지만 찾을 수 있어요)';
    return departIsNow() ? '지금보다 늦은 시각을 골라 주세요.' : '출발 시각보다 늦은 시각을 골라 주세요.';
  }
  if (v - now < MIN_WINDOW) return `시간이 너무 짧아요. ${MIN_WINDOW}분 이상 남았을 때 찾아볼 수 있어요.`;
  return null;
}
function checkDeadline() {
  clearErr('deadline-err', 'deadline');
  const err = validateDeadline();
  if (!err) return true;
  openEditor('deadline');
  toggleCustom(true);
  showErr('deadline-err', err, 'deadline');
  $('deadline').focus();
  return false;
}

function onQuickAdd(e) {
  state.noDeadline = false;
  const target = (departMin() ?? toMin(nowDate())) + +e.currentTarget.dataset.add;
  clearErr('deadline-err', 'deadline');
  if (target >= 24 * 60) {
    $('deadline').value = '';
    syncTimeUI();
    toggleCustom(true);
    showErr('deadline-err', '오늘 안의 시각으로 골라 주세요. (자정 전까지만 찾을 수 있어요)', 'deadline');
    $('deadline').focus();
    return;
  }
  $('deadline').value = fmtHM(target);
  syncTimeUI();
}
function onNoDeadline() {
  state.noDeadline = true;
  syncTimeUI();
}

/* ---------- 찾기 ---------- */

async function runSearch() {
  if (!state.dataOk) {
    setStatus('error', '근처 정보를 불러오지 못해서 찾을 수 없어요.', '인터넷 연결을 확인하고 새로고침해 주세요.');
    return;
  }
  // 고르는 사이 시각이 지났을 수 있으니 다시 검사
  if (validateDepart() || validateDeadline()) { go('time'); checkTime(); return; }
  const d = state.draft;
  const withDeadline = hasDeadline();
  if (!d.origin) { go('origin'); onNext('origin'); return; }
  if (withDeadline && d.destMode === 'other' && !d.dest) { go('time'); checkDest(); return; }
  state.plan = {
    origin: d.origin, dest: withDeadline ? destOf(d) : null, destMode: d.destMode, hasDeadline: withDeadline,
    deadlineMin: withDeadline ? parseHM($('deadline').value) : null, nowMin: departMin(), departNow: departIsNow(),
  };
  const nextBtns = document.querySelectorAll('[data-next], [data-apply]');
  nextBtns.forEach((b) => { b.disabled = true; });
  setStatus('loading', '걷는 길을 계산하는 중이에요');
  state.plan.routes = await cachedRoutes(state.plan.origin, state.plan.dest);
  nextBtns.forEach((b) => { b.disabled = false; });
  state.computed = compute(state.plan);
  go('results', { focus: false });
  renderResults();
  $('v-results-h').focus();
}

function visibleResults() {
  const freeOnly = $('f-free').checked;
  const kind = document.querySelector('input[name="kind"]:checked').value;
  const sortBy = $('sort').value;
  return state.computed
    .filter((p) => p.reachable)
    .filter((p) => !freeOnly || p.isFree)
    .filter((p) => kind === 'all' || p.kind === kind)
    .sort((a, b) => sortBy === 'stay' ? (b.stay ?? -1) - (a.stay ?? -1) || a.go - b.go : a.go - b.go);
}

function renderResults({ keepStatus } = {}) {
  const say = keepStatus ? () => {} : setStatus;
  const list = $('result-list');
  list.replaceChildren();
  const plan = state.plan;
  const shown = visibleResults();
  const reachable = state.computed.filter((p) => p.reachable);

  $('results-count').textContent = `${shown.length}곳`;
  renderCondChips();
  renderExcluded();
  renderDataDate();

  if (!shown.length) {
    if (reachable.length) {
      say('empty', '필터 조건에 맞는 곳이 없어요.', `필터를 풀면 ${reachable.length}곳이 있어요. ‘무료만’이나 종류를 바꿔 보세요.`);
    } else {
      const nearest = state.computed.reduce((m, p) => Math.min(m, p.km), Infinity);
      const farAway = nearest > 15;
      if (farAway) say('empty', '출발지 근처에 찾아본 정보가 없어요. 지금은 서울 안의 정보만 있어요.', '서울 안의 역을 출발지로 골라 보세요.');
      else if (plan.hasDeadline) say('empty', `이 시간 안에 ${MIN_STAY}분 이상 머물 수 있는 곳이 없어요.`, '돌아올 시각을 늦추거나 도착지를 바꿔 보세요.');
      else say('empty', `${plan.departNow ? '지금' : '출발할 때'} 열려 있고 걸어서 ${NEARBY_MIN}분 안에 갈 곳이 없어요.`, '돌아올 시각을 정하면 조금 먼 곳이나 나중에 여는 곳도 찾아볼 수 있어요.');
    }
    list.append(el('li', { className: 'none', textContent: '조건에 맞는 곳이 없어요.' }));
  } else {
    say('ok', plan.hasDeadline ? `${fmtHM(plan.deadlineMin)}까지 다녀올 수 있는 곳 ${shown.length}곳을 찾았어요.` : `${plan.departNow ? '지금' : `${fmtHM(plan.nowMin)}에 출발하면`} 갈 수 있는 곳 ${shown.length}곳을 찾았어요.`);
    shown.forEach((p, i) => list.append(resultItem(p, i + 1)));
  }
  renderMapPlaces(shown, { fit: true, numbered: true });
}

// 운영하지 않아 뺀 곳: 접힌 목록으로
function renderCondChips() {
  const plan = state.plan;
  const dep = plan.departNow ? `지금 ${fmtHM(plan.nowMin)}` : fmtHM(plan.nowMin);
  const cells = [
    ['cc-origin', `출발 · ${plan.origin.label}`, '출발지'],
    ['cc-time', plan.hasDeadline ? `${dep} → ${fmtHM(plan.deadlineMin)}` : `${dep} · 시간 제한 없음`, '시간'],
    ['cc-dest', plan.destMode === 'return' ? '출발지로 복귀' : `${plan.dest?.label} 도착`, '도착지'],
  ];
  for (const [id, text, what] of cells) {
    $(id).textContent = text;
    $(id).setAttribute('aria-label', `${what}: ${text}. 눌러서 바꾸기`);
  }
  $('cc-dest').hidden = !plan.hasDeadline;
}

function renderExcluded() {
  const out = state.computed.filter((p) => p.why === 'closed' || p.why === 'hours');
  const box = $('excluded');
  box.hidden = !out.length;
  if (!out.length) return;
  box.open = false;
  $('excluded-summary').textContent = `운영하지 않아 뺀 곳 ${out.length}곳`;
  const list = $('excluded-list');
  list.replaceChildren();
  for (const p of out.sort((a, b) => a.go - b.go)) {
    const why = p.why === 'closed' ? p.sched.reason : '그 시간엔 운영하지 않아요';
    list.append(el('li', { textContent: `${p.title} — ${why}` }));
  }
}

function badges(p) {
  return el('span', { className: 'badges' },
    el('span', { className: `badge ${p.kind}`, textContent: p.kind === 'event' ? '행사' : '상시 장소' }),
    el('span', { className: `badge ${p.isFree ? 'free' : 'paid'}`, textContent: p.isFree ? '무료' : '유료' }),
    el('span', { className: 'badge cat', textContent: p.category }));
}

// 결과 카드: 이름 → 큰 숫자 두 개(걷는 시간·머물 수 있는 시간) → 한 줄 설명. 운영시간 원문·특이사항은 상세로.
function stayNumber(c) {
  if (c.startOnly) return `${fmtHM(c.from)} 시작`;
  if (c.stay == null) return '자유';
  return fmtDur(c.stay).replace('약 ', '');
}
// 가는 길·(기다림)·머무는 시간·(여유)·돌아오는 길 막대. 돌아올 시각이 있을 때만.
function timeBar(c, plan, { big = false } = {}) {
  if (!plan?.hasDeadline || !c.reachable || c.stay == null || c.until == null) return null;
  const total = plan.deadlineMin - plan.nowMin;
  const wait = Math.max(0, c.wait || 0);
  const idle = Math.max(0, total - (c.go + wait + c.stay + c.back));
  const segs = [['move', c.go], ['wait', wait], ['stay', c.stay], ['idle', idle], ['move', c.back]].filter(([, m]) => m > 0);
  const bar = el('span', { className: `tbar${big ? ' big' : ''}` }, ...segs.map(([k, m]) => {
    const seg = el('span', { className: `seg ${k}` });
    seg.style.flexGrow = String(m);
    return seg;
  }));
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `가는 길 ${c.go}분${wait ? `, 기다림 ${wait}분` : ''}, 머무는 시간 ${c.stay}분${idle ? `, 여유 ${idle}분` : ''}, ${plan.destMode === 'return' ? '돌아오는 길' : '도착지까지'} ${c.back}분`);
  return bar;
}

function resultItem(p, n) {
  const t = stayText(p);
  const kindText = p.kind === 'event' ? '행사' : '상시 장소';
  const bar = timeBar(p, state.plan);
  const when = [p.wait > 0 ? null : `${fmtHM(p.arrive)} 도착`, t.sub].filter(Boolean).join(' · ');
  const btn = el('button', { type: 'button', className: 'result-row' },
    el('span', { className: 'head' },
      el('span', { className: `num-badge ${p.kind}`, textContent: String(n) }),
      el('span', { className: 'head-text' },
        el('span', { className: 'title', textContent: p.title }),
        el('span', { className: 'meta', textContent: [kindText, p.isFree ? '무료' : '유료', p.category].join(' · ') }))),
    el('span', { className: 'nums' },
      el('span', { className: 'num' }, '걸어서', el('b', { textContent: fmtDur(p.go).replace('약 ', '') })),
      el('span', { className: `num stay${t.unknown ? ' unknown' : ''}` }, p.startOnly ? '공연' : '머물 수 있는 시간', el('b', { textContent: stayNumber(p) })),
      p.routed ? null : el('span', { className: 'approx', textContent: '직선 어림' })),
    bar,
    when ? el('span', { className: `meta${t.unknown ? ' warn' : ''}`, textContent: when }) : null);
  btn.append(el('span', { className: 'chev', textContent: '›' }));
  btn.setAttribute('aria-label', `${n}번 ${p.title}, ${kindText}, 걸어서 ${fmtDur(p.go)}, ${t.main}${t.sub ? `, ${t.sub}` : ''}. 자세히 보기`);
  btn.querySelector('.chev').setAttribute('aria-hidden', 'true');
  // 카드 ↔ 지도 번호 마커 연동
  btn.addEventListener('mouseenter', () => highlightMarker(p.id, { popup: false }));
  btn.addEventListener('focus', () => highlightMarker(p.id, { popup: false }));
  btn.addEventListener('mouseleave', () => highlightMarker(null, { popup: false }));
  btn.dataset.id = p.id;
  btn.addEventListener('click', () => openDetail(p.id));
  return el('li', {}, btn);
}

function stayLine(c) {
  const t = stayText(c);
  return el('span', { className: `stay${t.unknown ? ' unknown' : ''}` }, t.main, t.sub ? el('small', { textContent: ` · ${t.sub}` }) : null);
}

function renderDataDate() {
  const m = state.meta;
  if (!m?.updated_at) { $('data-date').textContent = ''; return; }
  const upd = new Date(m.updated_at);
  const days = Math.floor((nowDate() - upd) / 86400000);
  $('data-date').textContent = `정보 갱신 ${todayStr(upd)}${state.isSample ? ' · 샘플 데이터' : ''}${days >= STALE_DAYS ? ' · ⚠ 정보가 오래됐을 수 있어요' : ''} · 행사·도서관: 서울 열린데이터광장 · 길: © OpenStreetMap 기여자`;
}

/* ---------- 상세 ---------- */

function kakaoUrl(p) {
  // 카카오맵 길찾기 링크(도착지만 지정 → 출발은 카카오맵에서 현재 위치).
  // 출발지 좌표를 URL에 넣지 않는 것은 개인정보 설계상 의도한 것.
  const name = p.title.replace(/,/g, ' ');
  return `https://map.kakao.com/link/to/${encodeURIComponent(name)},${p.lat},${p.lng}`;
}

function openDetail(id) {
  const p = state.places.find((x) => x.id === id);
  if (!p) return;
  if (state.view !== 'detail') state.detailFrom = state.view;
  state.lastDetailId = id;
  const c = state.computed?.find((x) => x.id === id);
  const body = $('detail-body');
  body.replaceChildren();
  const wrap = el('article', { className: 'detail' });

  const visits = state.store.records.filter((r) => r.placeId === id);

  wrap.append(
    badges(p),
    el('h2', { id: 'v-detail-h', tabIndex: -1, textContent: p.title }),
    el('p', { className: 'venue', textContent: p.venue }));

  const info = el('dl', { className: 'info' });
  const addInfo = (k, v) => info.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
  addInfo('운영시간', p.hours || '정보 없음 · 방문 전 확인하세요');
  const sched = c?.sched || GapHours.todaySchedule({ hours: p.hours, closed: closedText(p) }, nowDate());
  addInfo('오늘', scheduleText(sched));
  if (closedText(p)) addInfo('휴관', closedText(p));
  addInfo('기간', p.kind === 'event'
    ? `${fmtDate(p.startDate)} ~ ${fmtDate(p.endDate)}${p.endDate === todayStr() ? ' (오늘 마지막 날)' : ''}`
    : '상시');
  addInfo('분류', `${p.kind === 'event' ? '행사' : '상시 장소'} · ${p.category}`);
  addInfo('요금', p.isFree ? '무료' : '유료');
  wrap.append(info);

  if (p.description) wrap.append(el('p', { className: 'desc', textContent: p.description }));

  if (c && state.plan) {
    const plan = state.plan;
    const why = { closed: sched.reason, hours: '이 시간엔 운영하지 않아요', time: '시간 안에 다녀오기 어려워요', far: `걸어서 ${NEARBY_MIN}분이 넘어요` };
    const rows = [
      ['가는 데 (걸어서)', fmtDur(c.go)],
      ['도착 예상', `약 ${fmtHM(c.arrive)}`],
      ['머물 수 있는 시간', !c.reachable ? why[c.why] || '—' : c.startOnly ? `${fmtHM(c.from)} 시작` : c.stay == null ? '자유' : fmtDur(c.stay)],
    ];
    if (plan.hasDeadline) {
      rows.push([plan.destMode === 'return' ? '돌아오는 데' : '도착지까지', fmtDur(c.back)]);
      if (c.reachable && c.until != null) rows.push(['나와야 하는 시각', `약 ${fmtHM(c.until)}`]);
    }
    const bar = timeBar(c, plan, { big: true });
    if (bar) {
      const lbl = (t, k) => el('span', {}, el('strong', { textContent: fmtHM(t) }), el('br'), k);
      wrap.append(el('div', { className: 'tblock' },
        el('div', { className: 'tblock-head' }, el('span', { textContent: c.startOnly ? '공연 시작 후 머물 수 있는 시간' : '머물 수 있는 시간' }), el('strong', { textContent: stayNumber(c) })),
        bar,
        el('div', { className: 'tblock-times' },
          lbl(plan.nowMin, '출발'), lbl(c.from, c.wait > 0 ? '입장' : '도착'), lbl(c.until, '나오기'),
          lbl(c.until + c.back, plan.destMode === 'return' ? '복귀' : '도착'))));
    } else {
      const times = el('dl', { className: 'times' });
      for (const [k, v] of rows) times.append(el('div', {}, el('dt', { textContent: k }), el('dd', { textContent: v })));
      wrap.append(el('h3', { textContent: '이동과 머무는 시간 (대략값)' }), times);
    }
    wrap.append(el('p', { className: 'hint', textContent: c.routed
      ? '걷는 시간은 OpenStreetMap 길 데이터로 계산했어요.'
      : '이 장소는 길 데이터 범위 밖이라 직선거리로 어림했어요. 실제로는 더 걸릴 수 있어요.' }));
    if (c.reachable) {
      const tips = [
        c.wait > 0 && `${fmtHM(c.from)}에 열어요. 도착해서 약 ${c.wait}분 기다려야 해요.`,
        c.limit === 'close' && `${fmtHM(c.until)}에 닫아요.`,
        c.startOnly && c.stay == null && '끝나는 시각은 방문 전 확인하세요.',
        !c.sched.known && '운영시간을 읽지 못해 이동 시간만으로 계산했어요. 방문 전 확인하세요.',
      ].filter(Boolean);
      if (tips.length) wrap.append(el('p', { className: 'hint', textContent: tips.join(' ') }));
    }
    if (c.go > TRANSIT_TIP_MIN || c.back > TRANSIT_TIP_MIN) {
      wrap.append(el('p', { className: 'transit-tip', textContent: '🚇 걸어서 20분이 넘어요. 대중교통이 더 빠를 수 있어요.' }));
    }
    if (/공휴일/.test(closedText(p))) wrap.append(el('p', { className: 'hint', textContent: '법정 공휴일 휴관은 반영했지만, 임시 휴관은 반영하지 못해요.' }));
  } else {
    wrap.append(el('p', { className: 'hint', textContent: '‘지금 떠나기’에서 조건을 고르면 이동 시간과 여유 시간을 계산해 드려요.' }));
  }

  const notes = (p.notes || []).filter((n) => !n.startsWith('휴관: ')); // 휴관은 위 정보에 이미 표시
  if (notes.length) {
    wrap.append(el('h3', { textContent: '특이사항' }), el('ul', { className: 'notes' }, ...notes.map((n) => el('li', { textContent: n }))));
  }
  if (p.subEvents?.length) {
    wrap.append(el('h3', { textContent: p.kind === 'event' ? '세부 프로그램' : '진행 중인 프로그램' }),
      el('ul', { className: 'subs' }, ...p.subEvents.map((s) => el('li', {}, el('span', { textContent: s.when }), s.title))));
  }

  wrap.append(el('p', {
    className: 'visits',
    textContent: visits.length
      ? `이전에 ${visits.length}번 다녀왔어요 · 마지막 ${visits[0].date}`
      : '아직 다녀온 적 없어요.',
  }));

  const actions = el('div', { className: 'actions' });
  const share = el('button', { type: 'button', className: 'btn share-btn', textContent: '공유' });
  share.setAttribute('aria-label', `${p.title} 공유`);
  share.addEventListener('click', () => shareSpot(p));
  actions.append(share);
  const map = el('a', { className: 'btn', href: kakaoUrl(p), target: '_blank', rel: 'noopener', textContent: '길찾기 (카카오맵)' });
  map.setAttribute('aria-label', `${p.title} 길찾기, 카카오맵 새 탭에서 열림`);
  actions.append(map);
  if (p.url) {
    const off = el('a', { className: 'btn', href: p.url, target: '_blank', rel: 'noopener', textContent: p.kind === 'event' ? '행사 정보 바로가기' : '공식 사이트' });
    off.setAttribute('aria-label', `${p.title} ${off.textContent}, 새 탭에서 열림`);
    actions.append(off);
  }
  const doneToday = visits.some((r) => r.date === todayStr());
  const done = el('button', { type: 'button', className: 'btn btn-primary', textContent: doneToday ? '오늘 기록했어요 ✓' : '다녀왔어요', disabled: doneToday });
  done.addEventListener('click', () => addRecord(p, c));
  actions.append(done);
  wrap.append(actions);

  body.append(wrap);
  $('btn-detail-back').textContent = state.detailFrom === 'results' ? '← 목록으로' : '← 돌아가기';
  go('detail', { focus: false });
  $('v-detail-h').focus();
  if (!drawRoute(c)) panTo(p, 15);
  highlightMarker(id);
}

// 장소 링크 공유: ?place=<id> (위치 정보는 넣지 않음)
async function shareSpot(p) {
  const url = `${location.origin}${location.pathname}?place=${encodeURIComponent(p.id)}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: p.title, text: `${p.title} · ${p.venue}`, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    setStatus('ok', '장소 링크를 복사했어요.', '메신저에 붙여 넣어 보내 보세요.');
  } catch (e) {
    if (e?.name === 'AbortError') return; // 공유 창을 닫음
    setStatus('error', '링크를 복사하지 못했어요. 아래 주소를 직접 복사해 주세요.', url);
  }
}

function closeDetail() {
  const id = state.lastDetailId;
  go(state.detailFrom);
  if (state.detailFrom === 'results') {
    document.querySelector(`.result-row[data-id="${id}"]`)?.focus();
  }
}

/* ---------- 나들이 기록 ---------- */

function addRecord(p, c) {
  const ok = c?.reachable && state.plan;
  const plannedMin = ok ? c.go + (c.stay ?? 0) + c.back : null;
  const rec = {
    placeId: p.id, title: p.title, venue: p.venue, date: todayStr(), plannedMin,
    departAt: ok ? fmtHM(state.plan.nowMin) : null,
    returnAt: ok && state.plan.hasDeadline && c.until != null ? fmtHM(c.until + c.back) : null,
    stayMin: ok ? c.stay : null,
    starred: false,
  };
  state.store.records.unshift(rec);
  if (!saveStore()) { state.store.records.shift(); return; }
  setStatus('ok', `‘${p.title}’ 나들이를 기록했어요. 위쪽 ‘나들이 기록’ 탭에서 볼 수 있어요.`);
  openDetail(p.id);
}

function renderRecordsPage() {
  const all = state.store.records;
  const thisMonth = todayStr().slice(0, 7);
  const month = state.recMonth || (state.recMonth = thisMonth);
  const [y, m] = month.split('-').map(Number);
  $('rec-month-h').textContent = `${y}년 ${m}월`;
  const oldest = all.reduce((a, r) => (r.date < a ? r.date : a), todayStr()).slice(0, 7);
  $('rec-prev').disabled = month <= oldest;
  $('rec-next').disabled = month >= thisMonth;

  const inMonth = all.map((r, i) => ({ r, i }))
    .filter(({ r }) => r.date.startsWith(month))
    .sort((a, b) => b.r.date.localeCompare(a.r.date) || a.i - b.i);
  // 처음 간 곳: 이 기록보다 앞선 같은 장소 기록이 없음 (기록은 최근 것이 앞에 쌓임)
  const isFirst = ({ r, i }) => !all.some((o, j) => o.placeId === r.placeId && (o.date < r.date || (o.date === r.date && j > i)));
  $('rec-count').textContent = `${inMonth.length}번`;
  const mins = inMonth.reduce((sum, { r }) => sum + (r.plannedMin || 0), 0);
  $('rec-time').textContent = mins ? fmtSpan(mins) : '—';
  $('rec-first').textContent = `${inMonth.filter(isFirst).length}곳`;

  // 달력
  const cal = $('rec-cal');
  cal.replaceChildren();
  for (const w of '일월화수목금토') cal.append(el('span', { className: 'cal-h', textContent: w }));
  const firstDow = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  for (let k = 0; k < firstDow; k++) cal.append(el('span'));
  const counts = {};
  inMonth.forEach(({ r }) => { const d = +r.date.slice(8, 10); counts[d] = (counts[d] || 0) + 1; });
  const today = todayStr();
  for (let d = 1; d <= days; d++) {
    const ds = `${month}-${pad(d)}`;
    const cell = el('span', { className: `cal-d${counts[d] ? ' on' : ''}${ds === today ? ' today' : ''}`, textContent: String(d) });
    if (counts[d] > 1) cell.append(el('small', { textContent: `×${counts[d]}` }));
    cal.append(cell);
  }
  const visited = Object.keys(counts).map(Number).sort((a, b) => a - b);
  cal.setAttribute('aria-label', visited.length ? `${m}월에 다녀온 날: ${visited.map((d) => `${d}일`).join(', ')}` : `${m}월에는 다녀온 날이 없어요`);

  // 이 달의 기록
  const list = $('record-list');
  list.replaceChildren();
  if (!inMonth.length) {
    list.append(el('li', { className: 'empty', textContent: all.length ? `${m}월에는 기록이 없어요.` : '아직 기록이 없어요. 장소 상세에서 ‘다녀왔어요’를 눌러 보세요.' }));
  }
  for (const { r, i } of inMonth) {
    const dt = new Date(`${r.date}T00:00:00`);
    const meta = r.departAt
      ? `${r.departAt}${r.returnAt ? ` → ${r.returnAt}` : ' 출발'}${r.stayMin != null ? ` · 머문 시간(계획) ${fmtDur(r.stayMin)}` : ''}`
      : `${r.venue}${r.plannedMin ? ` · 계획 ${fmtDur(r.plannedMin)}` : ''}`;
    const star = el('button', { type: 'button', className: `star-btn${r.starred ? ' on' : ''}`, textContent: r.starred ? '★' : '☆' });
    star.setAttribute('aria-pressed', String(!!r.starred));
    star.setAttribute('aria-label', `${r.title} 다시 가고 싶은 곳으로 표시`);
    star.addEventListener('click', () => toggleStar(i));
    const del = el('button', { type: 'button', className: 'btn btn-ghost', textContent: '삭제' });
    del.setAttribute('aria-label', `${r.date} ${r.title} 기록 삭제`);
    del.addEventListener('click', () => removeRecord(i));
    list.append(el('li', {},
      el('span', { className: 'rec-day' }, el('strong', { textContent: String(dt.getDate()) }), el('span', { textContent: '일월화수목금토'[dt.getDay()] })),
      el('div', { className: 'rec-body' }, el('strong', { textContent: r.title }), el('span', { className: 'meta', textContent: meta })),
      star, del));
  }
  $('btn-clear-records').disabled = !all.length;

  const favs = $('fav-manage');
  favs.replaceChildren();
  if (!state.store.favorites.length) {
    favs.append(el('li', { className: 'empty', textContent: '즐겨찾기 역이 없어요. ‘지금 떠나기’에서 역을 검색한 뒤 추가할 수 있어요.' }));
  }
  for (const f of state.store.favorites) {
    const st = stationById(f.stationId);
    const del = el('button', { type: 'button', className: 'btn btn-ghost', textContent: '삭제' });
    del.setAttribute('aria-label', `즐겨찾기 ${f.name} 삭제`);
    del.addEventListener('click', () => removeFavorite(f.id));
    favs.append(el('li', {}, el('div', {}, el('strong', { textContent: f.name }), el('span', { className: 'meta', textContent: st ? `${st.name}역` : '알 수 없는 역' })), del));
  }
  $('btn-clear-favs').disabled = !state.store.favorites.length;
}

function toggleStar(i) {
  const r = state.store.records[i];
  if (!r) return;
  r.starred = !r.starred;
  if (!saveStore()) { r.starred = !r.starred; return; }
  renderRecordsPage();
  setStatus('ok', r.starred ? `‘${r.title}’을(를) 다시 가고 싶은 곳으로 표시했어요.` : '표시를 지웠어요.');
}

function shiftRecMonth(delta) {
  const [y, m] = state.recMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.recMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  renderRecordsPage();
}

function removeRecord(i) {
  const before = state.store.records.slice();
  state.store.records.splice(i, 1);
  if (!saveStore()) { state.store.records = before; return; }
  renderRecordsPage();
  setStatus('ok', '기록을 삭제했어요.');
  $('records-h').focus();
}

function clearAll(kind) {
  const label = kind === 'records' ? '나들이 기록' : '즐겨찾기';
  if (!confirm(`${label}을(를) 모두 지울까요? 되돌릴 수 없어요.`)) return;
  const before = state.store[kind];
  state.store[kind] = [];
  if (!saveStore()) { state.store[kind] = before; return; }
  if (kind === 'favorites') {
    for (const t of ['origin', 'dest']) if (state.draft[t]?.favId) state.draft[t] = null;
  }
  renderRecordsPage();
  setStatus('ok', `${label}을(를) 모두 지웠어요.`);
  $('records-h').focus();
}

/* ---------- 지도 ---------- */
// 지도 엔진을 감싼 함수들: initMap / renderMapPlaces / renderMapMe / panTo / highlightMarker / relayoutMap

let mapEngine = null; // 'kakao' | 'leaflet' | null(지도 없음)
let map = null;
let placeLayer = null, meLayer = null;   // Leaflet 레이어
let kPlaces = [], kMe = [];              // 카카오 오버레이
const markers = new Map();               // place id → { el?, leaflet? }

const kLevel = (zoom) => Math.min(14, Math.max(1, 19 - zoom)); // Leaflet 줌 → 카카오 레벨(대략)
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function loadKakaoSdk(key) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('카카오 지도 응답 없음')), 8000);
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`;
    s.onload = () => {
      if (!window.kakao?.maps) { clearTimeout(t); reject(new Error('카카오 지도 객체 없음')); return; }
      kakao.maps.load(() => { clearTimeout(t); resolve(); });
    };
    s.onerror = () => { clearTimeout(t); reject(new Error('카카오 지도 스크립트 불러오기 실패')); };
    document.head.append(s);
  });
}

async function initMap() {
  const cfg = window.GAPTRIP_CONFIG || {};
  const key = cfg.kakaoJsKey;
  const forceLeaflet = new URLSearchParams(location.search).get('map') === 'leaflet';
  if (cfg.useKakaoMap && key && !forceLeaflet) {
    try {
      await loadKakaoSdk(key);
      map = new kakao.maps.Map($('map'), { center: new kakao.maps.LatLng(...SEOUL), level: 7 });
      map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
      mapEngine = 'kakao';
      return;
    } catch (e) {
      console.warn('카카오 지도를 불러오지 못해 OpenStreetMap으로 대신합니다.', e);
    }
  }
  if (!window.L) { $('map-fallback').hidden = false; return; }
  try {
    map = L.map('map', { zoomControl: true }).setView(SEOUL, 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 기여자 · <a href="https://www.openstreetmap.org/fixthemap">지도 오류 알리기</a>',
    }).addTo(map);
    placeLayer = L.layerGroup().addTo(map);
    meLayer = L.layerGroup().addTo(map);
    mapEngine = 'leaflet';
  } catch (e) {
    console.error(e);
    map = null;
    $('map-fallback').hidden = false;
  }
}

const kLL = (p) => new kakao.maps.LatLng(p.lat, p.lng);
function kOverlay(p, content, opts = {}) {
  const o = new kakao.maps.CustomOverlay({ position: kLL(p), content, xAnchor: 0.5, yAnchor: 0.5, ...opts });
  o.setMap(map);
  return o;
}

function placeDot(p) {
  const b = el('button', { type: 'button', className: `kmarker ${p.kind}`, title: p.title });
  b.setAttribute('aria-label', `${p.title} 자세히 보기`);
  b.addEventListener('click', () => openDetail(p.id));
  return b;
}

function renderMapPlaces(list, { fit, numbered = false }) {
  if (!mapEngine) return;
  markers.clear();
  if (mapEngine === 'kakao') {
    kPlaces.forEach((o) => o.setMap(null));
    kPlaces = list.map((p, i) => {
      const dot = placeDot(p);
      if (numbered) dot.textContent = String(i + 1);
      markers.set(p.id, { el: dot });
      return kOverlay(p, dot, { zIndex: 2 });
    });
  } else {
    placeLayer.clearLayers();
    if (numbered) {
      // 결과: 목록 순서대로 번호를 붙인 마커 (키보드는 목록 카드로 다룸)
      list.forEach((p, i) => {
        const m = L.marker([p.lat, p.lng], {
          icon: L.divIcon({ className: '', html: `<span class="num-pin ${p.kind === 'event' ? 'event' : 'place'}">${i + 1}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
          keyboard: false,
          riseOnHover: true,
        });
        m.bindTooltip(`${i + 1}. ${p.title}`, { direction: 'top', offset: [0, -14] });
        m.on('click', () => openDetail(p.id));
        m.on('mouseover', () => hoverCard(p.id, true));
        m.on('mouseout', () => hoverCard(p.id, false));
        m.addTo(placeLayer);
        markers.set(p.id, { leaflet: m, num: i + 1 });
      });
    }
    for (const p of numbered ? [] : list) {
      const m = L.circleMarker([p.lat, p.lng], {
        radius: 9, color: '#fff', weight: 2, fillColor: COLORS[p.kind], fillOpacity: 1,
      });
      const more = el('button', { type: 'button', className: 'link', textContent: '자세히 보기 →' });
      more.addEventListener('click', () => openDetail(p.id));
      m.bindPopup(el('div', {}, el('strong', { textContent: p.title }), el('span', { textContent: p.venue }), el('br'), more));
      m.bindTooltip(p.title);
      m.addTo(placeLayer);
      markers.set(p.id, { leaflet: m });
    }
  }
  if (fit) {
    const pts = list.slice();
    if (state.plan) pts.push(state.plan.origin, ...(state.plan.dest ? [state.plan.dest] : []));
    if (!pts.length) return;
    if (mapEngine === 'kakao') {
      const bounds = new kakao.maps.LatLngBounds();
      pts.forEach((p) => bounds.extend(kLL(p)));
      map.setBounds(bounds, 48, 48, 48, 48);
      if (map.getLevel() < kLevel(15)) map.setLevel(kLevel(15));
    } else {
      map.fitBounds(pts.map((p) => [p.lat, p.lng]), { padding: [40, 40], maxZoom: 15 });
    }
  }
}

function renderMapMe() {
  if (!mapEngine) return;
  const d = state.draft;
  const hereTip = state.here ? (state.here.demo ? `현재 위치 (가정: ${DEMO_HERE.name})` : '현재 위치') : '';
  const pts = [];
  // 현재 위치가 출발지면 현재 위치 핀이 대신함
  if (d.origin && d.origin.type !== 'geo') pts.push([d.origin, d.destMode === 'return' ? '출발·도착' : '출발']);
  if (d.destMode === 'other' && d.dest) pts.push([d.dest, '도착']);

  if (mapEngine === 'kakao') {
    kMe.forEach((o) => o.setMap(null));
    kMe = [];
    if (state.here) kMe.push(kOverlay(state.here, el('div', { className: 'here-pin', title: hereTip }), { zIndex: 5 }));
    for (const [p, label] of pts) {
      const node = el('div', { className: 'kme' }, el('span', { className: 'kme-label', textContent: `${label}: ${p.label}` }), el('span', { className: 'kme-dot' }));
      kMe.push(kOverlay(p, node, { yAnchor: 1, zIndex: 4 }));
    }
  } else {
    meLayer.clearLayers();
    if (state.here) {
      L.marker([state.here.lat, state.here.lng], {
        icon: L.divIcon({ className: '', html: '<div class="here-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        keyboard: false, zIndexOffset: 1000,
      }).bindTooltip(hereTip).addTo(meLayer);
    }
    for (const [p, label] of pts) {
      L.circleMarker([p.lat, p.lng], { radius: 10, color: '#fff', weight: 3, fillColor: COLORS.me, fillOpacity: 1 })
        .bindTooltip(`${label}: ${p.label}`, { permanent: true, direction: 'top', offset: [0, -8] })
        .addTo(meLayer);
    }
  }
}

function panTo(p, zoom) {
  if (mapEngine === 'kakao') {
    if (map.getLevel() > kLevel(zoom)) map.setLevel(kLevel(zoom));
    if (reduceMotion()) map.setCenter(kLL(p)); else map.panTo(kLL(p));
  } else if (mapEngine === 'leaflet') {
    map.setView([p.lat, p.lng], Math.max(map.getZoom(), zoom), { animate: !reduceMotion() });
  }
}

function highlightMarker(id, { popup = true } = {}) {
  markers.forEach((m, key) => {
    const on = key === id;
    m.el?.classList.toggle('is-active', on);
    if (m.num && m.leaflet) {
      m.leaflet.getElement()?.querySelector('.num-pin')?.classList.toggle('is-active', on);
      m.leaflet.setZIndexOffset(on ? 1000 : 0);
      if (on) m.leaflet.openTooltip(); else m.leaflet.closeTooltip();
    }
  });
  const m = markers.get(id);
  if (popup && m?.leaflet && !m.num) m.leaflet.openPopup();
}

// 지도 마커에 올리면 목록 카드도 강조
function hoverCard(id, on) {
  document.querySelector(`.result-row[data-id="${CSS.escape(id)}"]`)?.classList.toggle('is-hover', on);
}

// 상세: 출발지 → 장소 경로 선 (도착지가 다르면 장소 → 도착지 점선)
let routeLayer = null;
function clearRoute() {
  if (routeLayer) { routeLayer.remove(); routeLayer = null; }
}
function drawRoute(c) {
  clearRoute();
  const routes = state.plan?.routes;
  if (mapEngine !== 'leaflet' || !routes || !c?.routed) return false;
  const goPath = routes.goPath(c);
  if (!goPath) return false;
  routeLayer = L.featureGroup().addTo(map);
  L.polyline(goPath, { color: '#b2410f', weight: 5, opacity: 0.9 }).addTo(routeLayer);
  if (state.plan.hasDeadline && state.plan.destMode === 'other') {
    const back = routes.backPath(c);
    if (back) L.polyline(back, { color: '#1d1b18', weight: 4, opacity: 0.7, dashArray: '6 8' }).addTo(routeLayer);
  }
  map.fitBounds(routeLayer.getBounds(), { padding: [48, 48], maxZoom: 17, animate: !reduceMotion() });
  return true;
}

function relayoutMap() {
  if (mapEngine === 'kakao') map.relayout();
  else if (mapEngine === 'leaflet') map.invalidateSize();
}

/* ---------- 휴대전화 아래 시트 ---------- */

function setSheet(mode) {
  const panel = $('panel');
  panel.classList.toggle('expanded', mode === 'expanded');
  panel.classList.toggle('collapsed', mode === 'collapsed');
  $('sheet-toggle').setAttribute('aria-expanded', String(mode !== 'collapsed'));
  $('sheet-toggle-label').textContent = mode === 'collapsed' ? '패널 펼치기' : '지도 크게 보기';
  setTimeout(relayoutMap, 250);
}
function toggleSheet() {
  const collapsed = $('panel').classList.contains('collapsed');
  setSheet(collapsed ? (state.view === 'start' ? 'normal' : 'expanded') : 'collapsed');
}

/* ---------- 페이지 이동 (홈 / 기록) ---------- */

function route() {
  const onRecords = location.hash === '#/records';
  $('home').hidden = onRecords;
  $('records-page').hidden = !onRecords;
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.route === (onRecords ? 'records' : 'home')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (onRecords) {
    renderRecordsPage();
    $('records-h').focus();
  } else {
    setTimeout(relayoutMap, 0);
    if (state.view === 'detail') {
      // 기록 삭제 등으로 방문 횟수가 바뀌었을 수 있음
      const id = state.lastDetailId;
      if (id) openDetail(id);
    }
  }
}

/* ---------- 시작 ---------- */

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

async function init() {
  setStatus('loading', '근처 정보를 불러오는 중이에요');
  const storeOk = loadStore();

  const tickNow = () => {
    const t = fmtHM(toMin(nowDate()));
    $('now-label').textContent = t;
    $('depart-now').textContent = t;
    if (state.view === 'time') { syncRange(); renderSentence(); }
  };
  tickNow();
  setInterval(tickNow, 30000);

  buildPicker('origin');
  buildPicker('dest');
  const mapReady = initMap();

  // 이벤트 연결
  $('btn-start').addEventListener('click', startFlow);
  $('btn-change-origin').addEventListener('click', () => { state.flowHasOrigin = true; state.flow = computeFlow(); go('origin'); });
  document.querySelectorAll('[data-prev]').forEach((b) => b.addEventListener('click', goPrev));
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  document.querySelectorAll('[data-next]').forEach((b) => b.addEventListener('click', () => onNext(b.dataset.next)));
  $('btn-detail-back').addEventListener('click', closeDetail);
  $('deadline').addEventListener('input', () => { clearErr('deadline-err', 'deadline'); syncRange(); renderSentence(); scheduleCount(); });
  $('deadline-range').addEventListener('input', onRange);
  document.querySelectorAll('input[name="departMode"]').forEach((r) => r.addEventListener('change', syncDepartUI));
  $('depart').addEventListener('input', () => { clearErr('depart-err', 'depart'); syncRange(); renderSentence(); scheduleCount(); });
  $('deadline').addEventListener('keydown', (e) => { if (e.key === 'Enter') onNext('time'); });
  document.querySelectorAll('.span-chip[data-add]').forEach((b) => b.addEventListener('click', onQuickAdd));
  $('chip-none').addEventListener('click', onNoDeadline);
  $('btn-custom').addEventListener('click', () => toggleCustom($('deadline-box').hidden));
  document.querySelectorAll('#time-sentence .tok').forEach((t) => t.addEventListener('click', () => openEditor(t.dataset.editor)));
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => startEdit(b.dataset.edit)));
  document.querySelectorAll('[data-apply]').forEach((b) => b.addEventListener('click', () => applyEdit(b.dataset.apply)));
  document.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', cancelEdit));
  $('rec-prev').addEventListener('click', () => shiftRecMonth(-1));
  $('rec-next').addEventListener('click', () => shiftRecMonth(1));
  document.querySelectorAll('input[name="destMode"]').forEach((r) => r.addEventListener('change', syncDestMode));
  const refilter = () => state.computed && renderResults();
  $('f-free').addEventListener('change', refilter);
  document.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', refilter));
  $('sort').addEventListener('change', refilter);
  $('btn-clear-records').addEventListener('click', () => clearAll('records'));
  $('btn-clear-favs').addEventListener('click', () => clearAll('favorites'));
  $('sheet-toggle').addEventListener('click', toggleSheet);
  window.addEventListener('hashchange', route);

  try {
    await mapReady;
    const [places, stations, meta] = await Promise.all([fetchJson(PLACES_URL), fetchJson(STATIONS_URL), fetchJson(META_URL)]);
    state.places = (Array.isArray(places) ? places : places.items)
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    state.stations = stations.items || stations;
    state.meta = meta;
    state.isSample = Boolean(places.sample || meta.sample);
    state.dataOk = true;
  } catch (e) {
    console.error(e);
    setStatus('error', '근처 정보를 불러오지 못했어요.', '인터넷 연결을 확인하고 잠시 뒤 새로고침해 주세요.');
    route();
    return;
  }

  $('sample-note').hidden = !state.isSample;
  const upd = state.meta.updated_at ? todayStr(new Date(state.meta.updated_at)) : '알 수 없음';
  $('foot-meta').textContent = `정보 갱신일 ${upd}${state.isSample ? ' · 샘플 데이터(가짜)' : ''} · 걷는 시간은 OpenStreetMap 길 데이터(ODbL) 기반 대략값 · 지도 © ${mapEngine === 'kakao' ? 'Kakao' : 'OpenStreetMap 기여자'}`;

  go('start', { focus: false });
  route();
  renderHere();
  locateMe();

  // 공유받은 장소 링크(?place=)로 열면 그 상세부터
  const sharedId = new URLSearchParams(location.search).get('place');
  if (sharedId) {
    if (state.places.some((x) => x.id === sharedId)) openDetail(sharedId);
    else setStatus('empty', '링크의 장소를 찾지 못했어요.', '행사가 끝났거나 정보가 바뀌었을 수 있어요.');
  }

  if (!storeOk) {
    setStatus('error', '저장된 즐겨찾기와 기록을 읽지 못했어요.', '사생활 보호 모드라면 일반 창에서 열어 주세요. 찾기는 그대로 쓸 수 있어요.');
  }
}

init();
