import unittest

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


if __name__ == "__main__":
    unittest.main()
