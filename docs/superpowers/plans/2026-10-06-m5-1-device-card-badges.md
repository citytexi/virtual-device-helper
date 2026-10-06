---
id: m5-1-device-card-badges
title: M5-1 — 기기 카드 배지 겹침 수정
status: draft
type: work-order
created: 2026-10-06
updated: 2026-10-06
owner: virtual-device-helper 팀
scope: [renderer]
hosts: []
archived_reason:
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

**Goal:** 대상 기기 카드에서 플랫폼 배지와 `(대상)` 배지가 포개지지 않고, 긴 이름·serial이 버튼을 밀어내지 않는다.

**Architecture:** `DevicePanel.tsx`의 `.device-row`는 CSS grid다. 배지 둘이 같은 칸(`grid-row: 2; grid-column: 2`)에
놓여 겹친다. 배지를 한 묶음으로 싸서 그 칸 하나에 나란히 놓는다.

**Tech Stack:** React, CSS grid, Vitest + Testing Library

**Spec:** [`../specs/2026-10-06-m5-multi-screen.md`](../specs/2026-10-06-m5-multi-screen.md) — "기기 카드" 절.

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- ADR-0015: mcp·renderer는 `platform`으로 분기하지 않는다. 칸 id나 라벨로 돌려서 분기하지도 않는다.
- 새 npm 의존성을 들이지 않는다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다. 테스트 출력에 경고가 없어야 한다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 문서를 고치면 `docs.py lint`와 `docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
- 배지 문구(`Android`, `iOS`, `(대상)`)와 버튼의 `aria-label`은 바꾸지 않는다.

## Review Focus

- **긴 이름**: `iPad Pro 13-inch (M4)` 같은 긴 이름에서 `종료`·`부팅` 버튼이 잘리지 않는다. → Task 1 테스트(구조)와 앱 확인.
- **긴 serial**: iOS UDID가 카드 폭을 넘으면 말줄임으로 잘리고 전체 값은 `title`로 볼 수 있다. → Task 1 테스트.
- **대상이 아닌 카드**: 배지가 하나일 때 모양이 지금과 같다. → Task 1 테스트.

---

### Task 1: 배지 묶음과 넘침 처리

**Files:**
- Modify: `src/renderer/src/components/DevicePanel.tsx`, `src/renderer/src/app.css`
- Test: `src/renderer/src/components/DevicePanel.test.tsx`

**Interfaces:**
- `.device-row` 안의 배지들을 `<span className="device-badges">`로 싼다. 플랫폼 배지가 먼저, `(대상)` 배지가 다음이다.
- serial 요소에 `title={avd.serial}`을 단다.
- `app.css`: `.device-badges`는 `grid-row: 2; grid-column: 2`에 놓이는 `inline-flex` 묶음(`gap`은 기존 간격 토큰).
  `.device-row .badge`의 개별 grid 배치 규칙과 `.badge + .device-serial` 규칙을 지우고 serial은 묶음 다음 칸에 둔다.
  `.device-name`과 `.device-serial`은 `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`.
  `.device-action`은 `flex-shrink: 0`에 해당하는 grid 설정(열을 `auto`로)으로 줄어들지 않게 한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — 대상인 실행 중 기기 카드에서 `Android`(또는 `iOS`) 배지와 `(대상)` 배지의 부모가 같은 `.device-badges` 요소다 / 대상이 아닌 카드의 `.device-badges` 안에는 배지가 하나다 / serial 요소의 `title`이 serial 전체 값이다 / `종료` 버튼의 `aria-label`이 그대로다.
- [ ] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/renderer/src/components/DevicePanel.test.tsx` / Expected: FAIL.
- [ ] **Step 3: 구현한다.**
- [ ] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [ ] **Step 5: 앱에서 본다** — `npm run dev`로 띄워 실행 중인 기기를 하나 고르고 그 카드를 캡처해 본다: 배지 둘이 나란히 있고, 이름이 잘려도 버튼이 온전하다. 볼 수 없으면 "사람 확인 필요"로 보고한다.
- [ ] **Step 6: 커밋** — `git commit -m "fix(renderer): 기기 카드의 배지가 포개지지 않게 한 묶음으로 놓는다"`
