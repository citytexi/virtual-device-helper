#!/usr/bin/env python3
"""docs/ 아래 문서를 타게팅해서 조회·검사·생성하는 단일 CLI.

용법:
    python3 docs/script/docs.py index [--type adr] [--scope android] [--status accepted]
    python3 docs/script/docs.py find "<쿼리>" [--type ...] [--scope ...] [--top N]
    python3 docs/script/docs.py show <id> [--section "제목"] [--sections] [--meta]
    python3 docs/script/docs.py related <id> [--depth 2]
    python3 docs/script/docs.py lint
    python3 docs/script/docs.py links [경로 ...]
    python3 docs/script/docs.py new <type> <slug> --title "<제목>"

규약:
- stdlib 전용(pip 의존성 0).
- repo 루트 = Path(__file__).resolve().parents[2] (= docs/script/docs.py 기준). repo 이동에 무관.
- 문서 종류별 필수 필드·상태값의 권위 출처는 이 파일의 TYPE_SPEC이다. 각 디렉토리의
  template.md는 사람이 읽는 사본이고, 둘의 불일치는 `lint`가 잡는다.
"""
import argparse
import datetime as _dt
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_ROOT = REPO_ROOT / "docs"

SCOPE_VALUES = {
    "main", "renderer", "preload", "mcp", "android", "ios",
    "streaming", "build", "shared", "docs",
}
HOST_VALUES = {"windows", "macos"}

# 관계 필드는 가리키는 문서 종류가 정해져 있다. spec과 plan은 같은 slug를 쓰는 것이 정상이라
# (한 기능의 설계와 그 구현 순서) id만으로는 가릴 수 없고, 이 매핑이 그것을 가른다.
RELATION_TARGET = {
    "related_adr": "adr",
    "related_architecture": "architecture",
    "related_spec": "spec",
    "related_plan": "plan",
}
RELATION_FIELDS = tuple(RELATION_TARGET)

# 문서 자체가 아닌 파일. 수집에서 제외한다.
NON_DOC_NAMES = {"README.md", "template.md"}

KEBAB = r"[a-z0-9]+(?:-[a-z0-9]+)*"

TYPE_SPEC = {
    "adr": {
        "dir": DOCS_ROOT / "adr",
        "archive": None,
        "filename": re.compile(rf"^\d{{4}}-{KEBAB}\.md$"),
        "filename_hint": "NNNN-kebab-title.md",
        "status": ("proposed", "accepted", "superseded", "deprecated"),
        "required": ("id", "title", "status", "date", "deciders", "scope", "tags"),
    },
    "architecture": {
        "dir": DOCS_ROOT / "architecture",
        "archive": None,
        "filename": re.compile(rf"^{KEBAB}\.md$"),
        "filename_hint": "kebab-id.md",
        "status": ("living", "superseded", "deprecated"),
        "required": ("id", "title", "status", "verified", "scope", "tags"),
    },
    "spec": {
        "dir": DOCS_ROOT / "superpowers" / "specs",
        "archive": DOCS_ROOT / "superpowers" / "specs" / "archive",
        "filename": re.compile(rf"^\d{{4}}-\d{{2}}-\d{{2}}-{KEBAB}\.md$"),
        "filename_hint": "YYYY-MM-DD-kebab-topic.md",
        "status": ("draft", "in-progress", "implemented", "superseded"),
        "required": ("id", "title", "status", "verified", "scope", "tags"),
    },
    "plan": {
        "dir": DOCS_ROOT / "superpowers" / "plans",
        "archive": DOCS_ROOT / "superpowers" / "plans" / "archive",
        "filename": re.compile(rf"^\d{{4}}-\d{{2}}-\d{{2}}-{KEBAB}\.md$"),
        "filename_hint": "YYYY-MM-DD-kebab-topic.md",
        "status": ("draft", "in-progress", "done", "abandoned", "superseded"),
        "required": ("id", "title", "status", "type", "created", "updated", "owner", "scope", "tags"),
    },
}

TYPE_ORDER = ("adr", "architecture", "spec", "plan")


# --------------------------------------------------------------------------- 파싱

FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n?", re.S)
HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
# 값 뒤에 붙은 줄 끝 주석. 앞에 공백이 있어야 주석으로 본다 (URL의 '#anchor' 보호).
TRAILING_COMMENT = re.compile(r"\s+#.*$")


def _clean_value(raw):
    raw = raw.strip()
    if raw.startswith("#"):   # 값 없이 주석만 있는 줄 (`supersedes:   # ...`)
        return ""
    raw = TRAILING_COMMENT.sub("", raw).strip()
    if raw.startswith("[") and raw.endswith("]"):
        inner = raw[1:-1].strip()
        return [v.strip().strip("\"'") for v in inner.split(",") if v.strip()]
    return raw.strip("\"'")


def parse_frontmatter(text):
    """YAML 부분집합 파서. 스칼라 · 인라인 리스트 · 블록 리스트만 다룬다."""
    m = FRONTMATTER.match(text)
    if not m:
        return {}, text
    data = {}
    key = None
    for line in m.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        block_item = re.match(r"^\s+-\s*(.*)$", line)
        if block_item and key is not None:
            value = _clean_value(block_item.group(1))
            if not isinstance(data.get(key), list):
                data[key] = []
            if value:
                data[key].append(value)
            continue
        kv = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if kv:
            key = kv.group(1)
            data[key] = _clean_value(kv.group(2))
    return data, text[m.end():]


def as_list(value):
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return [v for v in value if v]
    return [v.strip() for v in re.split(r"[,\s]+", str(value)) if v.strip()]


class Doc:
    def __init__(self, doc_type, path, meta, body, archived):
        self.type = doc_type
        self.path = path
        self.meta = meta
        self.body = body
        self.archived = archived

    @property
    def id(self):
        return str(self.meta.get("id") or self.path.stem)

    @property
    def title(self):
        return str(self.meta.get("title") or self.path.stem)

    @property
    def status(self):
        return str(self.meta.get("status") or "")

    @property
    def scope(self):
        return as_list(self.meta.get("scope"))

    @property
    def rel(self):
        return self.path.relative_to(REPO_ROOT).as_posix()

    def headings(self):
        return [(len(m.group(1)), m.group(2)) for m in
                (HEADING.match(line) for line in self.body.splitlines()) if m]


def load_docs():
    docs = []
    for doc_type in TYPE_ORDER:
        spec = TYPE_SPEC[doc_type]
        for directory, archived in ((spec["dir"], False), (spec["archive"], True)):
            if directory is None or not directory.is_dir():
                continue
            for path in sorted(directory.glob("*.md")):
                if path.name in NON_DOC_NAMES:
                    continue
                text = path.read_text(encoding="utf-8", errors="ignore")
                meta, body = parse_frontmatter(text)
                docs.append(Doc(doc_type, path, meta, body, archived))
    return docs


def filter_docs(docs, doc_type=None, scope=None, status=None, include_archived=True):
    out = []
    for d in docs:
        if doc_type and d.type != doc_type:
            continue
        if scope and scope not in d.scope:
            continue
        if status and d.status != status:
            continue
        if not include_archived and d.archived:
            continue
        out.append(d)
    return out


def resolve(docs, wanted, doc_type=None):
    """id · 파일명 stem · 파일명으로 문서를 찾는다. 대소문자 무시.

    `spec:device-log-stream`처럼 `종류:id`로 적으면 그 종류 안에서만 찾는다. spec과 plan이
    같은 slug를 쓰는 경우를 가리는 수단이다.
    """
    key = wanted.strip().lower()
    prefix, _, rest = key.partition(":")
    if rest and prefix in TYPE_SPEC:
        doc_type, key = prefix, rest
    pool = [d for d in docs if doc_type is None or d.type == doc_type]
    for d in pool:
        if d.id.lower() == key:
            return d
    for d in pool:
        if d.path.stem.lower() == key or d.path.name.lower() == key:
            return d
    for d in pool:
        if d.id.lower().endswith(key) or key in d.path.stem.lower():
            return d
    return None


# --------------------------------------------------------------------------- index

def fmt_row(doc):
    scope = ",".join(doc.scope) or "-"
    mark = "A " if doc.archived else "  "
    return f"{mark}{doc.type:<13}{doc.id:<22}{doc.status:<13}[{scope}] {doc.title}\n    {doc.rel}"


def cmd_index(args):
    docs = filter_docs(load_docs(), args.type, args.scope, args.status,
                       include_archived=not args.no_archive)
    if not docs:
        print("해당하는 문서 없음")
        return 0
    for doc in docs:
        print(fmt_row(doc))
    print(f"\n문서 {len(docs)}개 (A = archive)")
    return 0


# --------------------------------------------------------------------------- find

# 한글 음절 · 영숫자를 토큰으로 본다. 한국어는 형태소 분석 없이 부분 문자열로 센다.
TOKEN = re.compile(r"[0-9a-z가-힣]+")

BODY_HIT_CAP = 3  # 본문 반복만으로 제목 일치를 이기지 못하게 한다 (제목 가중치는 4)


def tokenize(text):
    return TOKEN.findall(text.lower())


def count_hits(token, text):
    return text.lower().count(token)


def score(query, doc):
    tokens = set(tokenize(query))
    if not tokens:
        return 0.0
    title = doc.title
    ident = f"{doc.id} {doc.path.stem}"
    labels = " ".join(as_list(doc.meta.get("tags")) + doc.scope)
    headings = " ".join(h for _, h in doc.headings())
    body = doc.body
    total = 0.0
    for token in tokens:
        total += 4 * count_hits(token, title)
        total += 3 * count_hits(token, ident)
        total += 2 * count_hits(token, labels)
        total += 2 * count_hits(token, headings)
        total += min(count_hits(token, body), BODY_HIT_CAP)
    return total


def cmd_find(args):
    query = " ".join(args.query)
    docs = filter_docs(load_docs(), args.type, args.scope, args.status,
                       include_archived=not args.no_archive)
    ranked = sorted(((score(query, d), d) for d in docs), key=lambda p: -p[0])
    hits = [(s, d) for s, d in ranked if s > 0][:args.top]
    if not hits:
        print(f"매칭 문서 없음: {query}")
        return 1
    for value, doc in hits:
        print(f"{value:6.0f}  {fmt_row(doc)}")
    print(f"\n본문을 보려면: python3 docs/script/docs.py show {hits[0][1].id}")
    return 0


# --------------------------------------------------------------------------- show

def extract_section(body, wanted):
    """제목이 wanted를 포함하는 첫 섹션을, 같거나 더 높은 수준의 다음 제목 전까지 돌려준다."""
    lines = body.splitlines()
    start = None
    level = 0
    for i, line in enumerate(lines):
        m = HEADING.match(line)
        if m and wanted.lower() in m.group(2).lower():
            start, level = i, len(m.group(1))
            break
    if start is None:
        return None
    end = len(lines)
    for i in range(start + 1, len(lines)):
        m = HEADING.match(lines[i])
        if m and len(m.group(1)) <= level:
            end = i
            break
    return "\n".join(lines[start:end]).rstrip()


def cmd_show(args):
    docs = load_docs()
    doc = resolve(docs, args.id)
    if doc is None:
        print(f"문서 없음: {args.id}", file=sys.stderr)
        return 1
    if args.sections:
        print(f"# {doc.title}  ({doc.rel})")
        for level, text in doc.headings():
            print(f"{'  ' * (level - 1)}- {text}")
        return 0
    if args.meta:
        print(f"--- {doc.rel}")
        for key, value in doc.meta.items():
            shown = ", ".join(value) if isinstance(value, list) else value
            if shown:
                print(f"{key}: {shown}")
        print("---")
    if args.section:
        section = extract_section(doc.body, args.section)
        if section is None:
            print(f"섹션 없음: {args.section}", file=sys.stderr)
            print("사용 가능한 섹션은 --sections 로 확인한다.", file=sys.stderr)
            return 1
        print(section)
        return 0
    print(doc.body.strip())
    return 0


# --------------------------------------------------------------------------- related

def cmd_related(args):
    docs = load_docs()
    root = resolve(docs, args.id)
    if root is None:
        print(f"문서 없음: {args.id}", file=sys.stderr)
        return 1
    seen = {(root.type, root.id)}
    missing = []

    def walk(doc, depth, prefix):
        if depth > args.depth:
            return
        for field in RELATION_FIELDS:
            for ref in as_list(doc.meta.get(field)):
                target = resolve(docs, ref, RELATION_TARGET[field])
                if target is None:
                    missing.append((doc.id, field, ref))
                    continue
                mark = "" if (target.type, target.id) not in seen else "  (순환)"
                print(f"{prefix}└─ {field.removeprefix('related_')}: "
                      f"{target.id} — {target.title}{mark}")
                if (target.type, target.id) in seen:
                    continue
                seen.add((target.type, target.id))
                walk(target, depth + 1, prefix + "   ")

    print(f"{root.id} — {root.title}  ({root.rel})")
    walk(root, 1, "")
    if missing:
        print("\n해결되지 않은 참조:")
        for owner, field, ref in missing:
            print(f"  {owner}.{field} → {ref}")
    if len(seen) == 1 and not missing:
        print("  (연결된 문서 없음)")
    return 0


# --------------------------------------------------------------------------- lint

def index_readme(doc):
    """이 문서가 등록돼야 할 README 경로."""
    return TYPE_SPEC[doc.type]["dir"] / "README.md"


def cmd_lint(args):
    docs = load_docs()
    ids = {}
    problems = []

    def bad(doc, message):
        problems.append(f"{doc.rel}: {message}")

    for doc in docs:
        spec = TYPE_SPEC[doc.type]
        if not doc.meta:
            bad(doc, "frontmatter 없음")
            continue
        for field in spec["required"]:
            value = doc.meta.get(field)
            if value is None or value == "" or value == []:
                bad(doc, f"필수 필드 비어 있음: {field}")
        if doc.status and doc.status not in spec["status"]:
            bad(doc, f"허용되지 않는 status: {doc.status} "
                     f"(허용: {' | '.join(spec['status'])})")
        for value in doc.scope:
            if value not in SCOPE_VALUES:
                bad(doc, f"허용되지 않는 scope: {value}")
        for value in as_list(doc.meta.get("hosts")):
            if value not in HOST_VALUES:
                bad(doc, f"허용되지 않는 hosts: {value}")
        if not spec["filename"].match(doc.path.name):
            bad(doc, f"파일명 규약 위반 (기대: {spec['filename_hint']})")
        # spec과 plan이 같은 slug를 쓰는 것은 정상이므로 유일성은 종류 안에서만 본다
        key = (doc.type, doc.id)
        if key in ids:
            bad(doc, f"같은 종류 안에서 id 중복: {doc.id} (이미 {ids[key]})")
        else:
            ids[key] = doc.rel
        readme = index_readme(doc)
        if readme.is_file():
            if doc.path.name not in readme.read_text(encoding="utf-8", errors="ignore"):
                bad(doc, f"{readme.relative_to(REPO_ROOT).as_posix()} 인덱스에 등록되지 않음")
        if doc.archived and doc.type == "plan" and not doc.meta.get("archived_reason"):
            bad(doc, "archive된 계획에 archived_reason 없음")

    for doc in docs:
        for field in RELATION_FIELDS:
            for ref in as_list(doc.meta.get(field)):
                if resolve(docs, ref, RELATION_TARGET[field]) is None:
                    bad(doc, f"{field}가 가리키는 {RELATION_TARGET[field]} 문서 없음: {ref}")
        for field in ("supersedes", "superseded_by"):
            for ref in as_list(doc.meta.get(field)):
                if resolve(docs, ref, doc.type) is None:
                    bad(doc, f"{field}가 가리키는 {doc.type} 문서 없음: {ref}")

    for problem in problems:
        print(problem)
    print(f"\n문서 {len(docs)}개 검사 · 문제 {len(problems)}건")
    return 1 if problems else 0


# --------------------------------------------------------------------------- links

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "out"}
FENCE = re.compile(r"```.*?```", re.S)
INLINE_CODE = re.compile(r"`[^`\n]*`")
LINK = re.compile(r"(?<!\])\]\(\s*([^)\s]+?)\s*(?:\s+\"[^\"]*\")?\)")
EXTERNAL = ("http://", "https://", "mailto:", "tel:", "data:")


def is_checkable(target):
    if not target or target.startswith(("#", "/")):
        return False
    if target.startswith(EXTERNAL):
        return False
    if target.startswith("<") or "{" in target:  # 템플릿 플레이스홀더
        return False
    return True


def blank_out(text):
    """코드 펜스·인라인 코드를 줄 수를 지킨 채 지운다 — 줄 번호가 어긋나지 않게."""
    def keep_newlines(match):
        return "\n" * match.group(0).count("\n")
    return INLINE_CODE.sub("", FENCE.sub(keep_newlines, text))


def iter_markdown(roots):
    for root in roots:
        if root.is_file():
            yield root
            continue
        for path in sorted(root.rglob("*.md")):
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            yield path


def broken_links(path):
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []
    found = []
    for lineno, line in enumerate(blank_out(text).splitlines(), start=1):
        for target in LINK.findall(line):
            if not is_checkable(target):
                continue
            bare = target.split("#", 1)[0].split("?", 1)[0].replace("%20", " ")
            if not bare:
                continue
            resolved = (path.parent / bare).resolve()
            if not resolved.exists():
                found.append((lineno, target, resolved))
    return found


def cmd_links(args):
    roots = [Path(r) if Path(r).is_absolute() else REPO_ROOT / r for r in args.roots] or [REPO_ROOT]
    scanned = 0
    total = 0
    for path in iter_markdown(roots):
        scanned += 1
        for lineno, target, resolved in broken_links(path):
            total += 1
            print(f"{path.relative_to(REPO_ROOT).as_posix()}:{lineno}: 깨진 링크 {target!r} → {resolved}")
    print(f"\n파일 {scanned}개 검사 · 깨진 링크 {total}건")
    return 1 if total else 0


# --------------------------------------------------------------------------- new

USAGE_COMMENT = re.compile(r"\n*<!--.*?-->\s*\Z", re.S)


def next_adr_number(directory):
    highest = 0
    for path in directory.glob("*.md"):
        m = re.match(r"^(\d{4})-", path.name)
        if m:
            highest = max(highest, int(m.group(1)))
    return highest + 1


def set_frontmatter_field(lines, key, value):
    """frontmatter 한 줄의 값만 바꾼다. 줄 끝 주석은 보존한다."""
    pattern = re.compile(rf"^({re.escape(key)}:)(\s*)([^#]*)(#.*)?$")
    for i, line in enumerate(lines):
        m = pattern.match(line)
        if m:
            comment = m.group(4) or ""
            pad = "" if not comment else " " * max(1, 30 - len(f"{key}: {value}"))
            lines[i] = f"{key}: {value}{pad}{comment}".rstrip()
            return True
    return False


def insert_index_row(readme_path, row, marker="index"):
    if not readme_path.is_file():
        return False
    text = readme_path.read_text(encoding="utf-8")
    end = f"<!-- {marker}:end -->"
    if end not in text:
        return False
    readme_path.write_text(text.replace(end, f"{row}\n{end}", 1), encoding="utf-8")
    return True


def cmd_new(args):
    doc_type = args.doc_type
    spec = TYPE_SPEC[doc_type]
    slug = args.slug.strip().lower()
    if not re.fullmatch(KEBAB, slug):
        print(f"slug는 kebab-case여야 한다: {slug}", file=sys.stderr)
        return 1
    today = args.date or _dt.date.today().isoformat()
    title = args.title or slug.replace("-", " ")

    if doc_type == "adr":
        number = next_adr_number(spec["dir"])
        filename = f"{number:04d}-{slug}.md"
        doc_id = f"ADR-{number:04d}"
        heading = f"# {doc_id}: {title}"
    elif doc_type == "architecture":
        filename = f"{slug}.md"
        doc_id = slug
        heading = f"# {title}"
    else:
        filename = f"{today}-{slug}.md"
        doc_id = slug
        heading = f"# {title}"

    target = spec["dir"] / filename
    if target.exists():
        print(f"이미 있다: {target.relative_to(REPO_ROOT).as_posix()}", file=sys.stderr)
        return 1

    template = (spec["dir"] / "template.md").read_text(encoding="utf-8")
    m = FRONTMATTER.match(template)
    if not m:
        print("template.md에 frontmatter가 없다", file=sys.stderr)
        return 1
    fm_lines = m.group(1).splitlines()
    body = template[m.end():]

    set_frontmatter_field(fm_lines, "id", doc_id)
    set_frontmatter_field(fm_lines, "title", title)
    for field in ("date", "verified", "created", "updated"):
        set_frontmatter_field(fm_lines, field, today)

    body = USAGE_COMMENT.sub("\n", body)
    body_lines = body.splitlines()
    for i, line in enumerate(body_lines):
        if line.startswith("# "):
            body_lines[i] = heading
            break
    body = "\n".join(body_lines).rstrip() + "\n"

    target.write_text("---\n" + "\n".join(fm_lines) + "\n---\n" + body, encoding="utf-8")

    if doc_type == "adr":
        row = f"| [{doc_id.removeprefix('ADR-')}]({filename}) | {title} | proposed | {today} |  |"
    elif doc_type == "architecture":
        row = f"| [{slug}]({filename}) | living | {today} | (내용 한 줄) |"
    elif doc_type == "spec":
        row = f"| [{slug}]({filename}) | draft | (내용 한 줄) |"
    else:
        row = f"| [{slug}]({filename}) | draft | (내용 한 줄) |"

    registered = insert_index_row(spec["dir"] / "README.md", row)
    print(f"생성: {target.relative_to(REPO_ROOT).as_posix()}")
    print("인덱스 등록: " + ("완료 — 비고 칸을 채워라" if registered else "실패 (README 마커 없음) — 손으로 등록해라"))
    if doc_type != "adr":
        print("다음: scope를 채우고 `python3 docs/script/docs.py lint`를 돌린다")
    else:
        print("다음: scope·deciders를 채우고 `python3 docs/script/docs.py lint`를 돌린다")
    return 0


# --------------------------------------------------------------------------- CLI

def build_parser():
    ap = argparse.ArgumentParser(
        prog="docs.py", description="docs/ 문서 조회·검사·생성")
    sub = ap.add_subparsers(dest="command", required=True)

    def add_filters(p):
        p.add_argument("--type", choices=TYPE_ORDER, help="문서 종류로 좁힌다")
        p.add_argument("--scope", choices=sorted(SCOPE_VALUES), help="scope로 좁힌다")
        p.add_argument("--status", help="status로 좁힌다")
        p.add_argument("--no-archive", action="store_true", help="archive 문서를 뺀다")

    p_index = sub.add_parser("index", help="전 문서 카탈로그")
    add_filters(p_index)
    p_index.set_defaults(func=cmd_index)

    p_find = sub.add_parser("find", help="쿼리로 문서 랭킹")
    p_find.add_argument("query", nargs="+")
    p_find.add_argument("--top", type=int, default=8)
    add_filters(p_find)
    p_find.set_defaults(func=cmd_find)

    p_show = sub.add_parser("show", help="문서 또는 섹션 하나 출력")
    p_show.add_argument("id")
    p_show.add_argument("--section", help="제목에 이 문자열이 든 섹션만 출력")
    p_show.add_argument("--sections", action="store_true", help="섹션 목록만 출력")
    p_show.add_argument("--meta", action="store_true", help="frontmatter도 출력")
    p_show.set_defaults(func=cmd_show)

    p_rel = sub.add_parser("related", help="related_* 그래프 순회")
    p_rel.add_argument("id")
    p_rel.add_argument("--depth", type=int, default=2)
    p_rel.set_defaults(func=cmd_related)

    p_lint = sub.add_parser("lint", help="frontmatter·파일명·인덱스 등록 검사")
    p_lint.set_defaults(func=cmd_lint)

    p_links = sub.add_parser("links", help="마크다운 상대 링크 resolve 검사")
    p_links.add_argument("roots", nargs="*", default=[])
    p_links.set_defaults(func=cmd_links)

    p_new = sub.add_parser("new", help="템플릿에서 새 문서 생성 + 인덱스 등록")
    p_new.add_argument("doc_type", choices=TYPE_ORDER)
    p_new.add_argument("slug")
    p_new.add_argument("--title")
    p_new.add_argument("--date", help="기본값: 오늘")
    p_new.set_defaults(func=cmd_new)

    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
