---
id: ADR-NNNN
title: <결정 제목>
status: proposed                # proposed | accepted | superseded | deprecated
date: YYYY-MM-DD
deciders: virtual-device-helper 팀   # 팀/역할 (실명·개인정보 금지)
scope: []                       # main | renderer | preload | mcp | android | ios | streaming | build | shared | docs
hosts: []                       # windows | macos — 호스트 OS마다 결정이 갈릴 때만 채운다
supersedes:                     # 이 ADR이 대체하는 ADR-NNNN (없으면 비움)
superseded_by:                  # 이 ADR을 대체한 ADR-NNNN (없으면 비움)
related_adr:
related_spec:
related_architecture:
related_plan:
related_code:                   # 파일명#심볼 (라인번호·변동 수치 금지)
tags: [adr]
---

# ADR-NNNN: 결정 제목

> 상태·날짜·결정자·대체 관계는 위 frontmatter가 단일 출처. 본문은 결정 내용에 집중한다.

## 맥락

무엇이 문제이고 왜 이 결정이 필요한가. 배경이 자명하면 생략한다.

## 결정

무엇을 하기로 했는가. 핵심을 먼저 한 문장으로, 세부는 불릿으로.

## 대안

- **대안 A** — 장점. 그러나 단점.
  **→ 기각:** 기각 사유.
- **대안 B** — 장점. 그러나 단점.
  **→ 기각:** 기각 사유.

## 영향

**긍정**

- …

**트레이드오프**

- …

**위험·방어**

- 어떻게 검증하거나 완화하는가 (테스트·가드 등).

<!--
작성 규칙 (작성 후 이 주석 삭제):
- 본문은 현재 결정의 최종 상태만 담는다. 번복·보강 시 본문을 갱신하고 "이전엔" 식 이력을 누적하지 않는다.
- 대체 관계는 구 문서에 `status: superseded` + `superseded_by`, 신 문서에 `supersedes`를 쓴다.
- 근거는 파일명 + 심볼명으로. 라인번호·파일 개수·진행률·호출 횟수는 적지 않는다 (README.md 참고).
- 파일명 `NNNN-kebab-case-title.md`. `docs.py new adr <slug> --title "<제목>"`이 번호·인덱스 등록까지 해 준다.
-->
