import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import decky_watch
from decky_watch import FINDERS, classes, code, load_ui_finders, missing, name, props

BUNDLE = [
    'X.render=function(){return(0,a.jsx)(b,{setFocusedColumn:c})};',
    'const{"flow-children":e,onActivate:t,onCancel:n}=p;class Q{GetPanelElementProps(){}}',
]
MODULES = {"7": {"Title": "a", "QuickAccessMenu": "b"}, "8": {"Title": "c", "Page": "d"}}


def reasons(*finders):
    return [(finder.name, reason) for finder, reason in missing(BUNDLE, MODULES, finders)]


class MissingTest(unittest.TestCase):
    def test_every_clause_must_match_and_any_alternative_satisfies_a_clause(self):
        self.assertEqual(reasons(code("o", "A", "setFocusedColumn:", ("gone", re.compile(r"jsx\)\(\w,")))), [])
        self.assertEqual(reasons(code("o", "B", "setFocusedColumn:", ("gone", re.compile("also gone")))),
                         [("B", "none of `gone` / `also gone` (regex)")])

    def test_class_rule_needs_one_module_with_all_names_and_none_of_the_excluded(self):
        self.assertEqual(reasons(classes("o", "C", "Title", lacks=("Page",))), [])
        self.assertEqual(reasons(classes("o", "D", "Title", "Page", lacks=("QuickAccessMenu",))), [])
        self.assertEqual(reasons(classes("o", "E", "QuickAccessMenu", "Page")),
                         [("E", "no class module with Page, QuickAccessMenu")])
        self.assertEqual(reasons(classes("o", "F", "Page", module="7")), [("F", "no module 7 with Page")])
        self.assertEqual(reasons(classes("o", "G", "Page", module="99")), [("G", "no module 99 with Page")])

    def test_prop_list_regex_uses_table_prefix(self):
        text = 'let{"flow-children":e,"onActivate":t}=p;'
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "table.json"
            path.write_text(json.dumps({"ui": "5.0.1", "prop_prefix": r"(?:const|let)\{", "finders": [
                {"name": "f.js: props", "code": [[{"props": ["flow-children", "onActivate"], "from_start": True}]]}
            ]}))
            finders = load_ui_finders(path)
        self.assertEqual(missing([text], {}, finders), [])
        self.assertEqual(len(missing([text], {}, (code("o", "legacy", props("flow-children", "onActivate")),))), 1)
    def test_names_do_not_match_inside_longer_identifiers(self):
        self.assertEqual(reasons(code("o", "L", name("GetPanelElementProps"))), [])
        self.assertEqual(len(reasons(code("o", "M", name("PanelElementProps")))), 1)

    def test_toast_dismissal_requires_both_removal_methods(self):
        toaster = [finder for finder in FINDERS if finder.name.startswith("toaster:")]
        bundle = (
            'const toast={controller:"notification",method:"toast"};'
            'class NotificationStore{RemoveGroupFromTray(){}RemoveFromToastsWhere(){}}'
        )
        self.assertEqual(missing([bundle], {}, toaster), [])
        for method in ("RemoveGroupFromTray", "RemoveFromToastsWhere"):
            with self.subTest(method=method):
                failures = missing([bundle.replace(method, "MissingMethod")], {}, toaster)
                self.assertEqual([finder.name for finder, _ in failures],
                                 ["toaster: NotificationStore removal methods"])

    def test_qam_hook_needs_only_the_browser_view(self):
        # tabs-hook.tsx patches QuickAccessMenuEmbedded only when the build has it.
        qam = [finder for finder in FINDERS if finder.name.startswith("tabs-hook")]
        self.assertEqual(len(qam), 1)
        bundle = ['A.type=function(){return"QuickAccessMenuBrowserView"};']
        self.assertEqual(missing(bundle, {}, qam), [])

    def test_generated_table_loads_with_bounded_regexes(self):
        table = {"ui": "9.9.9", "prop_prefix": r"const\{", "finders": [
            {"name": "f.js: A", "code": [[{"text": "setFocusedColumn:"}, {"name": "Gone"}], [{"props": ["onActivate", "onCancel"], "from_start": False}]]},
            {"name": "f.js: B", "code": [[{"regex": r"className:.+?\.Sep"}]]},
            {"name": "f.js: C", "classes": {"has": ["Title"], "lacks": ["Page"]}}]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "table.json"
            path.write_text(json.dumps(table))
            finders = load_ui_finders(path)
        self.assertEqual({f.owner for f in finders}, {"@decky/ui 9.9.9"})
        self.assertEqual([(f.name, r) for f, r in missing(BUNDLE + ['className:a.Sep'], MODULES, finders)], [])
        far = ["className:" + "x" * 301 + ".Sep"]
        self.assertEqual([f.name for f, _ in missing(far, {"7": {"Title": "a", "Page": "b"}}, finders)],
                         ["f.js: A", "f.js: B", "f.js: C"], "`.+?` stops at 300 characters")

    def test_esm_preserves_backticks_and_skips_webpack_only_finders(self):
        esm = ["const __vite__mapDeps=(i)=>i; function fn(){return{controller:`notification`,method:`toast`}}"]
        toaster = code("o", "toaster", re.compile(r'controller:[`"]notification[`"],method:'))
        webpack_only = code("o", "webpack", "only webpack", webpack_only=True)
        self.assertEqual(missing(esm, {}, (toaster, webpack_only)), [])
        self.assertEqual([f.name for f, _ in missing(["only webpack"], {}, (webpack_only,))], [])
        self.assertEqual([f.name for f, _ in missing([""], {}, (webpack_only,))], ["webpack"])

    def test_loader_patterns_match_new_literals(self):
        error = next(f for f in FINDERS if f.name.startswith("errorboundary-hook"))
        self.assertEqual(missing(["const store=()=>(store||=new CErrorReportingStore,store);BIsBlacklisted"], {}, (error,)), [])
        toaster = next(f for f in FINDERS if f.name == "toaster: Valve toast renderer")
        for quote in ('"', "`"):
            self.assertEqual(missing([f"controller:{quote}notification{quote},method:"], {}, (toaster,)), [])

    def test_main_chooses_finder_table_by_bundle_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            webpack = Path(tmp) / "webpack.json"
            esm = Path(tmp) / "esm.json"
            webpack.touch()
            esm.touch()
            selected = []
            def table(path):
                selected.append(path)
                return (code("ui", "present", "present"),)
            def sources(fields):
                return ["present const __vite__mapDeps=(i)=>i;" if fields == "esm" else "present"]
            with patch.object(decky_watch, "fetch_manifest", side_effect=[
                ("1", "webpack"), ("2", "esm")]), \
                 patch.object(decky_watch, "download_sources", side_effect=sources), \
                 patch.object(decky_watch, "extract_class_modules", return_value={}), \
                 patch.object(decky_watch, "load_ui_finders", side_effect=table), \
                 patch.object(decky_watch, "FINDERS", ()):
                self.assertEqual(decky_watch.main([
                    tmp, "--ui-finders-webpack", str(webpack), "--ui-finders-esm", str(esm),
                    "--branch", "stable", "--branch", "publicbeta",
                ]), 0)
            self.assertEqual(selected, [webpack, esm])



if __name__ == "__main__":
    unittest.main()
