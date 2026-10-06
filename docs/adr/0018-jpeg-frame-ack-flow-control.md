---
id: ADR-0018
title: JPEG 프레임은 renderer 확인을 받은 뒤 다음 장을 보낸다
status: accepted
date: 2026-10-06
deciders: virtual-device-helper 팀
scope: [main, renderer, shared, streaming, ios]
hosts: []
supersedes:
superseded_by:
related_adr: [ADR-0010, ADR-0013, ADR-0016, ADR-0017]
related_spec: m5-multi-screen
related_architecture: main-layers
related_plan:
related_code: [stream.ts#StreamUp, streamManager.ts#createStreamManager, jpegRenderer.ts#createJpegRenderer, useScrcpyStream.ts#useScrcpyStream]
tags: [adr, streaming, flow-control]
---

# ADR-0018: JPEG 프레임은 renderer 확인을 받은 뒤 다음 장을 보낸다

> 상태·날짜·결정자·대체 관계는 위 frontmatter가 단일 출처. 본문은 결정 내용에 집중한다.

## 맥락

`jpeg` 세션([ADR-0016](0016-stream-codec-per-session.md))은 프레임 한 장을 포트 메시지 하나로 보낸다.
main은 renderer가 따라오는지 모른 채 받은 대로 보낸다. renderer의 `jpegRenderer.ts`가 최신 한 장만 그려
화면 지연은 쌓이지 않지만, renderer 이벤트 루프가 멈추면(중단점, 무거운 렌더) 포트 큐에 프레임이 계속 쌓인다.

화면을 둘 여는([ADR-0017](0017-screen-slots-separate-from-target.md)) 순간 이 양이 두 배가 되고, 칸을 늘리면
칸 수만큼 는다.

## 결정

`jpeg` 세션의 프레임은 **renderer가 앞 장을 받았다고 알린 뒤에만** 다음 장을 보낸다. 최신 한 장만 남기는
규칙을 받는 쪽이 아니라 보내는 쪽에서 건다.

- `StreamUp`에 `{ type: 'frame_ack' }`를 더한다. renderer는 `frame` 한 장을 그렸거나, 버렸거나, 디코드에
  실패했을 때 한 번 보낸다.
- main의 프레임 전달부는 확인을 기다리는 동안 온 프레임 중 최신 한 장만 들고 나머지는 버린다. 확인이 오면
  그 한 장을 보낸다.
- main에 남는 것은 칸마다 최대 한 장이다.
- `session` 메시지를 새로 보낼 때와 포트가 바뀔 때 기다림 상태를 비운다.
- `h264` 세션은 이 규칙을 타지 않는다.

## 대안

- **지금대로 둔다(renderer에서만 버린다)** — 고칠 것이 없다. 그러나 renderer가 멈추면 메모리가 프레임 속도만큼
  자란다.
  **→ 기각:** 화면 수가 늘수록 커지는 문제를 구조에 남긴다.
- **main에서 시간 간격으로 솎아 낸다(고정 fps 상한)** — 확인 메시지가 필요 없다. 그러나 renderer가 실제로
  멈췄는지와 무관하게 보내므로 쌓이는 것을 막지 못하고, 빠른 renderer에서는 쓸데없이 프레임을 버린다.
  **→ 기각:** 받는 쪽 상태를 모르는 제한이다.
- **프레임 버퍼를 transfer로 넘긴다** — 복사를 없앤다. 그러나 큐가 쌓이는 문제와는 다른 문제이고,
  `MessagePortMain`의 transfer는 포트만 받는다.
  **→ 기각:** 해당 없음.
- **h264에도 같은 규칙을 건다** — 한 가지 규칙으로 통일된다. 그러나 h264는 중간 프레임을 버리면 다음
  키프레임까지 화면이 깨진다.
  **→ 지금은 하지 않는다:** 키프레임 요청과 함께 따로 설계한다. M5 스펙의 열린 질문에 남긴다.

## 영향

**긍정**

- renderer가 멈춰도 main과 포트에 쌓이는 양이 칸마다 한 장으로 묶인다.
- 느린 renderer에서는 디코드할 수 없는 프레임을 보내지 않아 직렬화 비용도 준다.

**트레이드오프**

- 포트 프로토콜에 올라가는 메시지가 하나 늘고, `streamManager.ts`의 메시지 전달부에 상태가 생긴다.
  재연결·포트·세션 수명 로직은 바꾸지 않는다.
- renderer가 확인을 빠뜨리면 그 칸의 화면이 멈춘다.

**위험·방어**

- 확인 누락: `jpegRenderer`의 세 출구(그림·버림·실패) 각각에서 한 번씩 보내는지 단위 테스트로 고정한다.
  `close()` 뒤에는 보내지 않는다.
- 세션이 바뀐 뒤 옛 확인이 늦게 오는 경우: 포트가 세션마다 새로 만들어지므로 옛 포트의 확인은 새 세션에
  닿지 않는다.
- 확인이 영영 오지 않는 경우(가려진 창): 세션은 유지되고 최신 한 장만 든다. 창이 돌아와 확인이 오면 그
  장부터 이어진다.
