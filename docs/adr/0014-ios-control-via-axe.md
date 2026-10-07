---
id: ADR-0014
title: iOS 입력·노드·스트림은 AXe로 한다
status: accepted
date: 2026-09-29
deciders: virtual-device-helper 팀
scope: [main, ios, streaming]
hosts: [macos]
supersedes:
superseded_by:
related_adr: [ADR-0003, ADR-0005, ADR-0016]
related_spec: m4-ios-simulator
related_architecture: main-layers
related_plan:
related_code: [axeClient.ts, simctlClient.ts, iosDevice.ts#IosDevice]
tags: [adr, ios, axe, dependency]
---

# ADR-0014: iOS 입력·노드·스트림은 AXe로 한다

## 맥락

로드맵은 M4를 "`simctl` 기반 `Device` 구현체"로 적었다. `simctl`은 부팅·앱·권한·스크린샷·로그를
다룬다. 그러나 `Device` 인터페이스의 입력(`tap`, `swipe`, `inputText`, `pressKey`), 노드 트리
(`dumpUi`), 실시간 화면 스트림은 `simctl`에 없다. 이 셋을 채울 외부 도구가 하나 필요하다.

## 결정

`simctl`과 함께 **AXe**(`cameroncooke/axe`, Swift CLI)를 쓴다. 사용자가 brew로 설치하고, 앱은
번들하지 않는다.

- `simctl`이 할 수 있는 일은 `simctl`로 한다. AXe는 입력·`describe-ui`·`stream-video`에만 쓴다.
- `axeClient.ts`가 `axe` 문법을 아는 유일한 층이다. `adbClient.ts`와 같은 자리다.
- `axe`가 없으면 해당 호출만 `ios_tool_not_found`를 낸다. `simctl` 기능은 계속 돈다.
- 설치 경로는 [ADR-0003](0003-no-bundled-android-sdk.md)과 같은 방침이다. 사용자가 설치한 도구를
  찾아 쓴다.

## 대안

- **idb** (`idb_companion` + Python 클라이언트) — `video-stream`이 H.264라 renderer의 WebCodecs
  경로를 그대로 쓴다. 그러나 companion(brew tap)과 클라이언트(pip) 둘을 설치해야 하고, 유지보수가
  느려졌으며 최신 Xcode 호환이 불확실하다.
  **→ 기각:** 설치 부담과 유지보수 위험이 스트림 형식의 이점보다 크다.
- **WebDriverAgent** (XCUITest runner) — 노드 트리가 가장 정확하고 MJPEG 스트림도 준다. 그러나
  첫 실행에 `xcodebuild`로 빌드해야 하고 Xcode 버전에 민감하다.
  **→ 기각:** "사용자가 한 줄로 설치한다"는 방침과 맞지 않고 첫 부팅이 느리다.
- **도구를 앱에 번들** — 설치 부담이 없다. 그러나 앱 크기·라이선스·서명 문제가 생기고
  [ADR-0009](0009-unsigned-arm64-mac-distribution.md)의 unsigned 배포와 충돌할 수 있다.
  **→ 기각:** 배포 방침을 흔든다.

## 영향

**긍정**

- 설치가 `brew install cameroncooke/axe/axe` 한 줄이다.
- 입력·노드·스트림을 한 도구가 맡아 경계가 하나다.

**트레이드오프**

- `stream-video`는 H.264가 아니라 MJPEG다. renderer에 JPEG 경로가 하나 더 생긴다
  ([ADR-0016](0016-stream-codec-per-session.md)).
- 호출마다 프로세스가 떠서 연속 제스처가 느리다. 화면 입력은 제스처를 모아 한 번에 보낸다.

**위험·방어**

- AXe는 CoreSimulator 비공개 API를 쓴다. Xcode가 올라가면 깨질 수 있다. `*.ios.integration.test.ts`
  를 Xcode 업데이트 때 돌리고, 깨지면 `axeClient.ts` 한 곳만 갈아 끼운다.
- 한 사람이 관리하는 도구다. 관리가 멈추면 idb나 WebDriverAgent로 옮긴다. `axeClient.ts` 경계
  덕분에 옮기는 비용이 이 층에 갇힌다.
