"""전광판 사이트 + 실시간 버스 정보를 함께 띄우는 작은 서버 (표준 라이브러리만 사용).

실행:
    set SEOUL_BUS_SERVICE_KEY=발급받은키      (PowerShell: $env:SEOUL_BUS_SERVICE_KEY="발급받은키")
    python server.py

그다음 브라우저에서 http://localhost:8000 을 연다.
같은 WiFi의 휴대폰은 http://<PC-IP>:8000 으로 들어오면 된다.
"""
import http.server
import os
import re
import socketserver
import sys
import time
import urllib.parse
import urllib.request

PORT = int(os.environ.get("PORT", "8000"))
KEY = os.environ.get("SEOUL_BUS_SERVICE_KEY", "").strip()
API = "http://ws.bus.go.kr/api/rest/stationinfo/getStationByUid"
CACHE_SEC = 20  # 여러 기기가 봐도 API 호출이 늘지 않게 busarrival_server.py와 같은 20초 캐시
ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC_FILES = {"/index.html", "/board.js", "/services.js", "/data.js"}
cache = {}


def station_xml(ars):
    hit = cache.get(ars)
    if hit and time.time() - hit[0] < CACHE_SEC:
        return hit[1]
    url = f"{API}?arsId={ars}&serviceKey={urllib.parse.quote(KEY, safe='')}"
    with urllib.request.urlopen(url, timeout=8) as res:
        body = res.read()
    cache[ars] = (time.time(), body)
    return body


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/board/station_xml":
            return self.send_station(parsed)
        if parsed.path == "/" or parsed.path in PUBLIC_FILES or parsed.path.startswith("/audio/"):
            return super().do_GET()
        self.send_error(404)

    def send_station(self, parsed):
        ars = urllib.parse.parse_qs(parsed.query).get("ars", [""])[0]
        if not re.fullmatch(r"\d{1,8}", ars):
            return self.send_error(400, "ars required")
        try:
            body, status = station_xml(ars), 200
        except Exception as exc:
            print("버스 API 호출 실패:", type(exc).__name__)
            body, status = b"upstream error", 502
        self.send_response(status)
        self.send_header("Content-Type", "application/xml; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    if not KEY:
        sys.exit("SEOUL_BUS_SERVICE_KEY 환경변수에 서비스 키를 넣고 다시 실행하세요.")
    print(f"http://localhost:{PORT} 에서 전광판이 열립니다. 끄려면 Ctrl+C")
    Server(("0.0.0.0", PORT), Handler).serve_forever()
