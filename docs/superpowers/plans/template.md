---
id: <slug>                      # 파일명에서 날짜 접두사를 뺀 slug
title: <사람이 읽는 제목>
status: draft                   # draft | in-progress | done | abandoned | superseded
type: work-order                # work-order | handoff
created: YYYY-MM-DD
updated: YYYY-MM-DD
owner:                          # 담당 팀/역할 (실명·개인정보 금지)
scope: []                       # main | renderer | preload | mcp | android | ios | streaming | build | shared | docs
hosts: []                       # windows | macos — 호스트 OS마다 작업이 갈릴 때만 채운다
archived_reason:                # done/abandoned 시 사유 (활성 계획은 비움)
related_adr:
related_spec:
related_architecture:
related_plan:
related_code:                   # 파일명#심볼 (라인번호·변동 수치 금지)
tags: [plan]
---

# 기능/컴포넌트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** …

**Architecture:** …

**Global Constraints:** …

## Tasks

- [ ] …

<!--
사용법 (작성 후 이 주석 삭제):
- 파일명 `YYYY-MM-DD-<slug>.md`. `docs.py new plan <slug> --title "<제목>"`이 날짜·인덱스 등록까지 해 준다.
- 완료: `status: done` + `archived_reason` 기입 후 `archive/`로 이동.
- 폐기: `status: abandoned` + `archived_reason` 기입 후 `archive/`로 이동 (맥락 보존).
- 계획을 손대면 `updated`를 갱신한다.
-->
