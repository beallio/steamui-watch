"""Dump Steam Deck UI CSS class modules into a DeckThemes/CSSLoader-Mappings checkout.

Reads Valve's Steam Deck client manifests, downloads the matching steamui bundle,
writes webpack/<version>.<stable|beta>.json and runs the upstream mapping scripts.
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

CDN = "https://client-update.steamstatic.com"
# Valve client branch -> CSSLoader-Mappings file suffix.
BRANCHES = {"stable": "stable", "publicbeta": "beta"}
PIPELINE = ("webpack_id_mappings.py", "classname_mappings.py", "backport_classname_mappings.py")
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


def download_sources(fields):
    data = _get(f"{CDN}/{fields['file']}")
    if hashlib.sha256(data).hexdigest() != fields["sha2"].lower():
        raise SystemExit(f"{fields['file']}: SHA-256 does not match the manifest")
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        return [bundle.read(n).decode("utf-8", "replace") for n in bundle.namelist() if n.endswith(".js")]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mappings_repo", type=Path, help="checkout of DeckThemes/CSSLoader-Mappings")
    parser.add_argument("--branch", choices=BRANCHES, action="append", help="Valve branch (default: both)")
    parser.add_argument("--force", action="store_true", help="rewrite dumps that already exist")
    parser.add_argument("--no-pipeline", action="store_true", help="only write the webpack dumps")
    args = parser.parse_args(argv)

    webpack_dir = args.mappings_repo / "webpack"
    if not webpack_dir.is_dir() or not all((args.mappings_repo / s).is_file() for s in PIPELINE):
        parser.error(f"{args.mappings_repo} is not a CSSLoader-Mappings checkout")

    for branch in args.branch or BRANCHES:
        version, fields = fetch_manifest(branch)
        target = webpack_dir / f"{version}.{BRANCHES[branch]}.json"
        if target.exists() and not args.force:
            print(f"{branch}: {target.name} exists, skipping")
            continue
        modules = extract_class_modules(download_sources(fields))
        if len(modules) < MIN_MODULES:
            raise SystemExit(f"{branch}: only {len(modules)} class modules found; parser needs an update")
        target.write_text(json.dumps(modules), encoding="utf-8")
        print(f"{branch}: wrote {target.name} ({len(modules)} class modules)")

    # Run even when every dump existed: a failed or --no-pipeline earlier run must still be retryable.
    if not args.no_pipeline:
        for script in PIPELINE:
            print(f"running {script}", flush=True)
            subprocess.run([sys.executable, script], cwd=args.mappings_repo, check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
