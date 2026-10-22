"""Warn when a Steam Deck client bundle no longer has what Decky's finders search for.

Decky Loader and @decky/ui find Steam components at runtime by text in their minified source
(`toString().includes(...)`) and by the property names of CSS class modules. This reads the
same minified bundle from Valve's CDN and checks that each finder's text and class module
still exist. Writes OUTDIR/<branch>-<version>.md for each branch with missing finders.

The @decky/ui finders come from --ui-finders, the JSON that `bun tools/finder_table.ts` makes from
the installed package; the loader's finders are copied by hand into FINDERS.

The check is static: a hit proves the text is somewhere in the bundle, not that it is in the
function the finder tests. Property and prototype names are only checked as names.
"""

import argparse
import json
import re
from pathlib import Path
from typing import NamedTuple

from css_mappings import BRANCHES, download_sources, extract_class_modules, fetch_manifest

LOADER = "decky-loader 36c0733"

type Text = str | re.Pattern[str]


class Classes(NamedTuple):
    has: frozenset[str]
    lacks: frozenset[str]
    module: str | None


class Finder(NamedTuple):
    owner: str
    name: str
    code: tuple[tuple[Text, ...], ...]  # every clause must match; a clause is a set of alternatives
    classes: Classes | None


def code(owner, name, *clauses):
    return Finder(owner, name, tuple(c if isinstance(c, tuple) else (c,) for c in clauses), None)


def classes(owner, name, *has, lacks=(), module=None):
    return Finder(owner, name, (), Classes(frozenset(has), frozenset(lacks), module))


def props(*names, from_start=True):
    """`createPropListRegex` from @decky/ui `utils/react/react.js`."""
    body = ",".join(f'"?{re.escape(n)}"?:[a-zA-Z_$]{{1,2}}' for n in names)
    return re.compile(("const\\{" if from_start else "") + body)


def name(word):
    """A property or method name the finder tests on a live object; the name is all a static check sees."""
    return re.compile(rf"(?<![\w$]){re.escape(word)}(?![\w$])")


def bounded(pattern):
    """A JS regex as Python's, with `.+`/`.*` limited to 300 characters."""
    # shortcut: unbounded, it would match across functions in a one-line bundle; 300 is a guess at one function.
    return re.compile(re.sub(r"(?<!\\)\.([+*])", lambda m: ".{1,300}" if m[1] == "+" else ".{0,300}", pattern))


def load_ui_finders(path):
    """The @decky/ui finders from `bun tools/finder_table.ts` output."""
    table = json.loads(Path(path).read_text(encoding="utf-8"))
    owner = f"@decky/ui {table['ui']}"

    def atom(a):
        if "text" in a:
            return a["text"]
        if "regex" in a:
            return bounded(a["regex"])
        if "name" in a:
            return name(a["name"])
        return props(*a["props"], from_start=a["from_start"])

    return tuple(
        classes(owner, f["name"], *f["classes"]["has"], lacks=f["classes"]["lacks"]) if "classes" in f
        else code(owner, f["name"], *(tuple(atom(a) for a in clause) for clause in f["code"]))
        for f in table["finders"])


FINDERS = (
    # errorboundary-hook.tsx anchors this to the whole function; a bundle search cannot.
    code(LOADER, "errorboundary-hook: error reporting store",
         re.compile(r"\(\)=>\([\w$]+\|\|(?:[\w$]+\(|\([\w$]+=)new [\w$]+\),[\w$]+\)"), name("BIsBlacklisted")),
    code(LOADER, "router-hook: Route", '"router-backstack"',
         (re.compile(r"routePath:[\w$]+\.match\?\.path."), re.compile(r"routePath:null===\(.=.\.match\)"))),
    code(LOADER, "router-hook: router node", "bShowDesktopUIContent:"),
    code(LOADER, "router-hook: settings node", "Settings.Root()"),
    # tabs-hook.tsx also patches QuickAccessMenuEmbedded, but only when it exists.
    code(LOADER, "tabs-hook: QAM renderer", "QuickAccessMenuBrowserView"),
    code(LOADER, "toaster: Valve toast renderer", 'controller:"notification",method:'),
    code(LOADER, "toaster: NotificationStore removal methods",
         name("RemoveGroupFromTray"), name("RemoveFromToastsWhere")),
    # library.ts finds the routing store by a set m_history. Steam sets it only in
    # UpdateRoutingInfo, which a router component calls from a useEffect.
    code(LOADER, "filepicker: history", re.compile(r"UpdateRoutingInfo\([\w$]+,[\w$]+\)\{this\.m_history=[\w$]+"),
         ".UpdateRoutingInfo("),
    classes(LOADER, "Markdown: EventDetailsBody", "EventDetailsBody"),
    classes(LOADER, "Markdown: event link", "Link", module="43088"),
    classes(LOADER, "Toast: templateClasses", "ShortTemplate"),
    classes(LOADER, "DropdownMultiselect: classes", "DropDownControlButton", "duration-app-launch"),
    classes(LOADER, "Store: TabCount", "TabCount", "TabTitle"),
)


def _describe(text):
    return f"`{text.pattern}` (regex)" if isinstance(text, re.Pattern) else f"`{text}`"


def missing(sources, class_modules, finders=FINDERS):
    """Return (finder, reason) for every finder the bundle no longer satisfies."""
    bundle = "\n".join(sources)
    found = {}

    def hit(text):
        if text not in found:
            found[text] = text in bundle if isinstance(text, str) else text.search(bundle) is not None
        return found[text]

    result = []
    for finder in finders:
        if rule := finder.classes:
            candidates = [class_modules.get(rule.module, {})] if rule.module else class_modules.values()
            if not any(rule.has <= m.keys() and not rule.lacks & m.keys() for m in candidates):
                where = f"module {rule.module}" if rule.module else "class module"
                lacks = f" without {', '.join(sorted(rule.lacks))}" if rule.lacks else ""
                result.append((finder, f"no {where} with {', '.join(sorted(rule.has))}{lacks}"))
            continue
        for clause in finder.code:
            if not any(hit(text) for text in clause):
                result.append((finder, "none of " + " / ".join(map(_describe, clause))))
                break
    return result


def report(branch, version, misses):
    lines = [f"Static check of the Steam Deck {branch} client `{version}` against Decky's finders.", ""]
    for owner in dict.fromkeys(finder.owner for finder, _ in misses):
        lines += [f"### {owner}", ""]
        lines += [f"- **{finder.name}**: {reason}" for finder, reason in misses if finder.owner == owner]
        lines.append("")
    lines.append("A miss means the finder will probably fail on this version. Confirm on the SteamOS VM, "
                 "then update the finder or `decky_watch.py`. Close this issue when done.")
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("outdir", type=Path,
                        help="directory for the <branch>-<version>.md reports; a passing version gets an empty .ok file")
    parser.add_argument("--branch", choices=BRANCHES, action="append", help="Valve branch (default: both)")
    parser.add_argument("--ui-finders", type=Path, required=True, help="output of `bun tools/finder_table.ts`")
    args = parser.parse_args(argv)
    finders = load_ui_finders(args.ui_finders) + FINDERS
    args.outdir.mkdir(parents=True, exist_ok=True)
    for branch in args.branch or BRANCHES:
        version, fields = fetch_manifest(branch)
        sources = download_sources(fields)
        misses = missing(sources, extract_class_modules(sources), finders)
        print(f"{branch} {version}: {len(misses)} of {len(finders)} finders missing")
        for finder, reason in misses:
            print(f"  {finder.owner} {finder.name}: {reason}")
        name = f"{BRANCHES[branch]}-{version}"
        if misses:
            (args.outdir / f"{name}.md").write_text(report(BRANCHES[branch], version, misses), encoding="utf-8")
        else:
            # The issue step closes older reports for this branch when it sees a pass.
            (args.outdir / f"{name}.ok").write_text("")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
