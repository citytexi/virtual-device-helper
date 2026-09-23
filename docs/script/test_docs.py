#!/usr/bin/env python3
"""docs.py 테스트.

용법:
    python3 -m unittest discover -s docs/script

디렉토리에 의존하는 테스트는 임시 docs 트리를 만들고 docs.py의 경로 전역을 그쪽으로 돌린다.
"""
import contextlib
import io
import shutil
import tempfile
import unittest
from pathlib import Path

import docs as D


REAL_DOCS = Path(__file__).resolve().parents[1]


class TempDocsTree:
    """임시 docs 트리로 docs.py 경로 전역을 갈아끼우는 컨텍스트 매니저."""

    def __enter__(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.root = self.tmp / "repo"
        docs = self.root / "docs"
        for name in ("adr", "architecture", "superpowers/specs", "superpowers/plans"):
            (docs / name).mkdir(parents=True)
        (docs / "superpowers/specs/archive").mkdir()
        (docs / "superpowers/plans/archive").mkdir()
        for name in ("adr", "architecture", "superpowers/specs", "superpowers/plans"):
            shutil.copy(REAL_DOCS / name / "template.md", docs / name / "template.md")
            shutil.copy(REAL_DOCS / name / "README.md", docs / name / "README.md")

        self.saved = (D.REPO_ROOT, D.DOCS_ROOT, {k: dict(v) for k, v in D.TYPE_SPEC.items()})
        D.REPO_ROOT = self.root
        D.DOCS_ROOT = docs
        D.TYPE_SPEC["adr"]["dir"] = docs / "adr"
        D.TYPE_SPEC["architecture"]["dir"] = docs / "architecture"
        D.TYPE_SPEC["spec"]["dir"] = docs / "superpowers/specs"
        D.TYPE_SPEC["spec"]["archive"] = docs / "superpowers/specs/archive"
        D.TYPE_SPEC["plan"]["dir"] = docs / "superpowers/plans"
        D.TYPE_SPEC["plan"]["archive"] = docs / "superpowers/plans/archive"
        return self

    def __exit__(self, *exc):
        D.REPO_ROOT, D.DOCS_ROOT, saved_spec = self.saved
        for key, value in saved_spec.items():
            D.TYPE_SPEC[key].update(value)
        shutil.rmtree(self.tmp, ignore_errors=True)
        return False

    def write(self, relative, text):
        path = self.root / relative
        path.write_text(text, encoding="utf-8")
        return path


ADR_DOC = """---
id: ADR-0001
title: 테스트 결정
status: accepted
date: 2026-01-01
deciders: 팀
scope: [main]
tags: [adr]
---

# ADR-0001: 테스트 결정

## 맥락
배경.
"""


class ParseFrontmatterTest(unittest.TestCase):
    def test_scalar_inline_list_and_block_list(self):
        meta, body = D.parse_frontmatter(
            "---\n"
            "id: x\n"
            "scope: [main, mcp]\n"
            "tags:\n"
            "  - adr\n"
            "  - docs\n"
            "---\n"
            "# 제목\n"
        )
        self.assertEqual(meta["id"], "x")
        self.assertEqual(meta["scope"], ["main", "mcp"])
        self.assertEqual(meta["tags"], ["adr", "docs"])
        self.assertEqual(body, "# 제목\n")

    def test_comment_only_value_is_empty(self):
        meta, _ = D.parse_frontmatter("---\nsupersedes:   # 없으면 비움\n---\n")
        self.assertEqual(meta["supersedes"], "")

    def test_trailing_comment_stripped(self):
        meta, _ = D.parse_frontmatter("---\nstatus: accepted   # proposed | accepted\n---\n")
        self.assertEqual(meta["status"], "accepted")

    def test_no_frontmatter(self):
        meta, body = D.parse_frontmatter("# 그냥 제목\n")
        self.assertEqual(meta, {})
        self.assertEqual(body, "# 그냥 제목\n")


class AsListTest(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(D.as_list(None), [])
        self.assertEqual(D.as_list(""), [])
        self.assertEqual(D.as_list(["a", ""]), ["a"])
        self.assertEqual(D.as_list("ADR-0001, ADR-0002"), ["ADR-0001", "ADR-0002"])


class ExtractSectionTest(unittest.TestCase):
    body = "# 제목\n\n## 맥락\n앞.\n\n### 하위\n깊음.\n\n## 결정\n뒤.\n"

    def test_stops_at_same_level(self):
        self.assertEqual(D.extract_section(self.body, "결정"), "## 결정\n뒤.")

    def test_includes_deeper_headings(self):
        section = D.extract_section(self.body, "맥락")
        self.assertIn("### 하위", section)
        self.assertNotIn("## 결정", section)

    def test_missing_section(self):
        self.assertIsNone(D.extract_section(self.body, "없는섹션"))


class ScoreTest(unittest.TestCase):
    def _doc(self, title, body, doc_id="x"):
        meta = {"id": doc_id, "title": title, "tags": [], "scope": []}
        return D.Doc("adr", Path("docs/adr/0001-x.md"), meta, body, False)

    def test_title_outweighs_body(self):
        in_title = self._doc("스트리밍 파이프라인", "본문.")
        in_body = self._doc("다른 문서", "스트리밍 이야기.")
        self.assertGreater(D.score("스트리밍", in_title), D.score("스트리밍", in_body))

    def test_body_repetition_is_capped(self):
        spam = self._doc("무관", "스트리밍 " * 50)
        titled = self._doc("스트리밍", "본문.")
        self.assertGreaterEqual(D.score("스트리밍", spam), 1)
        self.assertLessEqual(D.score("스트리밍", spam), D.BODY_HIT_CAP)
        self.assertGreater(D.score("스트리밍", titled), D.score("스트리밍", spam))

    def test_empty_query(self):
        self.assertEqual(D.score("", self._doc("제목", "본문")), 0.0)


class SetFrontmatterFieldTest(unittest.TestCase):
    def test_preserves_trailing_comment(self):
        lines = ["id: ADR-NNNN", "status: proposed   # proposed | accepted"]
        self.assertTrue(D.set_frontmatter_field(lines, "status", "accepted"))
        self.assertTrue(lines[1].startswith("status: accepted"))
        self.assertIn("# proposed | accepted", lines[1])

    def test_missing_key(self):
        self.assertFalse(D.set_frontmatter_field(["id: x"], "없는키", "v"))


class ResolveTest(unittest.TestCase):
    def _doc(self, doc_type, doc_id, path):
        return D.Doc(doc_type, Path(path), {"id": doc_id, "title": doc_id}, "", False)

    def setUp(self):
        self.docs = [
            self._doc("spec", "log-stream", "docs/superpowers/specs/2026-01-01-log-stream.md"),
            self._doc("plan", "log-stream", "docs/superpowers/plans/2026-01-02-log-stream.md"),
            self._doc("adr", "ADR-0001", "docs/adr/0001-shell.md"),
        ]

    def test_type_prefix_disambiguates_shared_slug(self):
        self.assertEqual(D.resolve(self.docs, "plan:log-stream").type, "plan")
        self.assertEqual(D.resolve(self.docs, "spec:log-stream").type, "spec")

    def test_type_argument_disambiguates(self):
        self.assertEqual(D.resolve(self.docs, "log-stream", "plan").type, "plan")

    def test_filename_stem(self):
        self.assertEqual(D.resolve(self.docs, "0001-shell").id, "ADR-0001")

    def test_missing(self):
        self.assertIsNone(D.resolve(self.docs, "없는문서"))


class NewCommandTest(unittest.TestCase):
    def test_adr_numbering_and_index_registration(self):
        with TempDocsTree() as tree:
            self.assertEqual(D.main(["new", "adr", "first-thing", "--title", "첫 결정"]), 0)
            self.assertEqual(D.main(["new", "adr", "second-thing", "--title", "둘째 결정"]), 0)
            adr_dir = D.TYPE_SPEC["adr"]["dir"]
            self.assertTrue((adr_dir / "0001-first-thing.md").is_file())
            self.assertTrue((adr_dir / "0002-second-thing.md").is_file())
            readme = (adr_dir / "README.md").read_text(encoding="utf-8")
            self.assertIn("[0002](0002-second-thing.md)", readme)
            self.assertIn("| 둘째 결정 |", readme)
            body = (adr_dir / "0002-second-thing.md").read_text(encoding="utf-8")
            self.assertIn("# ADR-0002: 둘째 결정", body)
            self.assertNotIn("<!--", body)   # 사용법 주석은 제거된다
            self.assertEqual(tree.root.name, "repo")

    def test_spec_and_plan_share_slug(self):
        with TempDocsTree():
            self.assertEqual(D.main(["new", "spec", "log-stream", "--date", "2026-01-01"]), 0)
            self.assertEqual(D.main(["new", "plan", "log-stream", "--date", "2026-01-02"]), 0)
            self.assertTrue((D.TYPE_SPEC["spec"]["dir"] / "2026-01-01-log-stream.md").is_file())
            self.assertTrue((D.TYPE_SPEC["plan"]["dir"] / "2026-01-02-log-stream.md").is_file())

    def test_rejects_non_kebab_slug(self):
        with TempDocsTree():
            self.assertEqual(D.main(["new", "adr", "Not Kebab"]), 1)

    def test_rejects_existing_file(self):
        with TempDocsTree():
            D.main(["new", "architecture", "bridge"])
            self.assertEqual(D.main(["new", "architecture", "bridge"]), 1)


class LintTest(unittest.TestCase):
    def _lint(self):
        return D.main(["lint"])

    def test_clean_tree_passes(self):
        with TempDocsTree() as tree:
            tree.write("docs/adr/0001-test.md", ADR_DOC)
            readme = D.TYPE_SPEC["adr"]["dir"] / "README.md"
            readme.write_text(readme.read_text(encoding="utf-8").replace(
                "<!-- index:end -->", "| [0001](0001-test.md) | 테스트 결정 |\n<!-- index:end -->"),
                encoding="utf-8")
            self.assertEqual(self._lint(), 0)

    def test_unregistered_doc_fails(self):
        with TempDocsTree() as tree:
            tree.write("docs/adr/0001-test.md", ADR_DOC)
            self.assertEqual(self._lint(), 1)

    def test_bad_status_and_scope_fail(self):
        with TempDocsTree() as tree:
            tree.write("docs/adr/0001-test.md",
                       ADR_DOC.replace("status: accepted", "status: 애매함")
                              .replace("scope: [main]", "scope: [없는영역]"))
            self.assertEqual(self._lint(), 1)

    def test_filename_convention_enforced(self):
        with TempDocsTree() as tree:
            tree.write("docs/adr/nonumber-test.md", ADR_DOC)
            self.assertEqual(self._lint(), 1)

    def test_relation_must_match_target_type(self):
        with TempDocsTree() as tree:
            tree.write("docs/adr/0001-test.md",
                       ADR_DOC.replace("tags: [adr]", "related_spec: 없는스펙\ntags: [adr]"))
            self.assertEqual(self._lint(), 1)


class LinksTest(unittest.TestCase):
    def test_detects_broken_relative_link(self):
        with TempDocsTree() as tree:
            tree.write("docs/adr/0001-test.md", ADR_DOC + "\n[깨짐](없는파일.md)\n")
            self.assertEqual(D.main(["links", "docs"]), 1)

    def test_ignores_external_and_anchor(self):
        with TempDocsTree() as tree:
            tree.write("docs/adr/0002-ok.md",
                       ADR_DOC + "\n[웹](https://example.com) [앵커](#맥락)\n")
            self.assertEqual(D.main(["links", "docs/adr/0002-ok.md"]), 0)

    def test_ignores_link_inside_code_fence(self):
        with TempDocsTree() as tree:
            tree.write("docs/adr/0003-fence.md",
                       ADR_DOC + "\n```\n[예시](없는파일.md)\n```\n")
            self.assertEqual(D.main(["links", "docs/adr/0003-fence.md"]), 0)

    def test_skips_superpowers_scratch_tree(self):
        # 저장소 루트를 훑을 때 gitignore된 SDD 작업 트리(.superpowers/)는 문서가 아니므로 뺀다.
        # 같은 깨진 링크를 일반 디렉토리에 두면 여전히 잡혀야 한다 — 루트 스캔 자체는 살아 있다.
        with TempDocsTree() as tree:
            scratch = tree.root / ".superpowers/sdd/some-plan"
            scratch.mkdir(parents=True)
            (scratch / "brief.md").write_text("[깨짐](없는파일.md)\n", encoding="utf-8")
            notes = tree.root / "notes"
            notes.mkdir()
            (notes / "memo.md").write_text("[깨짐](없는파일.md)\n", encoding="utf-8")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                D.main(["links"])
            self.assertNotIn(".superpowers", out.getvalue())
            self.assertIn("notes/memo.md", out.getvalue())

if __name__ == "__main__":
    unittest.main()
