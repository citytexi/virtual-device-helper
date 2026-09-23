# docs

virtual-device-helper의 문서 루트. 네 종류가 각각 **다른 질문**에 답한다.

| 디렉토리 | 답하는 질문 | 수명 |
|---|---|---|
| [`adr/`](adr/) | **왜** 이렇게 결정했나 | 결정이 번복될 때까지 |
| [`architecture/`](architecture/) | **어떻게 / 어디** 있나 | 상시 갱신 (`status: living`) |
| [`superpowers/specs/`](superpowers/specs/) | **무엇을** 만들 것인가 | 구현되면 `archive/`로 |
| [`superpowers/plans/`](superpowers/plans/) | **어떤 순서로** 만들 것인가 | 완료되면 `archive/`로 |

`superpowers/` 아래 두 디렉토리는 `superpowers:brainstorming`·`superpowers:writing-plans`의
**기본 출력 위치 그대로**다. 경로를 override하지 않으므로 스킬이 갱신돼도 어긋나지 않는다.

## 문서 찾기

`grep -r docs/`보다 [`script/docs.py`](script/)를 먼저 쓴다. 매칭된 줄을 전부 쏟아내는 대신
필요한 문서와 필요한 섹션만 돌려준다.

```bash
python3 docs/script/docs.py find "로그 스트리밍"        # 주제로 문서 찾기
python3 docs/script/docs.py show <id> --sections         # 섹션 목록만 (싸다)
python3 docs/script/docs.py show <id> --section "실패 처리"  # 섹션 하나만
python3 docs/script/docs.py related <id>                 # 이 문서가 기대는 결정들
python3 docs/script/docs.py index --scope android        # 영역으로 좁힌 카탈로그
```

## 공통 frontmatter

네 종류가 공유하는 필드다. 종류별 추가 필드는 각 디렉토리의 README와 `template.md`에 있다.

| 필드 | 뜻 |
|---|---|
| `id` | 문서 식별자. ADR은 `ADR-NNNN`, 나머지는 파일명 slug |
| `title` | 사람이 읽는 제목 |
| `status` | 종류마다 허용값이 다르다 |
| `scope` | 문서가 건드리는 영역. `main` `renderer` `preload` `mcp` `android` `ios` `streaming` `build` `shared` `docs` |
| `hosts` | `windows` `macos` — 호스트 OS마다 내용이 갈릴 때만 채운다 |
| `related_adr` · `related_spec` · `related_architecture` · `related_plan` | 문서 간 연결. `docs.py related`가 이걸 따라간다 |
| `related_code` | 파일명#심볼. 라인번호 금지 |
| `tags` | 자유 태그 |

`scope`가 축인 이유: 이 프로젝트는 **호스트 OS**(windows/macos), **타깃 디바이스**(android/ios),
**Electron 프로세스**(main/renderer/preload)가 서로 다른 축이라 단일 `platform` 필드로 담기지 않는다.

## 근거 표기 규칙

문서 전체에 적용된다. 상세와 이유는 [`adr/README.md`](adr/README.md)에 있다.

- **적는다**: 파일명 + 심볼명, 설계 결정과 대안, 수치 없는 방향성.
- **안 적는다**: 라인번호(`main.ts:34`), 파일·핸들러 개수, 진행률, 호출 횟수.

지금 수치가 필요하면 그때 코드에서 직접 센다.

## 검사

```bash
python3 docs/script/docs.py lint    # frontmatter · 파일명 · 인덱스 등록 · 관계 참조
python3 docs/script/docs.py links   # 깨진 상대 링크
```
