---
id: main-layers
title: main 프로세스 층 구조
status: living                  # living | superseded | deprecated
verified: 2026-09-28
scope: [main, mcp, android, streaming]
hosts: []                       # windows | macos — 호스트 OS마다 구조가 갈릴 때만 채운다
related_adr: [ADR-0005, ADR-0001, ADR-0010, ADR-0013]
related_spec: [m1-device-core-mcp-server, m2-live-streaming, m3-node-control-logs-events]
related_architecture:
related_plan:
related_code: [adbClient.ts#createAdbClient, androidDevice.ts#createAndroidDevice, registry.ts#createDeviceRegistry, registerTools.ts#registerTools, httpServer.ts#startMcpHttpServer, ipcBridge.ts#registerIpcBridge, appState.ts#createAppState, streamManager.ts#createStreamManager, bootstrap.ts#bootstrapApp, layering.test.ts]
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
| adb 경계 | `src/main/adb/` · `adbClient.ts#createAdbClient` | adb 바이너리 실행, `exec`(일회성)과 `stream`(장시간) | adb 문법 |
| 기기 구현 | `src/main/device/` · `androidDevice.ts#createAndroidDevice` | adb 출력에 의미를 붙여 `Device`를 구현한다. 출력 파싱은 `device/parsers/`에 둔다 | Android 도메인 |
| 기기 관리 | `src/main/device/` · `registry.ts#createDeviceRegistry` | 연결된 기기와 활성 기기, 기기별 직렬 실행(`run`) | `Device` 인터페이스 |
| MCP 툴 | `src/main/mcp/` · `registerTools.ts#registerTools`, `runTool.ts#runTool` | 툴 정의, 응답 크기 제어, 호출 기록 | MCP 규격 |
| MCP 전송 | `src/main/mcp/` · `httpServer.ts#startMcpHttpServer` | Streamable HTTP, 세션, 인증. 근거는 [ADR-0001](../adr/0001-mcp-transport-http-in-app.md) | HTTP |
| 앱 상태 · IPC | `src/main/app/` · `appState.ts#createAppState`, `ipcBridge.ts#registerIpcBridge` | renderer로 상태·이벤트 전달, renderer 요청 처리 | Electron IPC |

**위층은 바로 아래층만 부른다.** MCP 툴 층은 `adbClient`나 `androidDevice`를 직접 import하지 않는다.
`src/main/mcp/layering.test.ts`가 이 규칙을 import 검사로 지킨다. M4에서 iOS 구현이 들어와도 MCP 툴 층이
바뀌지 않게 하려는 장치다.

## 옆으로 붙는 파이프라인

층 구조 옆에 기기 하나에 붙어 계속 흐르는 파이프라인이 있다. 이 파이프라인들은 adb 경계와 기기 관리 층을
쓰고, renderer와는 `app:event`가 아니라 용도별 전용 포트로 이야기한다.

| 파이프라인 | 디렉토리 · 진입 심볼 | 전용 포트 | 근거 |
|---|---|---|---|
| 화면 스트림 | `src/main/stream/` · `streamManager.ts#createStreamManager` | `app:stream-port` | [ADR-0010](../adr/0010-stream-transport-message-port.md) |

파이프라인 매니저는 기기 관리 층의 이벤트로 수명을 정한다. 포트는 전달만 맡는다. 포트 채널은 용도가
정해진 것만 추가한다. 근거는 [ADR-0013](../adr/0013-log-transport-dedicated-port.md).

## 조립

`src/main/index.ts`가 실제 구현체를 만들어 `bootstrap.ts#bootstrapApp`에 주입한다. `bootstrapApp`은 SDK를
찾고, 기기 관리 층·앱 상태·파이프라인 매니저·MCP 서버를 순서대로 연결한다. SDK를 못 찾으면 기기 관리 층 없이
SDK 안내 상태로 뜬다.

주입 구조라서 테스트는 `adbClient`만 가짜로 바꾸면 그 위층 전부를 실기기 없이 덮는다. 실기기가 필요한
테스트는 `*.integration.test.ts`로 이름을 나눈다.
