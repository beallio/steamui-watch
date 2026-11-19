import gzip
import tempfile
import unittest
from pathlib import Path

import vite_css


class ViteDetectionTest(unittest.TestCase):
    def test_detects_vite_and_rolldown_bundles(self):
        self.assertTrue(vite_css.is_vite_bundle(["const __vite__mapDeps=(i)=>i;"]))
        self.assertTrue(vite_css.is_vite_bundle(["/* https://rolldown.rs/in-depth/bundling-cjs */"]))
        self.assertFalse(vite_css.is_vite_bundle(["(self.webpackChunksteamui||[]).push([[1],{}]);"]))
        self.assertFalse(vite_css.is_vite_bundle(["const __vite__mapDeps=1;", "self.webpackChunksteamui"]))
        self.assertFalse(vite_css.is_vite_bundle(["console.log('plain');"]))

    def test_vite_hash_pattern(self):
        for valid in ("mORFK1ZCuIg-", "_8VNLBL23-Uw-", "-lZeM6FxbKY-", "kg8VJS07NZk-"):
            self.assertTrue(vite_css.is_vite_hash(valid), valid)
        for invalid in ("Launch", "GamepadMode", "fntOoeLPSTpmyXGGmgf99", "short-", "too_long_class_name-"):
            self.assertFalse(vite_css.is_vite_hash(invalid), invalid)


class ExtractViteJsModulesTest(unittest.TestCase):
    def test_extracts_var_backed_objects_and_namespace_exports(self):
        src = (
            'var a=`mORFK1ZCuIg-`,b=`_8VNLBL23-Uw-`,c=`500px`,'
            'obj={narrowWidth:c,"duration-app-launch":`800ms`,Dialog:a,Active:b};'
            'r({Tab:()=>d,Selected:()=>e,default:()=>nsObj});'
            'var d=`ClGEWqq4TSI-`,e=`PCyR5hQQwH4-`,nsObj={Tab:d,Selected:e};'
            'var plain={foo:`bar`,baz:`qux`};'
        )
        hashed = {"mORFK1ZCuIg-", "_8VNLBL23-Uw-", "ClGEWqq4TSI-", "PCyR5hQQwH4-"}
        extracted = vite_css.extract_vite_js_modules([src], hashed)
        self.assertIn(
            {"narrowWidth": "500px", "duration-app-launch": "800ms", "Dialog": "mORFK1ZCuIg-", "Active": "_8VNLBL23-Uw-"},
            extracted,
        )
        self.assertIn({"Tab": "ClGEWqq4TSI-", "Selected": "PCyR5hQQwH4-"}, extracted)
        self.assertEqual(len(extracted), 2)

    def test_decodes_js_escapes_in_backtick_and_quoted_literals(self):
        src = r'var x=`mORFK1ZCuIg-`,y=`\x5f8VNLBL23-Uw-`,o={"T\xF6r":x,Alt:y,Font:`\"Motiva Sans\", sans-serif`};'
        hashed = {"mORFK1ZCuIg-", "_8VNLBL23-Uw-"}
        extracted = vite_css.extract_vite_js_modules([src], hashed)
        self.assertEqual(
            extracted,
            [{"Tör": "mORFK1ZCuIg-", "Alt": "_8VNLBL23-Uw-", "Font": '"Motiva Sans", sans-serif'}],
        )

    def test_rejects_jsx_props_objects_with_class_hashes(self):
        src = (
            'var h=`mORFK1ZCuIg-`,empty=``,loc=`#Login_NoSteamAccount`;'
            'jsx(`div`,{className:h,title:loc,children:empty});'
            'jsx(`div`,{radius:`sm`,background:`dull-8`,className:h});'
        )
        self.assertEqual(vite_css.extract_vite_js_modules([src], {"mORFK1ZCuIg-"}), [])


class CssFingerprintTest(unittest.TestCase):
    def test_webpack_and_lightningcss_normalize_to_identical_hashes(self):
        webpack_css = {
            "sp.css": (
                "/* comment */"
                "@keyframes _oldKf{from{opacity:0px}to{opacity:1}}"
                "._oldA::before{background-color:rgba(0,0,0,.5);color:hsla(0,0%,100%,.15);"
                "transition:color 200ms ease;margin-left:8px;margin-right:-8px;border-left:1px solid #000000;"
                "top:0px;right:0px;bottom:0px;left:0px;font-weight:normal;"
                "background:radial-gradient(ellipse 80px 80px at 60px 12px, #59bf40 0%, #236c39 70%);"
                "width:calc(var(--w)*-1);font-family:\"Motiva Sans\",sans-serif;animation:_oldKf 0.5s}"
            )
        }
        lightning_css = {
            "chunk~1.css": (
                "@keyframes newKf123456-{0%{opacity:0}100%{opacity:1}}"
                ".newClass123-:before{animation:newKf123456- .5s;font-family:Motiva Sans,sans-serif;"
                "width:calc(var(--w) * -1);background:radial-gradient(80px 80px at 60px 12px,#59bf40 0%,#236c39 70%);"
                "font-weight:400;inset:0;border-inline-start:1px solid #000;margin-inline:8px -8px;"
                "transition:color .2s;color:#ffffff26;background-color:#00000080}"
            )
        }
        fp_old = vite_css.build_css_fingerprint(webpack_css, {"_oldA"}, {"_oldKf"}, version="100", bundler="webpack")
        fp_new = vite_css.build_css_fingerprint(
            lightning_css, {"newClass123-"}, {"newKf123456-"}, version="200", bundler="vite"
        )
        self.assertEqual(len(fp_old["rules"]), 1)
        self.assertEqual(len(fp_new["rules"]), 1)
        # Full hash and loose hash both match across Webpack and LightningCSS.
        self.assertEqual(fp_old["rules"][0][0], fp_new["rules"][0][0])
        self.assertEqual(fp_old["rules"][0][1], fp_new["rules"][0][1])
        self.assertEqual(fp_old["keyframes"]["_oldKf"], fp_new["keyframes"]["newKf123456-"])

    def test_saved_fingerprint_contains_no_raw_css_and_is_byte_deterministic(self):
        css = {"sp.css": "._secretClass{background-color:#123456;content:'unique-valve-token';border-radius:19px}"}
        fp = vite_css.build_css_fingerprint(css, {"_secretClass"}, set(), version="100", bundler="webpack")
        with tempfile.TemporaryDirectory() as tmp:
            p1, p2 = Path(tmp) / "a.json.gz", Path(tmp) / "b.json.gz"
            vite_css.save_fingerprint(p1, fp)
            vite_css.save_fingerprint(p2, fp)
            self.assertEqual(p1.read_bytes(), p2.read_bytes())
            raw = gzip.decompress(p1.read_bytes()).decode("utf-8")
            self.assertNotIn("#123456", raw)
            self.assertNotIn("unique-valve-token", raw)
            self.assertNotIn("border-radius", raw)
            self.assertEqual(vite_css.load_fingerprint(p1), fp)


class MatchViteModulesTest(unittest.TestCase):
    def test_matches_via_js_anchors_keyframes_exact_cooccurrence_and_loose_neighborhood(self):
        old_mods = {
            "100": {
                "duration-app-launch": "800ms",
                "Root": "_oldRoot",
                "Child": "_oldChild",
                "Edited": "_oldEdited",
                "Removed": "_oldRemoved",
                "Spin": "_oldSpin",
            },
            "200": {
                "Panel": "_oldPanel",
                "Header": "_oldHeader",
                "Title": "_oldTitle",
                "Body": "_oldBody",
                "Footer": "_oldFooter",
            },
        }
        old_css = {
            "sp.css": (
                "@keyframes _oldSpin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}"
                "._oldRoot{display:flex;width:317px;height:41px;animation:_oldSpin 1s}"
                "._oldRoot ._oldChild{color:#fff}"
                "._oldEdited{padding:11px;letter-spacing:3px;border-radius:7px}"
                "._oldRemoved{opacity:0.42;z-index:99}"
                # Duplicate copy of ._oldChild rule elsewhere to prove co-occurrence disambiguates it
                "._unrelated{color:#fff}"
            )
        }
        new_css = {
            "chunk~1.css": (
                "@keyframes newSpin1234-{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}"
                ".newRoot1234-{height:41px;width:317px;display:flex;animation:newSpin1234- 1s}"
                ".newRoot1234- .newChild123-{color:#fff}"
                # Value tweaked (11px -> 14px) so full hash differs, but keys-only hash matches in neighborhood!
                ".newEdited12-{padding:14px;letter-spacing:3px;border-radius:7px}"
                ".otherUnrel1-{color:#fff}"
            )
        }
        # Module 200 survives in JS (anchors all 5 properties directly even with no CSS rules in this fixture)
        new_js_modules = [
            {
                "Panel": "newPanel123-",
                "Header": "newHeader12-",
                "Title": "newTitle123-",
                "Body": "newBody1234-",
                "Footer": "newFooter12-",
            },
            # Brand-new JS module not in old_mods
            {
                "BrandNewA": "brandNewAAA-",
                "BrandNewB": "brandNewBBB-",
                "BrandNewC": "brandNewCCC-",
            },
        ]
        fp_old = vite_css.build_css_fingerprint(
            old_css, {"_oldRoot", "_oldChild", "_oldEdited", "_oldRemoved", "_unrelated"}, {"_oldSpin"},
            version="100", bundler="webpack",
        )
        fp_new = vite_css.build_css_fingerprint(
            new_css, {"newRoot1234-", "newChild123-", "newEdited12-", "otherUnrel1-"}, {"newSpin1234-"},
            version="200", bundler="vite",
        )

        reconstructed, stats = vite_css.match_vite_modules(old_mods, fp_old, fp_new, new_js_modules)

        self.assertEqual(
            reconstructed["100"],
            {
                "duration-app-launch": "800ms",
                "Root": "newRoot1234-",
                "Child": "newChild123-",
                "Edited": "newEdited12-",
                "Spin": "newSpin1234-",
            },
        )
        self.assertNotIn("Removed", reconstructed["100"])
        self.assertEqual(reconstructed["200"], new_js_modules[0])
        # Brand-new JS module receives a deterministic synthetic ID
        new_ids = [mid for mid in reconstructed if mid not in ("100", "200")]
        self.assertEqual(len(new_ids), 1)
        self.assertTrue(new_ids[0].startswith("vite_"))
        self.assertEqual(reconstructed[new_ids[0]], new_js_modules[1])
        self.assertGreaterEqual(stats["matched_symbols"], 9)

    def test_vite_to_vite_identity_pass_preserves_unchanged_hashes(self):
        old_mods = {"100": {"Button": "keepSame123-", "Changed": "oldHash1234-"}}
        old_css = {"a.css": ".keepSame123-{color:#111}.oldHash1234-{padding:13px;margin:7px}"}
        # Suppose keepSame123-'s CSS changed drastically, yet its hash stayed identical; Changed got a new hash.
        new_css = {"a.css": ".keepSame123-{display:grid;gap:9px}.newHash1234-{margin:7px;padding:13px}"}
        fp_old = vite_css.build_css_fingerprint(
            old_css, {"keepSame123-", "oldHash1234-"}, set(), version="200", bundler="vite"
        )
        fp_new = vite_css.build_css_fingerprint(
            new_css, {"keepSame123-", "newHash1234-"}, set(), version="300", bundler="vite"
        )

        reconstructed, _ = vite_css.match_vite_modules(old_mods, fp_old, fp_new, [])
        self.assertEqual(reconstructed["100"], {"Button": "keepSame123-", "Changed": "newHash1234-"})

    def test_ambiguous_classes_without_context_are_omitted_not_guessed(self):
        old_mods = {"1": {"A": "_oldA"}, "2": {"B": "_oldB"}}
        old_css = {"a.css": "._oldA{color:red}._oldB{color:red}"}
        new_css = {"a.css": ".newClass001-{color:red}.newClass002-{color:red}"}
        fp_old = vite_css.build_css_fingerprint(old_css, {"_oldA", "_oldB"}, set(), version="100", bundler="webpack")
        fp_new = vite_css.build_css_fingerprint(
            new_css, {"newClass001-", "newClass002-"}, set(), version="200", bundler="vite"
        )
        reconstructed, _ = vite_css.match_vite_modules(old_mods, fp_old, fp_new, [])
        self.assertEqual(reconstructed, {})

    def test_csstransition_wrappers_are_not_added_as_synthetic_modules(self):
        old_mods = {"1": {"Root": "_oldRoot"}}
        fp_old = vite_css.build_css_fingerprint({"a.css": "._oldRoot{width:19px}"}, {"_oldRoot"}, set(), version="1", bundler="webpack")
        fp_new = vite_css.build_css_fingerprint({"a.css": ".newRoot1234-{width:19px}"}, {"newRoot1234-"}, set(), version="2", bundler="vite")
        transition_obj = {"enter": "trEnter1234-", "enterActive": "trActv12345-", "exit": "trExit12345-"}
        reconstructed, stats = vite_css.match_vite_modules(old_mods, fp_old, fp_new, [transition_obj])
        self.assertEqual(list(reconstructed), ["1"])
        self.assertEqual(stats["new_js_modules"], 0)


if __name__ == "__main__":
    unittest.main()
