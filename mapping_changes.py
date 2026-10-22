"""Describe new Steam CSS dumps and save readable class-data diffs in mapping-data."""

import argparse
import difflib
import html
import json
import re
from pathlib import Path


def read_dump(path):
    modules = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(modules, dict) or any(
        not isinstance(module_id, str) or not isinstance(props, dict)
        or any(not isinstance(key, str) or not isinstance(value, str) for key, value in props.items())
        for module_id, props in modules.items()
    ):
        raise ValueError(f"{path}: expected CSS module objects with string properties")
    # Upstream runtime dumps include translation tables and constants, unlike our bundle dumps.
    css_modules = [props for props in modules.values()
                   if props and not ({"language", "Generic_Close", "TimeInterval_XYears"} & props.keys())
                   and not any(key.startswith("moderation_") for key in props)
                   and set(props) not in ({"0"}, {"version"})]
    # Module IDs can change without changing any CSS. Keep duplicate module contents.
    return sorted(css_modules, key=lambda props: json.dumps(props, sort_keys=True))


def build_notice(repo, versions, repository_url, run_url, deployment):
    rows = []
    highlights = []
    changed = unknown = False
    for version in versions:
        if not re.fullmatch(r"\d+\.(stable|beta)", version):
            raise ValueError(f"Invalid dump version: {version}")
        number, branch = version.split(".")
        current = read_dump(repo / "webpack" / f"{version}.json")
        earlier = [path for path in (repo / "webpack").glob(f"*.{branch}.json")
                   if int(path.name.split(".")[0]) < int(number)]
        if not earlier:
            unknown = True
            rows.append(f"| {branch} | none | `{version}` | No earlier {branch} dump; comparison unavailable |")
            continue
        previous = max(earlier, key=lambda path: int(path.name.split(".")[0]))
        old = read_dump(previous)
        if old == current:
            rows.append(f"| {branch} | `{previous.stem}` | `{version}` | No class data changes |")
            continue
        changed = True
        old_values = {value for props in old for value in props.values()}
        new_values = {value for props in current for value in props.values()}
        added, removed = sorted(new_values - old_values), sorted(old_values - new_values)
        relative = Path("class-diffs") / f"{previous.stem}-to-{version}.diff"
        diff = "".join(difflib.unified_diff(
            json.dumps(old, indent=2, sort_keys=True).splitlines(keepends=True),
            json.dumps(current, indent=2, sort_keys=True).splitlines(keepends=True),
            fromfile=f"webpack/{previous.name}", tofile=f"webpack/{version}.json",
        ))
        target = repo / relative
        target.parent.mkdir(exist_ok=True)
        target.write_text(diff + "\n", encoding="utf-8")
        link = f"{repository_url}/blob/mapping-data/{relative.as_posix()}"
        rows.append(f"| {branch} | `{previous.stem}` | `{version}` | **Class changes: {len(added)} added, "
                    f"{len(removed)} removed** — [full diff]({link}) |")
        highlights.append(f"### `{version}`\n")
        if not added and not removed:
            highlights.append("Module/property bindings changed without adding or removing exported values.\n")
        for label, values in (("Removed", removed), ("Added", added)):
            if not values:
                continue
            shown = values[:5]
            names = ", ".join(f"<code>{html.escape(value)}</code>" for value in shown)
            highlights.append(f"- **{label}:** {names}")
            if len(shown) < len(values):
                highlights.append(f"- {len(values) - len(shown)} more {label.lower()} values are in the full diff.")
        highlights.append("")

    if changed:
        kind, label = "class changes", "Changes"
    elif unknown:
        kind, label = "comparison unavailable", ""
    else:
        kind, label = "version only", "No change"
    title = f"New CSS mappings ({kind}): {' '.join(versions)}"
    body = [f"New Steam Deck client versions: `{' '.join(versions)}`", "",
            f"Pages deployment in this run: **{deployment}**", "",
            "| Branch | Previous version | New version | CSS class data |",
            "|---|---|---|---|", *rows, "",
            "Module IDs are ignored. Counts cover distinct exported CSS values, including CSS constants; "
            "the full diffs also show property and module-content changes.", "", *highlights,
            "- [Stable mappings](https://beallio.github.io/steamui-watch/stable.json)",
            "- [Beta mappings](https://beallio.github.io/steamui-watch/beta.json)",
            f"- [Workflow run]({run_url})", ""]
    if deployment != "success":
        body.append("Do not test the published lists as this update until a later deployment succeeds.")
    elif changed or unknown:
        body.append("Check themes on the new version, then close this issue. These comparisons do not prove visual compatibility.")
    else:
        body.append("Version-only update: the extracted CSS class data is unchanged. This notice is informational and can be closed.")
    body.append("Keep the version names in the title: they mark the versions as announced.")
    return title, "\n".join(body) + "\n", label


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mappings_repo", type=Path)
    parser.add_argument("versions", nargs="+")
    parser.add_argument("--repository-url", required=True)
    parser.add_argument("--run-url", required=True)
    parser.add_argument("--deployment", required=True)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    title, body, label = build_notice(args.mappings_repo, args.versions, args.repository_url, args.run_url, args.deployment)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "title.txt").write_text(title + "\n", encoding="utf-8")
    (args.output_dir / "body.md").write_text(body, encoding="utf-8")
    (args.output_dir / "label.txt").write_text(label + "\n", encoding="utf-8")
    print(title)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
