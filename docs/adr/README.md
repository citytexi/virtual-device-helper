# Architecture Decision Records

virtual-device-helper의 구조 결정을 기록한다. 기록하는 것은 **"왜 이렇게 결정했는가"** 하나다.

> ADR 형식: [Michael Nygard의 경량 ADR](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) 기반
>
> 형식 권위 출처: [`template.md`](template.md)

<!-- index:start -->
| ADR | 제목 | 상태 | 날짜 | 비고 |
|-----|------|------|------|------|
| [0001](0001-mcp-transport-http-in-app.md) | MCP 전송은 앱 내장 Streamable HTTP | accepted | 2026-09-22 | 앱 없이는 툴도 없다. 루프백·토큰·Origin 3중 방어 |
| [0002](0002-screen-streaming-via-scrcpy-server.md) | 화면 스트리밍은 scrcpy-server.jar 직접 통신 | accepted | 2026-09-22 | server.jar만 번들. 클라이언트는 직접 구현. M1 스파이크로 선검증 |
| [0003](0003-no-bundled-android-sdk.md) | Android SDK를 번들하지 않고 호스트 설치분을 쓴다 | accepted | 2026-09-22 | adb 서버 데몬이 머신당 하나라 번들하면 충돌한다 |
| [0004](0004-hybrid-mcp-tool-surface.md) | MCP 툴 표면은 저수준 전부 + 고수준 소수 | accepted | 2026-09-22 | uiautomator 덤프를 그대로 못 주므로 순수 저수준안은 불성립 |
| [0005](0005-device-interface-abstraction.md) | 타깃 디바이스는 Device 인터페이스로 가른다 | accepted | 2026-09-22 | 구현체는 AndroidDevice 하나. iOS는 M4에서 인터페이스를 넓힌다 |
| [0006](0006-build-stack-electron-vite.md) | 빌드 스택은 electron-vite + electron-builder + React | accepted | 2026-09-22 | 세 타깃이 한 설정·한 타입 체계를 공유 |
| [0007](0007-xml-parsing-library.md) | uiautomator 덤프 파싱에 fast-xml-parser를 들인다 | accepted | 2026-09-22 | 정규식은 조용히 노드를 흘린다. 파서는 parseUiDump 한 곳에 가둔다 |
| [0008](0008-log-read-response-shape.md) | log_read 응답은 압축 한 줄 문자열과 바이트 예산으로 준다 | accepted | 2026-09-23 | 줄 수 상한만으론 인라인 한도를 못 막았다. 구조화된 LogLine은 툴 층 아래에 남긴다 |
| [0009](0009-unsigned-arm64-mac-distribution.md) | 배포는 서명 없는 macOS arm64 dmg·zip으로 한다 | accepted | 2026-09-23 | Developer ID 없음, Intel·Windows 미지원 |
<!-- index:end -->

## 언제 ADR을 쓰는가

스펙이나 계획을 쓰다가 아래 중 하나라도 걸리면 대응 ADR을 같은 라운드에 만든다.

- **되돌리기가 비싼 선택** — 나중에 바꾸려면 여러 모듈을 동시에 고쳐야 하는 것.
- **실재한 대안을 기각했다** — 비교 대상이 실제로 있었고 그중 하나를 골랐다.
- **다른 결정을 제약한다** — 이 선택 때문에 뒤따르는 선택지가 좁아진다.
- **외부 의존이나 SDK를 새로 들인다** — 버전·플랫폼 제약이 따라 들어온다.

반대로 되돌리기 싼 선택, 대안이 없던 선택, 한 파일 안에서 끝나는 선택은 ADR로 만들지 않는다.
스펙 본문에 한 줄 적는 것으로 충분하다.

## 작성 가이드

- 파일명: `NNNN-kebab-case-title.md` (예: `0001-electron-desktop-shell.md`). 번호는 4자리, 순차 증가.
- `python3 docs/script/docs.py new adr <slug> --title "<제목>"`이 번호 채번·날짜 기입·아래 인덱스 등록을 한다.
- 인덱스 행과 ADR 파일은 **같은 커밋**에 들어간다.
- 상태: `proposed` / `accepted` / `superseded` / `deprecated`.
- 결정을 번복하면 구 문서에 `status: superseded` + `superseded_by`, 신 문서에 `supersedes`를 쓴다.

## ⛔ 라인번호·수치 금지 규칙

ADR은 코드와 함께 바뀌어 금방 거짓이 되는 정보를 **적지 않는다.**

**적지 말 것**

- **라인번호** — `main.ts:34` 같은 `:NN`. refactor 한 번에 전부 어긋난다.
- **파일·화면 개수** — "핸들러 12개".
- **진행률·비율** — "약 70% 이행".
- **사용 횟수** — "이 API 206회 호출".

**적을 것**

- **파일명 + 심볼명** — `mcpBridge.ts`의 `registerTools`, `DeviceSession`의 `attachLogStream`.
  심볼명은 라인번호보다 훨씬 오래 산다.
- **설계 결정·대안·트레이드오프** — ADR의 본질. 코드가 안 바뀌는 한 유효하다.
- **방향성** — 수치 없이 "A에서 B로 수렴".

지금 수치가 필요하면 그때 코드에서 직접 센다. 한 번 거짓이 된 수치가 섞이면 문서 전체의 신뢰가 깨진다.

## Frontmatter (필수)

필드: `id`(ADR-NNNN) · `title` · `status` · `date` · `deciders`(팀/역할, **실명 금지**) · `scope` ·
`hosts` · `supersedes` · `superseded_by` · `related_adr` · `related_spec` · `related_architecture` ·
`related_plan` · `related_code` · `tags`.

`python3 docs/script/docs.py lint`이 필수 필드·상태값·인덱스 등록 여부를 검사한다.
