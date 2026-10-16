// 틈새 나들이 데이터 갱신 스크립트 (GitHub Actions에서 하루 1회 실행)
// 서울 열린데이터광장 Open API → 필요한 필드만 남겨 data/*.json 으로 저장.
//
//   SEOUL_API_KEY=... node scripts/fetch-data.js
//
// 인증키는 환경변수로만 받고, 로그나 파일 어디에도 남기지 않음.
// 확인용: SEOUL_API_KEY=sample PAGE_SIZE=5 MAX_PAGES=1 node scripts/fetch-data.js (공개 샘플 키, 5건만)
'use strict';

const fs = require('fs');
const path = require('path');

const KEY = process.env.SEOUL_API_KEY;
const PAGE_SIZE = Number(process.env.PAGE_SIZE) || 1000; // API 한 번에 최대 1000건
const MAX_PAGES = Number(process.env.MAX_PAGES) || 50;
const EVENT_AHEAD_DAYS = Number(process.env.EVENT_AHEAD_DAYS) || 30; // 오늘부터 이 기간 안에 시작하는 행사만 (파일 크기 줄이기)
const DESC_MAX = 300;
const NOTE_MAX = 120;
// 서울 대략 범위 — 밖이면 좌표가 잘못된 것으로 보고 제외
const SEOUL_BOX = { latMin: 37.41, latMax: 37.72, lngMin: 126.76, lngMax: 127.19 };

const OUT = process.env.OUT_DIR || path.join(__dirname, '..', 'data');

if (!KEY) {
  console.error('SEOUL_API_KEY 환경변수가 없습니다.');
  process.exit(1);
}

/* ---------- 도우미 ---------- */

function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clean(s, max) {
  if (s == null) return '';
  let t = String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (max && t.length > max) t = `${t.slice(0, max - 1).trim()}…`;
  return t;
}

// 좌표 확인: 숫자이고 서울 범위 안인지. 위도·경도가 뒤바뀐 경우는 바로잡음.
function coords(latRaw, lngRaw) {
  let lat = parseFloat(latRaw), lng = parseFloat(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat > 100 && lng < 100) [lat, lng] = [lng, lat];
  const b = SEOUL_BOX;
  if (lat < b.latMin || lat > b.latMax || lng < b.lngMin || lng > b.lngMax) return null;
  return { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
}

function url(u) {
  const t = clean(u);
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (/^www\./i.test(t) || /^[\w-]+\.[\w.-]+/.test(t)) return `http://${t}`;
  return '';
}

// API 호출 (실패 시 2번까지 다시 시도). URL에 키가 들어가므로 URL은 출력하지 않음.
async function call(service, start, end) {
  const u = `http://openapi.seoul.go.kr:8088/${encodeURIComponent(KEY)}/json/${service}/${start}/${end}/`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const body = d[service];
      if (!body) {
        const res = d.RESULT || {};
        if (res.CODE === 'INFO-200') return { total: 0, rows: [] }; // 데이터 없음
        throw new Error(`${res.CODE || '응답 형식 오류'} ${res.MESSAGE || ''}`.trim());
      }
      if (body.RESULT && body.RESULT.CODE !== 'INFO-000') throw new Error(`${body.RESULT.CODE} ${body.RESULT.MESSAGE}`);
      return { total: body.list_total_count, rows: body.row || [] };
    } catch (e) {
      lastErr = e;
      console.warn(`  ${service} ${start}-${end} 실패 (${attempt}/3): ${e.message}`);
      await sleep(2000 * attempt);
    }
  }
  throw new Error(`${service} 불러오기 실패: ${lastErr.message}`);
}

async function fetchAll(service) {
  const first = await call(service, 1, PAGE_SIZE);
  const rows = first.rows.slice();
  const pages = Math.min(MAX_PAGES, Math.ceil(first.total / PAGE_SIZE));
  for (let p = 2; p <= pages; p++) {
    const start = (p - 1) * PAGE_SIZE + 1;
    const { rows: more } = await call(service, start, start + PAGE_SIZE - 1);
    rows.push(...more);
    await sleep(300);
  }
  console.log(`${service}: 전체 ${first.total}건 중 ${rows.length}건 받음`);
  return rows;
}

/* ---------- 문화행사 ---------- */

function normEvents(rows, today) {
  const until = addDays(today, EVENT_AHEAD_DAYS);
  const out = [];
  const seen = new Set();
  const skip = { ended: 0, later: 0, noCoords: 0, badDate: 0, dup: 0 };
  for (const r of rows) {
    const startDate = String(r.STRTDATE || '').slice(0, 10);
    const endDate = String(r.END_DATE || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) { skip.badDate++; continue; }
    if (endDate < today) { skip.ended++; continue; }
    if (startDate > until) { skip.later++; continue; }
    const c = coords(r.LAT, r.LOT);
    if (!c) { skip.noCoords++; continue; }
    const page = url(r.HMPG_ADDR);
    const code = /cultcode=(\d+)/.exec(page)?.[1];
    const id = code ? `evt_${code}` : `evt_${Buffer.from(`${r.TITLE}|${startDate}|${r.PLACE}`).toString('base64url').slice(0, 16)}`;
    if (seen.has(id)) { skip.dup++; continue; }
    seen.add(id);
    const isFree = clean(r.IS_FREE) === '무료';
    const notes = [
      r.USE_TRGT && `대상: ${clean(r.USE_TRGT, NOTE_MAX)}`,
      !isFree && r.USE_FEE && `요금: ${clean(r.USE_FEE, NOTE_MAX)}`,
      r.ETC_DESC && clean(r.ETC_DESC, NOTE_MAX),
    ].filter(Boolean);
    out.push({
      id,
      kind: 'event',
      title: clean(r.TITLE, 120),
      category: clean(r.CODENAME) || '행사',
      venue: clean(r.PLACE, 80),
      gu: clean(r.GUNAME),
      ...c,
      startDate,
      endDate,
      isFree,
      ...(clean(r.PRO_TIME) && { hours: clean(r.PRO_TIME, 80) }),
      ...(clean(r.PROGRAM) && { description: clean(r.PROGRAM, DESC_MAX) }),
      ...(notes.length && { notes }),
      url: page || url(r.ORG_LINK),
    });
  }
  return { items: out, skip };
}

/* ---------- 공공도서관 (상시 장소) ---------- */

function normLibraries(rows) {
  const out = [];
  let noCoords = 0;
  for (const r of rows) {
    // 이 데이터는 XCNTS가 위도, YDNTS가 경도
    const c = coords(r.XCNTS, r.YDNTS);
    if (!c) { noCoords++; continue; }
    const closed = clean(r.FDRM_CLOSE_DATE, NOTE_MAX);
    out.push({
      id: `lib_${clean(r.LBRRY_SEQ_NO)}`,
      kind: 'place',
      title: clean(r.LBRRY_NAME, 80),
      category: clean(r.LBRRY_SE_NAME) || '도서관',
      venue: clean(r.ADRES, 100),
      gu: clean(r.CODE_VALUE),
      ...c,
      isFree: true,
      ...(clean(r.OP_TIME) && { hours: clean(r.OP_TIME, 100) }),
      ...(closed && { closed }),
      notes: [closed && `휴관: ${closed}`, '열람실 이용 조건은 도서관마다 달라요'].filter(Boolean),
      url: url(r.HMPG_URL),
    });
  }
  return { items: out, skip: { noCoords } };
}

/* ---------- 지하철역 ---------- */

// API의 노선 이름은 철도 법정 노선명(경원선·경부선 등)이라 타는 사람이 쓰는 이름으로 바꿈
const LINE_NAME = {
  경부선: '1호선', 경인선: '1호선', 경원선: '1호선', 장항선: '1호선',
  중앙선: '경의중앙선', 경의선: '경의중앙선',
  분당선: '수인분당선', 수인선: '수인분당선',
  일산선: '3호선', 과천선: '4호선', 안산선: '4호선', 진접선: '4호선',
  별내선: '8호선', '9호선(연장)': '9호선', '7호선(인천)': '7호선', '신분당선(연장2)': '신분당선', '신분당선(연장)': '신분당선',
  공항철도1호선: '공항철도', '수도권 광역급행철도': 'GTX-A',
};
// 경원선 중 용산~청량리 구간은 경의중앙선이 다님
const GYEONGWON_JUNGANG = new Set(['용산', '이촌', '서빙고', '한남', '옥수', '응봉', '왕십리', '청량리']);
const LINE_ORDER = ['1호선', '2호선', '3호선', '4호선', '5호선', '6호선', '7호선', '8호선', '9호선', '경의중앙선', '수인분당선', '신분당선', '공항철도', '경춘선', '서해선', '우이신설선', '신림선', '김포골드라인', 'GTX-A'];

function lineName(raw, stationName) {
  const base = stationName.replace(/\(.*\)$/, '');
  if (raw === '경원선' && GYEONGWON_JUNGANG.has(base)) return '경의중앙선';
  return LINE_NAME[raw] || raw;
}

function normStations(rows) {
  const byName = new Map();
  const linesOf = new Map(); // 좌표가 없는 행의 노선도 모아 둠(예: 회기역 1호선)
  let noCoords = 0;
  const missing = new Set();
  for (const r of rows) {
    // '서울역'처럼 이름에 '역'이 붙은 경우 화면에서 '역'을 다시 붙이므로 떼어 둠
    const name = clean(r.BLDN_NM).replace(/역$/, '');
    if (!name) continue;
    const line = clean(r.ROUTE) && lineName(clean(r.ROUTE), name);
    if (line) {
      if (!linesOf.has(name)) linesOf.set(name, new Set());
      linesOf.get(name).add(line);
    }
    const c = coords(r.LAT, r.LOT);
    if (!c) { noCoords++; missing.add(name); continue; }
    if (!byName.has(name)) byName.set(name, { id: `stn_${clean(r.BLDN_ID)}`, name, lines: [], ...c });
  }
  const sortLines = (ls) => [...ls].sort((a, b) => {
    const ia = LINE_ORDER.indexOf(a), ib = LINE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'ko');
  });
  for (const [name, s] of byName) s.lines = sortLines(linesOf.get(name) || []);
  // API에 좌표가 없는 역은 수동 목록(data/stations-manual.json)으로 채움
  let filled = 0;
  try {
    const manual = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'stations-manual.json'), 'utf8')).items;
    for (const m of manual) {
      // API에 '고려대(종암)'처럼 괄호 붙은 이름으로 이미 있으면 보충하지 않음
      if (byName.has(m.name) || [...byName.keys()].some((n) => n.startsWith(`${m.name}(`))) continue;
      const apiLines = linesOf.get(m.name);
      byName.set(m.name, { ...m, lines: apiLines ? sortLines(apiLines) : m.lines, approx: true });
      filled++;
    }
  } catch (e) {
    console.warn(`수동 역 목록을 읽지 못했어요: ${e.message}`);
  }
  const stillMissing = [...missing].filter((n) => n && !byName.has(n));
  return {
    items: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    skip: { noCoords, filled, stillMissing },
  };
}

/* ---------- 실행 ---------- */

function write(file, data) {
  fs.writeFileSync(path.join(OUT, file), `${JSON.stringify(data, null, 0)}\n`);
}

(async () => {
  const today = todayKST();
  console.log(`기준일(KST): ${today}`);

  const [eventRows, libRows, stationRows] = [
    await fetchAll('culturalEventInfo'),
    await fetchAll('SeoulPublicLibraryInfo'),
    await fetchAll('subwayStationMaster'),
  ];

  const events = normEvents(eventRows, today);
  const libs = normLibraries(libRows);
  const stations = normStations(stationRows);

  // 하나라도 비면 기존 파일을 지키고 실패 처리
  if (!events.items.length || !libs.items.length || !stations.items.length) {
    console.error(`결과가 비어 저장하지 않습니다. 행사 ${events.items.length}, 도서관 ${libs.items.length}, 역 ${stations.items.length}`);
    process.exit(1);
  }

  console.log(`행사: ${events.items.length}건 저장 · 제외 — 끝남 ${events.skip.ended}, ${EVENT_AHEAD_DAYS}일 이후 시작 ${events.skip.later}, 좌표 없음/범위 밖 ${events.skip.noCoords}, 날짜 오류 ${events.skip.badDate}, 중복 ${events.skip.dup}`);
  console.log(`도서관: ${libs.items.length}건 저장 · 좌표 없음/범위 밖 ${libs.skip.noCoords}건 제외`);
  console.log(`지하철역: ${stations.items.length}곳 저장 · API 좌표 없음 ${stations.skip.noCoords}건 · 수동 목록으로 채움 ${stations.skip.filled}곳`);
  if (stations.skip.stillMissing.length) {
    console.log(`  좌표를 못 구한 역 ${stations.skip.stillMissing.length}곳: ${stations.skip.stillMissing.join(', ')}`);
  }

  write('places.json', [...events.items, ...libs.items]);
  write('stations.json', { items: stations.items });
  write('meta.json', {
    updated_at: new Date().toISOString(),
    basis_date: today,
    sources: [
      { name: '서울시 문화행사 정보', service: 'culturalEventInfo', url: 'https://data.seoul.go.kr/dataList/OA-15486/S/1/datasetView.do', license: '공공누리 제1유형(출처표시)' },
      { name: '서울시 공공도서관 현황정보', service: 'SeoulPublicLibraryInfo', url: 'https://data.seoul.go.kr/dataList/OA-15480/S/1/datasetView.do', license: '공공누리 제1유형(출처표시)' },
      { name: '서울시 역사마스터 정보', service: 'subwayStationMaster', url: 'https://data.seoul.go.kr/dataList/OA-21232/S/1/datasetView.do', license: '공공누리 제1유형(출처표시)' },
    ],
    counts: {
      event: events.items.length,
      place: libs.items.length,
      station: stations.items.length,
      stationMissingCoords: stations.skip.stillMissing.length,
      excludedNoCoords: events.skip.noCoords + libs.skip.noCoords,
      excludedEnded: events.skip.ended,
      excludedLater: events.skip.later,
    },
  });
  console.log('저장 완료: data/places.json, data/stations.json, data/meta.json');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
