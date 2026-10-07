---
id: ADR-0018
title: JPEG 프레임은 renderer 확인을 받은 뒤 다음 장을 보낸다
status: accepted
date: 2026-10-06
deciders: virtual-device-helper 팀
scope: [main, renderer, shared, streaming]
hosts: []
supersedes:
superseded_by:
related_adr: [ADR-0010, ADR-0013, ADR-0016, ADR-0017]
related_spec: m5-multi-screen
related_architecture: main-layers
related_plan: [m5-2-jpeg-frame-ack, m5-3-screen-slots]
related_code: [stream.ts#StreamUp, streamManager.ts#createStreamManager, jpegRenderer.ts#createJpegRenderer, useScrcpyStream.ts#useScrcpyStream]
tags: [adr, streaming, flow-control]
---

# ADR-0018: JPEG 프레임은 renderer 확인을 받은 뒤 다음 장을 보낸다

> 상태·날짜·결정자·대체 관계는 위 frontmatter가 단일 출처. 본문은 결정 내용에 집중한다.

## 맥락

`jpeg` 세션([ADR-0016](0016-stream-codec-per-session.md))은 프레임 한 장을 포트 메시지 하나로 보낸다.
main은 renderer가 따라오는지 모른 채 받은 대로 보낸다. renderer의 `jpegRenderer.ts`가 최신 한 장만 그려
화면 지연은 쌓이지 않지만, renderer 이벤트 루프가 멈추면(중단점, 무거운 렌더) 포트 큐에 프레임이 계속 쌓인다.

화면을 둘 여는([ADR-0017](0017-screen-slots-separate-from-target.md)) 순간 이 양이 화면 수만큼 는다.

## 결정

`jpeg` 세션의 프레임은 **renderer가 앞 장을 받았다고 알린 뒤에만** 다음 장을 보낸다. 최신 한 장만 남기는
규칙을 받는 쪽이 아니라 보내는 쪽에서 건다.

- `StreamUp`에 `{ type: 'frame_ack' }`를 더한다. renderer는 프레임 한 장의 처리가 끝날 때마다(그렸든,
  버렸든, 실패했든) 그 프레임이 온 포트로 한 번 보낸다. 닫힌 뒤에는 보내지 않고, 연속 실패로 포기한 것도
  닫힘으로 본다.
- 흐름 상태는 `streamManager.ts`의 `Entry`에 둔다. 확인을 기다리는 동안 온 프레임 중 최신 한 장만 들고
  나머지는 버린다. 확인이 오면 그 한 장을 보낸다.
- **확인은 멱등이다.** 기다리는 중이 아닐 때 온 확인은 무시한다. 초과 확인은 해가 없고 누락만 화면을 멈춘다.
- 포트는 `open()`마다 하나이고 재연결은 같은 포트에 새 세션을 붙인다. 그래서 새 `session` 메시지를 보낼 때와
  재연결 때 흐름 상태를 비운다.
- **재동기.** `jpeg` 세션이 `streaming`인데 일정 시간 프레임이 없으면 renderer가 확인을 한 번 더 보낸다.
  누락이 영영 멈춘 화면이 되지 않게 한다.
- `frame_ack`는 `ControlIntent`가 아니다. 세션으로 넘기지 않는다.
- `h264` 세션은 이 규칙을 타지 않는다.

## 대안

- **지금대로 둔다(renderer에서만 버린다)** — 고칠 것이 없다. 그러나 renderer가 멈추면 메모리가 프레임 속도만큼
  자란다.
  **→ 기각:** 화면 수가 늘수록 커지는 문제를 구조에 남긴다.
- **main에서 시간 간격으로 솎아 낸다(고정 fps 상한)** — 확인 메시지가 필요 없다. 그러나 renderer가 실제로
  멈췄는지와 무관하게 보내므로 쌓이는 것을 막지 못하고, 빠른 renderer에서는 쓸데없이 프레임을 버린다.
  **→ 기각:** 받는 쪽 상태를 모르는 제한이다.
- **재동기 없이 확인만 둔다** — 프로토콜이 더 작다. 그러나 renderer의 출구 하나에서 확인을 빠뜨리는 버그가
  곧 영영 멈춘 화면이 된다.
  **→ 기각:** 누락에서 스스로 회복하게 한다.
- **h264에도 같은 규칙을 건다** — 한 가지 규칙으로 통일된다. 그러나 h264는 중간 프레임을 버리면 다음
  키프레임까지 화면이 깨진다.
  **→ 지금은 하지 않는다:** 키프레임 요청과 함께 따로 설계한다. 흐름 상태를 `Entry`에 둔 것은 codec별 규칙을
  붙일 자리를 남긴 것이다.

## 영향

**긍정**

- renderer가 멈춰도 쌓이지 않는다. main이 드는 대기 장은 entry마다 한 장이고, 전송 중인 장은 보통 한 장이다.
  `session`을 다시 보낸 뒤, 재연결 뒤, 재동기 확인이 기다리는 중에 닿은 뒤에는 한 장 더 날 수 있고 renderer의
  최신 한 장 칸이 흡수한다.
- 느린 renderer에서는 디코드할 수 없는 프레임을 보내지 않아 직렬화 비용도 준다.

**트레이드오프**

- 포트 프로토콜에 올라가는 메시지가 하나 늘고, `streamManager.ts`의 메시지 전달부에 상태가 생긴다.
  재연결·포트·세션 수명 로직은 바꾸지 않는다.
- 프레임마다 확인이 한 번 왕복한다. fps에 주는 영향은 재 봐야 안다.

**위험·방어**

- 확인 누락: `jpegRenderer`의 모든 출구에서 한 번씩 보내는지 단위 테스트로 고정하고, 재동기 확인으로 한 번 더
  막는다. `close()` 뒤에는 보내지 않는다.
- 옛 확인이 새 세션에 닿는 경우: 흐름 상태를 `Entry`에 두고 `session`·재연결 때 비운다. 확인이 멱등이라
  늦게 온 확인이나 기다리는 중에 닿은 재동기 확인은 최악에도 한 장을 일찍 보낼 뿐이다. 순서가 뒤바뀌거나
  같은 장이 두 번 가지는 않는다.
- 창을 가렸을 때: `jpegRenderer`는 그리기를 화면 갱신에 맞추지 않으므로 확인이 계속 올 수 있다. 실제 동작은
  재 본 뒤 가려진 칸의 스트림을 멈출지 정한다(M5 스펙의 열린 질문).
