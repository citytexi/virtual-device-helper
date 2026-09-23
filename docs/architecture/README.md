# Architecture

virtual-device-helper의 구조·설계 명세를 모은다. 다루는 것은 **"어떻게 / 어디"** 다.

> `architecture/`는 상시 갱신되는 구현 가이드, [`../adr/`](../adr/)는 결정과 그 근거,
> [`../superpowers/specs/`](../superpowers/specs/)는 구현 직전의 확정 설계다. 셋은 상호 보완이다.
>
> 모든 주장은 **파일명 + 심볼명**으로 근거를 표시하고, 추정에는 **Assumption** 라벨을 붙인다.
> 라인번호와 변동 수치는 적지 않는다 (규칙 상세: [`../adr/README.md`](../adr/README.md)).
>
> 형식 권위 출처: [`template.md`](template.md)

<!-- index:start -->
| 문서 | 상태 | 검증일 | 내용 |
|------|------|--------|------|
<!-- index:end -->

## 언제 architecture 문서를 쓰는가

**같은 구조 설명이 스펙 두 곳 이상에서 반복되기 시작하면** 그 설명을 여기로 올린다.
스펙은 한 번 구현되면 아카이브로 가지만 구조 설명은 계속 필요하기 때문이다.

한 기능 안에서만 쓰이는 설명은 스펙에 남겨 둔다. 승격은 반복이 관찰된 뒤에 한다.

## 작성 가이드

- 파일명: `<kebab-case-id>.md`. id와 파일명 stem을 일치시킨다.
- `python3 docs/script/docs.py new architecture <slug> --title "<제목>"`이 날짜 기입·인덱스 등록을 한다.
- `status: living` = 상시 갱신 문서. 코드와 대조할 때마다 `verified`를 갱신한다.
- 문서가 설명하는 결정의 근거는 여기 복사하지 않고 `related_adr`로 잇는다.

## Frontmatter (필수)

필드: `id` · `title` · `status`(living / superseded / deprecated) · `verified`(코드 대조일) ·
`scope` · `hosts` · `related_adr` · `related_spec` · `related_architecture` · `related_plan` ·
`related_code`(심볼명, 라인번호 금지) · `tags`.
