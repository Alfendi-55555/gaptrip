// 걷는 시간 계산 — data/walk/*.json(OpenStreetMap 길 그래프)으로 브라우저 안에서 최단 거리를 구함.
// 현재 위치는 이 계산에만 쓰이고 어디로도 보내지 않음.
// 그래프 범위 밖이거나 길에서 너무 멀면 null을 돌려주고, 화면은 직선거리 어림값으로 대신함.
(function (root) {
  'use strict';

  const WALK_M_PER_MIN = 75;   // 시속 4.5km
  const SNAP_MAX_M = 300;      // 장소·출발지가 길에서 이보다 멀면 계산하지 않음
  const SNAP_FACTOR = 1.2;     // 길까지 붙는 구간(직선)에 곱하는 보정
  const MAX_SEARCH_M = 8000;   // 이보다 먼 곳은 탐색하지 않음
  const CELL = 0.002;          // 가장 가까운 점 찾기용 격자(약 200m)

  function haversineM(aLat, aLng, bLat, bLng) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const inBox = (p, b, pad = 0) => p.lat >= b[0] - pad && p.lat <= b[2] + pad && p.lng >= b[1] - pad && p.lng <= b[3] + pad;

  class Graph {
    constructor(j) {
      this.name = j.name;
      this.bbox = j.bbox;
      const n = j.lat.length;
      this.n = n;
      this.lat = new Float64Array(n);
      this.lng = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        this.lat[i] = j.origin[0] + j.lat[i] / 1e5;
        this.lng[i] = j.origin[1] + j.lng[i] / 1e5;
      }
      // 간선 목록 → 양방향 인접 배열(CSR)
      const m = j.b.length;
      const ea = new Int32Array(m);
      let acc = 0;
      for (let k = 0; k < m; k++) { acc += j.a[k]; ea[k] = acc; }
      const deg = new Int32Array(n + 1);
      for (let k = 0; k < m; k++) { deg[ea[k] + 1]++; deg[j.b[k] + 1]++; }
      for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
      this.start = deg;
      this.to = new Int32Array(m * 2);
      this.w = new Float32Array(m * 2);
      const fill = deg.slice(0, n);
      for (let k = 0; k < m; k++) {
        const a = ea[k], b = j.b[k], w = j.w[k];
        this.to[fill[a]] = b; this.w[fill[a]++] = w;
        this.to[fill[b]] = a; this.w[fill[b]++] = w;
      }
      // 격자 색인
      this.grid = new Map();
      for (let i = 0; i < n; i++) {
        const key = `${Math.floor(this.lat[i] / CELL)},${Math.floor(this.lng[i] / CELL)}`;
        let list = this.grid.get(key);
        if (!list) this.grid.set(key, (list = []));
        list.push(i);
      }
      this.snapCache = new Map();
    }

    // 가장 가까운 교차로 { i, m } (없으면 null)
    nearest(p) {
      const key = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
      if (this.snapCache.has(key)) return this.snapCache.get(key);
      const cy = Math.floor(p.lat / CELL), cx = Math.floor(p.lng / CELL);
      let best = null;
      for (let r = 0; r <= 2; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dy), Math.abs(dx)) !== r) continue;
            const list = this.grid.get(`${cy + dy},${cx + dx}`);
            if (!list) continue;
            for (const i of list) {
              const m = haversineM(p.lat, p.lng, this.lat[i], this.lng[i]);
              if (!best || m < best.m) best = { i, m };
            }
          }
        }
        if (best && best.m < r * 150) break; // 이미 충분히 가까움
      }
      const out = best && best.m <= SNAP_MAX_M ? best : null;
      this.snapCache.set(key, out);
      return out;
    }

    // src 교차로에서 모든 교차로까지 최단 거리(미터) — 이진 힙 다익스트라
    dijkstra(src) {
      const n = this.n;
      const dist = new Float64Array(n).fill(Infinity);
      const prev = new Int32Array(n).fill(-1); // 경로 선을 그리려고 직전 교차로를 기억
      // 지연 삭제 방식이라 힙에는 간선 수만큼 들어갈 수 있음
      const cap = this.to.length + n + 16;
      const heapN = new Int32Array(cap);
      const heapD = new Float64Array(cap);
      let size = 0;
      const push = (i, d) => {
        let k = size++;
        while (k > 0) {
          const p = (k - 1) >> 1;
          if (heapD[p] <= d) break;
          heapN[k] = heapN[p]; heapD[k] = heapD[p]; k = p;
        }
        heapN[k] = i; heapD[k] = d;
      };
      const pop = () => {
        const topN = heapN[0];
        const lastN = heapN[--size], lastD = heapD[size];
        let k = 0;
        for (;;) {
          let c = k * 2 + 1;
          if (c >= size) break;
          if (c + 1 < size && heapD[c + 1] < heapD[c]) c++;
          if (heapD[c] >= lastD) break;
          heapN[k] = heapN[c]; heapD[k] = heapD[c]; k = c;
        }
        heapN[k] = lastN; heapD[k] = lastD;
        return topN;
      };
      dist[src] = 0;
      push(src, 0);
      while (size > 0) {
        const d0 = heapD[0];
        const u = pop();
        if (d0 > dist[u]) continue;
        if (d0 > MAX_SEARCH_M) break;
        for (let e = this.start[u]; e < this.start[u + 1]; e++) {
          const v = this.to[e], nd = d0 + this.w[e];
          if (nd < dist[v]) {
            dist[v] = nd;
            prev[v] = u;
            push(v, nd);
          }
        }
      }
      return { dist, prev };
    }

    // 출발점 p에서의 거리표: .minutesTo(place) → 분 또는 null, .pathTo(place) → [[위도, 경도], …] 또는 null
    from(p) {
      const s = this.nearest(p);
      if (!s) return null;
      const { dist, prev } = this.dijkstra(s.i);
      return {
        // 교차로만 남긴 그래프라 굽은 길은 모서리가 조금 깎여 보임
        pathTo: (q) => {
          const t = this.nearest(q);
          if (!t || !Number.isFinite(dist[t.i])) return null;
          const pts = [];
          for (let v = t.i; v !== -1; v = prev[v]) pts.push([this.lat[v], this.lng[v]]);
          pts.reverse();
          return [[p.lat, p.lng], ...pts, [q.lat, q.lng]];
        },
        minutesTo: (q) => {
          const t = this.nearest(q);
          if (!t || !Number.isFinite(dist[t.i])) return null;
          const meters = dist[t.i] + (s.m + t.m) * SNAP_FACTOR;
          return Math.max(1, Math.round(meters / WALK_M_PER_MIN));
        },
      };
    }
  }

  let indexPromise = null;
  const graphs = new Map();

  function loadIndex(base) {
    if (!indexPromise) {
      indexPromise = fetch(`${base}/index.json`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : { areas: [] }))
        .catch(() => ({ areas: [] }));
    }
    return indexPromise;
  }

  // 점 p가 들어가는 지역 그래프 (없으면 null)
  async function graphFor(p, base = 'data/walk') {
    const idx = await loadIndex(base);
    const area = idx.areas.find((a) => inBox(p, a.bbox));
    if (!area) return null;
    if (!graphs.has(area.id)) {
      graphs.set(area.id, fetch(`${base}/${area.file}`)
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then((j) => new Graph(j))
        .catch((e) => { console.warn('길 데이터를 불러오지 못했어요', e); graphs.delete(area.id); return null; }));
    }
    return graphs.get(area.id);
  }

  root.GapWalk = { graphFor, Graph };
})(typeof window !== 'undefined' ? window : globalThis);
