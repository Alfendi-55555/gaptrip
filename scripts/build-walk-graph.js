// 걷는 길 그물(그래프) 만들기 — GitHub Actions에서 주 1회 실행
// OpenStreetMap의 걸을 수 있는 길(인도·골목·계단·횡단보도 등)을 받아
// 교차로만 남긴 작은 그래프로 줄여 data/walk/<지역>.json 으로 저장.
// 브라우저는 이 파일로 출발지에서 각 장소까지 최단 걷는 거리를 직접 계산함(위치가 밖으로 나가지 않음).
//
//   node scripts/build-walk-graph.js
//   INPUT_FILE=받아둔.json AREA=hufs node scripts/build-walk-graph.js   (Overpass 응답 파일로 확인용)
//
// 데이터: © OpenStreetMap 기여자, ODbL 1.0 — 만들어진 그래프 파일도 ODbL을 따름.
'use strict';

const fs = require('fs');
const path = require('path');

const AREAS = [
  // 한국외대 서울캠퍼스 중심 약 5km — 걸어서 갈 만한 범위
  { id: 'hufs', name: '한국외대 주변', bbox: [37.552, 127.002, 37.642, 127.116] }, // [남, 서, 북, 동]
];

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const UA = 'gaptrip/0.1 (student project; https://github.com/Alfendi-55555/gaptrip)';

const WALKABLE = 'footway|path|pedestrian|steps|living_street|residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|track|cycleway|corridor';
const STEPS_FACTOR = 1.6; // 계단은 같은 거리라도 더 오래 걸림
const OUT = path.join(__dirname, '..', 'data', 'walk');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function fetchOverpass(bbox) {
  const [s, w, n, e] = bbox;
  const q = `[out:json][timeout:180];
way["highway"~"^(${WALKABLE})$"]["foot"!~"^no$"]["access"!~"^(private|no)$"]["area"!="yes"](${s},${w},${n},${e})->.w;
.w out body qt;
node(w.w);
out skel qt;`;
  let lastErr;
  for (const url of MIRRORS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(q)}`,
          signal: AbortSignal.timeout(200000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (!d.elements?.length) throw new Error('빈 응답');
        console.log(`  ${new URL(url).host}에서 받음: 요소 ${d.elements.length}개`);
        return d;
      } catch (e) {
        lastErr = e;
        console.warn(`  ${new URL(url).host} 실패 (${attempt}/2): ${e.message}`);
        await sleep(5000 * attempt);
      }
    }
  }
  throw new Error(`Overpass 불러오기 실패: ${lastErr.message}`);
}

function buildGraph(osm, bbox) {
  const coord = new Map(); // node id → [lat, lng]
  const ways = [];
  for (const el of osm.elements) {
    if (el.type === 'node') coord.set(el.id, [el.lat, el.lon]);
    else if (el.type === 'way' && el.nodes?.length > 1) ways.push({ nodes: el.nodes, steps: el.tags?.highway === 'steps' });
  }

  // 교차로·끝점만 남김: 두 번 이상 쓰인 점 또는 길의 양 끝
  const uses = new Map();
  for (const w of ways) {
    w.nodes.forEach((id, i) => {
      const extra = i === 0 || i === w.nodes.length - 1 ? 2 : 1;
      uses.set(id, (uses.get(id) || 0) + extra);
    });
  }
  const keep = (id) => (uses.get(id) || 0) >= 2;

  const edges = new Map(); // 'a|b' → 미터 (같은 두 점 사이 여러 길이면 짧은 것)
  for (const w of ways) {
    let from = null, acc = 0, prev = null;
    for (const id of w.nodes) {
      const c = coord.get(id);
      if (!c) { from = null; acc = 0; prev = null; continue; } // 범위 밖 점에서 끊김
      if (prev) acc += haversineM(prev[0], prev[1], c[0], c[1]) * (w.steps ? STEPS_FACTOR : 1);
      if (from === null) { from = id; acc = 0; }
      else if (keep(id)) {
        if (id !== from) {
          const [a, b] = from < id ? [from, id] : [id, from];
          const k = `${a}|${b}`;
          const m = Math.max(1, Math.round(acc));
          if (!edges.has(k) || edges.get(k) > m) edges.set(k, m);
        }
        from = id;
        acc = 0;
      }
      prev = c;
    }
  }

  // 가장 큰 연결 덩어리만 남김 (따로 떨어진 조각에 붙으면 거리를 못 구하므로)
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const k of edges.keys()) {
    const [a, b] = k.split('|').map(Number);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    union(a, b);
  }
  const size = new Map();
  for (const id of parent.keys()) { const r = find(id); size.set(r, (size.get(r) || 0) + 1); }
  let bigRoot = null, bigSize = 0;
  for (const [r, n] of size) if (n > bigSize) { bigRoot = r; bigSize = n; }

  // 번호 매기기: 공간적으로 가까운 점끼리 붙도록 정렬(파일 압축에 유리)
  const ids = [...parent.keys()].filter((id) => find(id) === bigRoot);
  const cell = (id) => { const [la, ln] = coord.get(id); return Math.floor((la - bbox[0]) / 0.005) * 1000 + Math.floor((ln - bbox[1]) / 0.005); };
  ids.sort((a, b) => cell(a) - cell(b) || coord.get(a)[0] - coord.get(b)[0]);
  const index = new Map(ids.map((id, i) => [id, i]));

  const list = [];
  for (const [k, m] of edges) {
    const [a, b] = k.split('|').map(Number);
    if (index.has(a) && index.has(b)) {
      const ia = index.get(a), ib = index.get(b);
      list.push(ia < ib ? [ia, ib, m] : [ib, ia, m]);
    }
  }
  list.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  // 저장 형식: 좌표는 남서쪽 모서리 기준 1e-5도(약 1m) 정수, 간선의 a는 앞 값과의 차이
  const lat = ids.map((id) => Math.round((coord.get(id)[0] - bbox[0]) * 1e5));
  const lng = ids.map((id) => Math.round((coord.get(id)[1] - bbox[1]) * 1e5));
  let prevA = 0;
  const a = list.map(([x]) => { const d = x - prevA; prevA = x; return d; });
  return {
    nodes: ids.length,
    edges: list.length,
    dropped: parent.size - ids.length,
    data: { lat, lng, a, b: list.map((e) => e[1]), w: list.map((e) => e[2]) },
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.env.AREA;
  const index = [];
  for (const area of AREAS) {
    if (only && area.id !== only) continue;
    console.log(`${area.name} (${area.id})`);
    const osm = process.env.INPUT_FILE
      ? JSON.parse(fs.readFileSync(process.env.INPUT_FILE, 'utf8'))
      : await fetchOverpass(area.bbox);
    const g = buildGraph(osm, area.bbox);
    if (g.nodes < 1000) throw new Error(`그래프가 너무 작아요(${g.nodes}점). 저장하지 않습니다.`);
    const file = `${area.id}.json`;
    const body = {
      v: 1,
      id: area.id,
      name: area.name,
      bbox: area.bbox,
      built: new Date().toISOString(),
      attribution: '© OpenStreetMap contributors (ODbL 1.0)',
      license: 'ODbL-1.0',
      origin: [area.bbox[0], area.bbox[1]],
      ...g.data,
    };
    fs.writeFileSync(path.join(OUT, file), JSON.stringify(body));
    const kb = (fs.statSync(path.join(OUT, file)).size / 1024).toFixed(0);
    console.log(`  교차로 ${g.nodes}개, 길 ${g.edges}개 저장 (${kb}KB) · 떨어진 조각에서 뺀 점 ${g.dropped}개`);
    index.push({ id: area.id, name: area.name, bbox: area.bbox, file, built: body.built });
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify({ attribution: '© OpenStreetMap contributors (ODbL 1.0)', areas: index }, null, 1)}\n`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
