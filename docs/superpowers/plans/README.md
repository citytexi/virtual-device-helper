# Plans

작업 계획 문서를 모은다. 다루는 것은 **"어떤 순서로 만들 것인가"** 다.

`superpowers:writing-plans`의 기본 출력 위치가 이 디렉토리다. 경로를 override하지 않으므로
스킬이 갱신돼도 위치가 어긋나지 않는다.

> 계획의 입력은 [`../specs/`](../specs/)의 스펙이고, 실행은
> `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans`가 맡는다.
>
> 형식 권위 출처: [`template.md`](template.md)

<!-- index:start -->
| 계획 | 상태 | 내용 |
|------|------|------|
| [agent-guide](2026-09-23-agent-guide.md) | draft | agentGuide 문구 → MCP instructions → useCopy → 에이전트 탭 → 탭 전환 → README → 수동 검증 |
<!-- index:end -->

## 아카이브

완료(`done`)·폐기(`abandoned`)된 계획은 `archived_reason`을 채우고 [`archive/`](archive/)로 옮긴 뒤
아래에 한 줄 남긴다. 폐기된 계획도 맥락 보존을 위해 지우지 않는다.

<!-- archive:start -->
| 계획 | 사유 |
|------|------|
| [m1-1-foundation-and-adb](archive/2026-09-22-m1-1-foundation-and-adb.md) | done — M1 구현 완료. Electron·TS 스캐폴딩, adbClient, scrcpy 스파이크(ADR-0002 유지) |
| [m1-2-android-device](archive/2026-09-22-m1-2-android-device.md) | done — M1 구현 완료. adb 파서, AndroidDevice, AvdController, DeviceRegistry |
| [m1-3-mcp-server](archive/2026-09-22-m1-3-mcp-server.md) | done — M1 구현 완료. MCP 툴, 응답 크기 상한, 루프백 HTTP 서버와 보안 기본값 |
| [m1-4-electron-shell-ui](archive/2026-09-22-m1-4-electron-shell-ui.md) | done — M1 구현 완료. IPC 계약, main 조립, 최소 renderer UI |
| [m1-5-integration-verification](archive/2026-09-22-m1-5-integration-verification.md) | done — M1 구현 완료. 실기기 통합 테스트와 완료 조건 검증, 결과는 스펙에 옮김 |
<!-- archive:end -->

## 작성 가이드

- 파일명: `YYYY-MM-DD-kebab-topic.md`.
- `python3 docs/script/docs.py new plan <slug> --title "<제목>"`이 날짜 접두사와 인덱스 등록을 한다.
- 계획을 손대면 `updated`를 갱신한다.
- 계획 본문의 Global Constraints에는 서브에이전트에게 닿아야 할 규약의 요지를 실어 나른다.
  루트 `CLAUDE.md`는 서브에이전트에게 자동으로 전달되지 않는다.

## Frontmatter (필수)

필드: `id` · `title` · `status`(draft / in-progress / done / abandoned / superseded) ·
`type`(work-order / handoff) · `created` · `updated` · `owner`(**실명 금지**) · `scope` · `hosts` ·
`archived_reason` · `related_adr` · `related_spec` · `related_architecture` · `related_plan` ·
`related_code` · `tags`.
