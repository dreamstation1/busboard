# busboard

MatrixPortal M4 + 128x32 LED 매트릭스로 만든 버스 도착 안내기를 웹사이트로 옮긴 것입니다.
펌웨어(`ledmatrix.ino`)의 화면 로직을 함수 단위로 그대로 옮겨서, 좌표·색·스크롤 속도·전환 시간이 보드와 같습니다.

## 그대로 옮긴 것

- 화면 전체: 정류장 이름 스크롤, 노선/태그/도착 시간, 곧도착 줄과 버스 아이콘, 현재 시각, 날짜 화면, 공지
- 글꼴: 보드에서 쓰던 `u8g2_font_unifont_t_korean1` 원본 바이트와 펌웨어의 도트 글자
- 색: 패널과 같은 채널당 4비트 단계
- 갱신: 30초마다 불러옵니다
- 안내방송: 원본 음성 파일과 같은 순서(앞 음성 → 번호 → 뒤 음성), 20초 간격
- 조작: UP/DOWN 버튼(◀ ▶ 또는 방향키), 정류장 변경, ARS 직접 입력, 노선 조회/고정, 전원, 공지

폰트에 없는 글자(포, 김, 승, 곡, 합, 홍, 출, 토, 북 등)는 보드와 똑같이 빈칸으로 나옵니다.

## 보드와 다른 점

- 부팅 때의 WiFi 연결 화면과 IP 주소 화면은 없습니다. `SEOUL`만 잠깐 나옵니다.
- 번호를 읽는 목소리는 PC의 Windows TTS 대신 그 기기의 음성입니다.
- 스크롤은 모니터 화면에서 눈이 편하도록 보드보다 잘게 움직이고, 갱신 중에도 멈추지 않습니다. 보드처럼 끊어서 보려면 주소 뒤에 `?smooth=0`을 붙이세요.
- 밝기는 모니터에 맞춰 80%로 낮췄습니다. 주소 뒤에 `?bright=60`처럼 붙이면 바꿀 수 있고, `?bright=100`이 원래 밝기입니다.
- 한 프레임 시간은 46ms로 잡은 추정값입니다. 속도를 바꾸려면 주소 뒤에 `?frame=60`처럼 붙이세요. 숫자가 클수록 느립니다.
- 안내방송은 브라우저 규칙상 `안내방송 켜기`를 눌러야 소리가 납니다.

## 실시간으로 쓰기

서울 버스 API는 http만 받기 때문에 https인 GitHub Pages에서는 바로 부를 수 없습니다. 그래서 중계 서버가 없으면 **시연 데이터**로 돌아가고, 화면 아래에 그렇게 표시됩니다.
서비스 키는 이 저장소에 넣지 마세요. 아래 방법 모두 키를 코드 밖에 둡니다.

### 방법 1: Vercel (PC 없이 어디서나, 추천)

사이트와 중계 서버가 한 주소로 같이 올라가서, 접속하면 바로 실시간으로 나옵니다.

1. https://vercel.com/new 에서 GitHub 계정으로 로그인합니다.
2. `busboard` 저장소를 Import 합니다.
3. Environment Variables에 이름 `SEOUL_BUS_SERVICE_KEY`, 값에 서비스 키를 넣습니다.
4. Deploy를 누르고, 나온 주소를 엽니다.

### 방법 2: PC에서 바로 실행

Python만 있으면 됩니다. 같은 WiFi의 휴대폰은 `http://<PC-IP>:8000`으로 접속합니다.

```powershell
$env:SEOUL_BUS_SERVICE_KEY="발급받은키"
python server.py
```

### 방법 3: Cloudflare Workers

1. Cloudflare에서 Worker를 만들고 `worker.js` 내용을 넣습니다.
2. Worker 설정의 Secret에 `SEOUL_BUS_SERVICE_KEY`를 추가합니다.
3. 사이트의 `보드 설정 > 실시간 연결`에 Worker 주소를 넣습니다. 주소는 그 브라우저에 저장됩니다.

## 파일

| 파일 | 내용 |
| --- | --- |
| `index.html` | 화면과 LED 패널 표현 |
| `board.js` | 펌웨어 화면 로직 |
| `services.js` | 데이터 불러오기, 시연 데이터, 안내방송 |
| `data.js` | 자동 생성된 글꼴과 도트 데이터 |
| `audio/` | 안내방송 음성 |
| `api/`, `vercel.json` | Vercel용 실시간 중계 |
| `server.py`, `worker.js` | PC용, Cloudflare용 실시간 중계 |

글꼴: GNU Unifont (GPLv2+, Font Embedding Exception), [u8g2](https://github.com/olikraus/u8g2) 형식
