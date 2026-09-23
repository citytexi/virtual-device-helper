---
id: ADR-0009
title: 배포는 서명 없는 macOS arm64 dmg·zip으로 한다
status: accepted
date: 2026-09-23
deciders: virtual-device-helper 팀
scope: [build]
hosts: [macos]
supersedes:
superseded_by:
related_adr: [ADR-0003, ADR-0006]
related_spec:
related_architecture:
related_plan:
related_code: [electron-builder.yml]
tags: [adr, build, release, signing]
---

# ADR-0009: 배포는 서명 없는 macOS arm64 dmg·zip으로 한다

## 맥락

처음으로 GitHub Release에 실행 파일을 올린다(v0.1.0). 지금 지원하는 호스트는 macOS뿐이다.
Windows는 M5에서 다룬다. 빌드 도구는 ADR-0006에서 정한 electron-builder다.

macOS에서 받은 앱을 문제없이 열려면 Apple Developer ID로 서명하고 공증을 받아야 한다. 이 프로젝트에는
Developer ID 인증서가 없다.

## 결정

- 서명도 공증도 하지 않는다. `electron-builder.yml`에 `mac.identity: null`을 둔다.
- arm64(Apple Silicon)용만 만든다. 산출물은 `dmg`와 `zip` 두 가지다.
- 빌드는 `npm run dist`로 한다. 릴리스는 `main`에 붙인 버전 태그에서 로컬로 빌드한 산출물을 `gh release`로 올린다.
- README에 Gatekeeper 격리 속성을 지우는 방법(`xattr -dr com.apple.quarantine`)을 적는다.

## 대안

- **Developer ID로 서명하고 공증한다** — 사용자가 경고 없이 연다.
  **→ 기각:** 인증서가 없다. 인증서를 발급받으면 이 ADR을 대체한다.
- **ad-hoc 서명(`identity: '-'`)** — 인증서 없이도 서명할 수 있다.
  **→ 기각:** 공증이 없으면 Gatekeeper는 인터넷에서 받은 앱을 똑같이 막는다. 사용자가 할 일이 줄지 않는다.
- **universal(arm64 + x64) 빌드** — Intel Mac에서도 돈다.
  **→ 기각:** 산출물이 두 배 가까이 커진다. 지금 개발과 검증은 Apple Silicon에서만 하므로 Intel 빌드는 검증되지 않은 채 나간다.
- **CI에서 빌드한다** — 빌드 환경이 고정된다.
  **→ 기각(지금은):** 이 저장소에 CI가 아직 없다. 첫 릴리스를 위해 CI부터 세우는 것은 범위를 넘는다.

## 영향

**긍정**

- 인증서나 유료 계정 없이 릴리스할 수 있다.
- 산출물이 하나의 아키텍처라 작고, 검증한 환경과 같다.

**트레이드오프**

- 사용자가 처음 열 때 Gatekeeper 경고를 만난다. `xattr`로 격리 속성을 지우거나 시스템 설정에서 직접 허용해야 한다.
- Intel Mac 사용자는 쓸 수 없다.
- 빌드가 로컬 머신에 기대므로 누가 빌드했느냐에 따라 산출물이 달라질 수 있다.

**위험·방어**

- 서명 없는 앱을 쓰라고 하는 것은 사용자가 출처를 스스로 믿어야 한다는 뜻이다. 릴리스 노트에 산출물의 SHA-256을 함께 적어 받은 파일을 확인할 수 있게 한다.
- Developer ID를 발급받거나 Intel·Windows 지원을 시작하면 이 결정을 다시 본다.
