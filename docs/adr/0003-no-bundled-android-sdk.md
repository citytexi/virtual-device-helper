---
id: ADR-0003
title: Android SDK를 번들하지 않고 호스트 설치분을 쓴다
status: accepted
date: 2026-09-22
deciders: virtual-device-helper 팀
scope: [main, android, build]
hosts: []
supersedes:
superseded_by:
related_adr: ADR-0002
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan:
related_code:
tags: [adr, android, adb]
---

# ADR-0003: Android SDK를 번들하지 않고 호스트 설치분을 쓴다

## 맥락

앱은 `adb`로 기기를 제어하고 `emulator`·`avdmanager`로 AVD를 다룬다. 이 도구들을 앱에 번들할지,
호스트에 설치된 Android SDK를 찾아 쓸지 정해야 한다.

번들은 "사용자가 아무것도 설치하지 않아도 동작한다"는 매력이 있다. 그러나 `adb`는 그 전제가
성립하지 않는 도구다.

## 결정

Android SDK를 번들하지 않는다. 호스트에 설치된 SDK를 찾아 쓴다.

- 탐색 순서: `ANDROID_HOME` → `ANDROID_SDK_ROOT` → macOS 기본 설치 위치 → `PATH`.
- 찾지 못하면 앱은 조용히 실패하지 않는다. 무엇을 설치해야 하는지와 어디를 뒤졌는지를 화면에 띄운다.
- 찾은 SDK 경로를 UI에 표시한다. 사용자가 어느 설치분을 쓰는지 알 수 있어야 한다.
- `adb`의 버전 하한을 검사하지 않는다. 실제로 깨지는 명령이 나오면 그때 그 명령의 에러로 다룬다.

## 대안

- **`adb`를 앱에 번들** — 사용자 환경에 의존하지 않는다.
  **→ 기각:** `adb`는 머신당 서버 데몬 하나를 공유한다. 번들한 `adb`와 사용자의 `adb`가 버전이
  다르면 서로의 서버를 죽이고 새로 띄운다. 사용자가 터미널에서 쓰던 연결이 우리 앱 때문에 끊기고
  그 반대도 일어난다. 재현이 어렵고 원인이 우리 앱으로 보이지 않는다.
  게다가 얻는 것도 없다. 에뮬레이터를 돌리려면 SDK 전체와 시스템 이미지가 필요하고 AVD는
  Android Studio로 만든다. `adb`만 있어도 켤 기기가 없다.
- **SDK 전체를 번들** — 설치 없이 완결된다.
  **→ 기각:** 배포물이 수 GB가 된다. 라이선스 동의 절차와 시스템 이미지 다운로드가 따라온다.
  Android 개발자가 이미 가지고 있는 것을 중복으로 들고 다니는 셈이다.

## 영향

**긍정**

- adb 서버 데몬 충돌이 원천적으로 없다. 사용자의 터미널 작업과 앱이 같은 서버를 본다.
- 배포물이 작다. SDK 라이선스·시스템 이미지 배포 문제를 지지 않는다.
- 사용자가 이미 만들어 둔 AVD를 그대로 본다.

**트레이드오프**

- 사용자가 Android SDK를 먼저 설치해야 한다. 앱만으로는 시작할 수 없다.
- 호스트마다 SDK 경로가 달라 탐색 로직이 필요하다.
- 사용자의 SDK 버전이 너무 낮아 특정 명령이 없을 수 있다.

**위험·방어**

- SDK를 못 찾는 경우가 가장 흔한 최초 실패다. 안내 화면에 탐색한 경로를 모두 보여준다.
- 탐색 로직은 환경변수·파일시스템을 주입 가능한 형태로 두고 단위 테스트로 덮는다.
- `scrcpy-server.jar`은 이 결정의 예외다. 기기 안에서 도는 물건이고 버전 고정이 필요해 번들한다
  ([ADR-0002](0002-screen-streaming-via-scrcpy-server.md)).
