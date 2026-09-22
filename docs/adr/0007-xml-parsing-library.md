---
id: ADR-0007
title: uiautomator 덤프 파싱에 fast-xml-parser를 들인다
status: accepted
date: 2026-09-22
deciders: virtual-device-helper 팀
scope: [main, android]
hosts: []
supersedes:
superseded_by:
related_adr: [ADR-0004, ADR-0005]
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan: m1-2-android-device
related_code: uiDump.ts#parseUiDump
tags: [adr, android, parsing, dependency]
---

# ADR-0007: uiautomator 덤프 파싱에 fast-xml-parser를 들인다

> 상태·날짜·결정자·대체 관계는 위 frontmatter가 단일 출처. 본문은 결정 내용에 집중한다.

## 맥락

`ui_find`가 돌려주는 것은 `uiautomator dump`가 만든 XML의 요약이다. 원본은 화면 하나가 수만
토큰이라 에이전트에게 그대로 줄 수 없고([ADR-0004](0004-hybrid-mcp-tool-surface.md)), 요약의
품질이 이 툴의 쓸모를 정한다.

덤프의 내용물은 우리가 통제하지 못한다. `text`와 `content-desc`에는 테스트 대상 앱이 화면에
띄운 문자열이 그대로 들어간다. 따옴표, `&`, XML 엔티티, 한글, 줄바꿈이 속성값 안에 섞여 온다.
여기서 파싱이 틀리면 결과는 예외가 아니라 **잘못된 좌표**다. 에이전트는 그것을 그대로
`ui_tap`에 넣고, 엉뚱한 곳을 누른 채 성공했다고 믿는다.

이 파싱은 Electron main 프로세스에서 돌고, 따라서 여기 쓰는 라이브러리는 개발 도구가 아니라
앱과 함께 배포되는 런타임 의존이 된다.

## 결정

`fast-xml-parser`를 런타임 의존으로 들이고, 그것을 보는 코드를 `uiDump.ts`의 `parseUiDump`
하나로 가둔다.

- `XMLParser`를 `ignoreAttributes: false`, `attributeNamePrefix: ''`로 설정해 속성을 읽는다.
  uiautomator 덤프는 정보가 전부 속성에 있다.
- 파서가 만든 raw 트리는 `parseUiDump` 밖으로 나가지 않는다. 경계를 넘는 것은 `UiNode[]`뿐이다.
  층 규칙([ADR-0005](0005-device-interface-abstraction.md))을 여기서도 지킨다.
- 버전은 설치 시점의 최신 안정판을 쓰고 `package-lock.json`으로 고정한다.
- 라이브러리를 갈아야 할 때 고칠 파일은 `uiDump.ts` 하나다.

## 대안

- **정규식으로 속성을 긁는다** — 의존이 늘지 않고 구현이 짧다.
  **→ 기각:** 속성값의 따옴표·이스케이프·엔티티에서 깨진다. 더 나쁜 것은 깨지는 방식이다.
  정규식은 매칭에 실패한 노드를 조용히 건너뛰므로, 에러 없이 화면의 일부가 사라진 요약이
  나온다. 잘못된 좌표를 돌려주는 실패는 에이전트가 눈치채지 못한다.
- **DOM 파서에 맡긴다** — 표준 API라 의존이 없다.
  **→ 기각:** Electron main은 Node 런타임이라 `DOMParser`가 없다. 파싱을 renderer로 보내면
  원본 XML이 프로세스 경계를 넘고, main이 유일한 진실원이라는 구조도 함께 깨진다.
- **직접 쓴 파서를 유지한다** — 의존이 늘지 않고 필요한 만큼만 다룬다.
  **→ 기각:** XML 엔티티와 이스케이프 처리를 우리가 떠안게 된다. 이 프로젝트의 값어치는 요약
  규칙에 있지 XML 파서에 있지 않다.

## 영향

**긍정**

- 앱이 만든 임의의 문자열이 속성값에 들어와도 덤프를 안정적으로 읽는다.
- 파서 교체 지점이 `parseUiDump` 한 곳이다. 위층은 이 결정을 모른다.

**트레이드오프**

- Electron 앱 번들에 런타임 의존이 하나 늘고, 그 의존이 다시 자기 전이 의존들(`strnum` 등)을
  달고 들어온다. 앱 용량과 공급망 점검 대상이 그만큼 넓어진다.
- 보안 권고와 상위 버전 변경을 추적할 대상이 하나 생긴다. XML 파서는 엔티티 확장 계열
  취약점의 역사가 있는 영역이다.

**위험·방어**

- 입력은 **우리가 띄운 기기의 덤프로 한정한다.** 외부에서 받은 XML을 이 파서에 넣지 않는다.
- 실기기에서 뜬 덤프 픽스처(`parsers/__fixtures__/window-dump.xml`)를 `uiDump.test.ts`가
  통째로 파싱한다. 라이브러리를 올릴 때 이 테스트가 1차 방어선이다.
- 버전을 `package-lock.json`으로 고정해, 파싱 동작이 설치 시점에 따라 달라지지 않게 한다.
