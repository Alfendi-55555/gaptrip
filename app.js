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
const NEARBY_MIN = 30; // 홈에서 '근처'로 세는 편도 도보 시간
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
  store: { favorites: [], stayMin: 30, records: [] },
  // 지금 떠나기 단계에서 고르는 값
  draft: { origin: null, dest: null, destMode: 'return' },
  here: null,       // 현재 위치 { lat, lng, demo } — 저장하지 않음
  hereState: 'pending', // pending | ok | fail
  flow: ['origin', 'time', 'dest', 'confirm'],
  plan: null,       // { origin, dest, deadlineMin, stayMin, nowMin }
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
const walkMin = (km) => Math.max(1, Math.round((km * DETOUR / WALK_KMH) * 60));
const isOpenToday = (p) => p.kind !== 'event' || (p.startDate <= todayStr() && todayStr() <= p.endDate);

function compute(plan) {
  const out = [];
  for (const p of state.places) {
    if (!isOpenToday(p)) continue;
    const km = haversineKm(plan.origin, p);
    const go = walkMin(km);
    const back = walkMin(haversineKm(p, plan.dest));
    const total = go + plan.stayMin + back;
    const slack = plan.deadlineMin - (plan.nowMin + total);
    out.push({ ...p, km, go, back, total, slack, reachable: slack >= 0 });
  }
  return out;
}

/* ---------- 저장 (localStorage) ---------- */

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return true;
    const s = JSON.parse(raw);
    state.store = {
      favorites: Array.isArray(s.favorites) ? s.favorites : [],
      stayMin: [15, 30, 60].includes(s.stayMin) ? s.stayMin : 30,
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

const VIEWS = ['start', 'origin', 'time', 'dest', 'confirm', 'results', 'detail'];
const STEP_NAMES = { origin: '출발지', time: '시간', dest: '도착지', confirm: '확인' };

// 현재 위치를 이미 알면 출발지 단계를 건너뛰고 3단계로 진행
function startFlow() {
  state.flow = state.draft.origin ? ['time', 'dest', 'confirm'] : ['origin', 'time', 'dest', 'confirm'];
  go(state.flow[0]);
}
function goPrev() {
  const i = state.flow.indexOf(state.view);
  go(i > 0 ? state.flow[i - 1] : 'start');
}

function go(view, { focus = true } = {}) {
  state.view = view;
  for (const v of VIEWS) document.querySelector(`[data-view="${v}"]`).hidden = v !== view;
  if (view === 'start') {
    if (state.hereState !== 'fail') clearStatus();
    renderMapPlaces(state.places.filter(isOpenToday), { fit: false });
    if (state.here) panTo(state.here, 15);
  }
  if (view === 'origin') renderPicker('origin');
  const stepper = document.querySelector(`[data-view="${view}"] .stepper`);
  if (stepper) {
    const i = state.flow.indexOf(view);
    stepper.textContent = i < 0 ? '출발지 바꾸기' : `${i + 1} / ${state.flow.length} · ${STEP_NAMES[view]}`;
  }
  if (view === 'dest') { syncDestMode(); renderPicker('dest'); }
  if (view === 'confirm') renderSummary();
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
    if (!checkDeadline()) return;
    go('dest');
  } else if (step === 'dest') {
    clearErr('dest-pick-err');
    if (state.draft.destMode === 'other' && !state.draft.dest) {
      showErr('dest-pick-err', '도착지를 골라 주세요. 즐겨찾기나 역 검색으로 고를 수 있어요.');
      $('dest-q').focus();
      return;
    }
    go('confirm');
  }
}

function destOf(draft) {
  return draft.destMode === 'return' ? draft.origin : draft.dest;
}

function renderSummary() {
  const d = state.draft;
  $('sum-origin').textContent = d.origin?.label || '—';
  const dl = parseHM($('deadline').value);
  $('sum-time').textContent = dl === null ? '—' : `${fmtHM(dl)}까지 · 머무는 시간 ${currentStay()}분`;
  $('sum-dest').textContent = d.destMode === 'return' ? `출발지로 돌아오기 (${d.origin?.label || '—'})` : (d.dest?.label || '—');
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
    if (!fromPicker) panTo(state.here, 15);
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
  setStatus('error', msg, '즐겨찾기나 역 검색으로 출발지를 골라 주세요.');
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
    const near = state.places.filter((p) => isOpenToday(p) && walkMin(haversineKm(o, p)) <= NEARBY_MIN);
    const ev = near.filter((p) => p.kind === 'event').length;
    $('today-count').textContent = `걸어서 ${NEARBY_MIN}분 안에 오늘 열린 행사 ${ev}곳, 상시 장소 ${near.length - ev}곳이 있어요. 몇 시까지 시간이 있는지만 알려 주세요.`;
  } else if (state.hereState === 'pending') {
    line.textContent = '📍 현재 위치를 확인하는 중…';
  } else {
    line.append('📍 현재 위치를 확인할 수 없어요', el('small', { textContent: '즐겨찾기나 역 검색으로 출발지를 골라 주세요.' }));
    btn.textContent = '출발지 고르기';
    $('today-count').textContent = '';
  }
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
}

/* ---------- 언제까지 입력 검증 ---------- */

const currentStay = () => +document.querySelector('input[name="stay"]:checked').value;

function validateDeadline() {
  const now = toMin(nowDate());
  const stay = currentStay();
  const v = parseHM($('deadline').value);
  if (v === null) return '몇 시까지 시간이 있는지 알려 주세요.';
  if (v <= now) {
    // 밤늦게 이른 새벽 시각을 고르면 '내일'을 뜻한 것으로 봄
    if (now >= 18 * 60 && v < 6 * 60) return '오늘 안의 시각으로 골라 주세요. (자정 전까지만 찾을 수 있어요)';
    return '지금보다 늦은 시각을 골라 주세요.';
  }
  if (v - now < stay) return `시간이 너무 짧아요. ${stay}분 이상 남았을 때 찾아볼 수 있어요.`;
  return null;
}
function checkDeadline() {
  clearErr('deadline-err', 'deadline');
  const err = validateDeadline();
  if (!err) return true;
  showErr('deadline-err', err, 'deadline');
  $('deadline').focus();
  return false;
}

function onQuickAdd(e) {
  const target = toMin(nowDate()) + +e.currentTarget.dataset.add;
  clearErr('deadline-err', 'deadline');
  if (target >= 24 * 60) {
    $('deadline').value = '';
    showErr('deadline-err', '오늘 안의 시각으로 골라 주세요. (자정 전까지만 찾을 수 있어요)', 'deadline');
    $('deadline').focus();
    return;
  }
  $('deadline').value = fmtHM(target);
}

/* ---------- 찾기 ---------- */

function runSearch() {
  if (!state.dataOk) {
    setStatus('error', '근처 정보를 불러오지 못해서 찾을 수 없어요.', '인터넷 연결을 확인하고 새로고침해 주세요.');
    return;
  }
  // 확인 화면에 머무는 사이 시각이 지났을 수 있으니 다시 검사
  if (validateDeadline()) { go('time'); checkDeadline(); return; }
  const d = state.draft;
  if (!d.origin) { go('origin'); onNext('origin'); return; }
  if (d.destMode === 'other' && !d.dest) { go('dest'); onNext('dest'); return; }
  state.plan = {
    origin: d.origin, dest: destOf(d), destMode: d.destMode,
    deadlineMin: parseHM($('deadline').value), stayMin: currentStay(), nowMin: toMin(nowDate()),
  };
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
    .sort((a, b) => sortBy === 'slack' ? b.slack - a.slack : a.go - b.go);
}

function renderResults({ keepStatus } = {}) {
  const say = keepStatus ? () => {} : setStatus;
  const list = $('result-list');
  list.replaceChildren();
  const plan = state.plan;
  const shown = visibleResults();
  const reachable = state.computed.filter((p) => p.reachable);

  $('results-count').textContent = `${shown.length}곳`;
  $('results-summary').textContent =
    `${plan.origin.label} 출발 → ${fmtHM(plan.deadlineMin)}까지 ${plan.destMode === 'return' ? '출발지로 복귀' : plan.dest.label + ' 도착'} · 머무는 시간 ${plan.stayMin}분`;
  renderDataDate();

  if (!shown.length) {
    if (reachable.length) {
      say('empty', '필터 조건에 맞는 곳이 없어요.', `필터를 풀면 ${reachable.length}곳이 있어요. ‘무료만’이나 종류를 바꿔 보세요.`);
    } else {
      const nearest = state.computed.reduce((m, p) => Math.min(m, p.km), Infinity);
      const farAway = nearest > 15;
      say('empty',
        farAway ? '출발지 근처에 찾아본 정보가 없어요. 지금은 서울 안의 정보만 있어요.' : '이 시간 안에 다녀올 곳이 없어요.',
        farAway ? '서울 안의 역을 출발지로 골라 보세요.' : '시각을 늦추거나 머무는 시간을 줄여 보세요.');
    }
    list.append(el('li', { className: 'none', textContent: '조건에 맞는 곳이 없어요.' }));
  } else {
    say('ok', `${fmtHM(plan.deadlineMin)}까지 다녀올 수 있는 곳 ${shown.length}곳을 찾았어요.`);
    for (const p of shown) list.append(resultItem(p));
  }
  renderMapPlaces(shown, { fit: true });
}

function badges(p) {
  return el('span', { className: 'badges' },
    el('span', { className: `badge ${p.kind}`, textContent: p.kind === 'event' ? '행사' : '상시 장소' }),
    el('span', { className: `badge ${p.isFree ? 'free' : 'paid'}`, textContent: p.isFree ? '무료' : '유료' }),
    el('span', { className: 'badge cat', textContent: p.category }));
}

function resultItem(p) {
  const note = p.notes?.[0];
  const btn = el('button', { type: 'button', className: 'result-row' },
    badges(p),
    el('span', { className: 'title', textContent: p.title }),
    el('span', { className: 'line' }, '🕘 ', el('b', { textContent: p.hours || '운영시간은 방문 전 확인하세요' })),
    note ? el('span', { className: 'line', textContent: `특이사항 · ${note}` }) : null,
    el('span', { className: 'line', textContent: `가는 데 ${fmtDur(p.go)} · 여유 ${fmtDur(p.slack)}` }),
    el('span', { className: 'more', textContent: '자세히 보기 →' }));
  btn.dataset.id = p.id;
  btn.addEventListener('click', () => openDetail(p.id));
  return el('li', {}, btn);
}

function renderDataDate() {
  const m = state.meta;
  if (!m?.updated_at) { $('data-date').textContent = ''; return; }
  const upd = new Date(m.updated_at);
  const days = Math.floor((nowDate() - upd) / 86400000);
  $('data-date').textContent = `정보 갱신 ${todayStr(upd)}${state.isSample ? ' · 샘플 데이터' : ''}${days >= STALE_DAYS ? ' · ⚠ 정보가 오래됐을 수 있어요' : ''}`;
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
  addInfo('기간', p.kind === 'event'
    ? `${fmtDate(p.startDate)} ~ ${fmtDate(p.endDate)}${p.endDate === todayStr() ? ' (오늘 마지막 날)' : ''}`
    : '상시');
  addInfo('분류', `${p.kind === 'event' ? '행사' : '상시 장소'} · ${p.category}`);
  addInfo('요금', p.isFree ? '무료' : '유료');
  wrap.append(info);

  if (p.description) wrap.append(el('p', { className: 'desc', textContent: p.description }));

  if (c && state.plan) {
    const times = el('dl', { className: 'times' });
    for (const [k, v] of [
      ['가는 데 (걸어서)', fmtDur(c.go)],
      [state.plan.destMode === 'return' ? '돌아오는 데' : '도착지까지', fmtDur(c.back)],
      ['도착 예상', `약 ${fmtHM(state.plan.nowMin + c.total)}`],
      ['여유', c.reachable ? fmtDur(c.slack) : '시간 안에 어려워요'],
    ]) times.append(el('div', {}, el('dt', { textContent: k }), el('dd', { textContent: v })));
    wrap.append(el('h3', { textContent: `이동 시간 (머무는 시간 ${state.plan.stayMin}분 포함, 대략값)` }), times);
    if (c.go > TRANSIT_TIP_MIN || c.back > TRANSIT_TIP_MIN) {
      wrap.append(el('p', { className: 'transit-tip', textContent: '🚇 걸어서 20분이 넘어요. 대중교통이 더 빠를 수 있어요.' }));
    }
  } else {
    wrap.append(el('p', { className: 'hint', textContent: '‘지금 떠나기’에서 조건을 고르면 이동 시간과 여유 시간을 계산해 드려요.' }));
  }

  if (p.notes?.length) {
    wrap.append(el('h3', { textContent: '특이사항' }), el('ul', { className: 'notes' }, ...p.notes.map((n) => el('li', { textContent: n }))));
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
  panTo(p, 15);
  highlightMarker(id);
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
  const rec = { placeId: p.id, title: p.title, venue: p.venue, date: todayStr(), plannedMin: c?.total ?? null };
  state.store.records.unshift(rec);
  if (!saveStore()) { state.store.records.shift(); return; }
  setStatus('ok', `‘${p.title}’ 나들이를 기록했어요. 위쪽 ‘나들이 기록’ 탭에서 볼 수 있어요.`);
  openDetail(p.id);
}

function renderRecordsPage() {
  const recs = state.store.records;
  const month = todayStr().slice(0, 7);
  const thisMonth = recs.filter((r) => r.date.startsWith(month)).length;
  $('rec-summary').textContent = recs.length ? `지금까지 ${recs.length}번 다녀왔어요 · 이번 달 ${thisMonth}번` : '';

  const list = $('record-list');
  list.replaceChildren();
  if (!recs.length) {
    list.append(el('li', { className: 'empty', textContent: '아직 기록이 없어요. 장소 상세에서 ‘다녀왔어요’를 눌러 보세요.' }));
  }
  recs.forEach((r, i) => {
    const del = el('button', { type: 'button', className: 'btn btn-ghost', textContent: '삭제' });
    del.setAttribute('aria-label', `${r.date} ${r.title} 기록 삭제`);
    del.addEventListener('click', () => removeRecord(i));
    list.append(el('li', {},
      el('div', {}, el('strong', { textContent: r.title }),
        el('span', { className: 'meta', textContent: `${r.date} · ${r.venue}${r.plannedMin ? ` · 계획 ${fmtDur(r.plannedMin)}` : ''}` })),
      del));
  });
  $('btn-clear-records').disabled = !recs.length;

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
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
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

function renderMapPlaces(list, { fit }) {
  if (!mapEngine) return;
  markers.clear();
  if (mapEngine === 'kakao') {
    kPlaces.forEach((o) => o.setMap(null));
    kPlaces = list.map((p) => {
      const dot = placeDot(p);
      markers.set(p.id, { el: dot });
      return kOverlay(p, dot, { zIndex: 2 });
    });
  } else {
    placeLayer.clearLayers();
    for (const p of list) {
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
    if (state.plan) pts.push(state.plan.origin, state.plan.dest);
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

function highlightMarker(id) {
  markers.forEach((m) => m.el?.classList.remove('is-active'));
  const m = markers.get(id);
  m?.el?.classList.add('is-active');
  m?.leaflet?.openPopup();
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
  document.querySelectorAll('input[name="stay"]').forEach((r) => { r.checked = +r.value === state.store.stayMin; });

  const tickNow = () => { $('now-label').textContent = fmtHM(toMin(nowDate())); };
  tickNow();
  setInterval(tickNow, 30000);

  buildPicker('origin');
  buildPicker('dest');
  const mapReady = initMap();

  // 이벤트 연결
  $('btn-start').addEventListener('click', startFlow);
  $('btn-change-origin').addEventListener('click', () => { state.flow = ['origin', 'time', 'dest', 'confirm']; go('origin'); });
  document.querySelectorAll('[data-prev]').forEach((b) => b.addEventListener('click', goPrev));
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  document.querySelectorAll('[data-next]').forEach((b) => b.addEventListener('click', () => onNext(b.dataset.next)));
  $('btn-search').addEventListener('click', runSearch);
  $('btn-detail-back').addEventListener('click', closeDetail);
  $('deadline').addEventListener('input', () => clearErr('deadline-err', 'deadline'));
  $('deadline').addEventListener('keydown', (e) => { if (e.key === 'Enter') onNext('time'); });
  document.querySelectorAll('.quick .chip').forEach((b) => b.addEventListener('click', onQuickAdd));
  document.querySelectorAll('input[name="stay"]').forEach((r) => r.addEventListener('change', () => {
    state.store.stayMin = currentStay();
    saveStore();
  }));
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
  $('foot-meta').textContent = `정보 갱신일 ${upd}${state.isSample ? ' · 샘플 데이터(가짜)' : ''} · 이동 시간은 직선거리 기반 대략값 · 지도 © ${mapEngine === 'kakao' ? 'Kakao' : 'OpenStreetMap'}`;

  go('start', { focus: false });
  route();
  renderHere();
  locateMe();

  if (!storeOk) {
    setStatus('error', '저장된 즐겨찾기와 기록을 읽지 못했어요.', '사생활 보호 모드라면 일반 창에서 열어 주세요. 찾기는 그대로 쓸 수 있어요.');
  }
}

init();
