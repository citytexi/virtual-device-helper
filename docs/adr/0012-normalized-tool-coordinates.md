---
id: ADR-0012
title: MCP 툴 좌표는 0..1 정규화 좌표로 한다
status: accepted                # proposed | accepted | superseded | deprecated
date: 2026-09-28
deciders: virtual-device-helper 팀   # 팀/역할 (실명·개인정보 금지)
scope: [main, mcp, renderer, shared, android]
hosts: []                       # windows | macos — 호스트 OS마다 결정이 갈릴 때만 채운다
supersedes:                     # 이 ADR이 대체하는 ADR-NNNN (없으면 비움)
superseded_by:                  # 이 ADR을 대체한 ADR-NNNN (없으면 비움)
related_adr: [ADR-0011, ADR-0004]
related_spec: m3-node-control-logs-events
related_architecture: main-layers
related_plan:
related_code: [ui.ts#registerUiTools, observe.ts#registerObserveTools, ipc.ts#Gesture, GestureOverlay.tsx#GestureOverlay, runTool.ts#runTool]
tags: [adr, mcp, coordinates]
---

# ADR-0012: MCP 툴 좌표는 0..1 정규화 좌표로 한다

> 상태·날짜·결정자·대체 관계는 위 frontmatter가 단일 출처. 본문은 결정 내용에 집중한다.

## 맥락

[ADR-0011](0011-node-ref-revalidation.md)로 에이전트는 주로 ref로 요소를 가리킨다. 그래도 좌표 입력은
남는다. 지도 캔버스나 게임처럼 접근성 트리에 잡히지 않는 화면이 있기 때문이다.

M1의 `ui_tap`·`ui_swipe`는 기기 픽셀을 받는다. 그런데 `screenshot`은 기본으로 축소한 이미지를 준다
(`observe.ts`의 `scale`). 에이전트가 스크린샷을 보고 좌표를 읽으면 축소 비율만큼 어긋난다. 노드가 없는
화면에서는 에이전트가 스크린샷만 보고 좌표를 정해야 한다. 이 경로가 바로 틀린다.

회전도 문제다. `wm size`는 자연 방향 크기만 말한다. 지금 `GestureOverlay.tsx`는 비디오 크기와 `screen`을
비교해 회전을 추정한다.

## 결정

MCP 툴이 주고받는 좌표는 전부 **현재 화면 방향 기준 0..1 정규화 좌표**다.

- `ui_tap`의 `x`, `y`와 `ui_swipe`의 `x1`, `y1`, `x2`, `y2`는 0 이상 1 이하다. 범위 밖은 인자 오류다.
- `ui_find`의 노드 `bounds`도 0..1이다.
- 기준은 **현재 방향의 디스플레이 전체 크기**다. `wm size`의 자연 방향 크기에 회전을 적용해서 구한다.
  덤프 루트 bounds는 기준으로 쓰지 않는다. `uiautomator dump`는 활성 창만 덤프하므로 다이얼로그가 떠 있으면
  루트가 다이얼로그 사각형이 된다.
- 회전은 덤프 경로에서는 덤프 XML의 `<hierarchy rotation>`에서, 좌표 경로에서는 `dumpsys window displays`의
  기본 디스플레이 `mDisplayRotation`에서 읽는다. 회전은 언제든 바뀌므로 캐시하지 않는다.
- `Gesture`(`ipc.ts`)도 0..1 좌표를 담는다. `screen` 필드는 없앤다. 오버레이는 비디오 크기를 곱하기만 한다.

## 대안

- **픽셀 유지 + 스크린샷에 축소 정보 제공** — 스크린샷 응답에 원본 크기와 축소 비율을 실어 에이전트가
  환산한다. 기존 호환이 유지된다.
  그러나 환산 계산이 에이전트에게 간다. 회전까지 겹치면 틀리기 쉽다.
  **→ 기각:** 에이전트가 틀리기 쉬운 계산을 매번 시킨다.
- **픽셀과 정규화 병행** — `x`, `y`(픽셀)와 `nx`, `ny`(정규화)를 따로 받는다.
  그러나 툴 표면이 넓어진다. 에이전트가 두 좌표계를 섞을 수 있다.
  **→ 기각:** 같은 일을 하는 인자가 둘이 된다.

## 영향

**긍정**

- 스크린샷 축소 비율, 해상도, 회전과 무관하게 같은 값이 같은 위치를 가리킨다.
- `Gesture`를 만들 때 화면 크기 조회가 필요 없다. `runTool.ts`의 gesture 대기 로직과 오버레이의 회전 추정
  로직이 단순해진다.
- Orca emulator의 `tap`과 같은 좌표계다.

**트레이드오프**

- **MCP 클라이언트 호환이 깨진다.** 픽셀을 넣던 에이전트는 동작하지 않는다. 0.2.0 단계라 지금이 가장 싸다.
- 좌표 입력마다 현재 회전을 한 번 묻는다. 자연 방향 크기는 연결 동안 캐시한다.

**위험·방어**

- 0..1 밖 값은 zod 스키마에서 거절한다. 픽셀을 넣던 클라이언트는 조용히 엉뚱한 곳을 누르지 않고 인자
  오류로 멈춘다.
- 네 방향 회전의 좌표 변환은 단위 테스트로 고정한다.
- 에이전트 안내(`agentGuide.ts`)와 툴 설명을 함께 바꾼다. `guideConsistency.test.ts`가 둘을 대조한다.
