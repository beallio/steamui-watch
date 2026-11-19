"""Match CSS class modules across Vite/Rolldown SteamUI bundles using hashed CSS fingerprints and JS anchors.

Valve's Vite/Rolldown builds tree-shake ~85% of CSS module property names out of JavaScript,
replacing `styles.Foo` with minified variables or bare 12-character trailing-dash class hashes.
This module matches those classes back to the previous retained dump using:
1. Surviving Rolldown CSS module objects / namespace exports in JS (exact anchors).
2. Identity matching for unchanged Vite class hashes on Vite -> Vite updates.
3. Irreversible SHA-256 fingerprints of normalized CSS rules and @keyframes (zero raw CSS saved).
4. Iterative selector co-occurrence and module-neighborhood Jaccard propagation.
"""

from __future__ import annotations

import colorsys
import gzip
import hashlib
import json
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

FINGERPRINT_SCHEMA = 1

_VITE_HASH = re.compile(r"^_?[A-Za-z0-9_-]{11}-$")
_CSS_COLOR = re.compile(r"^#[0-9a-fA-F]{3,8}$")
_CSS_UNIT = re.compile(r"^-?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|%|vw|vh|vmin|vmax|s|ms|deg|fr)?$")
_JSX_PROP_KEYS = frozenset({"className", "children", "style", "onClick", "onChange", "ref"})
_CSSTRANSITION_KEYS = frozenset({
    "appear", "appearActive", "appearDone",
    "enter", "enterActive", "enterDone",
    "exit", "exitActive", "exitDone",
    "base", "enterStart", "enterEnd", "exitStart", "exitEnd",
})
_CSS_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_CSS_CLASS = re.compile(r"\.(-?[_a-zA-Z][\w-]*)")
_CSS_RULE = re.compile(r"([^{}@;]+)\{([^{}]*)\}")
_KEYFRAMES_BLOCK = re.compile(r"@keyframes\s+(-?[_a-zA-Z][\w-]*)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}")

_RGBA = re.compile(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)")
_HSLA = re.compile(r"hsla?\(\s*([0-9.]+)\s*,\s*([0-9.]+)%\s*,\s*([0-9.]+)%\s*(?:,\s*([0-9.]+)\s*)?\)")
_MS = re.compile(r"(?<![.\d])(\d+)ms\b")
_ZERO_UNIT = re.compile(r"(?<![.\d])0(?:px|em|rem|%|vw|vh|deg|s|ms)\b")
_LEADING_ZERO = re.compile(r"\b0\.(\d+)")
_HEX6_SHORT = re.compile(r"#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b")
_HEX8_SHORT = re.compile(r"#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3([0-9a-f])\4\b")
_PUNCT_SPACE = re.compile(r"\s*([,()/*+])\s*")
_WHITESPACE = re.compile(r"\s+")
_PSEUDO_COLON = re.compile(r"::(before|after|first-line|first-letter)\b")
_COMBINATOR_SPACE = re.compile(r"\s*([>+~])\s*")
_TRANSITION_EASE = re.compile(r"\bease\b")

_ESCAPE = re.compile(r"\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(.))", re.S)
_SIMPLE_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0", "\n": ""}

_STR_LIT = r'(?:`(?:[^`\\$]|\\.)*`|"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\')'
_KEY_PAT = r'(?:[A-Za-z_$][\w$]*|"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\')'
_VAL_PAT = rf'(?:{_STR_LIT}|[A-Za-z_$][\w$]*)'
_VAR_BIND = re.compile(rf'(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*({_STR_LIT})(?=[,;)\s]|$)')
_OBJ_ENTRY = rf'\s*({_KEY_PAT})\s*:\s*({_VAL_PAT})\s*'
_OBJ_LIT = re.compile(rf'\{{((?:{_OBJ_ENTRY},)*(?:{_OBJ_ENTRY})?)\}}')
_OBJ_ENTRY_RE = re.compile(_OBJ_ENTRY)
_NS_ENTRY = rf'\s*({_KEY_PAT})\s*:\s*\(\)\s*=>\s*({_VAL_PAT})\s*'
_NS_CALL = re.compile(rf'(?<![\w$.])[A-Za-z_$][\w$]*\(\{{((?:{_NS_ENTRY},)*(?:{_NS_ENTRY})?)\}}\)')
_NS_ENTRY_RE = re.compile(_NS_ENTRY)


def is_vite_bundle(js_sources: Iterable[str]) -> bool:
    """Return True when the JS files are a Vite/Rolldown ESM bundle rather than Webpack."""
    has_vite = False
    for src in js_sources:
        if "webpackChunk" in src:
            return False
        if "__vite__mapDeps" in src or "rolldown.rs/" in src:
            has_vite = True
    return has_vite


def is_vite_hash(name: str) -> bool:
    """Return True for Vite/LightningCSS 12-13 char trailing-dash scoped class hashes."""
    return _VITE_HASH.match(name) is not None


def is_mappable_value(value: str) -> bool:
    """Mirror upstream classname_mappings.py filter_single: skip empty, numeric-leading, or spaced constants."""
    return len(value) > 0 and not value[0].isnumeric() and " " not in value


def _is_css_module_value(value: str) -> bool:
    """Return True for Vite hashed classes or CSS constants (colors, units, multi-word values), never JSX props."""
    if is_vite_hash(value):
        return True
    if not value:
        return False
    return not is_mappable_value(value) or _CSS_COLOR.match(value) is not None or _CSS_UNIT.match(value) is not None


def _is_css_module_object(entries: Mapping[str, str]) -> bool:
    if len(entries) < 2 or (_JSX_PROP_KEYS & entries.keys()):
        return False
    return all(_is_css_module_value(v) for v in entries.values())


def _decode_js_string(literal: str) -> str:
    """Decode a single-, double-, or backtick-quoted JS string literal without interpolations."""
    decoded = _ESCAPE.sub(
        lambda m: chr(int(m[1] or m[2] or m[3], 16)) if m[4] is None else _SIMPLE_ESCAPES.get(m[4], m[4]),
        literal[1:-1],
    )
    return decoded.encode("utf-16", "surrogatepass").decode("utf-16")


def extract_vite_js_modules(js_sources: Iterable[str], hashed_symbols: set[str]) -> list[dict[str, str]]:
    """Extract surviving Rolldown CSS module objects and namespace exports containing hashed symbols."""
    modules: list[dict[str, str]] = []
    seen: set[frozenset[tuple[str, str]]] = set()

    def record(entries: dict[str, str]) -> None:
        sig = frozenset(entries.items())
        if sig not in seen:
            seen.add(sig)
            modules.append(entries)

    for src in js_sources:
        bindings = {m.group(1): _decode_js_string(m.group(2)) for m in _VAR_BIND.finditer(src)}

        for match in _OBJ_LIT.finditer(src):
            body = match.group(1)
            if not body.strip():
                continue
            entries: dict[str, str] = {}
            ok = True
            has_hashed = False
            for key, value in _OBJ_ENTRY_RE.findall(body):
                key_name = _decode_js_string(key) if key[0] in "\"'" else key
                if value[0] in "`\"'":
                    val_str = _decode_js_string(value)
                elif value in bindings:
                    val_str = bindings[value]
                else:
                    ok = False
                    break
                if val_str in hashed_symbols:
                    has_hashed = True
                entries[key_name] = val_str
            if ok and has_hashed and _is_css_module_object(entries):
                record(entries)

        for match in _NS_CALL.finditer(src):
            body = match.group(1)
            if not body.strip():
                continue
            entries = {}
            has_hashed = False
            for key, value in _NS_ENTRY_RE.findall(body):
                key_name = _decode_js_string(key) if key[0] in "\"'" else key
                if key_name == "default":
                    continue
                if value[0] in "`\"'":
                    val_str = _decode_js_string(value)
                elif value in bindings:
                    val_str = bindings[value]
                else:
                    continue
                if val_str in hashed_symbols:
                    has_hashed = True
                entries[key_name] = val_str
            if has_hashed and _is_css_module_object(entries):
                record(entries)

    return modules


def css_symbols(css_files: Mapping[str, str]) -> tuple[set[str], set[str]]:
    """Return (selector class names, @keyframes names) present across CSS files."""
    classes: set[str] = set()
    keyframes: set[str] = set()
    for src in css_files.values():
        clean = _CSS_COMMENT.sub("", src)
        for km in _KEYFRAMES_BLOCK.finditer(clean):
            keyframes.add(km.group(1))
        for match in _CSS_RULE.finditer(_KEYFRAMES_BLOCK.sub("", clean)):
            for name in _CSS_CLASS.findall(match.group(1)):
                classes.add(name)
    return classes, keyframes


def _rgb_a_to_hex(r: int, g: int, b: int, a: float | None) -> str:
    if a is None or a >= 1.0:
        h = f"#{r:02x}{g:02x}{b:02x}"
        return f"#{h[1]}{h[3]}{h[5]}" if (h[1] == h[2] and h[3] == h[4] and h[5] == h[6]) else h
    ai = round(a * 255)
    h = f"#{r:02x}{g:02x}{b:02x}{ai:02x}"
    return (
        f"#{h[1]}{h[3]}{h[5]}{h[7]}"
        if (h[1] == h[2] and h[3] == h[4] and h[5] == h[6] and h[7] == h[8])
        else h
    )


def _rgba_sub(match: re.Match[str]) -> str:
    return _rgb_a_to_hex(
        int(match[1]),
        int(match[2]),
        int(match[3]),
        float(match[4]) if match[4] is not None else None,
    )


def _hsla_sub(match: re.Match[str]) -> str:
    r, g, b = colorsys.hls_to_rgb(float(match[1]) / 360.0, float(match[3]) / 100.0, float(match[2]) / 100.0)
    return _rgb_a_to_hex(
        round(r * 255),
        round(g * 255),
        round(b * 255),
        float(match[4]) if match[4] is not None else None,
    )


def _norm_ms(match: re.Match[str]) -> str:
    ms = int(match[1])
    if ms >= 100:
        seconds = f"{ms / 1000:g}"
        return (seconds[1:] if seconds.startswith("0.") else seconds) + "s"
    return match[0]


def _norm_value(value: str) -> str:
    v = value.strip().lower()
    v = _RGBA.sub(_rgba_sub, v)
    v = _HSLA.sub(_hsla_sub, v)
    v = _MS.sub(_norm_ms, v)
    v = _ZERO_UNIT.sub("0", v)
    v = _LEADING_ZERO.sub(r".\1", v)
    v = _HEX6_SHORT.sub(r"#\1\2\3", v)
    v = _HEX8_SHORT.sub(r"#\1\2\3\4", v)
    v = v.replace("radial-gradient(ellipse ", "radial-gradient(")
    v = v.replace("transparent", "#0000")
    v = _PUNCT_SPACE.sub(r"\1", v)
    v = _WHITESPACE.sub(" ", v)
    return v.replace('"', "").replace("'", "")


def _norm_decls(body: str, keyframe_names: set[str]) -> tuple[tuple[str, str], ...]:
    decls: dict[str, str] = {}
    for part in body.split(";"):
        part = part.strip()
        if ":" not in part:
            continue
        key, raw_val = part.split(":", 1)
        key = key.strip().lower()
        if key in ("animation", "animation-name"):
            raw_val = "".join("<KF>" if tok in keyframe_names else tok for tok in re.split(r"(\s+|,)", raw_val.strip()))
        val = _norm_value(raw_val)
        if key == "transition":
            val = _WHITESPACE.sub(" ", _TRANSITION_EASE.sub("", val)).strip()
        decls[key] = val

    for prefix in ("margin", "padding", "border"):
        left, right = f"{prefix}-left", f"{prefix}-right"
        if prefix == "border":
            if left in decls:
                decls["border-inline-start"] = decls.pop(left)
            if right in decls:
                decls["border-inline-end"] = decls.pop(right)
        else:
            if left in decls and right in decls:
                decls[f"{prefix}-inline"] = decls[left] if decls[left] == decls[right] else f"{decls[left]} {decls[right]}"
                del decls[left]
                del decls[right]
            elif left in decls:
                decls[f"{prefix}-inline-start"] = decls.pop(left)
            elif right in decls:
                decls[f"{prefix}-inline-end"] = decls.pop(right)
            top, bottom = f"{prefix}-top", f"{prefix}-bottom"
            if top in decls and bottom in decls:
                decls[f"{prefix}-block"] = decls[top] if decls[top] == decls[bottom] else f"{decls[top]} {decls[bottom]}"
                del decls[top]
                del decls[bottom]
            elif top in decls:
                decls[f"{prefix}-block-start"] = decls.pop(top)
            elif bottom in decls:
                decls[f"{prefix}-block-end"] = decls.pop(bottom)

    if all(side in decls for side in ("top", "right", "bottom", "left")):
        vals = (decls.pop("top"), decls.pop("right"), decls.pop("bottom"), decls.pop("left"))
        decls["inset"] = vals[0] if len(set(vals)) == 1 else " ".join(vals)
    if decls.get("font-weight") == "normal":
        decls["font-weight"] = "400"
    elif decls.get("font-weight") == "bold":
        decls["font-weight"] = "700"
    return tuple(sorted(decls.items()))


def _hash16(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def build_css_fingerprint(
    css_files: Mapping[str, str],
    target_classes: set[str],
    target_keyframes: set[str],
    *,
    version: str,
    bundler: str,
) -> dict[str, Any]:
    """Build an irreversible hashed CSS rule/keyframe fingerprint (stores zero raw CSS text)."""
    rules: list[list[Any]] = []
    keyframes: dict[str, str] = {}
    for filename in sorted(css_files):
        clean = _CSS_COMMENT.sub("", css_files[filename])
        for km in _KEYFRAMES_BLOCK.finditer(clean):
            kf_name, kf_body = km.group(1), km.group(2)
            if kf_name not in target_keyframes:
                continue
            stops = []
            for sm in _CSS_RULE.finditer(kf_body):
                stop_sel = _WHITESPACE.sub(" ", sm.group(1).strip().lower()).replace("from", "0%").replace("to", "100%")
                stops.append((stop_sel, _norm_decls(sm.group(2), target_keyframes)))
            keyframes[kf_name] = _hash16(json.dumps(sorted(stops), separators=(",", ":")))

        clean_no_kf = _KEYFRAMES_BLOCK.sub("", clean)
        for match in _CSS_RULE.finditer(clean_no_kf):
            sel_group = match.group(1).strip()
            decls = _norm_decls(match.group(2), target_keyframes)
            if not decls:
                continue
            decl_str = ";".join(f"{k}:{v}" for k, v in decls)
            keys_str = ",".join(k for k, _ in decls)
            for sel in sel_group.split(","):
                sel = sel.strip()
                found = [name for name in _CSS_CLASS.findall(sel) if name in target_classes]
                if not found:
                    continue
                tmpl = _CSS_CLASS.sub(lambda m: ".#" if m.group(1) in target_classes else m.group(0), sel)
                tmpl = _PSEUDO_COLON.sub(r":\1", tmpl)
                tmpl = _COMBINATOR_SPACE.sub(r"\1", tmpl)
                tmpl = _WHITESPACE.sub(" ", tmpl)
                rules.append([_hash16(f"{tmpl}|{decl_str}"), _hash16(f"{tmpl}|{keys_str}"), found])
    return {
        "schema": FINGERPRINT_SCHEMA,
        "version": version,
        "bundler": bundler,
        "rules": rules,
        "keyframes": keyframes,
    }


def save_fingerprint(path: Path, fingerprint: dict[str, Any]) -> None:
    """Write a deterministic gzipped JSON fingerprint (mtime=0 avoids spurious Git diffs)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(fingerprint, separators=(",", ":"), sort_keys=True).encode("utf-8")
    with path.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
        gz.write(payload)


def load_fingerprint(path: Path) -> dict[str, Any]:
    """Read a gzipped JSON CSS fingerprint."""
    with gzip.open(path, "rt", encoding="utf-8") as gz:
        return json.load(gz)


def _index_rules(
    rules: list[list[Any]],
) -> tuple[
    dict[str, list[tuple[int, int, str, str, int, list[str]]]],
    dict[str, list[tuple[int, list[str]]]],
    dict[str, list[tuple[int, list[str]]]],
]:
    per_cls: dict[str, list[tuple[int, int, str, str, int, list[str]]]] = defaultdict(list)
    by_fh: dict[str, list[tuple[int, list[str]]]] = defaultdict(list)
    by_lh: dict[str, list[tuple[int, list[str]]]] = defaultdict(list)
    for idx, (fh, lh, found) in enumerate(rules):
        by_fh[fh].append((idx, found))
        by_lh[lh].append((idx, found))
        n = len(found)
        for pos, cls_name in enumerate(found):
            per_cls[cls_name].append((pos, n, fh, lh, idx, found))
    return per_cls, by_fh, by_lh


def match_vite_modules(
    old_modules: Mapping[str, Mapping[str, str]],
    old_fingerprint: Mapping[str, Any],
    new_fingerprint: Mapping[str, Any],
    new_js_modules: list[dict[str, str]],
) -> tuple[dict[str, dict[str, str]], dict[str, int]]:
    """Reconstruct {module_id: {prop: new_hash}} for a Vite bundle against a previous dump + fingerprint."""
    old_rules: list[list[Any]] = old_fingerprint["rules"]
    new_rules: list[list[Any]] = new_fingerprint["rules"]
    old_kfs: dict[str, str] = old_fingerprint["keyframes"]
    new_kfs: dict[str, str] = new_fingerprint["keyframes"]

    old_syms = {c for _, _, found in old_rules for c in found} | set(old_kfs)
    new_syms = {c for _, _, found in new_rules for c in found} | set(new_kfs)

    matched: dict[str, str] = {}
    used: set[str] = set()

    # Stage 1: Exact JS anchors from surviving Rolldown CSS module objects (>= 5 keys, > 0.85 unique overlap).
    matched_js_indices: set[int] = set()
    for smod in old_modules.values():
        skeys = set(smod)
        if len(skeys) < 5:
            continue
        scored = [
            (len(skeys & set(bm)) / max(len(skeys), len(bm)), idx, bm)
            for idx, bm in enumerate(new_js_modules)
            if len(skeys & set(bm)) / max(len(skeys), len(bm)) > 0.85
        ]
        if len(scored) == 1:
            _, idx, bm = scored[0]
            matched_js_indices.add(idx)
            for key in skeys & set(bm):
                sv, bv = smod[key], bm[key]
                if is_mappable_value(sv) and (bv in new_syms or is_vite_hash(bv)):
                    if sv not in matched and bv not in used:
                        matched[sv] = bv
                        used.add(bv)
    js_anchored = len(matched)

    # Stage 2: Identity pass for unchanged class/keyframe hashes (Vite -> Vite updates).
    for sym in sorted(old_syms & new_syms):
        if sym not in matched and sym not in used:
            matched[sym] = sym
            used.add(sym)

    # Stage 3: Exact unique @keyframes matches.
    old_kf_by_h: dict[str, list[str]] = defaultdict(list)
    for kf, digest in old_kfs.items():
        if kf not in matched:
            old_kf_by_h[digest].append(kf)
    new_kf_by_h: dict[str, list[str]] = defaultdict(list)
    for kf, digest in new_kfs.items():
        if kf not in used:
            new_kf_by_h[digest].append(kf)
    for digest, oks in old_kf_by_h.items():
        nks = new_kf_by_h.get(digest, [])
        if len(oks) == 1 and len(nks) == 1:
            matched[oks[0]] = nks[0]
            used.add(nks[0])

    o_cls, _, _ = _index_rules(old_rules)
    n_cls, n_fh, n_lh = _index_rules(new_rules)

    # Stage 4: Exact unique full-signature selector matches.
    o_full: dict[tuple[tuple[tuple[int, int, str], int], ...], list[str]] = defaultdict(list)
    for cls_name, entries in o_cls.items():
        if cls_name not in matched:
            sig = tuple(sorted(Counter((p, n, fh) for p, n, fh, _, _, _ in entries).items()))
            o_full[sig].append(cls_name)
    n_full: dict[tuple[tuple[tuple[int, int, str], int], ...], list[str]] = defaultdict(list)
    for cls_name, entries in n_cls.items():
        if cls_name not in used:
            sig = tuple(sorted(Counter((p, n, fh) for p, n, fh, _, _, _ in entries).items()))
            n_full[sig].append(cls_name)
    for sig, olist in o_full.items():
        nlist = n_full.get(sig, [])
        if len(olist) == 1 and len(nlist) == 1:
            matched[olist[0]] = nlist[0]
            used.add(nlist[0])

    # Stage 5: Iterative co-occurrence propagation through multi-class selectors.
    def propagate(use_loose: bool) -> int:
        total_added = 0
        for _ in range(10):
            votes: dict[str, Counter[str]] = defaultdict(Counter)
            for fh, lh, o_found in old_rules:
                if len(o_found) < 2:
                    continue
                if not any(c in matched for c in o_found) or all(c in matched for c in o_found):
                    continue
                agreeing = [
                    nf
                    for _, nf in n_fh.get(fh, [])
                    if len(nf) == len(o_found)
                    and all(matched[oc] == nc for oc, nc in zip(o_found, nf) if oc in matched)
                ]
                if not agreeing and use_loose:
                    agreeing = [
                        nf
                        for _, nf in n_lh.get(lh, [])
                        if len(nf) == len(o_found)
                        and all(matched[oc] == nc for oc, nc in zip(o_found, nf) if oc in matched)
                    ]
                if len(agreeing) == 1:
                    for oc, nc in zip(o_found, agreeing[0]):
                        if oc not in matched and nc not in used:
                            votes[oc][nc] += 1
            proposed = {oc: next(iter(cnt)) for oc, cnt in votes.items() if len(cnt) == 1}
            claims: dict[str, list[str]] = defaultdict(list)
            for oc, nc in proposed.items():
                claims[nc].append(oc)
            added = 0
            for oc, nc in proposed.items():
                if len(claims[nc]) == 1 and nc not in used:
                    matched[oc] = nc
                    used.add(nc)
                    added += 1
            total_added += added
            if added == 0:
                break
        return total_added

    propagate(use_loose=False)

    # Stage 6: Module-neighborhood + Jaccard matching (exact hashes first, then strict keys-only hashes).
    n_pos = {c: sorted(e[4] for e in es) for c, es in n_cls.items()}
    o_fset = {c: Counter((p, n, fh) for p, n, fh, _, _, _ in es) for c, es in o_cls.items()}
    n_fset = {c: Counter((p, n, fh) for p, n, fh, _, _, _ in es) for c, es in n_cls.items()}
    o_lset = {c: Counter((p, n, lh) for p, n, _, lh, _, _ in es) for c, es in o_cls.items()}
    n_lset = {c: Counter((p, n, lh) for p, n, _, lh, _, _ in es) for c, es in n_cls.items()}

    n_by_f: dict[tuple[int, int, str], set[str]] = defaultdict(set)
    n_by_l: dict[tuple[int, int, str], set[str]] = defaultdict(set)
    for c, es in n_cls.items():
        for p, n, fh, lh, _, _ in es:
            n_by_f[(p, n, fh)].add(c)
            n_by_l[(p, n, lh)].add(c)

    cls_to_mids: dict[str, list[str]] = defaultdict(list)
    for mid, smod in old_modules.items():
        for val in smod.values():
            if val in o_cls:
                cls_to_mids[val].append(mid)

    for stage in ("exact", "loose"):
        for _ in range(4):
            mod_ranges: dict[str, tuple[int, int]] = {}
            for mid, smod in old_modules.items():
                pts = [p for v in smod.values() if v in matched and matched[v] in n_pos for p in n_pos[matched[v]]]
                if pts:
                    mod_ranges[mid] = (min(pts) - 250, max(pts) + 250)

            proposals: list[tuple[float, int, str, str]] = []
            for oc in o_cls:
                if oc in matched:
                    continue
                ranges = [mod_ranges[mid] for mid in cls_to_mids[oc] if mid in mod_ranges]
                if stage == "loose" and not ranges:
                    continue
                oset = o_fset[oc] if stage == "exact" else o_lset[oc]
                n_idx = n_by_f if stage == "exact" else n_by_l
                nset_map = n_fset if stage == "exact" else n_lset
                cands: set[str] = set()
                for key in oset:
                    cands |= n_idx.get(key, set())
                cands -= used
                if not cands:
                    continue
                otot = sum(oset.values())
                scored: list[tuple[float, bool, int, str]] = []
                for nc in cands:
                    in_range = any(lo <= p <= hi for lo, hi in ranges for p in n_pos[nc]) if ranges else False
                    if stage == "loose" and not in_range:
                        continue
                    nset = nset_map[nc]
                    inter = sum((oset & nset).values())
                    jacc = inter / (otot + sum(nset.values()) - inter)
                    scored.append((jacc, in_range, inter, nc))
                if not scored:
                    continue
                scored.sort(key=lambda x: (x[1], x[0], x[2]) if x[0] >= 0.5 else (False, x[0], x[2]), reverse=True)
                best_jacc, best_in, best_inter, best_nc = scored[0]
                second_jacc = scored[1][0] if len(scored) > 1 else 0.0
                second_in = scored[1][1] if len(scored) > 1 else False
                if stage == "exact":
                    if (best_in and best_jacc >= 0.5 and (not second_in or best_jacc > second_jacc + 0.05)) or (
                        best_jacc >= 0.65 and best_jacc > second_jacc + 0.15
                    ):
                        proposals.append((best_jacc, best_inter, oc, best_nc))
                else:
                    if best_jacc >= 0.8 and (not second_in or best_jacc > second_jacc + 0.15):
                        proposals.append((best_jacc, best_inter, oc, best_nc))

            proposals.sort(reverse=True)
            added = 0
            for _, _, oc, nc in proposals:
                if oc not in matched and nc not in used:
                    matched[oc] = nc
                    used.add(nc)
                    added += 1
            added += propagate(use_loose=(stage == "loose"))
            if added == 0:
                break

    # Reconstruct retained module IDs with matched hashes and preserved non-class constants.
    reconstructed: dict[str, dict[str, str]] = {}
    for mid, smod in old_modules.items():
        new_mod: dict[str, str] = {}
        has_matched = False
        for key, val in smod.items():
            if val in matched:
                new_mod[key] = matched[val]
                has_matched = True
            elif not is_mappable_value(val):
                new_mod[key] = val
        if has_matched:
            reconstructed[mid] = new_mod

    # Include brand-new JS-extracted CSS modules under deterministic synthetic IDs.
    old_key_sets = [set(smod) for smod in old_modules.values()]
    added_js_modules = 0
    for idx, bm in enumerate(new_js_modules):
        if idx in matched_js_indices or len(bm) < 3 or not _is_css_module_object(bm):
            continue
        bkeys = set(bm)
        if bkeys <= _CSSTRANSITION_KEYS:
            continue
        hashes = [v for v in bm.values() if is_vite_hash(v)]
        if not hashes or any(v in used for v in hashes):
            continue
        if any(len(bkeys & okeys) / max(len(bkeys), len(okeys)) > 0.5 for okeys in old_key_sets if okeys):
            continue
        synth_id = "vite_" + hashlib.sha256(json.dumps(sorted(bkeys), separators=(",", ":")).encode("utf-8")).hexdigest()[:10]
        if synth_id not in reconstructed:
            reconstructed[synth_id] = dict(bm)
            added_js_modules += 1

    stats = {
        "js_anchored": js_anchored,
        "matched_symbols": len(matched),
        "total_old_symbols": len(old_syms),
        "reconstructed_modules": len(reconstructed),
        "new_js_modules": added_js_modules,
    }
    return reconstructed, stats
