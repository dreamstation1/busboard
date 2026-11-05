/*
 * ledmatrix.ino 화면 로직을 브라우저로 옮긴 코드.
 * 함수 이름과 순서는 펌웨어와 맞춰 두었고, 수치(좌표·속도·대기시간)는 그대로다.
 * 그리기 대상은 Protomatter 대신 128x32 프레임버퍼(fb)다.
 */
(function () {
'use strict';

const G = window.BOARD_DATA.glyphs;
const W = 128, H = 32;

/* ---- 설정 ---- */
const params = new URLSearchParams(location.search);
// loop()의 delay(30)에 화면 전송·WiFi 호출 시간을 더한 한 바퀴 시간(추정치). ?frame=35 처럼 조절 가능.
const FRAME_MS = Math.max(10, Number(params.get('frame')) || 40);
// 기본은 화면 주사율에 맞춰 움직인다. 속도는 같고 3칸씩 튀던 걸음만 잘게 나뉜다. ?smooth=0 이면 보드처럼 프레임 단위로 움직인다.
const SMOOTH = params.get('smooth') !== '0';
let tick = 1; // 이번에 그리는 동안 지나간 시간을 보드 프레임 수로 센 값

const stationIds = ['19437', '19436', '19104', '19119', '19172', '16177', '14011'];
const stationNms = ['영등포청과시장->당산', '영등포청과시장->영등포역', '영등포시장역4번출구->당산', '김안과병원->오목교', '서울역환승센터(6)', '용문사.화곡청소년센터', '합정역(홍대방향)'];
const totalStations = 7;
const CUSTOM_STATION_IDX = 7;

/* ---- 프레임버퍼 (Adafruit_GFX 대응) ---- */
const fb = new Uint16Array(W * H);
function color565(r, g, b) { return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }
function drawPixel(x, y, c) { if (x >= 0 && x < W && y >= 0 && y < H) fb[y * W + x] = c; }
function fillScreen(c) { fb.fill(c); }
function drawFastHLine(x, y, w, c) { for (let i = 0; i < w; i++) drawPixel(x + i, y, c); }
function drawFastVLine(x, y, h, c) { for (let i = 0; i < h; i++) drawPixel(x, y + i, c); }
function drawRect(x, y, w, h, c) {
  drawFastHLine(x, y, w, c); drawFastHLine(x, y + h - 1, w, c);
  drawFastVLine(x, y, h, c); drawFastVLine(x + w - 1, y, h, c);
}

/* ---- u8g2 글꼴 (U8g2_for_Adafruit_GFX.cpp 대응) ---- */
const font = Uint8Array.from(atob(window.BOARD_DATA.font), ch => ch.charCodeAt(0));
const fi = {
  bits0: font[2], bits1: font[3], bitsW: font[4], bitsH: font[5], bitsX: font[6], bitsY: font[7], bitsD: font[8],
  startA: (font[17] << 8) | font[18], startLowerA: (font[19] << 8) | font[20], startUni: (font[21] << 8) | font[22],
};
function getGlyphData(enc) {
  let p = 23;
  if (enc <= 255) {
    if (enc >= 97) p += fi.startLowerA; else if (enc >= 65) p += fi.startA;
    for (;;) {
      if (font[p + 1] === 0) break;
      if (font[p] === enc) return p + 2;
      p += font[p + 1];
    }
  } else {
    p += fi.startUni;
    let t = p, e;
    do {
      p += (font[t] << 8) | font[t + 1];
      e = (font[t + 2] << 8) | font[t + 3];
      t += 4;
    } while (e < enc);
    for (;;) {
      e = (font[p] << 8) | font[p + 1];
      if (e === 0) break;
      if (e === enc) return p + 3;
      p += font[p + 2];
    }
  }
  return -1;
}
function bitReader(p) {
  let pos = 0;
  const u = cnt => {
    let v = font[p] >> pos;
    let n = pos + cnt;
    if (n >= 8) { p++; v = (v | (font[p] << (8 - pos))) & 0xFF; n -= 8; }
    pos = n;
    return v & ((1 << cnt) - 1);
  };
  return { u, s: cnt => u(cnt) - (1 << (cnt - 1)) };
}
const glyphCache = new Map();
function glyph(enc) {
  if (glyphCache.has(enc)) return glyphCache.get(enc);
  const p = getGlyphData(enc);
  let g = null;
  if (p >= 0) {
    const b = bitReader(p);
    const w = b.u(fi.bitsW), h = b.u(fi.bitsH);
    const x = b.s(fi.bitsX), y = b.s(fi.bitsY), d = b.s(fi.bitsD);
    const runs = []; // [lx, ly, len, isForeground]
    if (w > 0) {
      let lx = 0, ly = 0;
      const decodeLen = (len, fg) => {
        let cnt = len;
        for (;;) {
          const rem = w - lx;
          const cur = cnt < rem ? cnt : rem;
          if (cur > 0) runs.push([lx, ly, cur, fg]);
          if (cnt < rem) break;
          cnt -= rem; lx = 0; ly++;
        }
        lx += cnt;
      };
      for (;;) {
        const a = b.u(fi.bits0), c = b.u(fi.bits1);
        do { decodeLen(a, false); decodeLen(c, true); } while (b.u(1) !== 0);
        if (ly >= h) break;
      }
    }
    g = { w, h, x, y, d, runs };
  }
  glyphCache.set(enc, g);
  return g;
}
const u8g2 = {
  fg: 0, tx: 0, ty: 0,
  setForegroundColor(c) { this.fg = c; },
  setCursor(x, y) { this.tx = x; this.ty = y; },
  print(str) {
    for (const ch of String(str)) {
      const g = glyph(ch.codePointAt(0) & 0xFFFF);
      if (!g) continue;
      if (g.w > 0) {
        const ox = this.tx + g.x, oy = this.ty - (g.h + g.y);
        // setFont()이 투명 모드를 끄므로 글자 칸의 배경도 검정으로 칠해진다.
        for (const [lx, ly, len, isFg] of g.runs) drawFastHLine(ox + lx, oy + ly, len, isFg ? this.fg : 0);
      }
      this.tx += g.d;
    }
  },
  getUTF8Width(str) {
    let w = 0, dx = 0, gw = 0, gx = 0;
    for (const ch of String(str)) {
      const g = glyph(ch.codePointAt(0) & 0xFFFF);
      dx = 0;
      if (g) { dx = g.d; gw = g.w; gx = g.x; }
      w += dx;
    }
    if (gw !== 0) { w -= dx; w += gw; w += gx; }
    return w;
  },
};
function getStrWidth(s) { return u8g2.getUTF8Width(s); }

/* ---- 상태 변수 ---- */
let currentStationIdx = 0;
let busList = [], bottomList = [];
let busTotal = 0, bottomTotal = 0, currentIdx = 0;
let lastUpdate = 0, lastBusSwitchTime = 0;
let customArsId = '', customStationName = '';
let displayEnabled = true, manualDisplayEnabled = true;
let topScrollX = 0, isStopped = false, botX = 128;
let isShowingStationName = true, stationNameX = 128;
let isShowingDateTime = false, dateTimeUntil = 0, lastSingleRouteDateTime = 0;
let refreshPending = false, isUpdatingBuses = false;
let pendingFlaskBuses = '';
let previewRoute = '', previewRouteUntil = 0, pinnedRoute = '';
let externalNotice = '', externalNoticeUntil = 0, externalNoticeScrollX = 0;

const t0 = performance.now();
const millis = () => Math.floor(performance.now() - t0);
const f32 = Math.fround;
const isDigit = c => c >= '0' && c <= '9';
const toInt = s => { const m = String(s).trim().match(/^[-+]?\d+/); return m ? parseInt(m[0], 10) : 0; };
const epochNow = () => Math.floor(Date.now() / 1000);

/* ---- 도트 그리기 ---- */
function drawCustomBus(x, y) {
  const white = color565(255, 255, 255), red = color565(255, 0, 0);
  for (let i = 0; i < 14; i++) for (let j = 0; j < 57; j++) {
    const c = G.busDot[i][j];
    if (c === '2') drawPixel(x + j, y + i, white);
    else if (c === '1') drawPixel(x + j, y + i, red);
  }
}
function currentArsId() {
  if (currentStationIdx === CUSTOM_STATION_IDX && customArsId !== '') return customArsId;
  if (currentStationIdx >= 0 && currentStationIdx < totalStations) return stationIds[currentStationIdx];
  return stationIds[0];
}
function currentStationName() {
  if (currentStationIdx === CUSTOM_STATION_IDX && customStationName !== '') return customStationName;
  if (currentStationIdx >= 0 && currentStationIdx < totalStations) return stationNms[currentStationIdx];
  return stationNms[0];
}
function firstDigitIndex(s) { for (let i = 0; i < s.length; i++) if (isDigit(s[i])) return i; return -1; }

function cleanRouteName(route) {
  route = route.trim();
  const parenIdx = route.indexOf('(');
  let suffix = '';
  if (parenIdx >= 0) {
    suffix = route.substring(parenIdx);
    route = route.substring(0, parenIdx);
    if (suffix.indexOf('차고지') >= 0) suffix = '(차고지)';
    else if (suffix.indexOf('회차지') < 0 && suffix.indexOf('종점행') < 0) suffix = '';
  } else if (route.indexOf('차고지') >= 0) {
    suffix = '(차고지)';
    route = route.split('차고지').join('').split('출발').join('');
  }
  const digitIdx = firstDigitIndex(route);
  if (digitIdx < 0) return route + suffix;
  const isAlpha = c => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  let endIdx = digitIdx;
  while (endIdx < route.length && isDigit(route[endIdx])) endIdx++;
  while (endIdx < route.length && isAlpha(route[endIdx])) endIdx++;
  if (endIdx < route.length && route[endIdx] === '-') {
    const hyphenIdx = endIdx;
    let s = hyphenIdx + 1;
    while (s < route.length && isDigit(route[s])) s++;
    while (s < route.length && isAlpha(route[s])) s++;
    if (s > hyphenIdx + 1) endIdx = s;
  }
  return route.substring(0, endIdx) + suffix;
}
function routePrefix(route) { const d = firstDigitIndex(route); return d <= 0 ? '' : route.substring(0, d); }
function routeRest(route) { const d = firstDigitIndex(route); return d <= 0 ? route : route.substring(d); }
function routePrefixTighten(prefix) { return prefix === '' ? 0 : 1; }
function routeDirectionTag(route) {
  if (route.indexOf('차고지') >= 0) return '차고지';
  if (route.indexOf('종점행') >= 0) return '종점행';
  if (route.indexOf('회차지') >= 0) return '회차지';
  return '';
}
function routeWithoutDirectionTag(route) {
  const p = route.indexOf('(');
  if (p >= 0 && routeDirectionTag(route) !== '') return route.substring(0, p);
  return route;
}
function cleanArrivalMsg(msg) { return msg.split('분후').join('분').split('분 후').join('분'); }
function arrivalMinutes(msg) {
  msg = cleanArrivalMsg(msg);
  const minIdx = msg.indexOf('분');
  if (minIdx < 0) return -1;
  let startIdx = minIdx - 1;
  while (startIdx >= 0 && isDigit(msg[startIdx])) startIdx--;
  startIdx++;
  if (startIdx >= minIdx) return -1;
  return toInt(msg.substring(startIdx, minIdx));
}
function topArrivalMsg(msg) {
  msg = cleanArrivalMsg(msg).trim();
  const minVal = arrivalMinutes(msg);
  if (msg === '' || msg.indexOf('곧') >= 0 || (minVal > 0 && minVal <= 2)) return '곧도착';
  return msg;
}
function lastBusTopArrivalMsg(msg) {
  msg = cleanArrivalMsg(msg).split('막차').join('').trim();
  const nthIdx = msg.indexOf('번째');
  if (nthIdx >= 0) {
    let startIdx = nthIdx;
    while (startIdx > 0 && msg[startIdx - 1] !== ' ') startIdx--;
    msg = msg.substring(0, startIdx).trim();
  }
  const minVal = arrivalMinutes(msg);
  if (msg.indexOf('곧') >= 0 || (minVal > 0 && minVal <= 2)) return '곧도착';
  if (msg.indexOf('분') < 0 && msg.indexOf('종료') < 0 && msg.indexOf('대기') < 0) return '';
  return msg;
}
function drawDotGlyph(x, y, rows, h, color) {
  const w = rows[0].length;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const c = rows[yy][xx];
    if (c !== undefined && c !== '0') drawPixel(x + xx, y + yy, color);
  }
  return w;
}
function dotBitmapColor(ch, fallback) {
  if (ch === '1') return color565(0, 255, 0);
  if (ch === '2') return color565(0, 200, 255);
  if (ch === '3') return color565(255, 255, 0);
  if (ch === '4') return color565(255, 0, 0);
  if (ch === '5') return color565(0, 200, 255);
  if (ch === '6') return color565(255, 255, 255);
  return fallback;
}
const dotBitmapWidth = rows => rows[0].length;
function drawColorDotGlyph(x, y, rows, h, fallback) {
  const w = rows[0].length;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const ch = rows[yy][xx];
    if (ch !== undefined && ch !== '0') drawPixel(x + xx, y + yy, dotBitmapColor(ch, fallback));
  }
  return w;
}
function drawRouteNumber(x, y, route, forceSky = false) {
  let dirTag = routeDirectionTag(route);
  if (forceSky) dirTag = '';
  route = routeWithoutDirectionTag(route);
  const prefix = routePrefix(route);
  const rest = routeRest(route);
  const sky = color565(0, 200, 255), white = color565(255, 255, 255);
  if (route.length > 1 && route[0] === 'N' && isDigit(route[1])) {
    x += drawDotGlyph(x, y - 11, G.kGlyphNightN, 12, sky) + 2;
    let restW = drawRouteAsciiText(x, y, route.substring(1), forceSky ? sky : white);
    if (dirTag !== '') restW += 2 + drawRouteDirectionTag(x + restW + 2, y, dirTag, forceSky ? sky : white);
    return dotBitmapWidth(G.kGlyphNightN) + 2 + restW;
  }
  if (prefix !== '') {
    if (prefix === '양천') {
      x += drawColorDotGlyph(x, y - 12, G.kGlyphYangcheon, 15, sky) + 1;
    } else {
      u8g2.setForegroundColor(sky);
      u8g2.setCursor(x, y);
      u8g2.print(prefix);
      x += Math.max(0, getStrWidth(prefix) - routePrefixTighten(prefix));
    }
  }
  let restW = drawRouteAsciiText(x, y, rest, forceSky ? sky : white);
  if (dirTag !== '') restW += 2 + drawRouteDirectionTag(x + restW + 2, y, dirTag, forceSky ? sky : white);
  if (prefix === '양천') return dotBitmapWidth(G.kGlyphYangcheon) + 1 + restW;
  return Math.max(0, getStrWidth(prefix) - routePrefixTighten(prefix)) + restW;
}
function congestionColor(bus) {
  if (bus.isFull) return color565(255, 0, 0);
  if (bus.cong >= 5) return color565(255, 0, 0);
  if (bus.cong === 4) return color565(255, 140, 0);
  return color565(0, 255, 0);
}
function congestionLabel(bus) {
  if (bus.detour) return '지체';
  if (bus.isFull) return '만차';
  if (bus.cong >= 5) return '혼잡';
  if (bus.cong === 4) return '보통';
  return '여유';
}
function isFirstBusMessage(msg) { return msg.indexOf('첫차') >= 0 || msg.indexOf('운행대기') >= 0 || msg.indexOf('기점') >= 0; }
const firstBusTagWidth = () => G.kGlyphFirstBus[0].length;
const drawFirstBusTag = (x, y) => drawDotGlyph(x, y, G.kGlyphFirstBus, 12, color565(255, 255, 0));
const lastBusTagWidth = () => dotBitmapWidth(G.kGlyphLastBus);
const drawLastBusTag = (x, y, color) => drawDotGlyph(x, y - 11, G.kGlyphLastBus, 12, color);
function routeDirectionTagWidth(tag) {
  if (tag === '차고지') return getStrWidth('(') + dotBitmapWidth(G.kGlyphGarage) + getStrWidth(')');
  if (tag === '종점행') return getStrWidth('(') + dotBitmapWidth(G.kGlyphTerminal) + getStrWidth(')');
  if (tag === '회차지') return getStrWidth('(') + dotBitmapWidth(G.kGlyphTurnback) + getStrWidth(')');
  return getStrWidth(tag);
}
function drawRouteDirectionTag(x, y, tag, color) {
  if (tag === '차고지' || tag === '종점행' || tag === '회차지') {
    const startX = x;
    const tagColor = tag === '차고지' ? color565(255, 170, 90) : color;
    u8g2.setForegroundColor(tagColor);
    u8g2.setCursor(x, y);
    u8g2.print('(');
    x += getStrWidth('(');
    if (tag === '차고지') x += drawDotGlyph(x, y - 10, G.kGlyphGarage, 11, tagColor);
    else if (tag === '종점행') x += drawDotGlyph(x, y - 10, G.kGlyphTerminal, 11, tagColor);
    else x += drawDotGlyph(x, y - 10, G.kGlyphTurnback, 11, tagColor);
    u8g2.setCursor(x, y);
    u8g2.print(')');
    x += getStrWidth(')');
    return x - startX;
  }
  u8g2.setForegroundColor(color);
  u8g2.setCursor(x, y);
  u8g2.print(tag);
  return getStrWidth(tag);
}
const lowFloorTagWidth = () => dotBitmapWidth(G.kGlyphLowFloor);
const drawLowFloorTag = (x, y) => drawColorDotGlyph(x, y, G.kGlyphLowFloor, 14, color565(0, 255, 0));
function minuteArrivalWidth(msg) {
  const minVal = arrivalMinutes(msg);
  if (minVal < 0) return -1;
  const n = String(minVal);
  let w = 0;
  for (const c of n) w += routeAsciiCharWidth(c) + 1;
  return Math.max(0, w - 1) + 2 + dotBitmapWidth(G.kGlyphMinute);
}
function drawMinuteArrival(x, y, msg, color) {
  const minVal = arrivalMinutes(msg);
  if (minVal < 0) return 0;
  const startX = x;
  for (const c of String(minVal)) x += drawDotDigit(x, y - 11 + 1, c, color) + 1;
  x += 2;
  x += drawColorDotGlyph(x, y - 12, G.kGlyphMinute, 13, color);
  return x - startX;
}
function arrivalMsgWidth(msg) {
  if (msg.indexOf('종료') >= 0) return dotBitmapWidth(G.kGlyphClosed);
  if (msg.indexOf('곧') >= 0) return dotBitmapWidth(G.kGlyphSoon);
  if (msg.indexOf('대기') >= 0) return dotBitmapWidth(G.kGlyphWaiting);
  const m = minuteArrivalWidth(msg);
  if (m >= 0) return m;
  return getStrWidth(msg);
}
function drawArrivalMsg(x, y, msg, color) {
  if (msg.indexOf('종료') >= 0) return drawColorDotGlyph(x, y - 12, G.kGlyphClosed, 14, color565(255, 0, 0));
  if (msg.indexOf('곧') >= 0) return drawColorDotGlyph(x, y - 11, G.kGlyphSoon, 12, color565(0, 200, 255));
  if (msg.indexOf('대기') >= 0) return drawColorDotGlyph(x, y - 13, G.kGlyphWaiting, 14, color565(255, 255, 0));
  const m = minuteArrivalWidth(msg);
  if (m >= 0) return drawMinuteArrival(x, y, msg, color);
  u8g2.setForegroundColor(color);
  u8g2.setCursor(x, y);
  u8g2.print(msg);
  return getStrWidth(msg);
}
function congestionTextWidth(bus) {
  if (bus.detour) return dotBitmapWidth(G.kGlyphDelay);
  if (bus.isFull) return getStrWidth(congestionLabel(bus));
  if (bus.cong >= 5) return dotBitmapWidth(G.kGlyphCongested);
  if (bus.cong === 4) return dotBitmapWidth(G.kGlyphNormal);
  return dotBitmapWidth(G.kGlyphFree);
}
function drawCongestionText(x, y, bus) {
  if (bus.detour) return drawDotGlyph(x, y - 12, G.kGlyphDelay, 13, color565(255, 80, 0));
  if (bus.isFull) {
    u8g2.setForegroundColor(congestionColor(bus));
    u8g2.setCursor(x, y);
    u8g2.print(congestionLabel(bus));
    return getStrWidth(congestionLabel(bus));
  }
  if (bus.cong >= 5) return drawColorDotGlyph(x, y - 10, G.kGlyphCongested, 11, color565(255, 0, 0));
  if (bus.cong === 4) return drawDotGlyph(x, y - 11, G.kGlyphNormal, 12, color565(255, 140, 0));
  return drawColorDotGlyph(x, y - 9, G.kGlyphFree, 10, color565(0, 255, 0));
}
function congestionTagWidth(bus) {
  return dotBitmapWidth(G.kGlyphBracketOpen) + 1 + congestionTextWidth(bus) + 1 + dotBitmapWidth(G.kGlyphBracketClose);
}
function drawCongestionTag(x, y, bus) {
  const startX = x, yellow = color565(255, 255, 0);
  x += drawColorDotGlyph(x, y - 12, G.kGlyphBracketOpen, 12, yellow) + 1;
  x += drawCongestionText(x, y - (bus.cong === 4 ? 1 : 2), bus) + 1;
  x += drawColorDotGlyph(x, y - 12, G.kGlyphBracketClose, 12, yellow);
  return x - startX;
}
function drawDotDigit(x, y, c, color) {
  if (c < '0' || c > '9') return 0;
  return drawDotGlyph(x, y, G.kBigDigits[+c], 11, color);
}
function routeGlyphForChar(c) {
  if (c >= '0' && c <= '9') return G.kBigDigits[+c];
  if (c === 'A' || c === 'a') return G.kRouteA;
  if (c === 'B' || c === 'b') return G.kRouteB;
  if (c === 'G' || c === 'g') return G.kRouteG;
  if (c === '-') return G.kRouteHyphen;
  return null;
}
function routeAsciiCharWidth(c) {
  const g = routeGlyphForChar(c);
  if (g) return dotBitmapWidth(g);
  if (c === ' ') return 3;
  return 0;
}
function routeAsciiTextWidth(text) {
  let w = 0, fallback = '';
  for (const c of text) {
    const cw = routeAsciiCharWidth(c);
    if (cw > 0 || c === ' ') {
      if (fallback !== '') { w += getStrWidth(fallback); fallback = ''; }
      w += cw + 1;
    } else fallback += c;
  }
  if (fallback !== '') w += getStrWidth(fallback);
  return Math.max(0, w - 1);
}
function drawRouteAsciiText(x, y, text, color) {
  const startX = x;
  let fallback = '';
  for (const c of text) {
    const g = routeGlyphForChar(c);
    if (g || c === ' ') {
      if (fallback !== '') {
        u8g2.setForegroundColor(color);
        u8g2.setCursor(x, y);
        u8g2.print(fallback);
        x += getStrWidth(fallback) + 1;
        fallback = '';
      }
      if (c === ' ') x += 3;
      else x += drawDotGlyph(x, y - 11 + 1, g, 11, color) + 1;
    } else fallback += c;
  }
  if (fallback !== '') {
    u8g2.setForegroundColor(color);
    u8g2.setCursor(x, y);
    u8g2.print(fallback);
    x += getStrWidth(fallback);
  }
  return x - startX;
}
function routeNumberWidth(route, includeDirectionTag = true) {
  let dirTag = routeDirectionTag(route);
  if (!includeDirectionTag) dirTag = '';
  route = routeWithoutDirectionTag(route);
  const prefix = routePrefix(route), rest = routeRest(route);
  const suffixW = dirTag !== '' ? 2 + routeDirectionTagWidth(dirTag) : 0;
  if (prefix === '양천') return dotBitmapWidth(G.kGlyphYangcheon) + 1 + routeAsciiTextWidth(rest) + suffixW;
  if (route.length > 1 && route[0] === 'N' && isDigit(route[1])) return dotBitmapWidth(G.kGlyphNightN) + 2 + routeAsciiTextWidth(route.substring(1)) + suffixW;
  if (prefix !== '') return Math.max(0, getStrWidth(prefix) - routePrefixTighten(prefix)) + routeAsciiTextWidth(rest) + suffixW;
  return routeAsciiTextWidth(route) + suffixW;
}
function dotCurrentTimeWidth(buf) {
  const d = i => dotBitmapWidth(G.kBigDigits[+buf[i]]);
  let w = dotBitmapWidth(G.kGlyphHyun) + 1 + dotBitmapWidth(G.kGlyphJae) + 1 + dotBitmapWidth(G.kGlyphSi) + 1 + dotBitmapWidth(G.kGlyphGak) + 3;
  w += d(0) + 1;
  w += d(1) + 4;
  w += 1 + 5;
  w += d(3) + 1;
  w += d(4);
  return w;
}
const pad2 = n => String(n).padStart(2, '0');
function drawDotCurrentTime(x, y) {
  const white = color565(255, 255, 255);
  const e = epochNow() + 9 * 3600;
  const buf = pad2(Math.floor((e % 86400) / 3600)) + ':' + pad2(Math.floor((e % 3600) / 60));
  x = Math.max(0, Math.trunc((128 - dotCurrentTimeWidth(buf)) / 2));
  x += drawDotGlyph(x, y - 1, G.kGlyphHyun, 13, white) + 1;
  x += drawDotGlyph(x, y - 1, G.kGlyphJae, 13, white) + 1;
  x += drawDotGlyph(x, y - 1, G.kGlyphSi, 13, white) + 1;
  x += drawDotGlyph(x, y - 1, G.kGlyphGak, 13, white) + 3;
  x += drawDotDigit(x, y, buf[0], white) + 1;
  x += drawDotDigit(x, y, buf[1], white) + 4;
  drawFastVLine(x, y + 3, 2, white);
  drawFastVLine(x, y + 7, 2, white);
  x += 1 + 5;
  x += drawDotDigit(x, y, buf[3], white) + 1;
  drawDotDigit(x, y, buf[4], white);
}
function drawClockRight() { drawDotCurrentTime(20, 18); }
function showDateTimeFor(ms) { isShowingDateTime = true; dateTimeUntil = millis() + ms; }
function drawDateTimeScreen() {
  const e = epochNow() + 9 * 3600;
  const d = new Date(e * 1000);
  const weekNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dateBuf = `${String(d.getUTCFullYear()).padStart(4, '0')}.${d.getUTCMonth() + 1}.${d.getUTCDate()}.${weekNames[d.getUTCDay()]}`;
  const timeBuf = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  const yellow = color565(255, 255, 0);
  u8g2.setForegroundColor(yellow);
  u8g2.setCursor(Math.max(0, Math.trunc((128 - u8g2.getUTF8Width(dateBuf)) / 2)), 13);
  u8g2.print(dateBuf);
  u8g2.setForegroundColor(yellow);
  u8g2.setCursor(Math.trunc((128 - u8g2.getUTF8Width(timeBuf)) / 2), 29);
  u8g2.print(timeBuf);
}
function drawExternalNotice(animate) {
  if (externalNotice === '') return;
  const titleW = u8g2.getUTF8Width('MAP NOTICE');
  const msgW = u8g2.getUTF8Width(externalNotice);
  fillScreen(0);
  u8g2.setForegroundColor(color565(0, 255, 0));
  u8g2.setCursor(Math.max(0, Math.trunc((128 - titleW) / 2)), 13);
  u8g2.print('MAP NOTICE');
  u8g2.setForegroundColor(color565(255, 255, 255));
  if (msgW <= 126) {
    u8g2.setCursor(Math.max(0, Math.trunc((128 - msgW) / 2)), 29);
    u8g2.print(externalNotice);
  } else {
    u8g2.setCursor(128 - Math.trunc(externalNoticeScrollX), 29);
    u8g2.print(externalNotice);
    if (animate) {
      externalNoticeScrollX = f32(externalNoticeScrollX + 1.5 * tick);
      if (externalNoticeScrollX > msgW + 128) externalNoticeScrollX = 0;
    }
  }
}
function advanceBusIndex() {
  if (busTotal <= 0) return;
  const nextIdx = (currentIdx + 1) % busTotal;
  currentIdx = nextIdx;
  topScrollX = 0;
  isStopped = false;
  lastBusSwitchTime = millis();
  if (busTotal > 1 && bottomTotal === 0 && nextIdx === 0) showDateTimeFor(5000);
}
function requestDataRefresh() { refreshPending = true; }
function isVerySoon(msg) {
  msg = msg.trim();
  if (msg === '') return true;
  if (msg.indexOf('곧') >= 0) return true;
  const m = arrivalMinutes(msg);
  return m > 0 && m <= 2;
}
function queueFlaskBus(busNo, congLabel = '') {
  if (busNo === '') return;
  if (pendingFlaskBuses.indexOf(busNo) >= 0) return;
  if (pendingFlaskBuses !== '') pendingFlaskBuses += ',';
  pendingFlaskBuses += busNo;
  if (congLabel !== '') pendingFlaskBuses += '|' + congLabel;
}
function flushFlaskBuses() {
  if (pendingFlaskBuses === '') return;
  const buses = pendingFlaskBuses;
  pendingFlaskBuses = '';
  if (window.BoardAudio) window.BoardAudio.playMany(buses);
}
function resetDisplayStateForStationChange() {
  busTotal = 0; bottomTotal = 0; currentIdx = 0; botX = 128; topScrollX = 0;
  isStopped = false; isShowingDateTime = false; isShowingStationName = true; stationNameX = 128;
  lastSingleRouteDateTime = millis();
  requestDataRefresh();
}
function busLineText(b) {
  const msg = b.isLast ? lastBusTopArrivalMsg(b.msg) : topArrivalMsg(b.msg);
  let out = b.no;
  if (b.isLast) out += ' 막차';
  if (msg !== '') out += ' ' + msg;
  if (!b.isLast && msg.indexOf('종료') < 0) out += ' ' + congestionLabel(b);
  return out;
}
function routeMatchesQuery(busNo, route) {
  route = route.trim();
  const baseNo = routeWithoutDirectionTag(busNo);
  return route !== '' && (baseNo === route || busNo === route || baseNo.indexOf(route) >= 0 || busNo.indexOf(route) >= 0);
}
function findBusByRoute(route) {
  route = route.trim();
  if (route === '') return null;
  for (let i = 0; i < busTotal; i++) if (routeMatchesQuery(busList[i].no, route)) return busList[i];
  for (let i = 0; i < bottomTotal; i++) if (routeMatchesQuery(bottomList[i].no, route)) return bottomList[i];
  return null;
}
function routeQueryResult(route) {
  route = route.trim();
  if (route === '') return '';
  const found = findBusByRoute(route);
  return found ? busLineText(found) : route + ' 정보 없음';
}

/* ---- 버스 정보 갱신 (updateBuses 대응) ---- */
const utf8Len = s => new TextEncoder().encode(s).length;
function tagValue(item, name) {
  const open = `<${name}>`, close = `</${name}>`;
  const a = item.indexOf(open);
  if (a < 0) return null;
  const b = item.indexOf(close, a);
  return b > a ? item.substring(a + open.length, b) : null;
}
function applyStationXml(xml) {
  const up = [], down = [];
  let pos = 0;
  for (;;) {
    const s = xml.indexOf('<itemList>', pos);
    if (s < 0) break;
    const e = xml.indexOf('</itemList>', s);
    if (e < 0) break;
    const item = xml.substring(s, e + 11);
    pos = e + 11;
    if (utf8Len(item) > 1801) continue; // 보드의 1800바이트 버퍼를 넘는 항목은 버려진다
    let n = tagValue(item, 'rtNm') || '';
    let adir = tagValue(item, 'adirection') || '';
    let msg = tagValue(item, 'arrmsg1') || '';
    const traTime = toInt(tagValue(item, 'traTime1') || '');
    const bType = toInt(tagValue(item, 'busType1') || '');
    const cong = toInt(tagValue(item, 'congestion1') || '');
    const detour = tagValue(item, 'deTourAt') === '11';
    const fullVal = tagValue(item, 'full1') || '';
    const lastVal = tagValue(item, 'isLast1') || '';
    adir = adir.trim();
    if (n === '6620') n = adir.indexOf('당산역') >= 0 ? '6620(회차지)' : '6620(종점행)';
    n = n.split('전기').join('').trim();
    n = cleanRouteName(n);
    if (n === '') continue;
    if (msg.indexOf('종료') >= 0) msg = '종료';
    const brkIdx = msg.indexOf('[');
    if (brkIdx > 0) msg = msg.substring(0, brkIdx);
    msg = cleanArrivalMsg(msg.trim());
    if ((lastVal === '1' || msg.indexOf('막차') >= 0) && msg.indexOf('분') < 0 && msg.indexOf('곧') < 0 && traTime > 0) {
      msg = Math.max(1, Math.trunc((traTime + 59) / 60)) + '분';
    }
    const isLast = lastVal === '1';
    const tempBus = { no: n, msg, isLast, cong, bType, isFull: fullVal === '1', detour };
    const displayMsgForSoon = isLast ? lastBusTopArrivalMsg(msg) : topArrivalMsg(msg);
    const soonForDisplay = isVerySoon(msg) || displayMsgForSoon === '곧도착';
    if (soonForDisplay && msg !== '종료') {
      const baseNo = routeWithoutDirectionTag(n);
      if (!down.some(b => routeWithoutDirectionTag(b.no) === baseNo)) {
        down.push(tempBus);
        queueFlaskBus(baseNo, congestionLabel(tempBus));
      }
    }
    if (!soonForDisplay || msg === '종료') up.push(tempBus);
  }
  if (up.length === 0 && down.length > 0) up.push(...down);
  busList = up; bottomList = down;
  busTotal = up.length; bottomTotal = down.length;
  if (currentIdx >= busTotal) currentIdx = 0;
  lastUpdate = millis();
  flushFlaskBuses();
}
async function updateBuses() {
  isUpdatingBuses = true;
  try {
    const xml = await window.BoardSource.fetchStationXml(currentArsId());
    applyStationXml(xml);
  } catch (err) {
    lastUpdate = millis(); // 접속 실패 때 보드는 이전 목록을 그대로 둔다
    window.BoardSource.reportError(err);
  }
  pendingFlaskBuses = '';
  isUpdatingBuses = false;
}

/* ---- 프레임 그리기 (drawCurrentFrame 대응) ---- */
function emptyBus(no) { return { no, msg: '정보없음', isLast: false, cong: 0, bType: 0, isFull: false, detour: false }; }
function tagWidth(tag) {
  if (tag === '') return 0;
  if (tag === '__FIRST_BUS__') return firstBusTagWidth() + 3;
  if (tag === '__LOW_FLOOR__') return lowFloorTagWidth() + 5;
  if (tag === '막차') return lastBusTagWidth() + 2;
  return getStrWidth(tag) + 2;
}
function drawTag(p, tag, color) {
  if (tag === '__FIRST_BUS__') return p + drawFirstBusTag(p, 1) + 3;
  if (tag === '__LOW_FLOOR__') return p + drawLowFloorTag(p, 0) + 5;
  if (tag === '막차') return p + drawLastBusTag(p, 12, color) + 2;
  u8g2.setForegroundColor(color); u8g2.setCursor(p, 12); u8g2.print(tag);
  return p + getStrWidth(tag) + 2;
}
function drawCurrentFrame(animate) {
  displayEnabled = manualDisplayEnabled;
  if (!displayEnabled) { fillScreen(0); return; }
  fillScreen(0);

  if (externalNotice !== '') {
    if (millis() - externalNoticeUntil >= 0) { externalNotice = ''; externalNoticeScrollX = 0; }
    else { drawExternalNotice(animate); return; }
  }
  if (animate && pinnedRoute === '' && previewRoute === '' && !isUpdatingBuses && !isShowingStationName && !isShowingDateTime && busTotal === 1 && bottomTotal === 0 && millis() - lastSingleRouteDateTime > 15000) {
    showDateTimeFor(5000);
    lastSingleRouteDateTime = millis();
  }
  if (previewRoute !== '' && pinnedRoute === '' && millis() - previewRouteUntil >= 0) {
    previewRoute = ''; previewRouteUntil = 0; topScrollX = 0; isStopped = false;
  }
  if (isShowingDateTime) {
    if (animate && millis() - dateTimeUntil >= 0) { isShowingDateTime = false; lastBusSwitchTime = millis(); }
    else { drawDateTimeScreen(); return; }
  }

  if (isShowingStationName) {
    const stationName = currentStationName();
    u8g2.setForegroundColor(color565(255, 255, 255));
    u8g2.setCursor(Math.trunc(stationNameX), 24); u8g2.print(stationName);
    if (animate) {
      stationNameX -= 3 * tick;
      if (stationNameX < -getStrWidth(stationName)) {
        isShowingStationName = false;
        lastSingleRouteDateTime = millis();
        refreshPending = true;
      }
    }
  } else if (busTotal > 0 || pinnedRoute !== '' || previewRoute !== '') {
    let displayBus, forcedRouteMode = false, found;
    if (pinnedRoute !== '' && (found = findBusByRoute(pinnedRoute))) { displayBus = found; forcedRouteMode = true; }
    else if (previewRoute !== '' && (found = findBusByRoute(previewRoute))) { displayBus = found; forcedRouteMode = true; }
    else if (pinnedRoute !== '') { displayBus = emptyBus(pinnedRoute); forcedRouteMode = true; }
    else if (busTotal > 0) displayBus = busList[currentIdx];
    else { displayBus = emptyBus(previewRoute); forcedRouteMode = true; }

    const busNo = displayBus.no;
    const isLastBus = displayBus.isLast;
    const busMsg = isLastBus ? lastBusTopArrivalMsg(displayBus.msg) : topArrivalMsg(displayBus.msg);
    const isAnyClosed = busMsg.indexOf('종료') >= 0;
    const isYangcheon = busNo.indexOf('양천01') >= 0 || busNo.indexOf('양천02') >= 0;
    const lastBusColor = color565(255, 25, 55);

    let tag = '', tCol = 0;
    if (!isAnyClosed) {
      if (isLastBus) { tag = '막차'; tCol = lastBusColor; }
      else if (isFirstBusMessage(busMsg)) { tag = '__FIRST_BUS__'; tCol = color565(0, 200, 255); }
      else if (displayBus.isFull) { tag = '[만차]'; tCol = color565(255, 0, 0); }
      else if (displayBus.bType >= 1) { tag = '__LOW_FLOOR__'; tCol = color565(0, 255, 0); }
    }

    if (busTotal === 1 || forcedRouteMode) {
      const rightMsg = busMsg;
      const noW = routeNumberWidth(busNo);
      let midW = 0;
      const showFirstBus = tag === '__FIRST_BUS__';
      const showLastBus = isLastBus && !isAnyClosed;
      const showLowFloor = tag === '__LOW_FLOOR__';
      const showCongestion = !isAnyClosed && !isLastBus && !showFirstBus && !showLowFloor && busMsg !== '정보없음';
      if (showFirstBus) midW = firstBusTagWidth();
      else if (showLastBus) midW = lastBusTagWidth();
      else if (showLowFloor) midW = lowFloorTagWidth();
      else if (showCongestion) midW = congestionTextWidth(displayBus);
      const msgW = arrivalMsgWidth(rightMsg);
      const totalW = noW + (midW > 0 ? 2 + midW : 0) + (rightMsg !== '' ? 2 + msgW : 0);
      const mCol = isAnyClosed ? color565(255, 0, 0) : color565(0, 200, 255);

      if (totalW <= 124) {
        topScrollX = 0;
        isStopped = false;
        const congX = 42 + Math.max(0, Math.trunc((43 - midW) / 2));
        const msgX = Math.max(0, 128 - msgW - 2);
        drawRouteNumber(2, 12, busNo);
        if (showFirstBus) drawFirstBusTag(congX, 1);
        else if (showLastBus) drawLastBusTag(congX, 12, tCol);
        else if (showLowFloor) drawLowFloorTag(congX, 0);
        else if (showCongestion) drawCongestionText(congX, 12, displayBus);
        if (rightMsg !== '') drawArrivalMsg(msgX, 12, rightMsg, mCol);
      } else {
        const dx = 2 - Math.trunc(topScrollX);
        if (animate) {
          topScrollX = f32(topScrollX + 0.8 * tick);
          if (topScrollX > totalW + 4) topScrollX = 0;
        }
        let ptr = dx;
        ptr += drawRouteNumber(ptr, 12, busNo);
        if (showFirstBus) { ptr += 2; ptr += drawFirstBusTag(ptr, 1); }
        else if (showLastBus) { ptr += 2; ptr += drawLastBusTag(ptr, 12, tCol); }
        else if (showLowFloor) { ptr += 2; ptr += drawLowFloorTag(ptr, 0); }
        else if (showCongestion) { ptr += 2; ptr += drawCongestionText(ptr, 12, displayBus); }
        if (rightMsg !== '') { ptr += 2; drawArrivalMsg(ptr, 12, rightMsg, mCol); }
      }
    } else {
      const gapAfterNo = 7;
      const noW = routeNumberWidth(busNo), tagW = tagWidth(tag), msgW = arrivalMsgWidth(busMsg);
      const totalW = noW + gapAfterNo + tagW + msgW;
      let dx = 1;
      const scrollSpeed = isAnyClosed ? 2.8 : 0.8, waitTime = isAnyClosed ? 1000 : 3500;

      if (isYangcheon) { dx = 1; if (animate && millis() - lastBusSwitchTime > waitTime) advanceBusIndex(); }
      else if (totalW > 126) {
        if (!isStopped) {
          dx = 1 - Math.trunc(topScrollX);
          if (animate) {
            topScrollX = f32(topScrollX + scrollSpeed * tick);
            if (totalW - Math.trunc(topScrollX) <= 126) { topScrollX = totalW - 126; isStopped = true; lastBusSwitchTime = millis(); }
          }
        } else { dx = 1 - Math.trunc(topScrollX); if (animate && millis() - lastBusSwitchTime > waitTime) advanceBusIndex(); }
      } else { dx = 1; if (animate && millis() - lastBusSwitchTime > waitTime) advanceBusIndex(); }

      let ptr = dx + drawRouteNumber(dx, 12, busNo) + gapAfterNo;
      if (tag !== '') ptr = drawTag(ptr, tag, tCol);
      const mCol = isAnyClosed ? color565(255, 0, 0) : color565(0, 200, 255);
      if (busMsg !== '') drawArrivalMsg(ptr, 12, busMsg, mCol);

      if (!isYangcheon && totalW <= 61 && busTotal > 1 && topScrollX === 0) {
        const sepX = 64, rightX = sepX + 3, room = 128 - rightX - 1;
        let secondIdx = -1, secondMsg = '', secondTag = '', secondTagColor = 0;
        for (let off = 1; off < busTotal; off++) {
          const candIdx = (currentIdx + off) % busTotal;
          const cand = busList[candIdx];
          const candMsg = cand.isLast ? lastBusTopArrivalMsg(cand.msg) : topArrivalMsg(cand.msg);
          if (candMsg === '') continue;
          const candClosed = candMsg.indexOf('종료') >= 0;
          let candTag = '', candTagColor = 0;
          if (!candClosed) {
            if (cand.isLast) { candTag = '막차'; candTagColor = lastBusColor; }
            else if (isFirstBusMessage(candMsg)) { candTag = '__FIRST_BUS__'; candTagColor = color565(0, 200, 255); }
            else if (cand.isFull) { candTag = '[만차]'; candTagColor = color565(255, 0, 0); }
            else if (cand.bType >= 1) { candTag = '__LOW_FLOOR__'; candTagColor = color565(0, 255, 0); }
          }
          const candW = routeNumberWidth(cand.no) + gapAfterNo + tagWidth(candTag) + arrivalMsgWidth(candMsg);
          if (candW <= room) {
            secondIdx = candIdx; secondMsg = candMsg; secondTag = candTag; secondTagColor = candTagColor;
            break;
          }
        }
        if (secondIdx >= 0) {
          drawFastVLine(sepX, 0, 14, color565(255, 220, 0));
          let sp = rightX;
          sp += drawRouteNumber(sp, 12, busList[secondIdx].no) + gapAfterNo;
          if (secondTag !== '') sp = drawTag(sp, secondTag, secondTagColor);
          const secondMsgColor = secondMsg.indexOf('종료') >= 0 ? color565(255, 0, 0) : color565(0, 200, 255);
          drawArrivalMsg(sp, 12, secondMsg, secondMsgColor);
        }
      }
    }
  }

  if (bottomTotal > 0 && pinnedRoute === '' && !isShowingStationName) {
    let bottomW = 2 + 41 + 5;
    for (let i = 0; i < bottomTotal; i++) {
      bottomW += routeNumberWidth(bottomList[i].no, false) + 2 + congestionTagWidth(bottomList[i]);
      if (i < bottomTotal - 1) bottomW += 6;
    }
    if (bottomW <= 128) botX = 2;
    else if (bottomTotal === 1 && animate) {
      if (botX > 128 - bottomW) botX = f32(botX - tick); else botX = 2;
    } else if (animate) botX = f32(botX - tick);
    let tx = Math.trunc(botX);
    drawCustomBus(tx, 16);
    tx += 46;
    for (let i = 0; i < bottomTotal; i++) {
      tx += drawRouteNumber(tx, 29, bottomList[i].no, true);
      tx += 2;
      tx += drawCongestionTag(tx, 29, bottomList[i]);
      if (i < bottomTotal - 1) tx += 6;
    }
    if (animate && bottomW > 128 && bottomTotal > 1 && tx < 0) botX = 128;
  } else if (busTotal === 1 && !isShowingStationName) {
    drawClockRight();
  } else if (!isShowingStationName) {
    drawDotCurrentTime(20, 18);
  }
  if (!isShowingStationName) drawRect(0, 14, 128, 18, color565(80, 80, 0));
}

/* ---- 화면 출력: 16비트 색을 패널의 4비트 밝기로 낮춰 표시 ---- */
let onShow = () => {};
function show(dt = 0) { onShow(fb, dt); }

/* ---- loop() 대응 ---- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 다음 화면 주사에 맞춰 깨어난다. 탭이 가려져 주사가 멈춰도 타이머로 계속 돈다.
const nextFrame = () => new Promise(r => {
  const t = setTimeout(() => { cancelAnimationFrame(a); r(); }, 100);
  const a = requestAnimationFrame(() => { clearTimeout(t); r(); });
});
async function boot() {
  fillScreen(0);
  u8g2.setForegroundColor(color565(255, 255, 255));
  u8g2.setCursor(Math.trunc((128 - u8g2.getUTF8Width('SEOUL')) / 2), 21);
  u8g2.print('SEOUL');
  show();
  await Promise.all([window.BoardSource.ready(), sleep(1200)]);
  await updateBuses();
  isShowingStationName = true;
  stationNameX = 128;
  lastBusSwitchTime = millis();
  lastSingleRouteDateTime = millis();
  let prev = performance.now();
  for (;;) {
    const start = performance.now();
    const dt = Math.min(100, start - prev);
    prev = start;
    if (SMOOTH) tick = dt / FRAME_MS;
    drawCurrentFrame(true);
    show(SMOOTH ? dt : 0);
    if (!isShowingStationName && !isUpdatingBuses && millis() - lastUpdate > 30000 && !document.hidden) requestDataRefresh();
    if (!isShowingStationName && refreshPending && !isUpdatingBuses) {
      refreshPending = false;
      lastUpdate = millis();
      if (SMOOTH) updateBuses(); // 불러오는 동안에도 스크롤은 멈추지 않는다
      else await updateBuses(); // 보드는 갱신하는 동안 화면이 멈춘다
    }
    if (SMOOTH) await nextFrame();
    else await sleep(Math.max(0, FRAME_MS - (performance.now() - start)));
  }
}

/* ---- 조작 (보드 버튼과 보드 설정 페이지 대응) ---- */
function buttonStep(delta) {
  currentStationIdx = (((currentStationIdx >= totalStations ? 0 : currentStationIdx) + delta) + totalStations) % totalStations;
  isShowingStationName = true; isShowingDateTime = false; stationNameX = 128; currentIdx = 0;
  lastSingleRouteDateTime = millis(); requestDataRefresh();
}
window.Board = {
  W, H, stationIds, stationNms,
  boot,
  setShow(fn) { onShow = fn; },
  up() { buttonStep(1); },
  down() { buttonStep(-1); },
  setStation(idx) {
    if (idx >= 0 && idx < totalStations) {
      currentStationIdx = idx; customArsId = ''; customStationName = '';
      resetDisplayStateForStationChange();
    }
  },
  setCustom(ars, name) {
    ars = ars.trim();
    if (ars === '') return;
    currentStationIdx = CUSTOM_STATION_IDX; customArsId = ars; customStationName = name.trim() || ars;
    resetDisplayStateForStationChange();
  },
  setPower(on) {
    manualDisplayEnabled = on;
    if (on) { isShowingStationName = true; stationNameX = 128; requestDataRefresh(); }
  },
  refresh() { requestDataRefresh(); },
  query(route, pin) {
    route = route.trim();
    if (!pin) pinnedRoute = '';
    if (route !== '') {
      previewRoute = route; previewRouteUntil = millis() + 60000;
      if (pin) pinnedRoute = route;
      isShowingStationName = false; isShowingDateTime = false; topScrollX = 0; isStopped = false;
    }
    return routeQueryResult(route);
  },
  unpin() { pinnedRoute = ''; previewRoute = ''; previewRouteUntil = 0; topScrollX = 0; isStopped = false; },
  notice(text) {
    text = text.trim();
    if (text === '') return;
    externalNotice = text; externalNoticeUntil = millis() + 15000; externalNoticeScrollX = 0;
    isShowingStationName = false; isShowingDateTime = false;
  },
  get power() { return manualDisplayEnabled; },
  get stationIdx() { return currentStationIdx; },
  get stationName() { return currentStationName(); },
  get arsId() { return currentArsId(); },
  get pinned() { return pinnedRoute; },
};
})();
