---
id: ADR-0005
title: 타깃 디바이스는 Device 인터페이스로 가른다
status: accepted
date: 2026-09-22
deciders: virtual-device-helper 팀
scope: [main, android, ios, shared]
hosts: []
supersedes:
superseded_by:
related_adr: ADR-0004
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan:
related_code:
tags: [adr, architecture, device]
---

# ADR-0005: 타깃 디바이스는 Device 인터페이스로 가른다

## 맥락

이 프로젝트는 Android 에뮬레이터와 iOS 시뮬레이터를 모두 다루는 것이 목표다. 두 타깃은 도구가
완전히 다르다. Android는 `adb`, iOS는 `simctl`이다. 출력 형식도, 가능한 조작도 겹치지 않는 부분이 있다.

M1은 Android만 만든다. 그러나 iOS를 붙일 때 MCP 툴 층·서버 층·UI 층을 다시 쓰게 되면 M4의
비용이 감당하기 어려워진다.

## 결정

`Device` 인터페이스를 M1에서 정의하고, 구현체는 `AndroidDevice` 하나만 만든다.

- main 프로세스를 여섯 층으로 쌓는다: `adbClient` → `AndroidDevice` → `DeviceRegistry` →
  `mcpTools` → `mcpHttpServer` → `ipcBridge`.
- `adbClient`가 adb 문법을 아는 유일한 층이다. adb 출력 파싱은 `AndroidDevice`에 갇힌다.
- `mcpTools` 위의 층들은 `Device` 인터페이스만 본다. 특정 타깃을 모른다.
- **위층은 바로 아래층만 부른다.** `mcpTools`가 `adbClient`를 직접 부르는 것을 금지한다.
- 타깃마다 다른 능력은 인터페이스에 "지원함/지원 안 함"으로 드러낸다. 타깃 이름으로 분기하지 않는다.
- M1에서 인터페이스를 넓게 설계하지 않는다. Android 구현이 실제로 필요로 하는 만큼만 정의하고,
  iOS를 붙일 때 실제 차이를 보고 넓힌다.

## 대안

- **추상화 없이 Android 전용으로 구현** — M1이 가장 빠르다.
  **→ 기각:** iOS를 붙일 때 MCP 툴 층부터 UI까지 전부 손댄다. 되돌리기 비용이 M4 전체에 퍼진다.
- **M1에서 iOS까지 고려한 넓은 인터페이스 설계** — 나중에 인터페이스를 덜 바꾼다.
  **→ 기각:** 구현체가 하나뿐인 추상화는 검증되지 않는다. iOS의 실제 제약을 모르는 상태에서 만든
  인터페이스는 틀릴 확률이 높고, 틀린 추상화는 없는 것보다 나쁘다. 좁게 긋고 M4에서 넓힌다.

## 영향

**긍정**

- iOS 어댑터를 넣을 때 `DeviceRegistry` 위 네 층을 건드리지 않는다.
- 외부와 닿는 지점이 `adbClient` 하나라, 그것만 가짜로 바꾸면 위 다섯 층을 실기기 없이 테스트한다.
- 각 층의 책임이 한 문장으로 말해진다. 파일이 비대해지는 것을 층 경계가 막는다.

**트레이드오프**

- 구현체가 하나뿐인 인터페이스가 M4까지 검증되지 않은 채로 남는다.
- 층을 지키느라 간단한 일에도 호출이 한 단계 더 생긴다.

**위험·방어**

- 층 방향 규칙이 깨지면 iOS를 붙일 때 전부 샌다. 코드 리뷰에서 확인하고, 규칙 위반이 반복되면
  의존 방향 검사를 자동화한다.
- 인터페이스가 Android에 과적합될 위험이 있다. M4 착수 시 `simctl`의 실제 능력과 대조하고,
  맞지 않으면 인터페이스를 고치는 것을 M4 범위에 포함한다.
