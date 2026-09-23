---
id: m1-acceptance-log
title: M1 완료 조건 검증 기록
status: in-progress
type: handoff
created: 2026-09-23
updated: 2026-09-23
owner: virtual-device-helper 팀
scope: [main, mcp, android, renderer]
hosts: [macos]
archived_reason:
related_adr: [ADR-0001, ADR-0004]
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan: [m1-5-integration-verification]
related_code:
tags: [plan, m1, verification]
---

# M1 완료 조건 검증 기록

M1-5 Task 2·3의 관찰 기록이다. Task 4에서 스펙의 "검증 결과"로 옮긴 뒤 이 파일을 지운다.
관찰한 것만 적는다. 안 해 본 것은 안 해 봤다고 적는다.

> 파일명은 계획 본문의 `m1-acceptance-log.md` 대신 `docs.py lint`의 파일명 규약
> (`YYYY-MM-DD-<slug>.md`)을 따랐다.

검증 날짜: 2026-09-23
에뮬레이터: Pixel_7_API_36, API 36 (`emulator-5554`, `sdk_gphone64_arm64`, 1080x2400)
클라이언트: Claude Code 2.1.280, `claude -p`에 이 앱의 MCP 설정만 준 상태(`--strict-mcp-config`)
앱: `npm run dev`로 띄웠다. `lsof`로 보면 Electron은 `127.0.0.1:9321`에서만 듣는다.

## 에이전트 경로

지시문 (계획의 문구를 그대로 썼다):

> 이 APK를 설치하고 켜서, 첫 화면에서 텍스트 입력 칸 하나에 `test@example.com`을 넣고,
> 화면을 찍어서 보여주고, 에러 로그가 있으면 알려줘.
> APK 경로: `<다른 프로젝트의 APK 절대 경로>`

APK는 다른 프로젝트의 앱(`com.teamyg.parfait`)이다.

### 실행 1 — `app_install`에서 멈춤

MCP가 붙었고 스펙 표의 툴이 전부 목록에 보였다. 호출 순서는
`device_list` → `device_select emulator-5554` → `app_install reinstall:true`였다.

`app_install`이 `kind: command_failed`로 실패했다. stderr는 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`
(기기에 이미 있던 `com.teamyg.parfait`가 다른 키로 서명돼 있었다). 힌트는 "첨부된 stderr를
확인해라"라는 일반 문구였고, 에이전트는 stderr를 직접 읽어 원인을 짚었다. 제거하면 데이터가
지워지므로 에이전트는 거기서 멈추고 사람에게 물었다. 사람 개입 없이 끝까지 간 실행이 아니다.

사용자가 제거를 승인했고, 컨트롤러가 `emulator-5554`에서 `com.teamyg.parfait.test`와
`com.teamyg.parfait`를 `adb uninstall`로 지웠다.

- 분류: 3번(툴 자체가 실패했다)에 가깝다 — 실패 원인은 맞게 전달됐지만 복구 경로가 힌트에 없었다.
- 수정: `b38b1db` — `androidDevice.ts`의 `rethrowInstallFailure`가 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`·
  `INSTALL_FAILED_VERSION_DOWNGRADE`를 읽어, `kind: command_failed`는 유지한 채 구체적인 한국어
  메시지, `app_uninstall` 뒤 재설치하라는 힌트(데이터가 지워진다는 경고 포함), `details.reason`을 붙인다.
  `ToolErrorKind`는 늘리지 않았다(ADR-0004의 공개 인터페이스).

### 실행 2 — `app_launch` 실패, 에이전트가 스스로 우회

깨끗한 에뮬레이터에서 같은 지시문으로 다시 돌렸다.

- `device_list` → `app_install reinstall:true` 성공, `{pkg: com.teamyg.parfait}`
  (`-r`이어도 새 설치라 패키지명이 특정됐다) → `log_clear`
- `app_launch`가 `command_failed`로 실패했다. 당시 구현은 `monkey -p ... -c LAUNCHER 1`이었고,
  이 API 36 에뮬레이터에서 `** SYS_KEYS has no physical keys but with factor 2.0%.`와 함께 exit 251로
  끝났다. 컨트롤러가 손으로 재현했고, 같은 기기에서
  `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER com.teamyg.parfait`는
  `com.teamyg.parfait/.MainActivity`를 돌려줬다.
- 에이전트는 스스로 복구했다. 홈 화면에서 `ui_find` → Parfait 아이콘 좌표로 `ui_tap` → `ui_find`
  (스플래시) → `screenshot` → `log_read`(filter `AndroidRuntime`) → `ui_find` → `screenshot` →
  `log_read`(filter `parfait`, limit 300).
- `ui_text`는 부르지 않았다. 이 앱의 첫 화면은 온보딩과 "카카오 로그인" 버튼뿐이라 텍스트 입력
  칸이 없다. 에이전트는 UI 트리를 전부 보고 `EditText`가 없다고 판단했고, 외부 로그인 버튼은 누르지 않았다.
- 보고: FATAL·ANR 없음. 로그인 전에 `NotificationRepositoryImpl.registerDeviceToken`의
  `POST /api/v1/notifications/devices`가 401을 반복한다(앱 쪽 문제다).

- 분류: 3번(툴 자체가 실패했다).
- 수정: `60ea4f0` — `androidDevice.ts`의 `resolveLauncherComponent`가 `cmd package resolve-activity`로
  런처 액티비티를 찾아 `am start -n`으로 띄운다. `am start` 출력의 `Error` 줄은 실패로 본다.
  런처 액티비티가 없으면 `activity`를 직접 넘기라는 힌트로 `command_failed`를 낸다. 같은 커밋에서
  설치 후 힌트가 존재하지 않는 툴 `app_list`를 가리키던 문구도 고쳤다.

### 실행 3 — 원래 APK로 사람 개입 없이 끝까지

컨트롤러가 `com.teamyg.parfait`를 다시 지우고 홈 화면으로 돌린 뒤, 수정이 들어간 앱으로 같은 지시문을 줬다.

`device_list` → `device_select` → `app_install`(reinstall, serial) 성공 `pkg: com.teamyg.parfait` →
`log_clear` → `app_launch` 성공 `launched: true` → `ui_find` → `screenshot` → `ui_find` →
`log_read`(filter `parfait`, limit 300) → `log_read`(filter `AndroidRuntime`, limit 50).

사람이 끼어들지 않았다. `ui_text`·`ui_tap`은 부르지 않았다 — 실행 2와 같은 이유(첫 화면에 텍스트
입력 칸이 없다)이고, 에이전트는 외부 로그인을 누르지 않겠다고 보고했다. 보고 내용은 실행 2와 같다
(FATAL·ANR 없음, 로그인 전 401).

### 실행 4 — `ui_text` 대체 검증 (설정 앱)

주어진 APK로는 로그인 전 텍스트 입력 칸이 없어 `ui_find` → `ui_tap` → `ui_text`를 덮을 수 없었다.
그래서 설정 앱의 검색창으로 따로 지시했다. **원래 APK로 이 구간을 검증하지는 못했다.**

`device_list` → `log_clear` → `app_launch com.android.settings` 성공 → `ui_find`(query `search`) →
`ui_tap` → `ui_find`(query `search`) → `ui_tap` → `ui_text test@example.com` 성공 → `screenshot`
(키보드와 함께 "No results for test@example.com"이 보인다) → `log_read`를 여러 번.

이 실행에서 응답 크기 문제가 나왔다(아래 "응답이 너무 커서 문제가 된 툴").

### 완료 조건 툴 표 (실행 3·4 합산)

| 툴 | 불렸나 | 성공했나 | 관찰 |
|---|---|---|---|
| app_install | 예 (실행 3) | 예 | `pkg: com.teamyg.parfait`. 실행 1에서는 서명 충돌로 실패 → `b38b1db` |
| app_launch | 예 (실행 3·4) | 예 | 실행 2에서는 `monkey` exit 251로 실패 → `60ea4f0` |
| ui_find | 예 | 예 | 응답에 XML 없음. 홈 화면 약 6.8KB, 스플래시 약 0.3KB, 온보딩 약 1.2KB, `query`를 준 호출 0.6–3KB |
| ui_tap | 예 (실행 4) | 예 | 실행 3에서는 원래 APK에 입력 칸이 없어 불리지 않았다 |
| ui_text | 예 (실행 4) | 예 | 설정 검색창. 원래 APK로는 검증하지 못했다 |
| screenshot | 예 | 예 | 이미지가 클라이언트에 인라인으로 들어갔다(base64 약 14.7KB·약 50KB) |
| log_read | 예 | 예 (실행 4에서 크기 문제 → `ece1be9`·`eff1106`) | 아래 "응답이 너무 커서" 참고 |

- 사람이 끼어들지 않고 끝까지 갔나: 실행 3·4는 예. 실행 1은 아니오(설치 충돌에서 사람에게 물었다).
- 끝까지 못 갔다면 어디서 멈췄나: 실행 1은 `app_install`. 실행 2는 `app_launch`가 실패했지만 에이전트가
  `ui_tap`으로 우회해 끝까지 갔다.
- 에이전트가 잘못 고른 툴이 있었나: 관찰하지 못했다. 실패는 모두 툴 자체의 실패였다.
- 응답이 너무 커서 문제가 된 툴이 있었나: 예, `log_read`. 실행 4에서 `log_read`(filter `"E "`, limit 200)와
  `log_read`(filter `com.android.settings`, 기본 limit)가 각각 약 56KB였고, Claude Code 2.1.280은 인라인을
  거부했다("Output too large (56.2KB). Full output saved to ..."). 에이전트는 이를 후처리하려고 승인이
  필요한 Bash 명령을 시도했고 실행되지 않았다. 에이전트는 레벨 필터도 원했다(`filter`는 태그·메시지
  텍스트에만 걸린다). 한 줄마다 키 이름을 다시 쓰는 2칸 들여쓰기 JSON이 크기를 부풀렸다.
  실행 3의 `log_read`(limit 300) 약 23KB는 인라인으로 들어갔다.
  - 분류: 2번(응답이 너무 커서 에이전트가 무너졌다).
  - 수정: `ece1be9` — `observe.ts`의 `formatLogLine`이 줄마다 `MM-DD HH:MM:SS.mmm L tag(pid): message`
    한 문자열로 줄이고, 응답 JSON은 들여쓰지 않는다. 메시지는 `LOG_MESSAGE_MAX_CODEPOINTS`에서 자르고
    `…(+N자)`로 표시한다. 기본·상한 줄 수(`LOG_READ_DEFAULT_LIMIT`·`LOG_READ_MAX_LIMIT`)를 낮췄다.
    `eff1106` — 직렬화한 응답 전체가 `LOG_READ_RESPONSE_BUDGET_CHARS`를 넘으면 가장 오래된 줄부터
    더 버리고 그만큼 `truncated`·`droppedCount`에 반영한다. 메시지 자르기는 코드포인트 단위다.
    툴 이름·인자는 그대로다.
- 앱의 활동 탭에 호출이 순서대로 쌓였나: 예. 사람이 본 화면에서 실행 1·2의 호출이 전부 최신순으로
  시각·툴·인자·소요 시간·성공/실패와 함께 보였고, 두 실패(실행 1의 `app_install`, 실행 2의 `app_launch`)는
  `command_failed`와 함께 빨간색으로 표시됐다. 순서는 에이전트 기록과 일치했다. 실행 3·4의 활동 탭 순서는
  따로 확인하지 않았다.

## 사람 경로

사용자가 앱 화면에서 직접 봤다.

**첫 확인 (최소 CSS 전).**

- AVD 목록: 로컬 AVD가 전부 보였다. Pixel_7_API_36 행에는 `emulator-5554`와 종료 버튼, 나머지 행에는 부팅 버튼.
- 스크린샷: 홈 화면이 떴다. 새로고침 버튼이 있다. 새로고침을 눌러 갱신되는지는 따로 기록하지 않았다.
- 엔드포인트 카드: URL과 버튼들이 보이고, 설정 JSON 복사를 누르면 "복사했다"가 뜬다.
- 활동 탭: 호출 전에는 빈 목록 안내가 보였다.
- 결함: 스타일이 없었다. 왼쪽/오른쪽 2단이 아니라 작업 영역이 엔드포인트 카드 아래에 붙었고,
  활성 기기 표시가 눈에 보이지 않았다. 사용자: "디자인이 안 예쁘긴 하네".
  - 수정: `97cca64` — 최소 CSS로 2단 구성과 활성 기기 표시만 넣었다. 디자인 작업은 하지 않았다.

**두 번째 확인 (`97cca64` 뒤, HMR로 반영).**

- 2단 구성이 된다(왼쪽 기기와 화면, 오른쪽 활동). 다크 모드가 시스템 설정을 따른다.
  활성 행에 "(대상)"과 왼쪽 테두리가 붙는다.
- 결함: 활동 행의 필드가 띄어쓰기 없이 붙어 보였다("10시 39분 54초log_read{...}27ms성공").
  기기 행이 줄 바꿈되면서 serial이 "emulator-" / "5554"로 갈리고 부팅 버튼이 다음 줄로 떨어졌다.
  - 수정: `b375082` (CSS만). 사용자가 이 수정을 명시적으로 확인하지는 않았다.

**재시작 뒤.**

- 부팅·종료: Pixel_7_API_36을 앱에서 종료했다가 다시 부팅하니 상태와 화면이 바뀌었다
  ("상태와 화면 바뀌는거 확인했어").
- 설정 JSON: 복사한 JSON을 그대로 외부 에이전트(`claude -p`) 설정으로 썼고 연결됐다.
- 기기를 바꾸면 화면도 바뀌나: 에뮬레이터가 한 대뿐이라 확인하지 못했다.
- SDK를 못 찾을 때의 안내 화면: 안 해 봤다.

## 실패 경로

에뮬레이터 `emulator-5554` 한 대만 띄운 상태에서 확인했다(실행 5·7·8). 에뮬레이터 두 대를 띄운
상태는 만들지 않았다 — 계획대로 존재하지 않는 serial로 대신했다.

| 상황 | 기대 kind | 실제 kind | 힌트가 다음 행동을 말했나 | 에이전트가 복구했나 |
|---|---|---|---|---|
| 기기 없음 (`adb emu kill` 뒤 `screenshot`) | no_device | no_device, "연결된 기기가 없다" | 예 — "device_list로 AVD를 확인하고 device_boot로 부팅해라" | 부분 — `device_list`까지 부르고, AVD가 여럿이라 어느 것을 부팅할지 사람에게 물었다. 스스로 고르지 않았다 |
| 없는 serial (`device_info` serial `emulator-9999`) | no_device | no_device, "그런 기기가 없다: emulator-9999", `details.candidates` `["emulator-5554"]` | 예 — "device_list로 현재 연결된 기기를 확인해라" | 예 — `device_list` 뒤 `device_info emulator-5554` 성공(`sdk_gphone64_arm64`, API 36, 1080x2400) |
| 없는 패키지 (`app_launch com.example.does.not.exist`) | package_not_found | package_not_found | 예 — "app_install로 먼저 설치해라" | 해당 없음 — 설치할 APK가 없으니 복구하지 않은 것이 맞다 |
| 잘못된 APK 경로 (`app_install /tmp/nope.apk`) | apk_path_invalid | apk_path_invalid | 예 — "경로를 확인해라. 상대 경로면 절대 경로로 바꿔라" | 해당 없음 — 올바른 경로가 없다 |

기기 없음의 후속(실행 8): 지시문에 AVD 이름을 주자("Pixel_7_API_36 을 부팅하고 ... 찍어줘")
`device_boot avd Pixel_7_API_36`이 기기 정보(`emulator-5554`, API 36, 1080x2400)를 돌려줬고, 이어
`screenshot serial emulator-5554`가 완성된 홈 화면을 돌려줬다(324x720 PNG, base64 약 213KB, 인라인으로
들어갔다). 에뮬레이터 quickboot 스냅샷 덕에 실행 전체가 18초였다. 부팅 직후 설치(패키지 매니저 준비)는
안 해 봤다.

기기가 둘인데 `serial`을 빼는 경우(후보 목록 에러)는 에뮬레이터 두 대를 띄우지 않아 관찰하지 못했다.

## 응답 상한

| 툴 | 요청 | 실제 반환량 | truncated |
|---|---|---|---|
| log_read (수정 전) | limit 999999 | MCP 입력 스키마가 거부: "MCP error -32602: Input validation error: ... Too big: expected number to be <=2000 at limit". `kind`·`hint`는 없지만 메시지가 상한을 말한다 | — |
| log_read (수정 전) | 위 거부 뒤 에이전트가 limit 2000으로 재시도 | 2000줄, 457,731자 / 14,006줄의 들여쓴 JSON. Claude Code가 인라인을 거부했다("exceeds maximum allowed tokens", 파일로 저장) | true, `droppedCount` 2430 |
| log_read (`ece1be9`·`eff1106` 뒤, 실행 6) | limit 200 | 159줄(총량 예산에서 더 잘렸다), 약 20.3KB. 인라인으로 들어갔다 | true, `droppedCount` 5485 |
| log_read (`ece1be9`·`eff1106` 뒤, 실행 6) | 기본 limit | 100줄, 약 12.2KB. 인라인으로 들어갔다. 한 줄이 "…(+44자)"로 잘렸다 | — (`droppedCount`는 두 호출 사이에 서로 맞았다) |
| ui_find | 긴 목록 화면(검색 화면으로 열린 설정 앱, `query` 없음) | 21개 노드. XML 없음 | false — 60개 상한(`UI_FIND_MAX_NODES`)에 닿는 화면을 만나지 못해 상한 동작은 관찰하지 못했다 |

## 보안

`curl`로 직접 찔렀다. 앱을 재시작해 토큰이 바뀐 뒤에도 `127.0.0.1:9321`에만 열려 있었다.

| 검사 | 기대 | 실제 |
|---|---|---|
| 토큰 없음 | 401 | 401 |
| 틀린 토큰 | 401 | 401 |
| 틀린 토큰 + `Origin: https://evil.example` | 403 | 403 (`Origin` 검사가 토큰 검사보다 먼저다) |
| 올바른 토큰 + `Origin` 헤더 | 403 | 403 |
| LAN 주소 접속 (`192.168.0.28:9321`) | 연결 실패 | 연결 실패 (curl code 000) |
| 루프백 바인드 | `127.0.0.1`만 | `lsof`로 `127.0.0.1:9321`만 |

대조로, 올바른 토큰으로 `initialize`를 보내면 200과 `serverInfo` `virtual-device-helper`가 왔다.

## 종료 결함

사용자가 Electron 창이 두 개인 것을 알아챘다. 컨트롤러의 재시작(`pkill -f "electron-vite dev"` 뒤
`pkill -f ".../node_modules/electron"`)에서 살아남은 이전 인스턴스였다. 부모가 1인 고아 프로세스였고,
MCP 서버는 닫혀 9321에서 듣지 않았지만 프로세스는 살아 있었다. 첫 `pkill`이 닿았는지는 알 수 없다.

재현: 앱의 Electron main에 SIGTERM 한 번을 보내면 MCP 서버는 닫히지만 프로세스가 끝나지 않았다
(dev와 빌드한 `out/main` 둘 다). 계측한 빌드에서는 `before-quit`, 1ms 뒤 `before-quit`,
`window-all-closed`까지만 오고 `will-quit`·`quit`은 오지 않았다. 최소 Electron 재현에서
`before-quit`에서 `preventDefault`한 뒤 같은 틱의 마이크로태스크(`Promise.resolve`)에서 `app.quit()`을
다시 부르면 SIGTERM에서 멈췄고, `setImmediate`·`setTimeout 0`·200ms 지연이면 끝났다. `app.quit()`으로
시작한 종료(Cmd+Q)는 즉시 다시 불러도 끝났다.

- 수정: `c62dec0` — `src/main/index.ts`의 `before-quit`이 `stop`이 끝난 뒤 재종료를 `setImmediate`로 미룬다.
- 확인: 빌드한 앱에 SIGTERM 한 번 → `before-quit` 두 번 → `will-quit` → 프로세스 exit 0 → `quit`.
- 남은 것: `stop()` 자체에 시간 제한은 없다. `stop`이 끝나지 않으면 종료도 끝나지 않는다(관찰한 적은 없다).

## 실행하지 않은 것

아래는 어느 에이전트 실행에서도 불리지 않았다.

- `app_reset_and_launch` — 첫 화면 안정 판정(`app.ts`의 `waitForSettle`)을 실제 앱으로 돌려 보지 않았다.
- `ui_swipe`, `ui_key`, `app_stop`, `app_clear_data`, `app_grant_permission`, `app_uninstall`
- MCP를 통한 `device_shutdown` (사람 경로의 종료 버튼으로는 해 봤다)
- `ui_find` 60개 상한
