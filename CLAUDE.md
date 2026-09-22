# CLAUDE.md

## 프로젝트

virtual-device-helper는 **Electron 데스크탑 앱**이다. Windows와 macOS에서 돌아간다.

하는 일은 Android·iOS 가상 기기를 **MCP로 제어**하고, 화면 스트리밍·스크린샷·로그·이벤트를
한 화면에서 보게 하는 것이다. 목표는 다른 프로젝트에서 만든 앱을 여기 붙여 테스트하는 것이다.

축이 세 개다. 문서를 쓸 때 이 축들을 섞지 않는다.

- **호스트 OS** — windows / macos
- **타깃 디바이스** — android / ios
- **Electron 프로세스** — main / renderer / preload

## 언어

항상 한국어로 답한다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.

## 문서 위치

| 디렉토리 | 답하는 질문 |
|---|---|
| [`docs/adr/`](docs/adr/) | **왜** 이렇게 결정했나 |
| [`docs/architecture/`](docs/architecture/) | **어떻게 / 어디** 있나 (상시 갱신) |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | **무엇을** 만들 것인가 |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | **어떤 순서로** 만들 것인가 |

지도와 공통 frontmatter는 [`docs/README.md`](docs/README.md)에 있다.

## 문서를 찾을 때 (필수)

**`grep -r docs/` 전에 `docs.py`를 쓴다.** grep은 매칭된 줄을 전부 쏟아내지만 이쪽은 필요한
문서와 필요한 섹션만 돌려준다.

```bash
python3 docs/script/docs.py find "<주제>"                  # 주제로 문서 랭킹
python3 docs/script/docs.py show <id> --sections           # 섹션 목록만 (싸다)
python3 docs/script/docs.py show <id> --section "<제목>"   # 섹션 하나만
python3 docs/script/docs.py related <id>                   # 이 문서가 기대는 결정들
python3 docs/script/docs.py index --scope android          # 영역으로 좁힌 카탈로그
```

전체 사용법은 [`docs/script/README.md`](docs/script/README.md)에 있다.

## 작업 워크플로

코드 작업의 공통 진입은 `superpowers:brainstorming`이다. 그다음 갈래는 이렇다.

1. `superpowers:brainstorming` → 설계 스펙을 `docs/superpowers/specs/`에 확정
2. `superpowers:writing-plans` → 구현 계획을 `docs/superpowers/plans/`에 작성
3. `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans` → TDD로 실행

두 경로 모두 각 스킬의 **기본 출력 위치 그대로**다. override하지 않는다.

문서는 `docs.py new`로 만든다. 파일명 규약·날짜·ADR 번호·README 인덱스 등록을 대신 해 준다.

```bash
python3 docs/script/docs.py new spec <slug> --title "<제목>"
python3 docs/script/docs.py new plan <slug> --title "<제목>"
```

## 스펙·계획을 쓰다가 ADR을 만들어야 할 때 (필수)

스펙이나 계획을 쓰는 중 아래 중 **하나라도** 걸리면, 대응 ADR을 같은 라운드에 만들고
`related_adr`로 잇는다. 나중으로 미루면 근거가 사라진 채 결과만 남는다.

- **되돌리기가 비싸다** — 나중에 바꾸려면 여러 모듈을 동시에 고쳐야 한다.
- **실재한 대안을 기각했다** — 비교 대상이 실제로 있었고 그중 하나를 골랐다.
- **다른 결정을 제약한다** — 이 선택 때문에 뒤따르는 선택지가 좁아진다.
- **외부 의존이나 SDK를 새로 들인다** — 버전·플랫폼 제약이 따라 들어온다.

되돌리기 싼 선택, 대안이 없던 선택, 한 파일 안에서 끝나는 선택은 ADR로 만들지 않는다.
스펙 본문에 한 줄 적으면 된다.

```bash
python3 docs/script/docs.py new adr <slug> --title "<제목>"
```

## architecture 문서를 만들어야 할 때

**같은 구조 설명이 스펙 두 곳 이상에서 반복되기 시작하면** 그 설명을
`docs/architecture/`의 `status: living` 문서로 올리고, 스펙에서는 그 문서를 가리킨다.
스펙은 구현되면 아카이브로 가지만 구조 설명은 계속 필요하기 때문이다.

승격은 반복이 **관찰된 뒤에** 한다. 한 기능 안에서만 쓰이는 설명은 스펙에 남겨 둔다.
코드와 대조할 때마다 그 문서의 `verified`를 갱신한다.

## 근거 표기 규칙 (필수)

모든 문서에 적용된다.

- **적는다**: 파일명 + 심볼명(`mcpBridge.ts`의 `registerTools`), 설계 결정과 대안, 수치 없는 방향성.
- **안 적는다**: 라인번호(`main.ts:34`), 파일·핸들러 개수, 진행률, 호출 횟수.

코드와 함께 바뀌어 금방 거짓이 되기 때문이다. 지금 수치가 필요하면 그때 코드에서 직접 센다.
이유와 상세는 [`docs/adr/README.md`](docs/adr/README.md)에 있다.

## 문서를 고친 뒤

```bash
python3 docs/script/docs.py lint    # frontmatter · 파일명 · 인덱스 등록 · 관계 참조
python3 docs/script/docs.py links   # 깨진 상대 링크
python3 -m unittest discover -s docs/script -t docs/script   # docs.py 를 고쳤을 때
```

## 서브에이전트에게 (필수)

**이 파일은 서브에이전트에게 자동으로 전달되지 않는다.** 구현·리뷰를 디스패치할 때는
위 규칙 중 해당하는 요지를 프롬프트의 전역 제약에, 계획서에서는 Global Constraints에 실어 나른다.
