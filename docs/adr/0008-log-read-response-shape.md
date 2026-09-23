---
id: ADR-0008
title: log_read 응답은 압축 한 줄 문자열과 바이트 예산으로 준다
status: accepted
date: 2026-09-23
deciders: virtual-device-helper 팀
scope: [mcp, main, android, ios]
hosts: []
supersedes:
superseded_by:
related_adr: [ADR-0004, ADR-0005]
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan: m1-5-integration-verification
related_code: [observe.ts#formatLogLine, observe.ts#enforceResponseBudget, limits.ts#MAX_LOG_LIMIT, androidDevice.ts#readLogs]
tags: [adr, mcp, logs, response-size]
---

# ADR-0008: log_read 응답은 압축 한 줄 문자열과 바이트 예산으로 준다

> 상태·날짜·결정자·대체 관계는 위 frontmatter가 단일 출처. 본문은 결정 내용에 집중한다.

## 맥락

M1-5 통합 검증에서 Claude Code 2.1.280을 외부 에이전트로 붙여 `log_read`를 불렀다. 당시
`log_read`는 `LogLine` 객체 배열을 들여쓴 JSON으로 돌려줬고, 줄마다 키 이름이 반복됐다.

- 당시 기본 limit 200으로 부른 응답이 약 56KB였고, Claude Code가 인라인하지 않았다
  ("Output too large ... Full output saved to ..."). 에이전트는 파일로 저장된 결과를 Bash로
  후처리하려다 승인이 필요해 멈췄다.
- 당시 상한 2000으로 부른 응답은 약 458K자였고, 역시 인라인되지 않았다.
- 같은 검증에서 약 23KB 응답은 인라인됐다.

줄 수 상한만으로는 응답 크기가 막히지 않는다는 것이 관찰됐다. 한 줄의 길이가 제각각이고,
표현 형식 자체가 크기를 부풀린다. 이 형식은 `log_read`의 공개 응답 모양이라 되돌리려면
M4의 iOS 어댑터와 M3의 로그 패널이 함께 영향을 받는다.

관찰의 원문은 `.superpowers/sdd/2026-09-22-m1-5-integration-verification/observations.md`에 있다.

## 결정

`log_read`는 로그 한 줄을 압축한 문자열 하나로 돌려주고, 응답 전체를 UTF-8 바이트 예산 안에
맞춘다. 구조화된 `LogLine[]`은 툴 층 아래(`AndroidDevice.readLogs`)에 남긴다.

- 각 줄은 `MM-DD HH:MM:SS.mmm L tag(pid): message` 한 문자열이다(`observe.ts`의
  `formatLogLine`). 응답 JSON은 들여쓰지 않는다.
- 줄 수 기본값은 100, 상한은 200이다. 상한은 인자로도 넘을 수 없고 MCP 입력 스키마가 거부한다.
  값은 `src/shared/limits.ts`의 `DEFAULT_LOG_LIMIT`·`MAX_LOG_LIMIT`에 한 번만 있고,
  mcpTools 층과 `AndroidDevice.readLogs`가 함께 쓴다.
- 한 줄의 `message`는 코드포인트 단위로 자르고 `…(+N자)`로 잘린 양을 표시한다
  (`LOG_MESSAGE_MAX_CODEPOINTS`). 서로게이트 쌍을 반쪽으로 자르지 않기 위해 코드포인트로 센다.
- 직렬화한 응답 전체가 `LOG_READ_RESPONSE_BUDGET_BYTES`(20,000바이트, `Buffer.byteLength`로
  UTF-8 기준)를 넘으면 가장 오래된 줄부터 버리고, 버린 줄 수를 `droppedCount`에 더하고
  `truncated`를 `true`로 올린다(`observe.ts`의 `enforceResponseBudget`). 최신 쪽이 남는다.
- 예산을 문자 수가 아니라 바이트로 재는 이유는 클라이언트가 받는 것이 바이트이고, 한글처럼
  한 글자가 여러 바이트인 로그에서 문자 수는 크기를 과소평가하기 때문이다.

## 대안

- **limit만 줄이기** — 응답 모양을 바꾸지 않으니 호출하는 쪽이 고칠 것이 없다.
  **→ 기각:** 들여쓴 JSON은 줄당 크기가 커서, 줄 수를 줄여도 응답이 인라인 한도 근처에 머문다.
  긴 메시지 한 줄이 예산을 통째로 먹는 경우도 줄 수로는 막히지 않는다.
- **`level` 인자를 더해 레벨로 거르기** — 검증에서 에이전트가 실제로 원한 기능이고, 에러만
  볼 때 응답이 작아진다.
  **→ 기각(지금은):** 공개 툴 표면을 바꾸는 일이라 ADR-0004의 관장 아래에 있고, 크기 문제를
  근본적으로 풀지도 않는다(레벨로 걸러도 줄이 많고 길 수 있다). 사용자가 형식과 상한 쪽을 골랐다.
  필요해지면 별도 결정으로 다룬다.

## 영향

**긍정**

- 검증에서 상한 200으로 부른 응답이 예산 안(약 20.3KB)으로, 기본값 응답이 약 12.2KB로 와서
  Claude Code가 인라인했다.
- 응답 크기가 줄 수·줄 길이·문자 종류와 무관하게 예산으로 묶인다.

**트레이드오프**

- 툴 응답은 사람이 읽는 문자열이라 기계가 필드별로 다루기 어렵다. 구조가 필요한 쪽은 툴을
  거치지 말고 `AndroidDevice.readLogs`(장차 `Device.readLogs`)를 쓴다.
- 예산에 걸리면 요청한 limit보다 적은 줄이 온다. `truncated`·`droppedCount`와 툴 설명이 그 사실을
  말하고, 에이전트는 `filter`로 좁혀 다시 부른다.

**위험·방어**

- M4의 iOS 어댑터가 붙어도 `log_read`는 같은 모양(압축 한 줄 문자열, `truncated`·`droppedCount`)을
  내고 같은 예산을 지켜야 한다. 형식과 예산은 mcpTools 층(`observe.ts`)에 있으므로 어댑터는
  `LogLine[]`만 돌려주면 된다. 어댑터가 이 층을 우회하지 않도록 ADR-0005의 층 규칙과
  `layering.test.ts`의 의존 방향 검사가 막는다.
- M3의 로그 패널은 툴 텍스트를 파싱하지 않고 구조화된 `readLogs`를 쓴다. 툴 텍스트 형식은
  에이전트를 위한 것이라 바뀔 수 있다.
- 회귀는 `observe.test.ts`가 잡는다. 상한 근처 긴 줄, 한글 위주 줄에서 바이트 예산을 넘지 않는지,
  버린 줄이 `droppedCount`에 합산되는지 본다.
