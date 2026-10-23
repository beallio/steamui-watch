import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import css_mappings
from css_mappings import extract_class_modules

MINIFIED = (
    '(self.webpackChunksteamui||[]).push([[7462],{11995:(X=>{X.exports={ClipUploadStatus:"_3rMEP"}}),'
    '25025:(X=>{X.exports={"duration-app-launch":"800ms",Clip:"_1fyr",}}),'
    '300:(X=>{X.exports={version:"3"}}),'
    '301:(X=>{X.exports={a:"x",b:Y.c}}),'
    '302:(X=>{X.exports={}}),'
    'foo.303:(X=>{X.exports={a:"x"}}),'
    '304:(X,Y,Z)=>{Z.d(Y,{a:()=>"x"})}}]);'
)

PRETTIER = """
      67512: (ye) => {
        ye.exports = {
          BreakNarrow: "1158px",
          "duration-app-launch": "800ms",
          Esc: "a\\"b",
        };
      },
"""


class ExtractClassModulesTest(unittest.TestCase):
    def test_minified_bundle(self):
        self.assertEqual(
            extract_class_modules([MINIFIED]),
            {
                "11995": {"ClipUploadStatus": "_3rMEP"},
                "25025": {"duration-app-launch": "800ms", "Clip": "_1fyr"},
            },
        )

    def test_prettier_bundle(self):
        self.assertEqual(
            extract_class_modules([PRETTIER]),
            {"67512": {"BreakNarrow": "1158px", "duration-app-launch": "800ms", "Esc": 'a"b'}},
        )

    def test_decodes_js_escapes(self):
        src = r'7:(e=>{e.exports={"T\xF6r":"T\xF6rl\xE9s",q:"\"\u00e9\u{1F600}\uD83D\uDE00\n"}})'
        self.assertEqual(
            extract_class_modules([src]),
            {"7": {"Tör": "Törlés", "q": '"é\U0001F600\U0001F600\n'}},
        )

    def test_skips_large_localization_module(self):
        body = ",".join(f'k{i}:"v"' for i in range(1001)) + ',AboutSettings:"About"'
        self.assertEqual(extract_class_modules([f"5:(e=>{{e.exports={{{body}}}}})"]), {})


class PipelineOutputTest(unittest.TestCase):
    def test_pipeline_rejects_incompatible_outputs(self):
        for outputs in (
            {},
            {"stable.json": {"module": ["ok"]}},
            {"beta.json": {"module": ["ok"]}},
            {"beta.json": "not json", "stable.json": {"module": ["ok"]}},
            {"beta.json": {}, "stable.json": {"module": ["ok"]}},
            {"beta.json": [], "stable.json": {"module": ["ok"]}},
            {"beta.json": {"module": []}, "stable.json": {"module": ["ok"]}},
            {"beta.json": {"module": "not a list"}, "stable.json": {"module": ["ok"]}},
            {"beta.json": {"module": ["ok", 1]}, "stable.json": {"module": ["ok"]}},
            {"beta.json": {"module": ["ok"]}, "stable.json": {"module": ["ok", None]}},
        ):
            with self.subTest(outputs=outputs), tempfile.TemporaryDirectory() as tmp:
                repo = Path(tmp)
                (repo / "webpack").mkdir()
                for script in css_mappings.PIPELINE:
                    (repo / script).touch()
                for suffix in css_mappings.BRANCHES.values():
                    (repo / "webpack" / f"100.{suffix}.json").write_text("{}")
                generator = "from pathlib import Path\n"
                for name, payload in outputs.items():
                    content = payload if isinstance(payload, str) else json.dumps(payload)
                    generator += f"Path({name!r}).write_text({content!r}, encoding='utf-8')\n"
                (repo / css_mappings.PIPELINE[-1]).write_text(generator)
                with (
                    mock.patch.object(css_mappings, "fetch_manifest", return_value=("100", {})),
                    self.assertRaises(SystemExit),
                ):
                    css_mappings.main([str(repo)])

    def test_no_pipeline_writes_the_dump_without_requiring_final_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "webpack").mkdir()
            for script in css_mappings.PIPELINE:
                (repo / script).touch()
            with (
                mock.patch.object(css_mappings, "fetch_manifest", return_value=("100", {})),
                mock.patch.object(css_mappings, "download_sources", return_value=['1:(e=>{e.exports={Button:"old"}})']),
                mock.patch.object(css_mappings, "MIN_MODULES", 1),
            ):
                self.assertEqual(css_mappings.main([str(repo), "--branch", "stable", "--no-pipeline"]), 0)
            self.assertEqual(
                json.loads((repo / "webpack" / "100.stable.json").read_text()),
                {"1": {"Button": "old"}},
            )

class ValidateMatchesTest(unittest.TestCase):
    """Old 1 and 2 exist in version 100; 1 survives into 200, and 3 and 4 are new there."""

    def check(self, mapped, new=()):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "webpack").mkdir()
            (repo / "webpack-mappings").mkdir()
            (repo / "webpack" / "100.beta.json").write_text(json.dumps({"1": {"a": "x"}, "2": {"b": "y"}}))
            (repo / "webpack" / "200.beta.json").write_text(json.dumps({"1": {"a": "x"}, "3": {"b": "z"}, "4": {"c": "w"}}))
            doc = {"new": [{"new": n, "possible_mappings": {}} for n in new],
                   "mapped": {old: {"new": target, "possible_mappings": {old: 0.5}} for old, target in mapped.items()}}
            (repo / "webpack-mappings" / "100to200.json").write_text(json.dumps(doc))
            css_mappings.validate_matches(repo)

    def test_accepts_a_match_onto_a_new_module(self):
        self.check({"2": "3"}, new=["4"])

    def test_accepts_an_explicit_new_identity_for_a_reused_source_id(self):
        self.check({"1": "3"}, new=["1", "4"])

    def test_rejects_unsafe_matches(self):
        for mapped, new, reason in (
            ({"1": "3"}, [], "still exists"),
            ({"2": "1"}, [], "already existed"),  # target keeps its own history: merging crashes the pipeline
            ({"2": "3"}, ["3"], "used twice"),  # still listed as a brand-new module
            ({"2": "9"}, [], "not in version 200"),
            ({"9": "3"}, [], "not in version 100"),
        ):
            with self.subTest(mapped=mapped, new=new), self.assertRaisesRegex(SystemExit, reason):
                self.check(mapped, new)


if __name__ == "__main__":
    unittest.main()
