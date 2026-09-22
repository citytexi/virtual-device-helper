---
id: ADR-0002
title: 화면 스트리밍은 scrcpy-server.jar 직접 통신
status: accepted
date: 2026-09-22
deciders: virtual-device-helper 팀
scope: [main, renderer, streaming, android]
hosts: []
supersedes:
superseded_by:
related_adr: ADR-0003
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan:
related_code:
tags: [adr, streaming, scrcpy]
---

# ADR-0002: 화면 스트리밍은 scrcpy-server.jar 직접 통신

## 맥락

앱은 기기 화면을 Electron 창 안에 실시간으로 그려야 하고, 사람이 그 화면을 직접 눌러 기기를
조작할 수 있어야 한다. 에이전트만 기기를 만지는 것으로는 부족하다.

scrcpy는 두 조각이다. 기기에 푸시되어 화면을 인코딩하고 입력을 주입하는 `scrcpy-server.jar`,
그리고 그것을 받아 그리는 데스크탑 클라이언트다. 둘 사이는 adb 포워딩된 소켓으로 이어진다.

## 결정

`scrcpy-server.jar`을 앱에 번들하고, 데스크탑 클라이언트 역할을 직접 구현한다.

- 앱이 jar을 기기에 푸시하고 실행한 뒤, adb 포워딩된 소켓에서 H.264 스트림을 받는다.
- 번들한 jar의 버전을 고정한다. 호스트에 설치된 scrcpy는 쓰지 않는다.
- main은 소켓에서 읽은 H.264 청크를 디코딩하지 않고 renderer로 릴레이한다.
- renderer가 WebCodecs `VideoDecoder`로 디코딩해 그린다.
- 사람의 마우스·키보드 입력은 같은 연결의 control message로 되돌려 보낸다.
- 실제 구현은 M2다. M1에서는 "첫 키프레임을 WebCodecs로 디코딩해 한 프레임을 그린다"까지만
  확인하는 스파이크를 돌리고 코드는 버린다.

## 대안

- **scrcpy 데스크탑 바이너리를 자식 프로세스로 실행** — 구현이 가장 적고 검증된 클라이언트를
  그대로 쓴다.
  **→ 기각:** scrcpy가 자기 OS 창을 띄운다. Electron 창 안에 넣을 수 없어 한 화면에 모아 보겠다는
  목적 자체가 깨진다. 호스트마다 바이너리를 번들하거나 사용자 설치에 기대야 하는 부담도 붙는다.
- **`adb exec-out screencap` 폴링** — 외부 바이너리 의존이 없고 구현이 가장 싸다.
  **→ 기각:** 프레임 레이트가 낮아 애니메이션·스크롤을 볼 수 없고 지연이 크다. 입력 주입 경로도
  따로 만들어야 한다. 나중에 실시간으로 옮길 때 화면 파이프라인 전체를 다시 쓴다.
- **main에서 ffmpeg으로 디코딩** — renderer의 WebCodecs 지원에 기대지 않는다.
  **→ 기각:** 디코딩된 RGB 프레임을 프로세스 경계로 넘기면 대역폭이 압축 스트림의 수십 배가 된다.
  ffmpeg 바이너리 번들과 호스트별 빌드도 따라온다. WebCodecs 스파이크가 실패하면 이 안을 다시 검토한다.

## 영향

**긍정**

- 화면이 Electron 창 안에 완전히 들어온다. 로그·타임라인과 한 화면에 놓인다.
- 입력 주입이 비디오와 같은 연결을 쓴다. 별도 경로를 만들지 않는다.
- 디코딩이 Chromium의 하드웨어 디코더를 타므로 main이 프레임 데이터로 막히지 않는다.
- jar 버전을 고정하므로 사용자 머신의 scrcpy 설치 여부·버전과 무관하다.

**트레이드오프**

- scrcpy의 소켓 프로토콜에 의존한다. 문서가 얇고 버전마다 바뀐다.
- jar 업그레이드가 우리 파서의 변경을 요구할 수 있다.
- 구현 난도가 세 대안 중 가장 높다.

**위험·방어**

- 프로토콜 파싱과 WebCodecs 디코딩이 이 프로젝트에서 가장 불확실하다. M1 초반에 스파이크로
  먼저 확인한다. 실패하면 ffmpeg 디코딩 안으로 후퇴하고 이 ADR을 대체한다.
- jar 버전은 고정해서 저장소에 둔다. 올릴 때는 프로토콜 변경 확인을 동반한다.
