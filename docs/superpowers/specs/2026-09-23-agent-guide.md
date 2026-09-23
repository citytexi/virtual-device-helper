---
id: agent-guide
title: 에이전트 사용 안내와 프롬프트 템플릿
status: implemented
verified: 2026-09-23
scope: [main, renderer, mcp, shared, docs]
hosts: []
supersedes:
superseded_by:
related_adr: ADR-0001, ADR-0004
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan:
related_code: src/main/mcp/httpServer.ts#startMcpHttpServer, src/renderer/src/components/WorkArea.tsx#WorkArea, src/renderer/src/components/EndpointCard.tsx#EndpointCard
tags: [spec, agent, mcp, prompt]
---

# Spec: 에이전트 사용 안내와 프롬프트 템플릿

> 상태·날짜·관련 문서는 위 frontmatter가 단일 출처. 본문은 설계 내용에 집중한다.

## 목표

다른 프로젝트에서 만든 Android 앱을 이 앱에 붙여 Claude Code로 테스트하는 방법을 세 곳에서 알려 준다.

- **README**: 사람이 읽는 설명서다.
- **앱 안 "에이전트" 탭**: 연결 명령과 프롬프트를 복사한다. GitHub에서 README를 찾아 읽지 않아도 된다.
- **MCP 서버 `instructions`**: 연결한 에이전트가 툴 사용 규칙을 자동으로 받는다.

지금은 README의 "에이전트 붙이기"가 설정 JSON을 붙이라는 말뿐이다. 붙인 뒤 어떤 툴을 어떤 순서로
부르면 되는지, 에이전트에게 무엇을 시키면 되는지 알려 주는 곳이 없다.

## 전제로 삼는 사용 흐름

1. 사용자가 이 앱을 켜고 AVD를 부팅한다.
2. 테스트할 앱의 프로젝트 폴더에서 Claude Code를 켠다.
3. 앱의 에이전트 탭에서 연결 명령을 복사해 실행한다(`claude mcp add ...`).
4. 에이전트 탭에서 용도에 맞는 프롬프트를 복사해 Claude Code에 붙인다.
5. 에이전트가 그 프로젝트를 빌드해 APK를 만들고, 이 앱의 MCP 툴로 설치·실행·조작·관찰한다.

## 범위

- 포함
  - `src/shared/agentGuide.ts` — 안내 문구를 만드는 순수 함수. 단일 출처다.
  - MCP 서버 초기화에 `instructions`를 싣는다.
  - `WorkArea`의 탭 전환을 실제로 동작하게 하고, "에이전트" 탭(`AgentTab`)을 더한다.
  - 복사 동작과 성공·실패 표시를 공용 hook으로 뽑는다. `EndpointCard`와 `AgentTab`이 함께 쓴다.
  - README에 "에이전트로 테스트하기" 섹션을 쓴다.
  - README와 등록된 툴 목록이 어긋나지 않게 하는 테스트를 넣는다.
- 제외
  - Claude Code 외 클라이언트(Codex CLI, Cursor 등)의 연결 안내. 범용 설정 JSON 복사는 지금처럼 상단 바에 남는다.
  - 템플릿 빈칸을 앱 안 입력 폼으로 채우는 기능.
  - 토큰 고정·재사용. 보안 결정이라 따로 다룬다(열린 질문).
  - 툴 동작 변경. 이 스펙은 안내만 바꾼다.

## 인터페이스

```ts
// src/shared/agentGuide.ts
import type { ServerStatus } from './types/ipc'

export type PromptTemplateId = 'smoke' | 'scenario' | 'bug-repro'

export interface PromptTemplate {
  id: PromptTemplateId
  label: string        // 탭에 보이는 이름: '스모크 테스트' | '시나리오 E2E' | '버그 재현'
  description: string  // 언제 쓰는지 한 줄
  body: string         // 복사될 프롬프트 본문
}

/** MCP 초기화 응답의 instructions. 기기·세션과 무관한 고정 문구다. */
export function serverInstructions(): string

/** 대상 기기 serial이 있으면 본문에 채운다. 없으면 device_list로 고르라는 문장을 넣는다. */
export function promptTemplates(targetSerial: string | null): PromptTemplate[]

/** `claude mcp add` 한 줄. 토큰이 들어간다 — 복사 전용이다. */
export function claudeCodeCommand(server: ServerStatus): string

/** 화면 표시용. claudeCodeCommand와 같되 토큰 자리를 가린다. */
export function claudeCodeCommandMasked(server: ServerStatus): string
```

```ts
// src/renderer/src/hooks/useCopy.ts
export type CopyStatus = { ok: true } | { ok: false; message: string }

/** navigator.clipboard.writeText를 감싸고 마지막 결과를 상태로 돌려준다. */
export function useCopy(): { status: CopyStatus | null; copy(text: string): Promise<void> }
```

- `serverInstructions`는 `startMcpHttpServer`가 요청마다 만드는 `McpServer`의 두 번째 인자
  `{ instructions }`로 넘긴다. 테스트 하네스(`testHarness.ts`의 `createToolHarness`)도 같은 옵션으로
  만들어, 테스트 클라이언트가 `getInstructions()`로 받아 볼 수 있게 한다.
- `claudeCodeCommand`의 모양은 다음과 같다. 서버 이름은 `SERVER_INFO.name`과 같은 `virtual-device-helper`다.

  ```
  claude mcp add --transport http virtual-device-helper <url> --header "Authorization: Bearer <token>"
  ```

## 문구 내용

### `serverInstructions`

에이전트가 매번 지켜야 할 규칙만 짧게 담는다. 각 툴의 설명(description)과 겹치는 내용은 반복하지 않는다.

- 대상 기기가 불분명하면 `device_list`로 확인하고 `device_select`로 고른다.
- 좌표를 추측하지 않는다. `ui_find`로 요소를 찾은 뒤 그 좌표로 `ui_tap`을 부른다.
- 조작한 다음에는 `screenshot` 또는 `ui_find`로 결과를 확인하고 나서 다음 단계로 간다.
- 실패하거나 앱이 죽은 것 같으면 `log_read`로 로그를 본다. 새 시도 전에 `log_clear`를 부르면 로그 범위가 좁아진다.
- 깨끗한 상태에서 다시 시작하려면 `app_reset_and_launch`를 쓴다.
- 에러 응답의 `hint`를 읽고 그대로 복구를 시도한다.

### `promptTemplates`

세 템플릿의 공통 규칙이다.

- 토큰·URL을 넣지 않는다. 연결은 연결 명령이 맡고, 프롬프트에는 테스트 지시만 담는다.
  대화 기록은 남고 공유되기도 하므로 토큰이 거기 들어가면 안 된다.
- 자리표시자는 `<패키지명>`·`<APK 경로>`·`<시나리오>`처럼 꺾쇠로 둔다. 에이전트에게 "모르면 프로젝트에서
  찾아라(예: `applicationId`, 빌드 산출물 경로)"라고 지시한다.
- 대상 기기 serial만 앱이 채운다.
- 결과 보고 형식을 정해 둔다. 단계별 성공·실패, 실패한 단계의 스크린샷 여부, 관련 로그 발췌를 담는다.

템플릿별 요지는 다음과 같다.

- **스모크 테스트**: 빌드 → `app_install` → `app_launch` → 첫 화면 `screenshot` → `log_read`로
  크래시·ANR이 있는지 확인한다. "실행되고 죽지 않는가"만 본다.
- **시나리오 E2E**: `<시나리오>` 칸에 사용자가 단계를 적는다. 에이전트는 단계마다 `ui_find` → 조작 →
  확인을 반복하고, 기대와 다르면 거기서 멈추고 보고한다.
- **버그 재현**: `<증상>`과 `<재현 단계(알면)>` 칸이 있다. 에이전트는 `app_reset_and_launch`로 깨끗하게
  시작하고, 재현을 시도하고, 재현되면 스크린샷과 로그를 모은다. 재현되지 않으면 시도한 경로를 보고한다.

## 동작 / 상태

- **`WorkArea` 탭**: "활동"과 "에이전트" 두 탭이다. 선택 상태는 `WorkArea`의 로컬 state로 둔다(기본값: 활동).
  WAI-ARIA tabs 패턴을 따른다. 좌우 화살표로 탭을 옮기고, 선택되지 않은 패널은 `hidden`으로 둔다.
- **`AgentTab`의 "연결" 영역**
  - `claudeCodeCommandMasked`를 보여 주고, 복사 버튼은 `claudeCodeCommand`를 복사한다.
  - 토큰이 앱을 켤 때마다 바뀐다는 안내와 다시 등록하는 명령(`claude mcp remove virtual-device-helper`)을 함께 둔다.
  - `server`가 `null`이면 연결 영역 대신 "서버가 떠 있지 않다"는 안내를 보여 준다. `EndpointCard`와 같은 문구다.
- **`AgentTab`의 "프롬프트" 영역**
  - 템플릿 선택기, 선택한 템플릿의 `description`, 본문 미리보기(`<pre>`), 복사 버튼으로 구성한다.
  - 선택 상태는 탭 안 로컬 state로 둔다(기본값: 스모크 테스트).
  - 대상 기기가 바뀌면 미리보기가 새 serial로 다시 그려진다.
- **복사**: `useCopy`가 버튼 옆에 `role="status"`로 "복사했다" 또는 "복사하지 못했다 — <이유>"를 보여 준다.
  `EndpointCard`의 기존 동작과 같고, 그 코드를 이 hook으로 옮긴다.

## 실패 처리

- **클립보드 쓰기 실패**: 사용자에게 보이는 결과는 지금 `EndpointCard`와 같다. 실패 이유를 버튼 옆에 보여 주고, 삼키지 않는다.
- **서버가 없음**(`server === null`): 연결 영역을 안내 문구로 바꾼다. 프롬프트 영역은 그대로 쓸 수 있다. 프롬프트에는 연결 정보가 없기 때문이다.
- **대상 기기가 없음**: 템플릿 본문에 "`device_list`로 실행 중인 기기를 확인하고 `device_select`로 골라라"를 넣는다.
- **`instructions`를 무시하는 클라이언트**: 동작에는 영향이 없다. 프롬프트 템플릿에도 핵심 규칙이 한 번 더 들어간다.

## README "에이전트로 테스트하기"

기존 "에이전트 붙이기" 섹션을 이 섹션으로 바꾼다.

- **연결**: 에이전트 탭의 명령을 복사해 실행한다. 토큰이 바뀌면 remove 후 다시 add한다.
  다른 MCP 클라이언트는 상단 바의 "설정 JSON 복사"를 쓴다.
- **툴 목록**: 묶음별(device · app · ui · observe) 표에 툴 이름과 한 줄 설명을 적는다.
- **전형적인 흐름**: 빌드 → 설치 → 실행 → 찾기 → 조작 → 확인 → 로그.
- **프롬프트**: 에이전트 탭에서 복사하라는 안내와 세 템플릿의 쓰임새를 적는다. 본문은 README에 싣지 않는다.
  단일 출처는 `agentGuide.ts`다.
- **자주 나는 실패와 복구**: 에러 `kind`별(`no_device`, `package_not_found`, `apk_path_invalid` 등)로 무엇을 하면 되는지 적는다.

## 테스트

- **`agentGuide.test.ts`**
  - 모든 템플릿 본문과 `serverInstructions`에 토큰 문자열이 들어가지 않는다. 가짜 서버 상태의 토큰으로 검사한다.
  - 대상 serial이 있으면 본문에 그 serial이 들어가고, 없으면 `device_list` 안내가 들어간다.
  - `claudeCodeCommand`에는 URL과 토큰이 들어가고, `claudeCodeCommandMasked`에는 토큰이 없다.
- **툴 이름 일치 테스트**(`src/main/mcp/guideConsistency.test.ts`): 하네스의 `listTools`를 기준으로 두 방향을 본다.
  shared 층은 main의 하네스를 import할 수 없어 이 테스트를 main 쪽에 둔다.
  - 등록된 모든 툴 이름이 README의 "에이전트로 테스트하기" 섹션에 나온다.
  - `serverInstructions`와 템플릿 본문이 언급하는 툴 이름(백틱 안의 `snake_case`)은 모두 등록된 툴이다.
- **`createToolHarness` 경유 테스트**: 클라이언트가 `getInstructions()`로 `serverInstructions()`와 같은 값을 받는다.
- **`WorkArea` 테스트**: 탭을 클릭하거나 화살표 키로 옮기면 패널이 바뀐다.
- **`AgentTab` 테스트**
  - 템플릿을 고르면 미리보기가 바뀐다.
  - 복사 버튼은 토큰이 들어간 명령을 복사하지만, 화면 텍스트에는 토큰이 없다.
  - `server === null`이면 안내 문구가 나온다.
- **`useCopy` 테스트**: 성공과 실패 상태를 보여 준다. 기존 `EndpointCard` 테스트는 그대로 통과해야 한다.
- **수동 확인**: 실제 앱을 켜고 에이전트 탭의 명령으로 `claude mcp add`를 실행한다. Claude Code에서 연결한 뒤
  스모크 테스트 프롬프트로 한 번 돌려, `instructions`가 전달되는지와 흐름이 끝까지 가는지 본다.

## 검증 결과 (2026-09-23)

- **단위 테스트**: `npm test` 전부 통과. `npm run typecheck` 에러 없음.
- **연결**: 에이전트 탭의 명령과 같은 값으로 임시 폴더에서 `claude mcp add`를 실행했다.
  `claude mcp list`에서 `virtual-device-helper: http://127.0.0.1:9321/mcp (HTTP) - ✔ Connected`로 보였다.
  확인 뒤 `claude mcp remove virtual-device-helper`로 지웠다.
- **instructions 전달**: 같은 폴더에서 `claude -p`로 "서버가 보낸 instructions를 그대로 인용하라"고 물었다.
  `serverInstructions()`의 첫 문장과 규칙 목록이 글자 그대로 나왔다. Claude Code가 `instructions`를 에이전트
  컨텍스트에 넣는 것을 관찰했다.
- **화면**: 라이트·다크 모두에서 명령 블록과 미리보기가 읽혔다. 문서 높이가 창 높이와 같아 창 전체 스크롤은 없다.
  화면 텍스트에 실제 토큰이 없음을 renderer에서 스냅샷의 토큰과 대조해 확인했다.
- **관찰한 불편**: 에이전트 탭은 1440x900 창에서 패널 높이를 조금 넘어 탭 안에서 스크롤된다. "프롬프트 복사"
  버튼이 미리보기 아래에 있어 처음 화면에서는 보이지 않는다.
- **해 보지 않은 것**: 스모크 테스트 프롬프트로 실제 Android 프로젝트를 빌드·설치하는 흐름은 돌리지 않았다.
  이 자리에 테스트할 Android 프로젝트가 없었고, 부팅된 에뮬레이터도 없었다. 시나리오 E2E와 버그 재현 템플릿도
  실제로 돌리지 않았다.

## 파일 구성

- `src/shared/agentGuide.ts`, `src/shared/agentGuide.test.ts` — 문구 생성과 그 테스트.
- `src/main/mcp/httpServer.ts` — `McpServer` 생성에 `instructions`를 더한다.
- `src/main/mcp/testHarness.ts` — 같은 옵션으로 만든다.
- `src/main/mcp/guideConsistency.test.ts` — README·안내 문구와 등록된 툴 이름의 일치 테스트. MCP 툴 목록이 이 층에 있어 여기 둔다.
- `src/renderer/src/hooks/useCopy.ts`와 테스트 — `EndpointCard`에서 뽑은 복사 로직.
- `src/renderer/src/components/WorkArea.tsx` — 탭 전환.
- `src/renderer/src/components/AgentTab.tsx`와 테스트 — 새 탭.
- `src/renderer/src/components/EndpointCard.tsx` — `useCopy`로 교체.
- `src/renderer/src/app.css` — 탭 패널, 명령 블록, 미리보기 스타일. 기존 토큰만 쓴다.
- `README.md` — "에이전트로 테스트하기" 섹션.

## 기각한 대안

- **안내 문구를 마크다운 리소스 파일로 두고 앱이 실행 중에 읽는다** — 사람이 편집하기는 쉽다. 하지만 빌드와 패키징에
  리소스 경로 처리가 붙고, main과 renderer가 각자 파일을 읽어야 한다. 단일 출처라는 목적은 TS 모듈로도 이룰 수 있다.
- **README를 `agentGuide.ts`에서 생성한다** — 어긋날 일은 없다. 하지만 사람이 읽을 설명서까지 코드로 짜야 한다.
  어긋남은 README 일치 테스트로 충분히 막는다.
- **템플릿 빈칸을 앱 안 입력 폼으로 채운다** — 편하지만 탭에 입력 상태와 검증이 늘어난다. 패키지명과 APK 경로는
  에이전트가 프로젝트에서 스스로 찾을 수 있다.

## 열린 질문

- **토큰 고정 여부**: 지금은 앱을 켤 때마다 토큰이 바뀌어 Claude Code에 다시 등록해야 한다. 앱 데이터 디렉토리에
  토큰을 저장해 재사용할지는 보안 트레이드오프다. 로컬 파일에 비밀이 남는 대신 재등록이 없어진다. 정하게 되면
  ADR로 남긴다.
- **템플릿의 실제 효과**: 프롬프트가 에이전트를 의도대로 이끄는지는 실제 Android 프로젝트로 돌려 봐야 안다.
  처음 쓸 때 스모크 테스트부터 돌려 보고, 에이전트가 패키지명·APK 경로를 스스로 찾는지 본다.
