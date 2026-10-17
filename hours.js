// 운영시간·휴관일 문자열 읽기
// 원본 데이터의 자유 형식 문자열에서 흔한 형식만 읽고, 못 읽으면 known: false 로 돌려줌(화면에서는 '방문 전 확인').
//
//   읽는 것: "평일 : 09:00~22:00, 주말 : 09:00~18:00", "화-목 10:00~20:00 / 금 10:00~21:00",
//            "19:30"(시작 시각), "평일 19:30, 주말 15:00 (월,화 공연없음)", "11:00~19:00, 목요일 21:00까지 연장"
//   휴관일:  "매주 월요일 및 법정공휴일", "2,4주 월요일", "매월 첫째/셋째 화요일"
//   못 읽는 것: 특정 날짜("10.28 10:00 ~"), "둘째주 수요일 19:00", "프로그램별 상이" 등 → known: false
//   법정 공휴일은 아래 HOLIDAYS 목록으로 반영(휴관일에 '공휴일'이 적힌 곳). 임시 휴관은 알 수 없어 반영하지 않음.
(function (root) {
  'use strict';

  const DOW = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
  const ALL = [0, 1, 2, 3, 4, 5, 6];
  const WORD_DAYS = { 평일: [1, 2, 3, 4, 5], 주말: [0, 6], 매일: ALL };
  const ORDINAL = { 첫째: 1, 둘째: 2, 셋째: 3, 넷째: 4, 다섯째: 5 };

  const toMin = (h, m) => +h * 60 + +m;

  function normalize(s) {
    return String(s || '')
      .replace(/[∼〜～]/g, '~')
      .replace(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/g, '$1~$2')
      .replace(/(매주|매월|매달)/g, ' $1 ')
      .replace(/및/g, ' 및 ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function dayRange(a, b) {
    const out = [];
    for (let d = a; ; d = (d + 1) % 7) { out.push(d); if (d === b || out.length > 7) break; }
    return out;
  }

  // 요일 토큰: '월', '월요일', '평일', '주말', '매일' (앞뒤가 다른 한글 단어의 일부가 아닐 때만)
  const TOKEN = /(\d{1,2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2})|(\d{1,2}):(\d{2})(\s*까지)?|(평일|주말|매일)|(?<![가-힣])([월화수목금토일])요일|(?<![가-힣])([월화수목금토일])(?![가-힣])|(휴관|공연\s*없음)/g;

  /** 운영시간 문자열 → { known, rules: [{days|null, start, end|null}], closedDays: [] } */
  function parseHours(raw) {
    const s = normalize(raw);
    if (!s) return { known: false };
    // 특정 날짜, n째 주, 격주 같은 건 읽지 않음
    if (/\d{1,2}\s*\.\s*\d{1,2}\s*\.?\s*(\(|\d|~|$)|째\s*주|격주/.test(s)) return { known: false };

    const rules = [];
    const closed = new Set();
    let group = null;       // 지금 만들고 있는 요일 묶음
    let current = null;     // 이후 시각에 적용할 요일 (null = 매일)
    let lastEnd = 0;        // 직전 토큰 끝 위치
    let lastRange = null;
    let rangeFrom = null;   // '화-목'의 '화'

    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(s))) {
      const gap = s.slice(lastEnd, m.index);
      const dayTok = m[8] ? WORD_DAYS[m[8]] : (m[9] || m[10]) ? [DOW[m[9] || m[10]]] : null;

      if (dayTok) {
        const joinable = group && /^[\s,·./및~-]*$/.test(gap);
        if (joinable && /[~-]/.test(gap) && rangeFrom != null && dayTok.length === 1) {
          // '화-목', '토~일'
          for (const d of dayRange(rangeFrom, dayTok[0])) group.add(d);
        } else if (joinable) {
          dayTok.forEach((d) => group.add(d));
        } else {
          group = new Set(dayTok);
        }
        rangeFrom = dayTok.length === 1 ? dayTok[0] : null;
        current = [...group];
      } else if (m[11]) {
        // '월요일 휴관', '월,화 공연없음'
        if (group && /^[\s,·./]*$/.test(gap)) group.forEach((d) => closed.add(d));
        group = null;
        rangeFrom = null;
      } else if (m[1]) {
        const start = toMin(m[1], m[2]), end = toMin(m[3], m[4]);
        if (end > start) { lastRange = { days: current, start, end }; rules.push(lastRange); }
        group = null;
        rangeFrom = null;
      } else if (m[5]) {
        const t = toMin(m[5], m[6]);
        if (m[7] && lastRange) rules.push({ days: current, start: lastRange.start, end: t }); // '목요일 21:00까지'
        else rules.push({ days: current, start: t, end: null });                            // 시작 시각만
        group = null;
        rangeFrom = null;
      }
      lastEnd = TOKEN.lastIndex;
    }
    if (!rules.length) return { known: false };
    return { known: true, rules, closedDays: [...closed] };
  }

  /** 휴관일 문자열 → { weekly: [요일], monthly: [{ nth: [..], dow }] } */
  function parseClosed(raw) {
    let s = normalize(raw)
      .replace(/\([^)]*제외[^)]*\)/g, ' ')
      .replace(/[월화수목금토일]요일을?\s*제외한?/g, ' ');
    const weekly = new Set();
    const monthly = [];
    const re = /([월화수목금토일])요일/g;
    let m, from = 0;
    while ((m = re.exec(s))) {
      const prefix = s.slice(from, m.index);
      from = re.lastIndex;
      let nth = Object.keys(ORDINAL).filter((k) => prefix.includes(k)).map((k) => ORDINAL[k]);
      if (!nth.length) {
        const d = /(\d(?:\s*[,·/]\s*\d)*)\s*주/.exec(prefix);
        if (d) nth = d[1].split(/[,·/]/).map((x) => +x.trim()).filter(Boolean);
      }
      if (nth.length) monthly.push({ nth, dow: DOW[m[1]] });
      else weekly.add(DOW[m[1]]);
    }
    return { weekly: [...weekly], monthly };
  }

  // 관공서 공휴일(대체공휴일 포함). 해마다 한국천문연구원 월력요항을 보고 추가.
  // TODO: 2027년은 월력요항 확인 후 추가
  const HOLIDAYS = new Set([
    '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-01', '2026-03-02',
    '2026-05-05', '2026-05-24', '2026-05-25', '2026-06-03', '2026-06-06', '2026-08-15', '2026-08-17',
    '2026-09-24', '2026-09-25', '2026-09-26', '2026-10-03', '2026-10-05', '2026-10-09', '2026-12-25',
  ]);
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const isHoliday = (date) => HOLIDAYS.has(ymd(date));

  /**
   * 오늘(date) 기준 운영 정보
   * → { known, closedToday, reason, windows: [{ start, end|null }] }  (end가 null이면 시작 시각만 아는 공연)
   */
  function todaySchedule(place, date) {
    const dow = date.getDay();
    const nthWeek = Math.ceil(date.getDate() / 7);

    // 'OO 및 법정공휴일 휴관': 오늘이 공휴일이면 휴관 ('일요일 제외'라고 적힌 곳은 일요일 공휴일엔 엶)
    if (place.closed && /공휴일/.test(place.closed) && isHoliday(date)
        && !(dow === 0 && /일요일\s*제외|일요일을\s*제외/.test(place.closed))) {
      return { known: true, closedToday: true, reason: '오늘은 공휴일이라 휴관이에요', windows: [] };
    }
    if (place.closed) {
      const c = parseClosed(place.closed);
      if (c.weekly.includes(dow) || c.monthly.some((r) => r.dow === dow && r.nth.includes(nthWeek))) {
        return { known: true, closedToday: true, reason: '오늘 휴관일이에요', windows: [] };
      }
    }
    const h = parseHours(place.hours);
    if (!h.known) return { known: false, closedToday: false, windows: [] };
    if (h.closedDays.includes(dow)) return { known: true, closedToday: true, reason: '오늘은 운영하지 않아요', windows: [] };
    const windows = h.rules.filter((r) => !r.days || r.days.includes(dow)).map(({ start, end }) => ({ start, end }));
    if (!windows.length) return { known: true, closedToday: true, reason: '오늘은 운영하지 않아요', windows: [] };
    return { known: true, closedToday: false, windows };
  }

  const api = { parseHours, parseClosed, todaySchedule, isHoliday };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GapHours = api;
})(typeof window !== 'undefined' ? window : globalThis);
