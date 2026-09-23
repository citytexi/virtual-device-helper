---
id: <kebab-case-id>             # 파일명에서 날짜 접두사를 뺀 slug
title: <사람이 읽는 제목>
status: draft                   # draft | in-progress | implemented | superseded
verified: YYYY-MM-DD            # 코드와 대조해 확인한 날짜
scope: []                       # main | renderer | preload | mcp | android | ios | streaming | build | shared | docs
hosts: []                       # windows | macos — 호스트 OS마다 동작이 갈릴 때만 채운다
supersedes:                     # 이 스펙이 대체하는 기존 스펙 id (없으면 비움)
superseded_by:                  # 이 스펙을 대체한 새 스펙 id (없으면 비움)
related_adr:
related_spec:
related_architecture:
related_plan:
related_code:                   # 파일명#심볼 (라인번호·변동 수치 금지)
tags: [spec]
---

# Spec: 기능/컴포넌트명

> 상태·날짜·관련 문서는 위 frontmatter가 단일 출처. 본문은 설계 내용에 집중한다.

## 목표

무엇을 만드는가, 왜. 한두 문장.

## 범위

- 포함: …
- 제외: … (명시적으로 만들지 않는 것)

## 인터페이스

```ts
// 시그니처
```

- 파라미터별 의미와 기본값.

## 동작 / 상태

- 상태 목록과 각 상태의 진입 조건.
- 상태 전이와 그 트리거.

## 실패 처리

- 실패 종류별 사용자에게 보이는 결과와 복구 경로.

## 파일 구성

- 만들 파일과 각 역할.

## 열린 질문

- 미확정 사항. 결정되면 본문으로 올리거나 ADR로 승격한다.

<!--
사용법 (작성 후 이 주석 삭제):
- 파일명 `YYYY-MM-DD-kebab-topic.md`. `docs.py new spec <slug> --title "<제목>"`이 날짜·인덱스 등록까지 해 준다.
- 구현이 끝나면 `status: implemented`로 바꾸고 `archive/`로 옮긴다.
- 이 스펙이 새 구조 결정을 유발하면 대응 ADR을 `../../adr/`에 함께 만들고 `related_adr`로 잇는다.
- 근거는 파일명 + 심볼명으로. 라인번호·변동 수치·색 hex값은 적지 않는다.
-->
