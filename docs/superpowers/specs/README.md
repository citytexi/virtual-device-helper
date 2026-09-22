# Specs

구현 전에 확정한 **설계 스펙**을 모은다. 다루는 것은 **"무엇을 만들 것인가"** 다.

`superpowers:brainstorming`의 기본 출력 위치가 이 디렉토리다. 경로를 override하지 않으므로
스킬이 갱신돼도 위치가 어긋나지 않는다.

> `specs/`는 구현 직전의 확정 설계, [`../../adr/`](../../adr/)는 결정의 근거,
> [`../../architecture/`](../../architecture/)는 상시 구현 가이드,
> [`../plans/`](../plans/)는 작업 순서를 다룬다.
>
> 근거는 파일명 + 심볼명으로. 라인번호·변동 수치는 적지 않는다
> (규칙 상세: [`../../adr/README.md`](../../adr/README.md)).
>
> 형식 권위 출처: [`template.md`](template.md)

<!-- index:start -->
| 스펙 | 상태 | 내용 |
|------|------|------|
| [m1-device-core-mcp-server](2026-09-22-m1-device-core-mcp-server.md) | draft | macOS×Android 기기 제어 코어와 앱 내장 MCP 서버. 툴 네 묶음, 최소 UI, M2 스파이크 |
<!-- index:end -->

## 아카이브

구현이 끝난 스펙은 `status: implemented`로 바꾸고 [`archive/`](archive/)로 옮긴 뒤 아래에 한 줄 남긴다.

<!-- archive:start -->
| 스펙 | 내용 |
|------|------|
<!-- archive:end -->

## 작성 가이드

- 파일명: `YYYY-MM-DD-kebab-topic.md`.
- `python3 docs/script/docs.py new spec <slug> --title "<제목>"`이 날짜 접두사와 인덱스 등록을 한다.
- 스펙이 새 구조 결정을 유발하면 대응 ADR을 [`../../adr/`](../../adr/)에 함께 만들고 `related_adr`로 잇는다.
  ADR을 만드는 기준은 [`../../adr/README.md`](../../adr/README.md)에 있다.
- 스펙이 끝나면 [`../plans/`](../plans/)의 계획으로 넘어간다 (`superpowers:writing-plans`).

## Frontmatter (필수)

필드: `id` · `title` · `status`(draft / in-progress / implemented / superseded) · `verified` ·
`scope` · `hosts` · `supersedes` · `superseded_by` · `related_adr` · `related_spec` ·
`related_architecture` · `related_plan` · `related_code` · `tags`.
