---
id: ADR-0017
title: 화면 칸을 MCP 대상과 분리하고 칸마다 세션 관리자를 둔다
status: accepted
date: 2026-10-06
deciders: virtual-device-helper 팀
scope: [main, renderer, shared, streaming]
hosts: []
supersedes:
superseded_by:
related_adr: [ADR-0015, ADR-0016, ADR-0010, ADR-0018]
related_spec: m5-multi-screen
related_architecture: main-layers
related_plan:
related_code: [streamManager.ts#createStreamManager, registry.ts#createDeviceRegistry, ipc.ts#AppSnapshot, useAppState.ts#targetSerial, App.tsx#App, streamPort.ts#onStreamPort, ipcBridge.ts#BridgeActions]
tags: [adr, streaming, multi-screen]
---

# ADR-0017: 화면 칸을 MCP 대상과 분리하고 칸마다 세션 관리자를 둔다

> 상태·날짜·결정자·대체 관계는 위 frontmatter가 단일 출처. 본문은 결정 내용에 집중한다.

## 맥락

앱은 화면이 하나라는 전제로 만들어졌다. `streamManager.ts`의 `createStreamManager`는 세션 하나만 들고,
renderer `App.tsx`의 `App`은 `targetSerial(snapshot)` 하나로 화면 하나를 그린다. "화면에 보이는 기기"가
"MCP 대상"에서 파생된다. renderer의 포트 수신(`useScrcpyStream`이 자기 serial이 아닌 포트를 닫는다)과
`stopStream` IPC(인자가 없다)도 같은 전제 위에 있다.

Android와 iOS 화면을 나란히 보려면 이 전제를 깨야 한다. 깨는 방법을 고르는 기준은 구현의 쉬움이 아니라
확장성(칸 수와 배정이 바뀔 때 고칠 곳)과 안정성(한 화면의 실패가 닿는 범위)이다.

## 결정

화면 표시를 **칸(screen slot)**이라는 독립된 개념으로 올리고, 세 가지를 따로 둔다.

- **세션 기계** — 칸 하나의 스트림 수명. `createStreamManager`의 수명·재연결 로직을 고치지 않고 칸마다
  인스턴스 하나를 만든다. 관리자는 칸을 모른다. 포트 꼬리표의 칸과 세대는 조정자가 붙이고, 그 칸의 기기가
  이미 바뀌었으면 포트를 닫는다. 관리자가 바뀌는 곳은 프레임 전달부
  ([ADR-0018](0018-jpeg-frame-ack-flow-control.md))뿐이다.
- **배정** — 어느 기기를 어느 칸에 놓는가. `screenSlots.ts`가 받는 함수 하나(`PlaceFn`)다. 기기, 지금의 점유,
  놓게 된 까닭(`connected`·`selected`·`vacated`)을 받아 칸 id를 준다. 지금의 함수는 플랫폼당 한 칸이다.
- **MCP 대상** — `registry.ts`가 드는 명시적 선택. `AppSnapshot.activeSerial`의 이름과 뜻을 그대로 둔다.

세부:

- 칸 id는 플랫폼 이름이 아닌 중립 값이다. 조정자·세션 기계·renderer는 그 뜻을 읽지 않는다. 플랫폼을 보는
  곳은 조립 지점의 배정 클로저뿐이다([ADR-0015](0015-platform-difference-surface.md)). 칸의 라벨은 칸이
  아니라 놓인 기기에서 나온다.
- 칸의 진실은 main에 하나만 있다. `AppSnapshot.screens`로 내려 주고 renderer는 목록을 그린다.
- 칸마다 세대(`epoch`)를 두고 기기가 놓일 때마다 올린다. renderer는 칸과 세대로 화면을 가리키고
  (`SlotRef`), 낡은 세대의 스트림 요청은 조용히 무시한다.
- **대상은 늘 화면에 보이는 기기다.** 조정자가 `registry`의 `active_changed`를 구독해 그 기기를 칸에 놓는다.
  기기 카드, 화면 머리의 "대상으로", MCP `device_select`가 모두 `registry.setActive` 한 길로 간다.
- 화면을 클릭·타이핑해도 대상은 바뀌지 않는다.
- 조정자는 칸 상태를 먼저 바꾸고 세션 닫기는 그 뒤에 한다. 끊김 뒤의 승계는 빈 칸을 거치지 않는 한 번의
  변화다.
- renderer의 스트림 포트는 라우터 하나가 받아 칸과 세대가 맞는 화면에만 넘긴다.
- 칸 수의 상한을 `limits.ts`의 상수로 둔다.

## 대안

- **관리자 하나가 세션 여러 개를 든다** — `current` 하나를 `Map`으로 바꾼다. 전역 제한을 한곳에서 건다.
  그러나 세션끼리 상태와 가드를 공유해 한 곳의 실수가 모든 세션에 번지고, 검증된 재연결 로직을 다시 써야 해
  Android 경로에 회귀 위험이 생긴다.
  **→ 기각:** 격리를 구조로 얻는 쪽이 안정적이다. 전역 제한은 조정자가 걸면 된다.
- **renderer가 원하는 기기의 스트림을 직접 요청한다** — 칸 개념 없이 가장 유연하다. 그러나 "무엇이 보이는가"의
  진실이 main과 renderer로 갈려 MCP `device_select`와 화면이 어긋날 수 있고, 배정(플랫폼)을 renderer가
  알아야 해 ADR-0015와 부딪힌다.
  **→ 기각:** 진실을 한곳에 둔다.
- **칸을 플랫폼에 묶는다(칸 id가 플랫폼 이름, 배정은 기기→칸의 고정 대응)** — 지금 요구에는 딱 맞고 가장
  단순하다. 그러나 "아무 기기 둘"로 가려면 현재 점유와 사람의 의도가 필요해 배정 함수의 모양부터 바뀌고,
  플랫폼 이름인 칸 id에 renderer와 테스트가 기대기 쉽다.
  **→ 기각:** 배정 함수가 점유와 까닭을 받게 지금 넓혀 두면 같은 비용으로 함수만 바꾸면 된다.
- **serial로 스트림을 요청한다(세대 없음)** — IPC가 지금과 가깝다. 그러나 같은 기기가 빠르게 내려갔다
  올라오면 renderer가 변화를 보지 못해 화면이 얼어붙고, 내려가는 도중의 요청이 에러로 보인다.
  **→ 기각:** 칸과 세대로 가리킨다.
- **사람이 마지막으로 만진 화면이 대상이 된다** — 조작이 편하다. 그러나 에이전트가 일하는 도중 사람이 다른
  화면을 누르면 `serial`을 생략한 다음 툴 호출이 엉뚱한 기기로 간다.
  **→ 기각:** 대상은 명시적 조작으로만 바꾼다.
- **대상만 바꾸는 IPC를 따로 둔다(대상과 표시를 완전히 독립시킨다)** — "대상은 두고 다른 기기를 보기만 하기"가
  된다. 그러나 "보이지 않는 기기가 대상"인 상태가 생기고, mcp 층의 `device_select`가 화면을 알아야 칸을
  따라 바꿀 수 있다.
  **→ 기각:** 대상은 늘 보이는 기기라는 불변식이 어긋날 상태를 없앤다.

MCP 툴은 지금도 호출마다 `serial`을 받는다. 이 결정은 그 인터페이스를 바꾸지 않으며, 대상은 `serial`을
생략한 호출에만 쓰인다.

## 영향

**긍정**

- 세션 수명·재연결 로직을 고치지 않으므로 기기 한 대일 때의 그 경로가 지금과 같다.
- 한 칸의 실패가 다른 칸의 상태에 닿지 않는다.
- 칸 수나 배정을 바꿀 때 고칠 곳이 배정 함수, 칸 목록, 상한 상수, 화면 열 배치다.

**트레이드오프**

- 조정자 층과 renderer 포트 라우터가 늘고, 포트 꼬리표(`StreamPortMeta`)에 `slotId`와 `epoch`가 붙는다.
- `startStream`·`stopStream`이 `SlotRef`를 받게 바뀌어 `ipcBridge.ts`·preload·renderer 호출부를 함께 고친다.
- 대상은 두고 다른 기기를 보기만 할 수는 없다.
- 격리는 상태의 격리다. renderer 스레드와 main 이벤트 루프는 칸들이 함께 쓴다.

**위험·방어**

- 칸과 대상이 어긋난 채 남는 경우: `screenSlots.test.ts`와 `bootstrap.test.ts`에서 기기 카드·`device_select`·
  끊김·처음부터 붙어 있던 기기를 각각 검증한다.
- 칸 수 상한 우회: 칸과 세대가 맞지 않는 요청은 열지 않는다.
- 화면끼리 포트를 닫는 경우: 포트를 닫는 곳은 라우터뿐이고, 구독자 둘인 상태의 테스트로 고정한다.
- 죽은 기기의 세션 닫기가 오래 걸리는 경우: 칸 상태 변경과 알림을 닫기보다 먼저 한다.
