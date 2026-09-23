---
id: ADR-0006
title: 빌드 스택은 electron-vite + electron-builder + React
status: accepted
date: 2026-09-22
deciders: virtual-device-helper 팀
scope: [build, main, renderer, preload]
hosts: [macos, windows]
supersedes:
superseded_by:
related_adr:
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan:
related_code:
tags: [adr, build, toolchain]
---

# ADR-0006: 빌드 스택은 electron-vite + electron-builder + React

## 맥락

Electron 앱은 main·preload·renderer 세 타깃을 빌드한다. 세 타깃은 모듈 형식과 실행 환경이
다르지만 같은 타입을 공유해야 한다. IPC 채널 타입과 MCP 스키마가 세 프로세스에 걸쳐 있어서,
타입이 어긋나면 런타임에서만 드러난다.

M1 착수 전에 언어·번들러·패키저·UI 프레임워크를 정해야 한다. 이 선택들은 저장소 구조와
설정 파일 전체에 퍼지므로 나중에 바꾸기 비싸다.

## 결정

- **언어는 TypeScript.** main·preload·renderer 전부. 세 프로세스가 공유 타입 패키지를 참조한다.
- **번들러는 electron-vite.** 세 타깃을 한 설정으로 묶고 개발 중 HMR을 준다.
- **패키저는 electron-builder.** macOS·Windows 배포물과 서명·공증 경로를 담당한다.
- **UI는 React.**
- **테스트는 Vitest.** Vite 설정을 공유하므로 별도 변환 설정이 없다.
- **MCP는 `@modelcontextprotocol/sdk`.** 프로토콜과 전송을 직접 구현하지 않는다.
- 코드 서명·공증은 M1 범위가 아니다. 배포를 시작할 때 다룬다.

## 대안

- **세 타깃을 각자 빌드 설정으로 굴린다** — 각 타깃을 독립적으로 조정할 수 있다.
  **→ 기각:** 설정이 셋으로 갈리면 금방 어긋난다. Electron 앱의 표준적인 문제라 이미 풀린 도구를 쓴다.
- **Electron Forge** — 빌드와 패키징이 한 도구에 들어 있다.
  **→ 기각:** electron-vite + electron-builder 조합이 예제와 사례가 더 많다. 기능 차이보다
  막혔을 때 참고할 것이 있는지가 초기에 더 중요하다. 실제로 불편해지면 이 ADR을 대체한다.
- **UI에 Svelte 또는 Solid** — 런타임이 가볍고 문법이 간결하다.
  **→ 기각:** 이 앱의 무거운 부분은 UI 프레임워크가 아니라 비디오 디코딩과 프로세스 관리다.
  프레임워크를 바꿔 얻는 것이 적다. 생태계와 예제가 많은 쪽을 고른다.

## 영향

**긍정**

- 세 타깃이 한 설정과 한 타입 체계를 공유한다. IPC와 MCP 스키마 불일치가 컴파일 시점에 잡힌다.
- 테스트가 빌드와 같은 변환을 쓴다. 테스트 전용 설정을 유지하지 않는다.
- MCP 프로토콜·전송·세션 관리를 직접 만들지 않아 M1 범위가 줄어든다.

**트레이드오프**

- electron-vite와 electron-builder 두 도구의 설정을 각각 유지한다.
- React를 고른 만큼 renderer 번들이 더 가벼운 대안보다 크다.
- SDK의 버전 정책과 브레이킹 체인지를 따라가야 한다.

**위험·방어**

- Electron 도구 생태계는 변화가 잦다. 버전을 고정하고 올릴 때 세 타깃 빌드와 패키징을 함께 확인한다.
- WebCodecs는 Chromium 버전에 따라 동작이 갈릴 수 있다. Electron 버전을 올릴 때 스트리밍
  경로를 회귀 확인 대상으로 둔다([ADR-0002](0002-screen-streaming-via-scrcpy-server.md)).
