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
related_code: [streamManager.ts#createStreamManager, registry.ts#createDeviceRegistry, ipc.ts#AppSnapshot, useAppState.ts#targetSerial, App.tsx]
tags: [adr, streaming, multi-screen]
---

# ADR-0017: 화면 칸을 MCP 대상과 분리하고 칸마다 세션 관리자를 둔다

> 상태·날짜·결정자·대체 관계는 위 frontmatter가 단일 출처. 본문은 결정 내용에 집중한다.

## 맥락

앱은 화면이 하나라는 전제로 만들어졌다. `streamManager.ts`의 `createStreamManager`는 세션 하나만 들고,
renderer `App.tsx`는 `targetSerial(snapshot)` 하나로 화면 하나를 그린다. "화면에 보이는 기기"가
"MCP 툴의 대상"에서 파생된다.

Android와 iOS 화면을 나란히 보려면 이 전제를 깨야 한다. 깨는 방법을 고를 때의 기준은 구현의 쉬움이 아니라
확장성(칸 수와 배정 규칙이 바뀔 때 고칠 곳)과 안정성(한 화면의 실패가 번지는 범위)이다.

## 결정

화면 표시를 **칸(screen slot)**이라는 독립된 개념으로 올리고, 세 가지를 따로 둔다.

- **세션 기계** — 칸 하나의 스트림 수명. `createStreamManager`를 고치지 않고 칸마다 인스턴스 하나를 만든다.
- **배정 규칙** — 어느 기기가 어느 칸에 가는가. `screenSlots.ts`가 받는 함수(`SlotPolicy`) 하나다.
  지금 규칙은 플랫폼당 한 칸(`platformSlotPolicy`)이다.
- **MCP 대상** — `registry.ts`가 드는 명시적 선택. `AppSnapshot.activeSerial`의 이름과 뜻을 그대로 둔다.

세부:

- 칸 id는 불투명한 문자열이다. 세션 기계와 renderer는 그 뜻을 읽지 않는다. 플랫폼을 보는 곳은 배정 규칙의
  구현과 조립 지점뿐이다([ADR-0015](0015-platform-difference-surface.md)).
- 칸의 진실은 main에 하나만 있다. `AppSnapshot.screens`로 내려 주고 renderer는 목록을 그린다.
- 대상은 화면 조작으로 바뀌지 않는다. 기기 카드, 화면 머리의 "대상으로", MCP `device_select`만 바꾼다.
- 동시에 여는 칸 수의 상한(`MAX_SCREEN_SLOTS`)을 상수로 두고 조정자가 지킨다.

## 대안

- **관리자 하나가 세션 여러 개를 든다** — `current` 하나를 `Map`으로 바꾼다. 전역 제한을 한곳에서 건다.
  그러나 세션끼리 상태와 가드를 공유해 한 곳의 실수가 모든 세션에 번지고, 검증된 재연결 로직을 다시 써야 해
  Android 경로에 회귀 위험이 생긴다.
  **→ 기각:** 격리를 구조로 얻는 쪽이 안정적이다. 전역 제한은 조정자가 걸면 된다.
- **renderer가 원하는 기기의 스트림을 직접 요청한다** — 칸 개념 없이 가장 유연하다. 그러나 "무엇이 보이는가"의
  진실이 main과 renderer로 갈려 MCP `device_select`와 화면이 어긋날 수 있고, 배정 규칙(플랫폼)을 renderer가
  알아야 해 ADR-0015와 부딪힌다.
  **→ 기각:** 진실을 한곳에 둔다.
- **칸을 플랫폼에 묶는다(플랫폼마다 관리자 하나)** — 지금 요구에는 딱 맞고 가장 단순하다. 그러나 같은 플랫폼
  기기 둘이나 칸 넷으로 갈 때 세션 기계와 renderer까지 고쳐야 한다.
  **→ 기각:** 칸 id를 불투명하게 두면 같은 비용으로 배정 규칙만 바꾸면 된다.
- **사람이 마지막으로 만진 화면이 대상이 된다** — 조작이 편하다. 그러나 에이전트가 일하는 도중 사람이 다른
  화면을 누르면 다음 툴 호출이 엉뚱한 기기로 간다.
  **→ 기각:** 대상은 명시적 조작으로만 바꾼다.
- **모든 MCP 툴에 `serial` 인자를 더한다** — 에이전트가 두 기기를 번갈아 다룬다. 그러나 툴 스키마 전부와
  에이전트 가이드가 바뀐다.
  **→ 지금은 하지 않는다:** `resolve(serial?)`가 이미 serial을 받으므로 이 결정이 막지 않는다.

## 영향

**긍정**

- 기기가 한 대일 때의 코드 경로가 지금과 같다. 세션 기계를 고치지 않았기 때문이다.
- 한 칸의 실패가 다른 칸의 상태에 닿지 않는다.
- 칸 수나 배정 규칙을 바꿀 때 고칠 곳이 `SlotPolicy` 구현과 칸 목록, 상한 상수다.

**트레이드오프**

- 조정자 층이 하나 늘고, 포트 꼬리표(`StreamPortMeta`)에 `slotId`가 붙는다.
- `stopStream`이 `serial`을 받게 바뀌어 preload·renderer 호출부를 함께 고친다.
- 화면 표시와 대상이 갈리므로 "보이는데 대상이 아닌 기기"가 생긴다. 화면 머리의 대상 표시로 알린다.

**위험·방어**

- 칸과 대상이 어긋난 채 남는 경우: `screenSlots.test.ts`와 `bootstrap.test.ts`에서 `selectDevice`·`setTarget`·
  `device_select`·끊김을 각각 검증한다.
- 칸 수 상한 우회: 칸에 보이지 않는 serial의 `open`을 조정자가 거절한다.
- 늦게 온 옛 포트: renderer가 `slotId`와 `serial`이 모두 맞을 때만 포트를 쓴다.
