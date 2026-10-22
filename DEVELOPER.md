# Developer guide

See [README.md](README.md) for what the service does and how to use the published lists. This guide covers local tools and maintenance. [Background and research notes](docs/background.md) contain the data sources, experiments, validation results, and open questions. Those notes are dated; they are not a current operations guide.

## Setup and checks

The Python tools need Python 3.14 or newer and use only the standard library. CSS mapping generation also needs `git`.

```sh
git clone https://github.com/beallio/steamui-watch.git
cd steamui-watch
```

The project uses [uv](https://docs.astral.sh/uv/) to select Python 3.14 from `.python-version` and install the type checker [ty](https://docs.astral.sh/ty/). Run the same checks as CI:

```sh
uv run --locked python -m unittest
uv run --locked ty check
bun test tools/
```

The last command needs [Bun](https://bun.sh). `python3 -m unittest` also works without uv. Workflow tests need `git` and `jq`; tests that need missing tools are skipped. GitHub runs the Python tests, type check, and Bun tests on pushes and pull requests.

Keep downloads, reports, and mapping-data checkouts outside the source tree. The examples below use `$TMPDIR`, or `/var/tmp/omp-1000` when it is unset:

```sh
scratch="${TMPDIR:-/var/tmp/omp-1000}"
mkdir -m 700 -p "$scratch"
```

## Generate CSS mappings locally

Clone this repository's `mapping-data` branch into a new scratch folder, not from DeckThemes:

```sh
git clone --branch mapping-data https://github.com/beallio/steamui-watch.git "$scratch/steamui-watch-mapping-data"
python3 css_mappings.py "$scratch/steamui-watch-mapping-data"
```

Use the existing scratch checkout on later runs. It holds the upstream pipeline, seed data, retained Steam versions, and reviewed fixes. Starting again from DeckThemes would omit this service's added history and fixes.

The tool gets Valve's current stable and beta versions, downloads bundles it has not seen, checks their SHA-256 hashes, and extracts CSS class modules. It then runs the DeckThemes pipeline to produce `stable.json` and `beta.json` in the data checkout. It checks that both outputs have the expected JSON structure. This takes a few minutes and does not publish anything.

| Option | What it does |
|---|---|
| `--branch stable` or `--branch publicbeta` | Download only the selected branch. The pipeline still runs unless disabled. |
| `--force` | Download and parse a version again, even if its dump already exists. |
| `--no-pipeline` | Save the new Steam dumps without generating the translation lists. |

A successful run does not prove that every theme translates correctly. The parser extracts string-valued CSS class objects, not every kind of module. The pipeline can leave modules unmatched; output validation checks structure, not visual results. Check representative themes on the target Steam version.

## Check Decky compatibility locally

A finder is the search code Decky uses to locate a Steam component or store. The two checks below cover different failure cases. Neither proves that plugins work in Gaming Mode.

### Source-text check

```sh
python3 decky_watch.py "$scratch/decky-reports"
python3 decky_watch.py "$scratch/decky-beta-reports" --branch publicbeta
```

This needs no data checkout. It prints missing-finder counts and writes one report per failing branch as `<stable|beta>-<version>.md`. A text hit only proves that the text is somewhere in the bundle, not that the real finder selects the right object. Property and method checks see names only.

### Browser check

`tools/runtime_probe.ts` runs the real `@decky/ui` finders per file and copied loader predicates in headless Chrome. It needs Bun, `unzip`, Chrome, and an installed copy of `@decky/ui`. By default it uses `../decky-loader/frontend/node_modules/@decky/ui`, from a Decky Loader checkout with its frontend packages installed.

```sh
CHROME=/path/to/chrome bun tools/runtime_probe.ts
CHROME=/path/to/chrome bun tools/runtime_probe.ts --branch publicbeta --decky-ui /path/to/@decky/ui
```

The default checks stable and beta. It prints results for each version and lists failed finders. It exits with status 1 if any finder fails. With `--report-dir DIR`, it writes reports for failing versions and reserves nonzero exit status for execution errors, as the workflow does.

With `--snapshot-dir DIR`, it also writes `<stable|beta>-<version>.decky-ui-<version>.json` for each version whose finders all pass. A version with a failing finder gets no snapshot, because the workflow keeps the first snapshot forever; a later clean run writes it. For each finder result that is a Steam object, the file records where Steam exports it (`module:export`, or only the module for whole modules) and a fingerprint. The fingerprint holds string literals and property names for functions, plus prototype methods for classes. For objects, it holds the key names. Results are matched by identity, so the file includes finders that scan `CommonUIModule` directly. Helpers and wrappers that `@decky/ui` makes itself are left out, and so are loader checks that return only true or false.

For toast dismissal, the browser check verifies that `NotificationStore.RemoveGroupFromTray` and `NotificationStore.RemoveFromToastsWhere` are callable. The source-text check looks for both method names.

The browser uses a `SteamClient` stand-in, not a real Steam client. React-tree finders still need Gaming Mode. The history check verifies the store's shape, not that Gaming Mode has populated `m_history`. Confirm failures on a Steam Deck or SteamOS VM.

## Build or serve the UI catalog

`tools/decky_catalog.ts` uses the same tools and installed `@decky/ui` copy as the browser check. It draws supported component previews with Steam's own React and CSS. It also lists icons, class maps, helpers, and selected Steam components that `@decky/ui` does not expose by name. Each selected extra component has a source-text finder and a match count for that build.

```sh
CHROME=/path/to/chrome bun tools/decky_catalog.ts
CHROME=/path/to/chrome bun tools/decky_catalog.ts --branch publicbeta --out "$scratch/catalog.html"
```

The default output is `docs/local/decky-ui-catalog-<branch>-<version>.html`. The command prints how many previews rendered and which extra-component finders matched exactly one export. Some entries have no preview because they need live Gaming Mode state or layout. The static file is not interactive and uses a fallback font.

To try the controls in a browser:

```sh
bun tools/decky_catalog.ts --serve
```

Open the printed local address in Chrome or Chromium. The page runs Steam's code: toggles switch, sliders move, and supported menus and dialogs open. An event log shows callbacks. Stop it with Ctrl-C. Controller navigation, sounds, and features that need a running Steam client do not work there.

These tools also accept `--bundle-dir DIR` to use an extracted `steamui` directory and `--decky-ui PATH` to select the library. Finders and minified module/export keys must be checked on each Steam build; a unique match is not a guarantee of future compatibility.

Catalog output contains Valve's styles, icons, and images. `docs/local/` is Git-ignored; do not publish the generated files or commit downloaded bundles.

## Publishing and retained history

[Publish CSS mappings](.github/workflows/publish-mappings.yml) runs every 6 hours, on relevant pushes to `main`, and by manual dispatch. It clones `mapping-data`, generates both lists, saves new `webpack/` and `webpack-mappings/` inputs back to that branch, then deploys both JSON files together through GitHub Pages. A generation or deployment failure leaves the previous site available.

Do not recreate `mapping-data` from upstream or merge it into `main`. Its history preserves classes introduced by intermediate releases and reviewed mapping corrections. Keep the output format and stable/beta selection unchanged for CSS Loader consumers.

A **"New CSS mappings"** issue can open even if generation or deployment failed. Check the deployment result in the issue and the linked run before testing the published lists. Keep version numbers in issue titles: the workflow checks open and closed issues to avoid announcing the same version again.

[Mapping watchdog](.github/workflows/watchdog.yml) checks every 6 hours for a successful Pages deployment within the past 24 hours. It closes the overdue issue on the next check after recovery. Its keepalive job adds an empty commit to `main` after 45 days without commits, to avoid GitHub's 60-day inactivity cutoff. This is not an external monitor: it cannot alert while Actions is disabled for the repository.

## Reviewing DeckThemes changes

[Watch DeckThemes mappings](.github/workflows/upstream-watch.yml) compares DeckThemes `main` with `.github/upstream-baseline` daily. It adopts changes only when they add or edit dump/match JSON files, include fewer than 300 changed files, introduce no older dumps into an existing chain, merge without conflicts, and pass generation and validation. Other changes open a **"DeckThemes mappings changed"** issue.

To accept a change that needs review:

1. Read the issue's reason, commits, and changed-file list. Dumps marked **"also in mapping-data"** overlap with retained inputs; review match files too, even when they have no marker.
2. Merge the selected upstream commits into `mapping-data` without replacing its history. Review script changes before running them.
3. Run `css_mappings.py` against the merged data checkout and check the results before pushing that branch.
4. Set `.github/upstream-baseline` on `main` to the full upstream commit that was merged, then close the issue.

To skip the change, close the issue without advancing the baseline. A closed issue means that upstream head has been reviewed and will not be reported again.

## Keeping the Decky checks current

[Watch Decky finders](.github/workflows/decky-watch.yml) runs the text and browser checks daily. The browser check installs the `@decky/ui` version locked by `beallio/decky-loader`, not an independently selected latest version.

The workflow also compares the copied finder versions with the fork's lock file and changed frontend lines that search Steam's code or use its globals. This comparison is a heuristic: some reported changes need no check update, and it can miss relevant changes.

Each run also saves the finder snapshots to the `finder-data` branch as `snapshots/<stable|beta>-<version>.decky-ui-<version>.json`. If the branch does not exist, the run creates it. A run never replaces a file that already exists: the first snapshot of each client and `@decky/ui` version is the baseline. Use these files to find a broken finder's object again in a later build. Do not merge `finder-data` into `main`.

When a **"Decky finder copies out of date"** issue opens:

1. Review the linked fork comparison and the locked `@decky/ui` version.
2. Update `FINDERS` in `decky_watch.py` and the loader predicates in `tools/runtime_probe.ts` where dependencies changed. Include new uses of Steam globals, not just changed text finders.
3. Set `UI` to the reviewed library version and `LOADER` to the reviewed fork commit in `decky_watch.py`. Advance the commit only after reviewing the changes; it is not a way to hide an alert.
4. Run the checks against current stable and beta bundles. Confirm checks that need Gaming Mode on a Deck or SteamOS VM.
5. Publish the reviewed changes, then close the issue.

For **"Decky finders missing"** and **"Decky runtime finders failing"**, confirm the problem on the reported Steam version, fix the Decky finder or the incorrect local check, then close the issue. The workflow does not reopen a closed report with the same check and version.

## Troubleshooting

- **"is not a CSSLoader-Mappings checkout":** pass the path to the `mapping-data` checkout, not this source checkout.
- **"SHA-256 does not match the manifest":** do not use the downloaded bundle. Retry the download; if it keeps failing, investigate the connection or Valve's files.
- **"only N class modules found":** the parser found too few modules and stopped. Steam's bundle format may have changed; investigate before publishing.
- **"has its own history"** or **"is used twice":** a hand-made match in `webpack-mappings/` is invalid. Remove or correct the match without discarding retained history.
- **"module ... is not in version ...":** a match refers to a module absent from its source or target dump. Check both dumps and correct the match.
- **HTTP 403 errors:** Valve refused the request. Check network restrictions and try another connection.

## Research scope

[Background and research notes](docs/background.md) cover cross-version finder matching, object-identity comparisons, component prop-surface checks, and discovery of Steam exports missing from `@decky/ui`. Finder-repair suggestions and prop-change analysis remain experiments, not daily workflow features. The retained tools are the mapping generator, source-text check, browser probe, and catalog. A rendered preview or passing finder does not replace testing a theme or plugin in Steam.
