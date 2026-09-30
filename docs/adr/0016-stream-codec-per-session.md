---
id: ADR-0016
title: 스트림 코덱은 세션마다 정한다
status: accepted
date: 2026-09-29
deciders: virtual-device-helper 팀
scope: [main, renderer, shared, streaming, ios]
hosts: []
supersedes:
superseded_by:
related_adr: [ADR-0002, ADR-0010, ADR-0014, ADR-0015]
related_spec: m4-ios-simulator
related_architecture:
related_plan:
related_code: [stream.ts#StreamDown, streamManager.ts#StreamManagerDeps, scrcpySession.ts, axeStreamSession.ts, streamDecoder.ts, jpegRenderer.ts]
tags: [adr, streaming]
---

# ADR-0016: 스트림 코덱은 세션마다 정한다

## 맥락

Android 스트림은 scrcpy-server가 주는 H.264다([ADR-0002](0002-screen-streaming-via-scrcpy-server.md)).
renderer는 WebCodecs `VideoDecoder`로 H.264만 디코드한다. `StreamManagerDeps.createSession`은
`ScrcpySession` 타입에 묶여 있다.

iOS 스트림을 맡는 AXe `stream-video`([ADR-0014](0014-ios-control-via-axe.md))는 MJPEG를 준다.

## 결정

세션이 자기 코덱을 알리고 renderer가 그에 맞는 그리기 경로를 고른다.

- main의 세션을 `StreamSession` 인터페이스로 올린다. `ScrcpySession`과 `AxeStreamSession`이
  구현한다. 재연결·포트 관리는 `streamManager` 본체에 그대로 둔다.
- 포트 메시지 `session`에 `codec: 'h264' | 'jpeg'`와 `keys: DeviceKey[]`를 더한다.
- `StreamDown`에 JPEG 한 장을 담는 `frame` 메시지를 더한다.
- renderer는 `h264`면 `streamDecoder`, `jpeg`면 `jpegRenderer`를 쓴다. `jpegRenderer`는 최신
  프레임 한 장만 남긴다.
- 전송은 그대로 MessagePort다([ADR-0010](0010-stream-transport-message-port.md)).

## 대안

- **main에서 MJPEG를 H.264로 트랜스코딩** — renderer가 바뀌지 않는다.
  **→ 기각:** ffmpeg나 VideoToolbox 바인딩이라는 새 의존이 생기고, 인코딩 지연과 CPU가 더해진다.
- **iOS는 스크린샷 폴링** — 새 경로 없이 기존 강등 경로를 쓴다.
  **→ 기각:** "Android와 거의 같은 수준"이라는 M4 목표에 못 미친다. 폴링은 프레임률이 낮다.

## 영향

**긍정**

- 새 외부 의존이 없다. 브라우저 내장 `createImageBitmap`으로 끝난다.
- 코덱이 늘어도 세션과 renderer 경로 하나씩만 더하면 된다.

**트레이드오프**

- renderer에 그리기 경로가 둘이다. 좌표 변환과 입력은 두 경로가 같은 캔버스 크기를 공유해
  한 곳에 둔다.
- JPEG는 H.264보다 대역폭이 크다. 로컬 MessagePort라 문제가 작다.

**위험·방어**

- 두 경로가 크기·회전 처리에서 어긋날 수 있다. `session` 메시지의 `width`/`height`를 두 경로의
  유일한 크기 출처로 삼고, renderer 테스트에서 두 경로를 같은 입력으로 검증한다.
