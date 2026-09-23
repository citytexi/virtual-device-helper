---
id: ADR-0010
title: 스트림 전송은 MessageChannelMain 전용 포트로 한다
status: accepted                # proposed | accepted | superseded | deprecated
date: 2026-09-23
deciders: virtual-device-helper 팀   # 팀/역할 (실명·개인정보 금지)
scope: [main, preload, renderer, streaming]
hosts: []                       # windows | macos — 호스트 OS마다 결정이 갈릴 때만 채운다
supersedes:                     # 이 ADR이 대체하는 ADR-NNNN (없으면 비움)
superseded_by:                  # 이 ADR을 대체한 ADR-NNNN (없으면 비움)
related_adr: [ADR-0002]
related_spec: m2-live-streaming
related_architecture:
related_plan:
related_code: [preload/index.ts#api, ipc.ts#IPC_CHANNELS]
tags: [adr, streaming, ipc]
---

# ADR-0010: 스트림 전송은 MessageChannelMain 전용 포트로 한다

> 상태·날짜·결정자·대체 관계는 위 frontmatter가 단일 출처. 본문은 결정 내용에 집중한다.

## 맥락

[ADR-0002](0002-screen-streaming-via-scrcpy-server.md)에 따라 main은 scrcpy 비디오 소켓의 H.264 패킷을
디코딩하지 않고 renderer로 릴레이한다. 사람 입력은 반대 방향으로 흘러 control 소켓에 들어간다.
M1의 IPC는 요청·응답(`ipcMain.handle`)과 단일 이벤트 채널(`app:event`)뿐이라, 계속 흐르는 바이너리와
양방향 입력을 실을 통로가 없다.

기기를 바꾸는 순간 이전 기기의 패킷이 아직 오고 있을 수 있다. 그 패킷이 새 기기의 디코더에 들어가면
화면이 깨진다. 통로는 이 문제를 풀어야 한다.

## 결정

스트림 세션마다 `MessageChannelMain`을 하나 만들고, 그 포트 한쪽을 renderer에 건넨다.

- main은 세션을 열 때 채널을 만들고 `webContents.postMessage('stream:port', meta, [port])`로 보낸다.
- 비디오 패킷, 세션 상태, 사람 입력 의도가 모두 이 포트를 오간다. 패킷의 `ArrayBuffer`는 transfer로 넘긴다.
- 세션을 닫으면 포트도 닫는다. 늦게 도착한 패킷은 닫힌 포트와 함께 사라진다.
- preload는 포트를 main world로 넘기는 이 채널 하나만 연다. 범용 포트 통로는 만들지 않는다.

## 대안

- **기존 IPC에 채널 추가 (`webContents.send` / `ipcRenderer.send`)** — 익숙한 패턴이고 코드가 가장 적다.
  그러나 모든 세션이 같은 채널을 공유하므로, 기기 전환 직후 늦게 온 패킷을 세션 ID로 직접 걸러야 한다.
  `app:event`와 채널 디스패치 경로도 공유하게 된다.
  **→ 기각:** 세션 경계를 코드 규율로 지켜야 한다. 포트 방식은 구조가 대신 지켜 준다.
- **main에 로컬 WebSocket 서버를 열고 renderer가 접속** — 브라우저 표준 API만 쓰고, 나중에 원격 뷰어로
  넓히기 쉽다.
  그러나 포트·토큰·`Origin` 검사를 MCP HTTP 서버와 별도로 하나 더 관리해야 한다.
  **→ 기각:** 보안 표면이 하나 더 생긴다. 원격 뷰어는 지금 요구가 아니다.

## 영향

**긍정**

- 세션 하나에 포트 하나가 대응한다. 세션 수명과 통로 수명이 같아서 전환 시 섞임이 구조적으로 없다.
- 비디오 트래픽이 `app:event`와 분리된다. 기기·툴 호출 이벤트가 패킷에 밀리지 않는다.
- transfer로 넘기므로 패킷마다 복사하지 않는다.

**트레이드오프**

- contextIsolation 환경에서 `MessagePort`는 contextBridge를 못 넘는다. preload가
  `window.postMessage`로 main world에 다시 건네는 한 단계가 더 붙는다.
- 요청·응답과 이벤트 외에 세 번째 IPC 형태가 생긴다.

**위험·방어**

- main world로 넘기는 `window.postMessage`는 같은 창의 다른 스크립트도 받을 수 있다. renderer는 우리 번들만
  싣고 외부 콘텐츠를 싣지 않으므로 받아들인다. 채널 이름이 맞는 메시지만 처리한다.
- renderer에서 올라온 메시지는 main이 타입·필드 모양으로 검증하고, 맞지 않으면 버린다.
