# 회의봇 (meetbot)

사내 회의 일정 예약 에이전트. `/meet` 한 번이면 참석자 전원의 빈 시간을 찾아 후보 3개를 내밀고, 하나를 고르면 초대 발송과 회의실 예약까지 잡아준다. 봇이 만든 회의는 봇에서 취소·시간 변경까지.

**설계 원칙**: 상태는 카드가, 권한은 각자가 준 만큼(개인 동의), 멱등은 캘린더가, 기록은 로그가 맡는다. 봇이 소유하는 것은 코드와 사용자 표 하나, 로그 파일뿐.

## 구조

```
슬랙 (SaaS) ⇄ 봇 서버 (이 코드, 무상태 핸들러) ⇄ 캘린더 (Google)
```

| 구성요소 | 파일 | 역할 |
|---|---|---|
| 슬랙 어댑터 | `src/adapters/slack/` | 번역만 — 라우팅, Block Kit 선언 (그리는 건 슬랙) |
| 가용성 엔진 | `src/engine/availability.ts` | **읽기 경로.** 순수 계산: 근무시간−바쁜 구간→전원 교집합→30분 경계 이른 순 3개, 인원에 맞는 최소 회의실 |
| 예약 실행기 | `src/executor/booking.ts` | **유일한 쓰기 경로.** 생성 직전 재검증→생성·취소·변경, 감사 로그 |
| 캘린더 어댑터 | `src/adapters/calendar/` | 번역만 — 요청자 토큰으로 호출, 중립 모델 정규화, 요청 ID 멱등(캘린더에 위임) |
| 사용자 표 | `src/store/users.ts` | 봇이 소유하는 유일한 DB (SQLite): 암호화 위임 토큰, 확산 발송 표시 |
| 감사 로그 | `src/audit/log.ts` | JSON 한 줄 → stdout + 파일. 지표 = 이 로그의 카운트 |

대화 상태(후보 슬롯·요청 ID·이벤트 ID)는 서버가 아니라 **카드 payload**가 들고 다닌다.

## 안전장치 (쓰기 경로와 한 몸)

1. **확인 후 쓰기** — 쓰기는 사용자가 후보를 클릭한 뒤에만. 생성 직전 빈 시간 재검증, 선점됐으면 만들지 않고 새 후보
2. **멱등** — 요청 ID의 결정적 이벤트 ID로 insert. 같은 ID의 중복 생성을 캘린더가 409로 거른다 (우리 쪽 멱등키 저장소 없음)
3. **되돌리기** — 봇이 만든 회의는 완료 카드의 [취소]·[시간 변경]으로 즉시
4. **최소 권한** — OAuth 스코프는 `calendar.freebusy`(빈 시간 여부만, 제목·내용 접근 없음) + `calendar.events`(내 이름의 생성·관리)뿐. 위임 권한이라 사고 반경 = 동의한 사람들

## 실행

```bash
pnpm install
cp .env.example .env   # 토큰 채우기 (아래)
pnpm dev               # Socket Mode — 공개 URL 불필요
```

### 1. 슬랙 앱 만들기 (mydav12 워크스페이스)

1. https://api.slack.com/apps → **Create New App** → **From a manifest** → 워크스페이스 선택
2. `slack-manifest.yml` 내용 붙여넣기 → 생성
3. **Basic Information → App-Level Tokens** → `connections:write` 스코프로 토큰 생성 → `.env`의 `SLACK_APP_TOKEN`
4. **Install App** → 설치 → **Bot User OAuth Token** → `.env`의 `SLACK_BOT_TOKEN`

여기까지 하면 `CALENDAR_ADAPTER=fake`로 전체 사이클(폼→후보→생성→취소·변경)이 동작한다 — 가짜 캘린더에 방 3개(2·4·8인실)가 내장돼 있다.

### 2. 실제 Google Calendar 붙이기 (선택)

1. https://console.cloud.google.com → 프로젝트 생성 → **Google Calendar API** 활성화
2. **OAuth 동의 화면** → External + 테스트 모드 → 테스트 사용자에 본인 gmail 추가
3. **사용자 인증 정보** → OAuth 클라이언트 ID(웹) → 리디렉션 URI `http://localhost:3355/oauth/callback`
4. `.env`: `CALENDAR_ADAPTER=google`, `GOOGLE_CLIENT_ID/SECRET`, `TOKEN_ENC_KEY=$(openssl rand -hex 32)`
5. `/meet` 첫 실행 시 연동 카드가 오고, [연동하기] → 브라우저 동의 → 완료

개인 계정엔 회의실 리소스가 없으므로, 방 테스트는 `GOOGLE_ROOMS='[{"email":"room@...","name":"4인실","capacity":4}]'`처럼 일반 계정을 방으로 지정하거나 fake 어댑터로 한다.

## 테스트

```bash
pnpm test        # 엔진(경계·교집합·방 선택·결정론) + 실행기(멱등·재검증) 13케이스
pnpm typecheck
```

## 지표 (게이트 판정)

전부 감사 로그(`data/audit.log`) 카운트로 얻는다:

```bash
grep -c command_invoked data/audit.log                    # 호출 수
grep -c create_succeeded data/audit.log                   # 생성 성공 (채택률 분자)
grep -c candidates_shown data/audit.log                   # 후보 제시 (채택률 분모)
grep -c revalidation_conflict data/audit.log              # 재검증이 잡은 선점
grep candidates_empty data/audit.log | grep -oE '"reason":"[^"]*"' | sort | uniq -c   # 실패 사유 분포
```

## v1에서 안 만드는 것

봇 외부에서 만들어진 회의의 수정·삭제, 자연어 입력(요청 스키마 앞에 파서 한 층만 얹으면 되는 구조로 경계만 유지), 참석자와의 자동 협상, 선호 학습, 사외 참석자, 정기 회의.
