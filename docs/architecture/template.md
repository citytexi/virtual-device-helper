---
id: <kebab-case-id>             # 예: mcp-bridge
title: <사람이 읽는 제목>
status: living                  # living | superseded | deprecated
verified: YYYY-MM-DD            # 코드와 대조해 확인한 날짜
scope: []                       # main | renderer | preload | mcp | android | ios | streaming | build | shared | docs
hosts: []                       # windows | macos — 호스트 OS마다 구조가 갈릴 때만 채운다
related_adr:
related_spec:
related_architecture:
related_plan:
related_code:                   # 파일명#심볼 (라인번호·변동 수치 금지)
tags: [architecture]
---

# 문서 제목

> 상시 갱신되는 구현 가이드("어떻게 / 어디"). 결정 근거(why)는 `../adr/`, 구현 직전 설계(what)는
> `../superpowers/specs/`에 있다.
>
> 근거는 파일명 + 심볼명으로만 적는다. 라인번호·모듈 개수 같은 변동 수치는 적지 않는다
> (규칙 상세: [`../adr/README.md`](../adr/README.md)).

## 섹션

…

<!--
사용법 (작성 후 이 주석 삭제):
- `status: living` = 상시 갱신 문서. 코드와 대조할 때마다 `verified`를 갱신한다.
- 대체·폐기 시 `status: superseded | deprecated`.
- 추정은 **Assumption** 라벨을 붙여 사실과 구분한다.
-->
