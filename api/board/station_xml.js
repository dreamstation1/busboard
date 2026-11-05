// Vercel 서버 함수: https 사이트 대신 http 전용 버스 API를 불러 준다.
// 서비스 키는 코드가 아니라 Vercel 환경변수 SEOUL_BUS_SERVICE_KEY에 넣는다.
// 디코딩된 키(+,/,=)와 인코딩된 키(%2B,%2F,%3D) 둘 다 받는다.
function encodedKey() {
  const key = (process.env.SEOUL_BUS_SERVICE_KEY || '').trim();
  return key.includes('%') ? key : encodeURIComponent(key);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const ars = String((req.query && req.query.ars) || '');
  if (!/^\d{1,8}$/.test(ars)) return res.status(400).send('ars required');
  if (!process.env.SEOUL_BUS_SERVICE_KEY) return res.status(500).send('SEOUL_BUS_SERVICE_KEY is not set');
  try {
    const api = `http://ws.bus.go.kr/api/rest/stationinfo/getStationByUid?arsId=${ars}&serviceKey=${encodedKey()}`;
    const upstream = await fetch(api, { signal: AbortSignal.timeout(8000) });
    const body = await upstream.text();
    if (!upstream.ok) return res.status(502).send('upstream error');
    // 20초 캐시: 여러 명이 봐도 API 호출이 늘지 않는다.
    res.setHeader('Cache-Control', 'public, s-maxage=20');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.status(200).send(body);
  } catch (err) {
    return res.status(502).send('upstream error');
  }
};
