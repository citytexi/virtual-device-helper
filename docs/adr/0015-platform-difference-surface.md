---
id: ADR-0015
title: 플랫폼 차이는 platform 필드와 unsupported 에러로 드러낸다
status: accepted
date: 2026-09-29
deciders: virtual-device-helper 팀
scope: [main, mcp, renderer, shared, android, ios]
hosts: []
supersedes:
superseded_by:
related_adr: [ADR-0005, ADR-0011, ADR-0016]
related_spec: m4-ios-simulator
related_architecture: main-layers
related_plan:
related_code: [device.ts#Device, device.ts#DeviceInfo, device.ts#UiNode, errors.ts#ToolErrorKind, nodeRefs.ts, stream.ts#StreamDown]
tags: [adr, device, platform]
---

# ADR-0015: 플랫폼 차이는 platform 필드와 unsupported 에러로 드러낸다

## 맥락

[ADR-0005](0005-device-interface-abstraction.md)는 `Device` 인터페이스를 좁게 긋고 iOS를 붙일 때
실제 차이를 보고 넓히기로 했다. M4에서 구현체가 둘이 되며 드러난 차이는 이렇다.

- 식별자: Android는 adb serial, iOS는 UDID다.
- `DeviceInfo.apiLevel`은 Android에만 있다.
- iOS에는 back 키가 없고, `launch`의 activity 개념도 없다.
- `nodeRefs.ts`가 편집 가능한 노드를 `className`이 `EditText`로 끝나는지로 가려낸다.

이 차이를 위층에 어떻게 보일지 정해야 한다.

## 결정

차이는 **데이터와 에러로** 드러낸다. 위층은 플랫폼 이름으로 분기하지 않는다.

- `serial` 이름을 유지한다. iOS에서는 UDID를 담는다.
- `Device.platform`과 `DeviceInfo.platform`(`'android' | 'ios'`)을 더한다. 표시와 기록에만 쓴다.
- `DeviceInfo.apiLevel`을 `osVersion: string`으로 바꾼다.
- 할 수 없는 동작은 `ToolErrorKind`의 `unsupported`로 알린다. 조용히 무시하지 않는다.
- 능력 조회 API(`capabilities()`)는 만들지 않는다.
- 편집 가능 여부는 `UiNode.editable`로 파서가 채운다. `nodeRefs.ts`는 이 필드만 본다.
- 사람 UI가 미리 알아야 하는 키 목록은 스트림 세션의 `session.keys`로 준다
  ([ADR-0016](0016-stream-codec-per-session.md)).

## 대안

- **`serial`을 `id`로 이름 변경** — 의미가 정확하다.
  **→ 기각:** registry·MCP 툴·IPC·renderer를 모두 고치는데 동작은 같다. 주석으로 충분하다.
- **`capabilities()` 조회 API** — 에이전트가 호출 전에 가능 여부를 안다.
  **→ 기각:** 차이가 몇 개뿐이다. 호출해서 `unsupported`를 받는 것으로 충분하고, 조회 결과와
  실제 동작이 어긋날 곳이 하나 느는 것이 더 나쁘다.
- **위층에서 `platform`으로 분기** — 가장 빠르다.
  **→ 기각:** ADR-0005가 막은 방식이다. 플랫폼이 늘 때마다 위층이 바뀐다.

## 영향

**긍정**

- mcp 층과 renderer가 플랫폼을 모른 채 두 구현을 다룬다.
- `nodeRefs.ts`에서 Android 클래스 이름 의존이 사라진다.

**트레이드오프**

- 에이전트는 iOS에서 back을 눌러 보고서야 안 된다는 것을 안다. 에이전트 가이드
  (`agentGuide.ts`)에 차이를 적어 줄인다.
- `serial`이라는 이름이 iOS에서는 조금 어색하다.

**위험·방어**

- 누군가 위층에서 `platform`으로 분기하기 시작할 수 있다. renderer는 기기 패널의 라벨로만
  `platform`을 읽는다. 분기는 코드 리뷰로 막는다. import 방향은 `layering.test.ts`가 막는다.
