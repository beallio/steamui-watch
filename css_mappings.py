"""Dump Steam Deck UI CSS class modules into a mappings checkout and build the CSS Loader lists.

Reads Valve's Steam Deck client manifests, downloads the matching steamui bundle,
writes webpack/<version>.<stable|beta>.json and webpack-literals/<version>.<stable|beta>.json
(class names Steam's own CSS uses as written) and runs the upstream mapping scripts.
"""

import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

import vite_css

CDN = "https://client-update.steamstatic.com"
# Valve client branch -> CSSLoader-Mappings file suffix.
BRANCHES = {"stable": "stable", "publicbeta": "beta"}
PIPELINE = ("webpack_id_mappings.py", "classname_mappings.py", "backport_classname_mappings.py")
FINGERPRINT_DIR = "css-fingerprints"
# Upstream dumps hold 500+ modules; far fewer means the bundle format changed under the parser.
MIN_MODULES = 400

_STR = r'"(?:[^"\\]|\\.)*"'
_ENTRY = rf'\s*({_STR}|[A-Za-z_$][\w$]*)\s*:\s*({_STR})\s*'
# Minified `123:(e=>{e.exports={a:"b"}})` and Prettier `123: (e) => {\n e.exports = { a: "b" };`.
_MODULE = re.compile(
    rf'(?<![\w$.])(\d+)\s*:\s*\(?\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\{{\s*\2\.exports\s*=\s*'
    rf'\{{((?:{_ENTRY},)*(?:{_ENTRY})?)\s*\}}'
)
_ENTRY_RE = re.compile(_ENTRY)
_ESCAPE = re.compile(r"\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(.))", re.S)
_SIMPLE_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0", "\n": ""}
_CSS_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_CSS_PRELUDE = re.compile(r"([^{}]+)\{")
_CSS_CLASS = re.compile(r"\.(-?[_a-zA-Z][\w-]*)")


def _js_string(literal):
    """Decode a double-quoted JS string literal; minifiers emit \\xHH, which JSON rejects."""
    decoded = _ESCAPE.sub(
        lambda m: chr(int(m[1] or m[2] or m[3], 16)) if m[4] is None else _SIMPLE_ESCAPES.get(m[4], m[4]),
        literal[1:-1],
    )
    # Join \uD83D\uDE00-style surrogate pairs into one character.
    return decoded.encode("utf-16", "surrogatepass").decode("utf-16")


def extract_class_modules(sources):
    """Return {webpack module id: {property: class}} like @decky/ui classModuleMap."""
    modules = {}
    for src in sources:
        for match in _MODULE.finditer(src):
            entries = {
                (_js_string(key) if key.startswith('"') else key): _js_string(value)
                for key, value in _ENTRY_RE.findall(match.group(3))
            }
            # Same exclusions as @decky/ui class-mapper.js.
            if not entries or (len(entries) == 1 and "version" in entries):
                continue
            if len(entries) > 1000 and "AboutSettings" in entries:
                continue
            modules[match.group(1)] = entries
    return modules


def literal_classes(css_sources, modules, *, exclude_vite_hashes=False):
    """Return the class names Steam's CSS selectors use as written, not through an exported module class."""
    exported = {value for module in modules.values() for value in module.values()}
    used = {
        name
        for src in css_sources
        for prelude in _CSS_PRELUDE.findall(_CSS_COMMENT.sub("", src))
        for name in _CSS_CLASS.findall(prelude)
    }
    plain = used - exported
    if exclude_vite_hashes:
        plain = {name for name in plain if not vite_css.is_vite_hash(name)}
    return sorted(plain)


def _get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "steamui-watch"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.read()


def fetch_manifest(branch):
    """Return (client version, steamui_websrc_all fields) for a Steam Deck client branch."""
    manifest = _get(f"{CDN}/steam_client_steamdeck_{branch}_steamrt64").decode()
    version = re.search(r'"version"\s+"(\d+)"', manifest)
    block = re.search(r'"steamui_websrc_all"\s*\{([^}]*)\}', manifest)
    if not version or not block:
        raise SystemExit(f"{branch}: manifest has no version or steamui_websrc_all entry")
    fields = dict(re.findall(r'"(\w+)"\s+"([^"]*)"', block.group(1)))
    if "file" not in fields or "sha2" not in fields:
        raise SystemExit(f"{branch}: steamui_websrc_all entry has no file or sha2")
    return version.group(1), fields


def download_bundle(fields):
    """Return {file name: text} for the JS and CSS files of the verified steamui bundle."""
    data = _get(f"{CDN}/{fields['file']}")
    if hashlib.sha256(data).hexdigest() != fields["sha2"].lower():
        raise SystemExit(f"{fields['file']}: SHA-256 does not match the manifest")
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        return {n: bundle.read(n).decode("utf-8", "replace") for n in bundle.namelist() if n.endswith((".js", ".css"))}


def download_sources(fields):
    return [text for name, text in download_bundle(fields).items() if name.endswith(".js")]

def _validate_mapping_output(path):
    try:
        mappings = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"{path.name}: cannot read valid mapping JSON: {error}") from error
    if not isinstance(mappings, dict) or not mappings:
        raise SystemExit(f"{path.name}: expected a nonempty JSON object")
    for module_id, history in mappings.items():
        if not isinstance(history, list) or not history or any(not isinstance(name, str) for name in history):
            raise SystemExit(f"{path.name}: history for {module_id!r} must be a nonempty list of strings")


def validate_matches(repo):
    """Reject module matches the upstream pipeline would mishandle, e.g. bad hand edits.

    A match must map a module of the old version onto a module that is new in the new version,
    and each new module at most once: a target that already existed has its own history, and
    merging two histories crashes the pipeline ("Chain ... already exists").
    A source ID that is reused for a different module must also be listed as new; otherwise
    moving its history discards the surviving module's identity.
    """
    dumps = {p.name.split(".")[0]: p for p in (repo / "webpack").glob("*.json")}
    loaded = {}

    def modules(version, path):
        if version not in dumps:
            raise SystemExit(f"{path.name}: no webpack dump for version {version}")
        if version not in loaded:
            loaded[version] = json.loads(dumps[version].read_text(encoding="utf-8"))
        return loaded[version]

    for path in sorted((repo / "webpack-mappings").glob("*to*.json")):
        old_version, new_version = path.stem.split("to")
        old, new = modules(old_version, path), modules(new_version, path)
        doc = json.loads(path.read_text(encoding="utf-8"))
        listed_new = {entry["new"] for entry in doc["new"]}
        targets = set()
        for module_id, entry in doc["mapped"].items():
            target = entry["new"]
            match = f"{path.name}: {module_id}->{target}"
            if module_id not in old:
                raise SystemExit(f"{match}: module {module_id} is not in version {old_version}")
            if module_id in new and module_id not in listed_new:
                raise SystemExit(f"{match}: module {module_id} still exists in {new_version}; record a reused ID as new or keep its history")
            if target not in new:
                raise SystemExit(f"{match}: module {target} is not in version {new_version}")
            if target in old:
                raise SystemExit(f"{match}: module {target} already existed in {old_version} and has its own history")
            if target in listed_new or target in targets:
                raise SystemExit(f"{match}: module {target} is used twice (remove it from the \"new\" list)")
            targets.add(target)



def _fingerprint_matches(path, version):
    if not path.is_file():
        return False
    try:
        return vite_css.load_fingerprint(path).get("version") == version
    except (OSError, ValueError):
        return False


def _build_webpack_fingerprint(css_files, modules, version):
    all_classes, all_keyframes = vite_css.css_symbols(css_files)
    mappable = {v for mod in modules.values() for v in mod.values() if vite_css.is_mappable_value(v)}
    return vite_css.build_css_fingerprint(
        css_files, mappable & all_classes, mappable & all_keyframes, version=version, bundler="webpack"
    )


def _build_vite_fingerprint(css_files, version):
    all_classes, all_keyframes = vite_css.css_symbols(css_files)
    target_classes = {c for c in all_classes if vite_css.is_vite_hash(c)}
    target_keyframes = {k for k in all_keyframes if vite_css.is_vite_hash(k)}
    return vite_css.build_css_fingerprint(
        css_files, target_classes, target_keyframes, version=version, bundler="vite"
    )


def _select_reference(repo, suffix):
    """Return (modules, fingerprint) for the best retained reference dump to match a Vite bundle against."""
    webpack_dir = repo / "webpack"
    fp_dir = repo / FINGERPRINT_DIR
    other = "beta" if suffix == "stable" else "stable"
    candidates = []
    for priority_branch, fp_suffix in ((0, suffix), (1, other)):
        fp_path = fp_dir / f"{fp_suffix}.json.gz"
        if not fp_path.is_file():
            continue
        fp = vite_css.load_fingerprint(fp_path)
        fp_version = fp.get("version")
        if not isinstance(fp_version, str):
            continue
        dump_path = webpack_dir / f"{fp_version}.{fp_suffix}.json"
        if not dump_path.is_file():
            dump_path = webpack_dir / f"{fp_version}.{other if fp_suffix == suffix else suffix}.json"
        if not dump_path.is_file():
            continue
        # Prefer Vite -> Vite (identity pass + identical LightningCSS minification) over Webpack -> Vite.
        bundler_rank = 0 if fp.get("bundler") == "vite" else 1
        candidates.append((bundler_rank, priority_branch, dump_path, fp))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1]))
    _, _, dump_path, fp = candidates[0]
    return json.loads(dump_path.read_text(encoding="utf-8")), fp


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mappings_repo", type=Path,
                        help="checkout of this repository's mapping-data branch (DeckThemes/CSSLoader-Mappings format)")
    parser.add_argument("--branch", choices=BRANCHES, action="append", help="Valve branch (default: both)")
    parser.add_argument("--force", action="store_true", help="rewrite dumps that already exist")
    parser.add_argument("--no-pipeline", action="store_true", help="only write the webpack dumps")
    args = parser.parse_args(argv)

    webpack_dir = args.mappings_repo / "webpack"
    literals_dir = args.mappings_repo / "webpack-literals"
    fingerprints_dir = args.mappings_repo / FINGERPRINT_DIR
    if not webpack_dir.is_dir() or not all((args.mappings_repo / s).is_file() for s in PIPELINE):
        parser.error(f"{args.mappings_repo} is not a CSSLoader-Mappings checkout")

    for branch in args.branch or BRANCHES:
        version, fields = fetch_manifest(branch)
        suffix = BRANCHES[branch]
        name = f"{version}.{suffix}.json"
        target, literals = webpack_dir / name, literals_dir / name
        fp_path = fingerprints_dir / f"{suffix}.json.gz"
        if target.exists() and literals.exists() and _fingerprint_matches(fp_path, version) and not args.force:
            print(f"{branch}: {name} exists, skipping")
            continue
        files = download_bundle(fields)
        js_sources = [text for n, text in files.items() if n.endswith(".js")]
        css_files = {n: text for n, text in files.items() if n.endswith(".css")}
        is_vite = False
        fingerprint = None

        if target.exists() and not args.force:
            # Keep the retained dump; backfill only the literal list and/or CSS fingerprint it predates.
            modules = json.loads(target.read_text(encoding="utf-8"))
            is_vite = vite_css.is_vite_bundle(js_sources)
        else:
            modules = extract_class_modules(js_sources)
            if len(modules) < MIN_MODULES and vite_css.is_vite_bundle(js_sources):
                is_vite = True
                other_suffix = "beta" if suffix == "stable" else "stable"
                other_dump = webpack_dir / f"{version}.{other_suffix}.json"
                if other_dump.is_file() and not args.force:
                    modules = json.loads(other_dump.read_text(encoding="utf-8"))
                    print(f"{branch}: reused shared Vite dump from {other_dump.name} ({len(modules)} class modules)")
                else:
                    ref = _select_reference(args.mappings_repo, suffix)
                    if ref is None:
                        raise SystemExit(
                            f"{branch}: Vite/Rolldown bundle needs a retained CSS fingerprint to match against"
                        )
                    ref_modules, ref_fp = ref
                    fingerprint = _build_vite_fingerprint(css_files, version)
                    new_syms = {c for _, _, found in fingerprint["rules"] for c in found} | set(fingerprint["keyframes"])
                    js_mods = vite_css.extract_vite_js_modules(js_sources, new_syms)
                    modules, stats = vite_css.match_vite_modules(ref_modules, ref_fp, fingerprint, js_mods)
                    print(
                        f"{branch}: matched Vite bundle against {ref_fp['version']} "
                        f"({stats['matched_symbols']}/{stats['total_old_symbols']} symbols, "
                        f"{stats['js_anchored']} JS anchors, {stats['new_js_modules']} new JS modules)"
                    )
            if len(modules) < MIN_MODULES:
                raise SystemExit(f"{branch}: only {len(modules)} class modules found; parser needs an update")
            target.write_text(json.dumps(modules), encoding="utf-8")
            print(f"{branch}: wrote {target.name} ({len(modules)} class modules)")

        if fingerprint is None:
            fingerprint = (
                _build_vite_fingerprint(css_files, version)
                if is_vite
                else _build_webpack_fingerprint(css_files, modules, version)
            )
        vite_css.save_fingerprint(fp_path, fingerprint)
        print(f"{branch}: wrote {FINGERPRINT_DIR}/{fp_path.name} ({len(fingerprint['rules'])} rules)")

        plain = literal_classes(css_files.values(), modules, exclude_vite_hashes=is_vite)
        literals_dir.mkdir(exist_ok=True)
        literals.write_text(json.dumps(plain), encoding="utf-8")
        print(f"{branch}: wrote webpack-literals/{name} ({len(plain)} plain class names)")

    # Run even when every dump existed: a failed or --no-pipeline earlier run must still be retryable.
    if not args.no_pipeline:
        validate_matches(args.mappings_repo)
        for script in PIPELINE:
            print(f"running {script}", flush=True)
            subprocess.run([sys.executable, script], cwd=args.mappings_repo, check=True)
        for branch in BRANCHES.values():
            _validate_mapping_output(args.mappings_repo / f"{branch}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
