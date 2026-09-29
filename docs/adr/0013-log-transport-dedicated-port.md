---
id: ADR-0013
title: 로그 전송은 용도별 전용 MessagePort로 한다
status: accepted                # proposed | accepted | superseded | deprecated
date: 2026-09-28
deciders: virtual-device-helper 팀   # 팀/역할 (실명·개인정보 금지)
scope: [main, preload, renderer]
hosts: []                       # windows | macos — 호스트 OS마다 결정이 갈릴 때만 채운다
supersedes:                     # 이 ADR이 대체하는 ADR-NNNN (없으면 비움)
superseded_by:                  # 이 ADR을 대체한 ADR-NNNN (없으면 비움)
related_adr: [ADR-0010, ADR-0008]
related_spec: m3-node-control-logs-events
related_architecture: main-layers
related_plan:
related_code: [preload/index.ts#api, ipc.ts#IPC_CHANNELS, ipc.ts#MainEvent, streamManager.ts#createStreamManager]
tags: [adr, logs, ipc]
---

# ADR-0013: 로그 전송은 용도별 전용 MessagePort로 한다

> 상태·날짜·결정자·대체 관계는 위 frontmatter가 단일 출처. 본문은 결정 내용에 집중한다.

## 맥락

M3의 로그 패널은 기기별 logcat을 실시간으로 보여 준다. 에뮬레이터는 초당 수백 줄을 낼 때가 있다.
M4의 iOS 로그(`log stream`)는 양이 더 많다.

main에서 renderer로 가는 통로는 지금 두 가지다.

- `app:event` — 방송 채널이다. 기기 연결·끊김, 활성 기기 변경, 툴 호출 같은 상태 이벤트가 흐른다.
- `app:stream-port` — [ADR-0010](0010-stream-transport-message-port.md)의 스트림 전용 포트다.

ADR-0010은 "범용 포트 통로는 만들지 않는다"고 정했다. 목적은 renderer에 임의의 통로를 열지 않는 것이다.

## 결정

로그는 **로그 전용 `MessagePort`**로 나른다. preload는 용도별로 고정된 포트 채널만 연다.

- renderer가 한 기기의 로그를 열면 main이 `MessageChannelMain`을 만들어 `app:log-port`로 보낸다.
  preload는 `app:stream-port`와 같은 방식으로 main world에 넘긴다.
- main에서 renderer로는 버퍼 스냅샷, 새 줄 배치, 밀려난 구간 알림, 패키지 목록, tail 상태가 흐른다.
- renderer에서 main으로는 전송 일시정지와 재개가 흐른다. main은 renderer에서 온 메시지를 모양으로 검증하고,
  맞지 않으면 버린다.
- 포트는 **전달** 수명만 맡는다. logcat tail과 버퍼는 기기 연결 수명을 따른다. 포트를 닫아도 버퍼는 남는다.
- 새 포트 채널은 용도가 정해진 것만 추가한다. 아무 포트나 받는 범용 통로는 여전히 만들지 않는다.
  ADR-0010의 원래 목적은 그대로다.

## 대안

- **`app:event`에 배치 이벤트 추가** — `MainEvent`에 로그 배치를 더한다. 새 채널과 새 preload 표면이 없다.
  그러나 방송 채널이라 구독 개념이 없다. 구독·해제 API를 따로 만들어야 한다. 해제를 놓치면 전송이 샌다.
  로그가 폭주하면 상태 이벤트가 뒤에 밀린다. M3의 타임라인은 상태 이벤트의 시각을 기록하므로 정확도가
  떨어진다.
  **→ 기각:** 통제 이벤트와 대량 데이터를 한 통로에 섞는다. 흐름 제어를 넣을 자리도 없다.
- **renderer 폴링** — renderer가 주기적으로 `seq` 이후 줄을 요청한다. main은 버퍼만 관리한다.
  그러나 지연이 폴링 주기에 묶인다. 빈 호출이 생긴다.
  **→ 기각:** 실시간 tail의 목적과 맞지 않는다.

전송 비용은 세 방식이 같다. 모두 structured clone으로 복사한다. 이 결정은 성능이 아니라 구조로 골랐다.

## 영향

**긍정**

- 로그 트래픽이 `app:event`와 분리된다. 상태 이벤트가 로그에 밀리지 않는다.
- 포트가 양방향이라 일시정지·재개 같은 흐름 제어를 같은 통로로 보낸다. 나중에 필터를 main 쪽으로 내려도
  구조가 그대로다.
- 기기별 포트라 M4의 iOS 로그와 여러 기기 동시 보기로 넓히기 쉽다.

**트레이드오프**

- preload에 두 번째 포트 채널이 생긴다. ADR-0010의 "포트 채널 하나"가 "용도별 포트 채널"로 넓어진다.
- 포트 수신, 검증, 수명 관리 코드가 스트림과 비슷하게 한 벌 더 생긴다.

**위험·방어**

- `window.postMessage` 수신 쪽은 ADR-0010과 같은 규칙을 따른다. 채널 이름, 출처, 포트 개수를 확인한다.
- 닫힌 포트로 늦게 온 배치는 포트와 함께 사라진다. 기기 전환 시 로그가 섞이지 않는다.
- 일시정지 뒤 재개하면 main이 `seq`로 빠진 구간을 이어 보낸다. 프로토콜 단위 테스트로 고정한다.
