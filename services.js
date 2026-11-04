/*
 * 데이터 출처(BoardSource)와 안내방송(BoardAudio).
 * BoardAudio는 busarrival_server.py의 announcement_loop / route_to_korean을 옮긴 것이다.
 */
(function () {
'use strict';

/* ---------- 데이터 출처 ---------- */
// 실시간: 같은 주소의 server.py 또는 ?api=중계서버주소. 둘 다 없으면 시연 데이터.
const STORE_KEY = 'busled.api';
const store = {
  get() { try { return localStorage.getItem(STORE_KEY) || ''; } catch (e) { return ''; } },
  set(v) { try { v ? localStorage.setItem(STORE_KEY, v) : localStorage.removeItem(STORE_KEY); } catch (e) { /* 저장 불가 */ } },
};
const url = (base, ars) => `${base.replace(/\/$/, '')}/api/board/station_xml?ars=${encodeURIComponent(ars)}`;

async function fetchXml(base, ars, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url(base, ars), { signal: ctl.signal, cache: 'no-store' });
    const text = await res.text();
    if (text.indexOf('<ServiceResult') < 0) throw new Error('응답 형식이 다릅니다');
    return text;
  } finally { clearTimeout(timer); }
}

/* 시연 데이터: 실제 API와 같은 XML을 만들어 같은 해석 코드로 보낸다. 시간은 흐르면서 줄어든다. */
const DEMO_ROUTES = [
  { rtNm: '660', adirection: '가양역', period: 540, offset: 95, busType: 1, cong: 3 },
  { rtNm: '6620', adirection: '당산역', period: 660, offset: 300, busType: 1, cong: 4 },
  { rtNm: '5', adirection: '구로동', period: 480, offset: 40, busType: 0, cong: 3 },
  { rtNm: '6640B', adirection: '양천공영차고지', period: 780, offset: 520, busType: 0, cong: 5 },
  { rtNm: '양천02', adirection: '목동역', period: 900, offset: 700, busType: 1, cong: 3 },
  { rtNm: '영등포10', adirection: '영등포역', period: 600, offset: 130, busType: 0, cong: 4 },
  { rtNm: '661', adirection: '여의도', period: 720, offset: 440, busType: 0, cong: 3, last: true },
  { rtNm: 'N62', adirection: '양천공영차고지', period: 0, fixed: '운행종료' },
  { rtNm: '7612', adirection: '영등포역', period: 0, fixed: '출발대기' },
];
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
function demoXml(ars) {
  const seed = [...String(ars)].reduce((a, c) => a + c.charCodeAt(0), 0);
  const count = 3 + (seed % 5);
  const now = Math.floor(Date.now() / 1000);
  const start = seed % DEMO_ROUTES.length;
  let items = '';
  for (let i = 0; i < count; i++) {
    const r = DEMO_ROUTES[(start + i) % DEMO_ROUTES.length];
    let msg = r.fixed, tra = 0;
    if (!r.fixed) {
      tra = r.period - ((now + r.offset + seed * 7) % r.period);
      const m = Math.floor(tra / 60), s = tra % 60;
      msg = tra < 60 ? '곧 도착' : `${m}분${s}초후[${Math.max(1, Math.floor(m / 2))}번째 전]`;
    }
    items += `<itemList><adirection>${esc(r.adirection)}</adirection><arrmsg1>${esc(msg)}</arrmsg1><busType1>${r.busType || 0}</busType1>` +
      `<congestion1>${r.cong || 0}</congestion1><deTourAt>00</deTourAt><isLast1>${r.last ? 1 : 0}</isLast1>` +
      `<rtNm>${esc(r.rtNm)}</rtNm><traTime1>${tra}</traTime1></itemList>`;
  }
  return `<ServiceResult><msgHeader><headerCd>0</headerCd></msgHeader><msgBody>${items}</msgBody></ServiceResult>`;
}

const source = {
  mode: 'demo', base: '', error: '',
  onChange() {},
  set(mode, base, error = '') { this.mode = mode; this.base = base; this.error = error; this.onChange(); },
  async ready() {
    const q = new URLSearchParams(location.search).get('api');
    if (q !== null) store.set(q);
    const saved = store.get();
    const candidates = [];
    if (saved) candidates.push(saved);
    if (/^https?:$/.test(location.protocol) && !location.hostname.endsWith('github.io')) candidates.push('');
    for (const base of candidates) {
      try { await fetchXml(base, '19437', 6000); this.set('live', base); return; } catch (e) { /* 다음 후보 */ }
    }
    this.set('demo', '', saved ? '저장된 중계 서버에 연결하지 못했습니다' : '');
  },
  async fetchStationXml(ars) {
    if (this.mode === 'demo') return demoXml(ars);
    const xml = await fetchXml(this.base, ars, 8000);
    const cd = (xml.match(/<headerCd>(\d+)<\/headerCd>/) || [])[1];
    const msg = (xml.match(/<headerMsg>([^<]*)<\/headerMsg>/) || [])[1] || '';
    this.set('live', this.base, cd && cd !== '0' && cd !== '4' ? msg : '');
    return xml;
  },
  reportError(err) { this.set(this.mode, this.base, err.name === 'AbortError' ? '응답 시간 초과' : err.message); },
  async connect(base) {
    base = base.trim();
    await fetchXml(base, '19437', 8000);
    store.set(base);
    this.set('live', base);
  },
  disconnect() { store.set(''); this.set('demo', ''); },
};
window.BoardSource = source;

/* ---------- 안내방송 ---------- */
const COOLDOWN_SEC = 20, COLLECT_WINDOW_SEC = 1, STALE_SEC = 60;
const KOREAN_DIGITS = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const KOREAN_UNITS = [[1000, '천'], [100, '백'], [10, '십']];
const LETTER_SPOKEN = { A: '에이', B: '비', C: '씨', D: '디', E: '이', F: '에프', G: '지', H: '에이치', I: '아이', J: '제이', K: '케이', L: '엘', M: '엠', N: '엔', O: '오', P: '피', Q: '큐', R: '알', S: '에스', T: '티', U: '유', V: '브이', W: '더블유', X: '엑스', Y: '와이', Z: '제트' };

function koreanNumber(num) {
  num = parseInt(num, 10);
  if (num === 0) return '영';
  let text = '';
  for (const [value, unit] of KOREAN_UNITS) {
    const digit = Math.floor(num / value);
    if (digit) { text += (digit === 1 ? '' : KOREAN_DIGITS[digit]) + unit; num %= value; }
  }
  if (num) text += KOREAN_DIGITS[num];
  return text;
}
function routeToKorean(route, speakLetters) {
  route = String(route).trim();
  const chunks = route.match(/\d+|[A-Za-z]+/g);
  if (!chunks) return route;
  const parts = [];
  let firstNumberSeen = false, lastWasLetter = false;
  chunks.forEach((chunk, idx) => {
    if (/^\d+$/.test(chunk)) {
      parts.push((firstNumberSeen ? '다시 ' : '') + koreanNumber(chunk));
      firstNumberSeen = true; lastWasLetter = false;
    } else if (chunk.toUpperCase() === 'N' && idx === 0) {
      parts.push('엔'); lastWasLetter = false;
    } else if (speakLetters) {
      parts.push([...chunk].map(c => LETTER_SPOKEN[c.toUpperCase()] || c).join(' '));
      lastWasLetter = true;
    }
  });
  if (!parts.length) return route;
  return parts.join(' ') + (lastWasLetter ? ' 번' : '번');
}

// busarrival_state.json에 저장돼 있던 값: 송출 방식 2, 파일 볼륨 36, TTS 볼륨 93, 노선 문자 읽기 켬
const settings = { enabled: false, mode: 2, fileVolume: 0.36, ttsVolume: 0.93, speakLetters: true };
const clips = { 1: ['audio/bus.mp3', 'audio/soon.mp3'], 2: ['audio/t.mp3', 'audio/y.mp3'] };
const players = {};
for (const pair of Object.values(clips)) for (const src of pair) {
  const a = new Audio(src);
  a.preload = 'auto';
  players[src] = a;
}
let activeBuses = new Map();
let lastUpdateTime = Date.now() / 1000;
let lastFinished = 0;
let busy = false;

function playClip(src) {
  return new Promise(resolve => {
    const a = players[src];
    const done = () => { a.onended = a.onerror = null; clearTimeout(guard); resolve(); };
    const guard = setTimeout(done, 12000);
    a.onended = a.onerror = done;
    a.currentTime = 0;
    a.volume = settings.fileVolume;
    a.play().catch(done);
  });
}
function speak(text) {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.rate = 1.1;
    u.volume = settings.ttsVolume;
    const voice = speechSynthesis.getVoices().find(v => v.lang.replace('_', '-').startsWith('ko'));
    if (voice) u.voice = voice;
    const done = () => { clearTimeout(guard); resolve(); };
    const guard = setTimeout(done, 15000);
    u.onend = u.onerror = done;
    speechSynthesis.speak(u);
  });
}
async function announce(buses) {
  const spoken = buses.map(b => routeToKorean(b.raw, settings.speakLetters)).join(', ');
  const [first, last] = clips[settings.mode];
  audio.onSpeak(spoken);
  await playClip(first);
  await speak(spoken);
  await playClip(last);
  audio.onSpeak('');
}
const audio = {
  settings,
  onSpeak() {},
  routeToKorean,
  // /play_many 대응
  playMany(raw) {
    activeBuses = new Map();
    for (const part of raw.split(',')) {
      const route = part.split('|')[0].trim();
      if (route) activeBuses.set(route, true);
    }
    lastUpdateTime = Date.now() / 1000;
  },
  // 브라우저는 사용자가 누른 뒤에만 소리를 낼 수 있어서, 켜는 순간 재생 권한을 받아 둔다.
  enable(on) {
    settings.enabled = on;
    if (!on) { if ('speechSynthesis' in window) speechSynthesis.cancel(); return; }
    for (const a of Object.values(players)) {
      a.muted = true;
      a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
    }
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  },
  async test() {
    if (busy) return;
    busy = true;
    await announce([{ raw: '660' }]);
    lastFinished = Date.now() / 1000;
    busy = false;
  },
};
window.BoardAudio = audio;

// announcement_loop 대응
setInterval(async () => {
  if (busy) return;
  const now = Date.now() / 1000;
  if (now - lastUpdateTime > STALE_SEC) activeBuses.clear();
  if (!activeBuses.size || !settings.enabled) return;
  if (COOLDOWN_SEC - (now - lastFinished) > 0) return;
  if (now - lastUpdateTime < COLLECT_WINDOW_SEC) return;
  const buses = [];
  for (const raw of activeBuses.keys()) {
    const nums = raw.match(/\d+/g);
    if (nums) buses.push({ raw, num: parseInt(nums[0], 10) });
  }
  activeBuses.clear();
  buses.sort((a, b) => a.num - b.num);
  if (!buses.length) return;
  busy = true;
  await announce(buses);
  lastFinished = Date.now() / 1000;
  busy = false;
}, 200);
})();
