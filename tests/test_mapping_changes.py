import json
import tempfile
import unittest
from pathlib import Path

from mapping_changes import build_notice


class MappingChangesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        (self.repo / "webpack").mkdir()

    def dump(self, version, modules):
        (self.repo / "webpack" / f"{version}.json").write_text(json.dumps(modules))

    def notice(self, *versions, deployment="success"):
        return build_notice(self.repo, versions, "https://github.test/o/r", "https://github.test/run/1", deployment)

    def test_identical_classes_and_renumbered_modules_are_version_only(self):
        self.dump("100.stable", {"1": {"Button": "button", "Label": "label"}})
        self.dump("200.stable", {"9": {"Label": "label", "Button": "button"}})
        title, body, label = self.notice("200.stable")
        self.assertIn("version only", title)
        self.assertEqual(label, "No change")
        self.assertIn("200.stable", title)
        self.assertIn("No class data changes", body)
        self.assertNotIn("Check themes", body)
        self.assertFalse((self.repo / "class-diffs").exists())

    def test_upstream_translation_tables_do_not_appear_as_removed_classes(self):
        classes = {"1": {"Button": "button"}}
        self.dump("100.stable", {**classes,
                                "2": {"language": "english", "Label": "Not a CSS class"},
                                "3": {"Generic_Close": "Close"},
                                "4": {"TimeInterval_XYears": "%s years"},
                                "5": {"moderation_contentreports_title": "Content reports"},
                                "6": {"0": "Unrelated constant"}})
        self.dump("200.stable", classes)
        title, body, _ = self.notice("200.stable")
        self.assertIn("version only", title)
        self.assertNotIn("removed", body)

    def test_changes_use_previous_same_branch_and_keep_the_full_diff(self):
        self.dump("9.stable", {"1": {"Button": "very_old"}})
        self.dump("10.stable", {"1": {"Button": "old", "Label": "unchanged"}})
        self.dump("19.beta", {"1": {"Button": "wrong_branch"}})
        self.dump("20.stable", {"2": {"Button": "new", "Label": "unchanged", "Other": "added"}})
        self.dump("30.stable", {"1": {"Button": "future"}})
        title, body, _ = self.notice("20.stable")
        self.assertIn("class changes", title)
        self.assertIn("10.stable", body)
        self.assertIn("<code>old</code>", body)
        self.assertIn("<code>new</code>", body)
        self.assertIn("/blob/mapping-data/class-diffs/10.stable-to-20.stable.diff", body)
        diff = (self.repo / "class-diffs" / "10.stable-to-20.stable.diff").read_text()
        self.assertIn('-    "Button": "old"', diff)
        self.assertIn('+    "Button": "new"', diff)
        self.assertNotIn("wrong_branch", diff)
        self.assertNotIn("very_old", diff)
        self.assertNotIn("future", diff)

    def test_binding_changes_are_not_mistaken_for_version_only(self):
        self.dump("100.beta", {"1": {"Button": "a", "Label": "b"}})
        self.dump("200.beta", {"1": {"Button": "b", "Label": "a"}})
        title, body, label = self.notice("200.beta")
        self.assertIn("class changes", title)
        self.assertEqual(label, "Changes")
        self.assertIn("bindings changed", body)
        self.assertTrue((self.repo / "class-diffs" / "100.beta-to-200.beta.diff").is_file())

    def test_missing_baseline_and_failed_deployment_do_not_claim_no_change_or_publication(self):
        self.dump("100.beta", {"1": {"Button": "a"}})
        title, body, label = self.notice("100.beta", deployment="failure")
        self.assertIn("comparison unavailable", title)
        self.assertEqual(label, "")
        self.assertIn("No earlier beta dump", body)
        self.assertIn("**failure**", body)
        self.assertIn("Do not test the published lists", body)
        self.assertNotIn("No class data changes", body)

    def test_inline_highlights_are_bounded_but_diff_is_complete(self):
        self.dump("100.stable", {"1": {"Old": "old"}})
        self.dump("200.stable", {"1": {f"Prop{i}": f"new_{i:03d}" for i in range(100)}})
        _, body, _ = self.notice("200.stable")
        self.assertIn("100 added", body)
        self.assertIn("1 removed", body)
        self.assertIn("full diff", body)
        self.assertNotIn("<code>new_099</code>", body)
        diff = (self.repo / "class-diffs" / "100.stable-to-200.stable.diff").read_text()
        self.assertIn('"new_099"', diff)

    def test_invalid_dump_is_not_reported_as_version_only(self):
        self.dump("100.stable", {"1": {"Button": "old"}})
        self.dump("200.stable", {"1": {"Button": None}})
        with self.assertRaises(ValueError):
            self.notice("200.stable")


if __name__ == "__main__":
    unittest.main()
