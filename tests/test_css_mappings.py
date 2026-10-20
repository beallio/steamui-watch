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


class PipelineRetryTest(unittest.TestCase):
    """Dumps saved by a failed or --no-pipeline run must not block the next pipeline run."""

    def run_main(self, *flags):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "webpack").mkdir()
            for script in css_mappings.PIPELINE:
                (repo / script).touch()
            for suffix in css_mappings.BRANCHES.values():
                (repo / "webpack" / f"100.{suffix}.json").write_text("{}")
            with (
                mock.patch.object(css_mappings, "fetch_manifest", return_value=("100", {})),
                mock.patch.object(css_mappings, "download_sources") as download,
                mock.patch.object(css_mappings.subprocess, "run") as run,
            ):
                self.assertEqual(css_mappings.main([str(repo), *flags]), 0)
            download.assert_not_called()
            return [call.args[0][1] for call in run.call_args_list]

    def test_runs_pipeline_when_dumps_already_exist(self):
        self.assertEqual(self.run_main(), list(css_mappings.PIPELINE))

    def test_no_pipeline_skips_scripts(self):
        self.assertEqual(self.run_main("--no-pipeline"), [])


if __name__ == "__main__":
    unittest.main()
