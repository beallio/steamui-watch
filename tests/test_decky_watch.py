import json
import re
import tempfile
import unittest
from pathlib import Path

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

    def test_prop_list_regex_matches_like_decky_ui(self):
        self.assertEqual(reasons(code("o", "H", props("flow-children", "onActivate"))), [])
        self.assertEqual(len(reasons(code("o", "I", props("onActivate", "flow-children")))), 1, "order matters")
        self.assertEqual(len(reasons(code("o", "J", props("onActivate", "onCancel")))), 1, "needs const{ start")
        self.assertEqual(reasons(code("o", "K", props("onActivate", "onCancel", from_start=False))), [])

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
        table = {"ui": "9.9.9", "finders": [
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


if __name__ == "__main__":
    unittest.main()
