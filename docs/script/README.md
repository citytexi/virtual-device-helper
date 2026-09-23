# docs/script

`docs/` 문서를 다루는 파이썬 툴링 홈.

## 규약

- **stdlib 전용** — pip 의존성 0. `python3 docs/script/<name>.py`로 실행한다.
- repo 루트 = `Path(__file__).resolve().parents[2]` 기준. repo를 옮겨도 동작한다.
- 테스트는 같은 디렉토리에 `test_<name>.py`. 실행: `python3 -m unittest discover -s docs/script -t docs/script`.

## docs.py

문서를 **타게팅해서** 꺼내는 단일 CLI. `grep -r docs/`는 매칭된 줄을 전부 쏟아내지만, 이쪽은
필요한 문서·필요한 섹션만 돌려준다.

| 커맨드 | 하는 일 |
|---|---|
| `index [--type --scope --status --no-archive]` | 전 문서 카탈로그 한 줄씩 |
| `find "<쿼리>" [--type --scope --top]` | 제목·id·태그·소제목·본문 가중 랭킹 |
| `show <id> [--section "제목"] [--sections] [--meta]` | 문서 전체 · 섹션 하나 · 섹션 목록 |
| `related <id> [--depth N]` | `related_*` 그래프 순회 |
| `lint` | frontmatter 필수 필드·상태값·파일명·인덱스 등록·관계 참조 검사 |
| `links [경로 ...]` | 마크다운 상대 링크 resolve 검사 |
| `new <type> <slug> --title "<제목>"` | 템플릿에서 생성 + 번호·날짜 채움 + README 인덱스 등록 |

### 쓰는 순서

```bash
# 1. 주제가 이미 문서로 있는지
python3 docs/script/docs.py find "로그 스트리밍"

# 2. 긴 문서에서 필요한 섹션만
python3 docs/script/docs.py show device-log-stream --sections
python3 docs/script/docs.py show device-log-stream --section "실패 처리"

# 3. 그 결정이 어디서 왔는지
python3 docs/script/docs.py related device-log-stream

# 4. 새 문서
python3 docs/script/docs.py new adr adb-connection-pooling --title "adb 연결 풀링"
python3 docs/script/docs.py lint
```

### id 지정

spec과 plan은 한 기능에 대해 같은 slug를 쓴다(설계와 그 구현 순서). 가릴 때는
`spec:device-log-stream` / `plan:device-log-stream`처럼 **종류를 앞에 붙인다.**
`related_*` 필드는 가리키는 종류가 이미 정해져 있어 접두사가 필요 없다.

### 권위 출처

문서 종류별 **필수 필드·허용 상태값·파일명 규약**의 정본은 `docs.py`의 `TYPE_SPEC`이다.
각 디렉토리의 `template.md`는 사람이 읽는 사본이고, 둘이 어긋나면 `lint`가 잡는다.
