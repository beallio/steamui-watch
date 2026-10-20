import re
import unittest

from decky_watch import FINDERS, classes, code, missing, name, props

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

    def test_finder_table_is_well_formed(self):
        for finder in FINDERS:
            self.assertTrue(finder.code or finder.classes, finder.name)
            self.assertTrue(all(finder.code), finder.name)


if __name__ == "__main__":
    unittest.main()
