---
id: main-layers
title: main 프로세스 층 구조
status: living                  # living | superseded | deprecated
verified: 2026-09-30
scope: [main, mcp, android, ios, streaming]
hosts: []                       # windows | macos — 호스트 OS마다 구조가 갈릴 때만 채운다
related_adr: [ADR-0005, ADR-0001, ADR-0010, ADR-0013]
related_spec: [m1-device-core-mcp-server, m2-live-streaming, m3-node-control-logs-events, m4-ios-simulator]
related_architecture:
related_plan:
related_code: [processClient.ts#createProcessClient, adbClient.ts#createAdbClient, simctlClient.ts#createSimctlClient, axeClient.ts#createAxeClient, locateAxe.ts#locateAxe, androidDevice.ts#createAndroidDevice, iosDevice.ts#createIosDevice, trackSimulators.ts#trackSimulators, platformLogDeps.ts#createPlatformLogDeps, registry.ts#createDeviceRegistry, registerTools.ts#registerTools, httpServer.ts#startMcpHttpServer, ipcBridge.ts#registerIpcBridge, appState.ts#createAppState, streamManager.ts#createStreamManager, logManager.ts#createLogManager, bootstrap.ts#bootstrapApp, layering.test.ts]
tags: [architecture, main, layers]
---

# main 프로세스 층 구조

> 상시 갱신되는 구현 가이드("어떻게 / 어디"). 결정 근거(why)는 `../adr/`, 구현 직전 설계(what)는
> `../superpowers/specs/`에 있다.
>
> 근거는 파일명 + 심볼명으로만 적는다. 라인번호·모듈 개수 같은 변동 수치는 적지 않는다
> (규칙 상세: [`../adr/README.md`](../adr/README.md)).

## 층

main 프로세스는 아래에서 위로 쌓인다. 타깃 디바이스를 가르는 경계는 `Device` 인터페이스다.
근거는 [ADR-0005](../adr/0005-device-interface-abstraction.md).

| 층 | 디렉토리 · 진입 심볼 | 책임 | 아는 것 |
|---|---|---|---|
| 프로세스 경계 | `src/main/process/` · `processClient.ts#createProcessClient` | 외부 바이너리 실행의 공통부(`exec`, `stream`, stderr 꼬리, 제한 시간). 도구마다 실패 분류만 주입한다 | 프로세스 실행 |
| adb 경계 | `src/main/adb/` · `adbClient.ts#createAdbClient` | adb 바이너리 실행, `exec`(일회성)과 `stream`(장시간). `processClient` 위에 선다 | adb 문법 |
| simctl 경계 | `src/main/ios/` · `simctlClient.ts#createSimctlClient` | `xcrun simctl` 실행과 iOS 도구 실패 분류. `processClient` 위에 선다 | simctl 문법 |
| axe 경계 | `src/main/ios/` · `axeClient.ts#createAxeClient` | AXe 바이너리 실행. 모든 호출 끝에 `--udid <udid>`를 붙인다. 텍스트는 axe에 넘기지 않는다. `iosDevice.ts`의 `inputText`가 `simctl pbcopy` stdin으로 클립보드에 넣고 axe `key-combo`(⌘V)로 붙여 넣으므로, 입력할 때마다 시뮬레이터 클립보드가 덮인다. 실패는 `ios_tool_not_found`·`command_failed`·`device_unresponsive`로 분류한다. `processClient` 위에 선다 | axe 문법 |
| 기기 구현 | `src/main/device/` · `androidDevice.ts#createAndroidDevice`, `iosDevice.ts#createIosDevice` | adb / simctl / axe 출력에 의미를 붙여 `Device`를 구현한다. 출력 파싱은 `device/parsers/`에 둔다(`describe-ui`는 `axeUi.ts#parseAxeUi`). iOS의 입력·노드·화면 크기는 axe를 거치고, axe가 없으면 `ios_tool_not_found`다. iOS에 없는 동작(`back` 키 등)은 `unsupported`로 거절한다 | Android / iOS 도메인 |
| 기기 관리 | `src/main/device/` · `registry.ts#createDeviceRegistry` | 연결된 기기와 활성 기기, 기기별 직렬 실행(`run`), 부팅 직후 등록 대기(`waitFor`). 기기 추적은 adb 쪽 `trackDevices`와 simctl 폴링 `ios/trackSimulators.ts#trackSimulators`가 같은 `onChange`로 합류한다 | `Device` 인터페이스 |
| MCP 툴 | `src/main/mcp/` · `registerTools.ts#registerTools`, `runTool.ts#runTool` | 툴 정의, 응답 크기 제어, 호출 기록 | MCP 규격 |
| MCP 전송 | `src/main/mcp/` · `httpServer.ts#startMcpHttpServer` | Streamable HTTP, 세션, 인증. 근거는 [ADR-0001](../adr/0001-mcp-transport-http-in-app.md) | HTTP |
| 앱 상태 · IPC | `src/main/app/` · `appState.ts#createAppState`, `ipcBridge.ts#registerIpcBridge` | renderer로 상태·이벤트 전달, renderer 요청 처리 | Electron IPC |

**위층은 바로 아래층만 부른다.** MCP 툴 층은 `adbClient`나 `androidDevice`를 직접 import하지 않는다.
`src/main/mcp/layering.test.ts`가 이 규칙을 import 검사로 지킨다. iOS 구현(`iosDevice.ts`)이 들어와도 MCP 툴 층이
바뀌지 않게 하려는 장치다.

앱 상태 층은 스냅샷과 나란히 `TimelineEntry` 링을 들고 있다. 툴 호출과 기기·스트림·로그 이벤트를 기록한
순서대로 한 링에 쌓는다(시각으로 다시 정렬하지 않는다). 상한은 `src/shared/limits.ts`의 `TIMELINE_LIMIT`이고,
main의 링과 renderer `reduce`가 같은 값으로 오래된 항목부터 버린다. `appState.ts#createAppState`가 내보내는
`recordToolCall`은 MCP 툴 층이 낸 `ToolCallRecord`를 `tool_call` 항목으로 감싸고, `recordDeviceEvent`는 기기
관리 층의 연결·해제·활성 전환과 옆으로 붙는 파이프라인의 상태 변화를 `device` 항목으로 쌓는다. 파이프라인
쪽은 `streamManager`의 `onState`와 `logManager`의 `onTailState` 훅으로 이어지는데, 두 훅 모두
`bootstrap.ts#bootstrapApp`이 각 매니저 팩토리에 넘겨 앱 상태 층의 `recordDeviceEvent`로 연결한다. 링에
항목이 쌓일 때마다 앱 상태 층은 `timeline` MainEvent 하나로 renderer에 알린다.

## 옆으로 붙는 파이프라인

층 구조 옆에 기기 하나에 붙어 계속 흐르는 파이프라인이 있다. 이 파이프라인들은 adb 경계와 기기 관리 층을
쓰고, renderer와는 `app:event`가 아니라 용도별 전용 포트로 이야기한다.

| 파이프라인 | 디렉토리 · 진입 심볼 | 전용 포트 | 근거 |
|---|---|---|---|
| 화면 스트림 | `src/main/stream/` · `streamManager.ts#createStreamManager` | `app:stream-port` | [ADR-0010](../adr/0010-stream-transport-message-port.md) |
| 로그 | `src/main/logs/` · `logManager.ts#createLogManager` | `app:log-port` | [ADR-0013](../adr/0013-log-transport-dedicated-port.md) |

파이프라인 매니저는 기기 관리 층의 이벤트로 수명을 정한다. preload는 범용 포트 통로를 만들지 않는다.

**로그는 플랫폼 라우터를 거친다.** `logManager`는 tail·pid 조회 의존성을 하나만 받는다.
`logs/platformLogDeps.ts#createPlatformLogDeps`가 기기의 `platform`을 보고 Android(`logTail.ts`, `adbLogDeps.ts`)와
iOS(`iosLogTail.ts`의 `log stream` tail, `iosLogDeps.ts`)로 나눈다. 준비되지 않은 플랫폼의 기기는 `unsupported`다.
화면 스트림도 같은 방식으로 `createPlatformStreamSession`이 라우팅하고, iOS는 M4-3 전까지 `unsupported`로 거절한다.

## 조립

`src/main/index.ts`가 실제 구현체를 만들어 `bootstrap.ts#bootstrapApp`에 주입한다. `bootstrapApp`은 Android SDK와
iOS 도구(`ios/locateIosTools.ts#locateIosTools`)를 각각 찾고, 준비된 플랫폼만 조립해 기기 관리 층·앱 상태·
파이프라인 매니저·MCP 서버를 순서대로 연결한다. 한 플랫폼만 준비돼도 MCP 서버를 연다. 둘 다 못 찾을
때만 기기 관리 층 없이 안내 상태로 뜬다. 안내에는 플랫폼별 상태(`platforms`)가 담긴다.
AXe는 `index.ts`가 `ios/locateAxe.ts#locateAxe`로 따로 찾는다. 패키징된 앱은 셸 `PATH`를 받지 못하므로 Homebrew
기본 경로를 먼저 보고 그다음 `PATH`를 본다. 못 찾아도 iOS 자체는 조립하고 `IosDevice`에 `axe: null`을 넘긴다.

주입 구조라서 테스트는 `adbClient`만 가짜로 바꾸면 그 위층 전부를 실기기 없이 덮는다. 실기기가 필요한
테스트는 `*.integration.test.ts`로 이름을 나눈다.
