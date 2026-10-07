---
id: m5-1-device-card-badges
title: M5-1 — 기기 카드 배지 겹침 수정
status: done
type: work-order
created: 2026-10-06
updated: 2026-10-07
owner: virtual-device-helper 팀
scope: [renderer]
hosts: []
archived_reason: done — M5-1 구현 완료. 기기 카드의 배지를 한 묶음으로 놓고 일련번호를 버튼 열에서 뺀다. PR #27로 develop에 머지. 단계 체크박스는 채우지 않았다
related_adr: [ADR-0015]
related_spec: m5-multi-screen
related_architecture: main-layers
related_plan: [m5-2-jpeg-frame-ack, m5-3-screen-slots]
related_code: [DevicePanel.tsx#DevicePanel]
tags: [plan, renderer, ui]
---

# M5-1 — 기기 카드 배지 겹침 수정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** 대상 기기 카드에서 플랫폼 배지와 `(대상)` 배지가 포개지지 않고, 긴 serial이 이름과 버튼을 밀어내지 않는다.

**Architecture:** `DevicePanel.tsx`의 `.device-row`는 열 셋(`auto 1fr auto`)의 CSS grid다. 문제는 둘이다.
(a) 플랫폼 배지와 `(대상)` 배지가 같은 칸(2행 2열)에 놓여 포개진다. (b) `.device-row .badge + .device-serial` 규칙이
serial을 `auto`인 3열에 넣는다. 줄바꿈 없는 긴 iOS UDID가 그 열을 부풀려 2열의 이름을 짓누르고(`iPh…`), 같은 3열에
사는 `종료` 버튼을 카드 밖으로 민다. 배지를 한 묶음으로 싸고, serial을 버튼 열에서 빼 제 행에 둔다.

**Tech Stack:** React, CSS grid, Vitest + Testing Library

**Spec:** [`../specs/2026-10-06-m5-multi-screen.md`](../../specs/archive/2026-10-06-m5-multi-screen.md) — "기기 카드" 절.

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- 새 npm 의존성을 들이지 않는다.
- task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다. 테스트 출력에 경고가 없어야 한다.
- 배지 문구(`Android`, `iOS`, `(대상)`)와 버튼의 `aria-label`은 바꾸지 않는다. `PLATFORM_LABEL`은 건드리지 않는다.
- `.device-serial` 클래스는 화면 머리줄(`.screen-toolbar`)도 쓴다. 이 계획의 CSS는 `.device-row` 안으로 한정한다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다.
- 커밋 메시지는 한국어 Conventional Commits이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

- **긴 serial이 버튼을 민다**: iOS UDID가 대상인 카드에서 `종료` 버튼이 온전하고 이름이 `iPh…`로 짓눌리지 않는다.
  jsdom은 레이아웃을 계산하지 않으므로 테스트는 구조만 고정한다. 실제 모습은 Step 5에서 앱으로만 확인된다.
- **serial 전체 값**: 말줄임으로 잘린 serial은 `title`로 전체를 볼 수 있다. → Task 1 테스트.
- **배지가 하나인 카드**: 대상이 아닌 카드와 꺼진 기기 카드의 구조가 맞다. → Task 1 테스트.

---

### Task 1: 배지 묶음과 serial 행

**Files:**
- Modify: `src/renderer/src/components/DevicePanel.tsx`, `src/renderer/src/app.css`
- Test: `src/renderer/src/components/DevicePanel.test.tsx`

**Interfaces:**
- `DevicePanel.tsx`: 플랫폼 배지와 `(대상)` 배지(`isActive`일 때)를 이 순서로 `<span className="device-badges">` 안에 둔다.
  serial 요소는 묶음 밖에 그대로 두고 `title={avd.serial}`을 단다.
- `app.css`:
  - `.device-row`의 `grid-template-columns`를 `auto minmax(0, 1fr) auto`로 바꾼다.
  - 더한다: `.device-badges { grid-row: 2; grid-column: 2 / -1; display: flex; gap: var(--space-1); min-width: 0; }`
  - `.device-row .device-serial`을 다음으로 바꾼다:
    `{ grid-row: 3; grid-column: 2 / -1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }`
  - 지운다: `.device-row .badge, .device-row .device-serial { grid-row: 2 }`, `.device-row .badge { grid-column: 2; justify-self: start }`,
    `.device-row .badge + .device-serial { grid-column: 3 }`, 옛 `.device-row .device-serial { grid-column: 2 / 4; … }`.
  - `.device-row .device-action`(`grid-column: 3; grid-row: 1`)과 `.device-name`은 건드리지 않는다. 버튼이 밀리지 않는 것은
    serial이 3열을 떠났기 때문이다.
  - 행 구성을 설명하는 주석을 "1행 점·이름·버튼, 2행 배지 묶음, 3행 일련번호"로 고친다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — 픽스처: `virtualDevices`에 `{ platform: 'ios', id: <36자 UDID>, name: 'iPad Pro 13-inch (M4)', running: true, serial: <같은 UDID>, osVersion: '18.0' }`,
  `devices: [<UDID>]`, `activeSerial: <UDID>`. (a) 그 카드의 `.device-badges` 자식 `textContent`가 순서대로 `['iOS', '(대상)']`이고,
  serial 요소는 `.device-badges` 안에 있지 않으며 `title`이 UDID 전체다. (b) 대상이 아닌 실행 중 카드의 `.device-badges`에는 배지가 하나다.
  (c) 꺼진 기기 카드: `.device-badges`에 배지 하나, serial 요소 없음, `부팅` 버튼이 있다.
- [ ] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/renderer/src/components/DevicePanel.test.tsx` / Expected: FAIL.
- [ ] **Step 3: 구현한다.**
- [ ] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [ ] **Step 5: 앱에서 본다** — macOS 호스트에서 `npm run dev`로 띄운다. 실행 중인 iOS 시뮬레이터를 대상으로 골라야 재현된다(없으면
  `xcrun simctl boot`로 하나 부팅하고 끝나면 그것만 끈다. Simulator.app은 띄우지 않는다). 앱 창만 캡처해 그 카드를 본다: 배지 둘이 나란히
  있고, 이름이 읽히고, `종료` 버튼이 온전하고, UDID가 말줄임으로 잘린다. 캡처할 수 없으면 "사람 확인 필요"로 보고한다. dev 프로세스를 끝낸다.
- [ ] **Step 6: 커밋** — `git commit -m "fix(renderer): 기기 카드의 배지를 한 묶음으로 놓고 일련번호를 버튼 열에서 뺀다"`
