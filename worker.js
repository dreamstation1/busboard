// Cloudflare Workers용 중계 서버. 서비스 키는 코드가 아니라 Worker의 비밀 변수 SEOUL_BUS_SERVICE_KEY에 넣는다.
// GitHub Pages(https)에서는 http 전용인 버스 API를 부를 수 없어서 이 중계가 필요하다.
const ALLOWED_ORIGIN = '*'; // 내 사이트만 허용하려면 'https://<아이디>.github.io' 로 바꾼다.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN };
    if (url.pathname !== '/api/board/station_xml') return new Response('not found', { status: 404, headers: cors });
    const ars = url.searchParams.get('ars') || '';
    if (!/^\d{1,8}$/.test(ars)) return new Response('ars required', { status: 400, headers: cors });

    // 20초 캐시: 여러 명이 봐도 API 호출이 늘지 않는다.
    const cache = caches.default;
    const cacheKey = new Request(`https://cache.local/station/${ars}`);
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { headers: { ...cors, 'Content-Type': 'application/xml; charset=utf-8' } });

    const api = `http://ws.bus.go.kr/api/rest/stationinfo/getStationByUid?arsId=${ars}&serviceKey=${encodeURIComponent(env.SEOUL_BUS_SERVICE_KEY)}`;
    const res = await fetch(api);
    const body = await res.text();
    if (res.ok) {
      ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { 'Cache-Control': 'max-age=20' } })));
    }
    return new Response(res.ok ? body : 'upstream error', {
      status: res.ok ? 200 : 502,
      headers: { ...cors, 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};
