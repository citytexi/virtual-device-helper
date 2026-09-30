---
id: ADR-0011
title: 요소 지정은 스냅샷 ref와 실행 직전 재검증으로 한다
status: accepted                # proposed | accepted | superseded | deprecated
date: 2026-09-28
deciders: virtual-device-helper 팀   # 팀/역할 (실명·개인정보 금지)
scope: [main, mcp, android, shared]
hosts: []                       # windows | macos — 호스트 OS마다 결정이 갈릴 때만 채운다
supersedes:                     # 이 ADR이 대체하는 ADR-NNNN (없으면 비움)
superseded_by:                  # 이 ADR을 대체한 ADR-NNNN (없으면 비움)
related_adr: [ADR-0004, ADR-0012, ADR-0007]
related_spec: m3-node-control-logs-events
related_architecture: main-layers
related_plan:
related_code: [ui.ts#registerUiTools, uiDump.ts#parseUiDump, device.ts#UiNode, registry.ts#createDeviceRegistry]
tags: [adr, mcp, ui, node]
---

# ADR-0011: 요소 지정은 스냅샷 ref와 실행 직전 재검증으로 한다

> 상태·날짜·결정자·대체 관계는 위 frontmatter가 단일 출처. 본문은 결정 내용에 집중한다.

## 맥락

이 앱의 주 사용자는 MCP로 기기를 조작하는 에이전트다. 사람 입력은 부가 기능이다.

M1의 `ui_find`는 uiautomator 덤프를 평평한 목록으로 준다. 노드마다 중심 픽셀 `x`, `y`만 있다
(`uiDump.ts`의 `parseUiDump`, `device.ts`의 `UiNode`). 에이전트는 이 픽셀을 받아서 `ui_tap`에 다시 넣는다.
노드와 동작 사이에 연결이 없다. `ui_find`와 `ui_tap` 사이에 화면이 바뀌면 에이전트는 엉뚱한 곳을 누른다.
이 호출은 성공으로 끝난다. UI를 조작하는 에이전트에게 틀린 성공은 가장 나쁜 실패다.

Orca의 emulator 기능(`orca emulator ax`)은 접근성 트리를 노드 단위로 다룬다. 이 결정은 그 구조를 가져온다.

제약도 하나 있다. `uiautomator dump`는 한 번에 1~2초 걸린다.

## 결정

에이전트는 픽셀이 아니라 **스냅샷 ref**로 요소를 가리킨다. 서버는 동작 직전에 다시 덤프해서 같은 노드를
찾고, 그 노드의 **새 bounds**를 쓴다.

- `ui_find`는 덤프마다 세대 번호를 붙인다. 세대 번호는 프로세스 전역 단조 카운터다. 노드마다
  `g<세대>:<순번>` 형식의 ref를 준다.
- 서버는 기기 인스턴스별로 최근 스냅샷 몇 개를 들고 있다. ref는 대상 기기의 스냅샷에서만 찾는다.
  그래서 다른 기기의 ref와 재연결 전 ref는 풀리지 않는다.
- 노드 지문은 `className`, `resourceId`, `contentDesc`, `text`와, 남은 조상들의 `className`·`resourceId`
  체인이다. `UiNode.editable`이 참인 노드는 입력하면 바뀌는 `text`를 지문에서 뺀다.
- ref를 받는 툴은 동작 직전에 다시 덤프한다. 새 덤프에서 같은 지문을 찾는다.
- 같은 지문이 여럿이면 두 조건이 모두 맞을 때만 받아들인다. 옛 덤프와 새 덤프에서 그 지문의 개수가 같아야
  하고, 옛 순번으로 고른 노드가 옛 bounds에 가장 가까운 노드와 같아야 한다.
- 조건이 맞지 않거나 찾지 못하면 `stale_ref` 에러를 준다. hint는 "`ui_find`를 다시 불러 새 ref를 받아라"다. 추측해서 누르지 않는다.
- `ui_tap`, `ui_swipe`, `ui_text`가 ref를 받는다. 좌표 입력은 노드가 없는 화면을 위해 남긴다.

## 대안

- **스냅샷 ref + 캐시 좌표** — 마지막 덤프의 bounds를 그대로 누른다. 탭마다 재덤프가 없어서 빠르다.
  그러나 화면이 바뀐 뒤 엉뚱한 곳을 누르는 실패 모드가 지금 픽셀 방식과 같다. ref가 이름만 바뀐 좌표가 된다.
  **→ 기각:** 이 작업이 없애려는 실패를 그대로 남긴다.
- **셀렉터 ref** — ref가 `resourceId=login` 같은 조건을 담는다. 동작할 때마다 조건으로 다시 찾는다.
  세대 관리가 없다.
  그러나 같은 조건에 맞는 노드가 여럿이면 모호하다. 리스트 항목에서 흔하다. 모호함을 풀 옛 상태도 없다.
  **→ 기각:** 가장 흔한 화면(리스트)에서 어느 노드인지 정하지 못한다.
- **픽셀 좌표 유지** — 변경이 없다.
  **→ 기각:** 문제를 그대로 둔다.

## 영향

**긍정**

- 화면이 바뀐 뒤 옛 ref로 동작하면 `stale_ref`로 멈춘다. 틀린 성공이 생길 창이 `ui_find`에서 동작까지의
  전체 구간에서 재검증 덤프와 동작 사이의 짧은 구간으로 좁아진다.
- 스크롤로 위치만 바뀐 노드는 새 bounds로 제대로 누른다.
- 에이전트가 픽셀을 들고 다니지 않는다. 좌표 계산 실수가 사라진다.

**트레이드오프**

- ref 동작마다 덤프 한 번(1~2초)이 더 든다. 필요해지면 "마지막 덤프가 아주 최근이면 재사용" 같은 최적화를
  얹을 수 있다. 이 최적화는 이 결정을 바꾸지 않는다.
- 텍스트가 바뀌는 노드(카운터, 타이머)는 지문이 달라져 `stale_ref`가 된다. 에이전트는 `ui_find`를 다시
  부르면 된다.
- 같은 지문이 여럿인 리스트에서 스크롤이나 항목 변화가 있으면 `stale_ref`가 잦아진다. 틀린 행을 누르는 것보다 낫다.
- 재검증 덤프와 실제 동작 사이에 앱이 스스로 화면을 바꾸는 것은 막지 못한다. `registry.run`은 우리 툴끼리만
  직렬화한다.
- 서버가 기기별 스냅샷 상태를 갖는다. M1까지 MCP 툴 층은 상태가 없었다.

**위험·방어**

- 지문 매칭 규칙은 단위 테스트로 고정한다. 일치, 불일치, 같은 지문 여럿의 개수·최근접 판정, 이동한 노드,
  다른 기기 ref를 각각 확인한다.
- 실기기 통합 테스트로 "화면 전환 뒤 옛 ref는 `stale_ref`"를 확인한다.
- 스냅샷 캐시는 `Device` 인스턴스를 키로 하는 `WeakMap`에 둔다. registry는 재연결할 때 새 인스턴스를 만들므로
  재연결한 기기에 옛 ref가 통하지 않는다.
