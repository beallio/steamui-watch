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
bun install --frozen-lockfile
bun test tools/ packages/
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
bun install
bun tools/finder_table.ts /path/to/@decky/ui > "$scratch/finder-table.json"
python3 decky_watch.py --ui-finders "$scratch/finder-table.json" "$scratch/decky-reports"
python3 decky_watch.py --ui-finders "$scratch/finder-table.json" "$scratch/decky-beta-reports" --branch publicbeta
```

`tools/finder_table.ts` reads the `@decky/ui` package's `dist/` and writes its finders as JSON. Without a path, it uses `../decky-loader/frontend/node_modules/@decky/ui`. For each finder it lists the text, regexes, prop lists and property names the predicate needs. It stops with status 1 if a predicate uses a form it cannot read; then add that form to the tool. The loader's finders stay in `FINDERS` in `decky_watch.py`.

`decky_watch.py` needs no data checkout. It prints missing-finder counts and writes one report per failing branch as `<stable|beta>-<version>.md`, and an empty `<stable|beta>-<version>.ok` for each passing branch. A text hit only proves that the text is somewhere in the bundle, not that the real finder selects the right object. Property and method checks see names only.

### Browser check

`tools/runtime_probe.ts` runs the real `@decky/ui` finders per file and copied loader predicates in headless Chrome. It needs Bun, `unzip`, Chrome, and an installed copy of `@decky/ui`. By default it uses `../decky-loader/frontend/node_modules/@decky/ui`, from a Decky Loader checkout with its frontend packages installed.

```sh
CHROME=/path/to/chrome bun tools/runtime_probe.ts
CHROME=/path/to/chrome bun tools/runtime_probe.ts --branch publicbeta --decky-ui /path/to/@decky/ui
```

The default checks stable and beta. It prints results for each version and lists failed finders. It exits with status 1 if any finder fails. With `--report-dir DIR`, it writes reports for failing versions and an empty `.ok` file for each passing version, and reserves nonzero exit status for execution errors, as the workflow does.

With `--snapshot-dir DIR`, it also writes `<stable|beta>-<version>.decky-ui-<version>.json` for each version whose finders all pass. A version with a failing finder gets no snapshot, because the workflow keeps the first snapshot forever; a later clean run writes it. For each finder result that is a Steam object, the file records where Steam exports it (`module:export`, or only the module for whole modules) and a fingerprint. The fingerprint holds string literals and property names for functions, plus prototype methods for classes. For objects, it holds the key names. Results are matched by identity, so the file includes finders that scan `CommonUIModule` directly. Helpers and wrappers that `@decky/ui` makes itself are left out, and so are loader checks that return only true or false.

With `--baseline-dir DIR`, failing browser reports also look for repairs. Point it at the retained `finder-data/snapshots` directory:

```sh
CHROME=/path/to/chrome bun tools/runtime_probe.ts \
  --baseline-dir "$scratch/finder-data/snapshots" --report-dir "$scratch/decky-runtime-reports"
```

The repair tool reads the newest strictly older snapshot from the same branch and exact `@decky/ui` version. It ranks distinct Steam objects using module/export locations and fingerprint overlap, including names that changed from member access to string literals. Re-exports of one object count once. Only a complete module/export location can receive priority, and it needs meaningful fingerprint evidence; a reused module ID, export key, or common rendering names such as `children` and `className` do not establish identity. If location conflicts with clearly stronger fingerprint evidence, or candidates are close, the result is ambiguous.

It builds a short source-text or stable property/method predicate, keeping old match text as an alternative where needed. It checks the combined predicate for one distinct target in both catalogs, then runs the real `@decky/ui` helper and requires the expected object by identity (`===`) on stable and beta. A single-branch or `--bundle-dir` run cannot produce a verified repair. Missing baselines, weak evidence, shared factory code and failed identity checks produce reasons, not guessed fixes.

The report includes the baseline name, old and candidate export locations, match scores, shared fingerprint atoms, the proposed search and both identity results. Full function bodies stay in memory. Match scores are ranking evidence, not probabilities or a promise that a component behaves the same. Review and test suggestions in Gaming Mode before changing Decky code.

For toast dismissal, the browser check verifies that `NotificationStore.RemoveGroupFromTray` and `NotificationStore.RemoveFromToastsWhere` are callable. The source-text check looks for both method names.

The browser uses a `SteamClient` stand-in, not a real Steam client. React-tree finders still need Gaming Mode. The history check verifies the store's shape, not that Gaming Mode has populated `m_history`. Confirm failures on a Steam Deck or SteamOS VM.

## Discover and watch extra-component props

A prop is a setting passed to a React component, such as `value` or `onChange`. The browser probe can record the prop names read by all components in `packages/decky-extras/extras.json`:

```sh
CHROME=/path/to/chrome bun tools/runtime_probe.ts --props-dir "$scratch/extra-props"
bun tools/props_report.ts "$scratch/extra-props" \
  --baseline-dir "$scratch/steamui-watch-finder-data/props" \
  --out-dir "$scratch/extra-prop-reports"
```

The baseline directory is the `props/` folder from a `finder-data` checkout. It can be absent for the first run. The probe writes `<stable|beta>-<version>.json` only when every extra has one distinct match. An unrelated official finder failure does not prevent extra-prop analysis. With `--bundle-dir`, the output is `local-0.json`; the report tool can generate a local reference without a version comparison.

`tools/prop_surface.ts` uses the installed Acorn parser. It resolves webpack exports and re-exports, reads destructured and member props (including reads inside default expressions), and follows props passed through `jsx`, `jsxs`, and `createElement`, including `forwardRef`, `memo`, class bases, and a uniquely resolved Gaming Mode component override. Rest omissions, later overwritten props, and positional `createElement` children are excluded from the forwarded names. Sibling forwarding paths are checked separately.

These are observed names, not a complete or guaranteed prop contract. Types, requiredness, defaults, and meaning remain unknown. Dynamic access, helper calls, object copies, custom wrappers, unresolved targets, and ambiguous overrides produce uncertainty notes. Native HTML attributes are not enumerated. Module factory source stays in memory; saved observations and references contain no source bodies.

The report tool writes a `<branch>-<version>.reference.md` author reference for every snapshot. It compares prop-name sets against the newest strictly older snapshot of the same branch and writes `<branch>-<version>.md` when names were added or removed. A missing or older-schema baseline seeds the history without a change alert. Component additions or removals in our manifest are not reported as Steam prop changes.

The daily workflow runs this with the locked `@decky/ui`, not the pre-upgrade version. It retains the first prop snapshot and reference per client version under [`finder-data/props`](https://github.com/beallio/steamui-watch/tree/finder-data/props), and uploads JSON and references in the `decky-extra-props` workflow artifact. A retry still compares with the previous client version, not itself. Change reports become **"Decky extra props changed in …"** issues only after their references are saved successfully. These issues require manual review and do not close merely because the next daily check finds the same names.

Review added and removed names, read the uncertainty notes, and check the affected controls in Steam before changing a plugin. A removed observed read does not prove that a prop stopped working; another code path can consume it.

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

## Extra components for standard Decky plugins

[`@beallio/decky-extras`](packages/decky-extras/README.md) is bundled inside each plugin; official `@decky/ui` and React remain external and come from the user's loader. Do not add extras to `DFL` or require our fork. The package uses the public `createModuleMapping` API from official `@decky/ui` 4.15.1 or newer.

`packages/decky-extras/extras.json` is the single extras list for the package, catalog and runtime probe. Official components still come from the real `@decky/ui` package. The extras list contains stable component names, titles, descriptions, and AND clauses of OR atoms. Atoms can only match literal text, a whole member name, or a destructuring default binding. No downloaded JavaScript, regular expressions, module IDs, or remote URLs are allowed.

To correct a finder, edit its clauses and increase `revision`. Run the probe on stable and beta. Every extra must match exactly one distinct Steam object. Re-exports of that same object count once. These checks establish identity and presence, not prop meaning or controller behavior.

The publishing workflow runs the probe before deploying `decky-extras.json` alongside the CSS lists. If extras validation fails, it fetches and validates the last published extras file, stages that file beside the fresh CSS mappings, and skips the extras package release. A Decky finder failure therefore does not block CSS updates. If the previous extras file cannot be retrieved or validated, deployment stops rather than erase it.

Plugin packages download the definitions on first use, keep validated data in `localStorage`, refresh hourly while mounted, and retry after a minute on failure. Downloads that would lose a working finder are rejected before replacing the cache. See the package README for unload cleanup and explicit fallback behavior.

For a runtime implementation change, increase the package version and build it:

```sh
bun packages/decky-extras/build.ts --outdir "$scratch/decky-extras-package"
npm pack "$scratch/decky-extras-package" --pack-destination "$scratch"
```

After Pages deploys, the workflow creates a `decky-extras-v<version>` GitHub release with the installable tarball if the release does not exist. Old releases are never replaced, so existing plugin lock files keep working. Finder-only changes need a manifest revision bump but no package version bump. No npm credentials are needed.

## Publishing and retained history

[Publish CSS mappings](.github/workflows/publish-mappings.yml) runs every 6 hours, on relevant pushes to `main`, and by manual dispatch. It clones `mapping-data`, generates both lists, saves new `webpack/` and `webpack-mappings/` inputs back to that branch, then deploys both JSON files together through GitHub Pages. A generation or deployment failure leaves the previous site available.

Do not recreate `mapping-data` from upstream or merge it into `main`. Its history preserves classes introduced by intermediate releases and reviewed mapping corrections. Keep the output format and stable/beta selection unchanged for CSS Loader consumers.

A **"New CSS mappings"** issue can open even if generation or deployment failed. Check the deployment result in the issue and the linked run before testing the published lists. Titles distinguish **"version only"**, **"class changes"**, and **"comparison unavailable"**. The workflow applies `No change` only when all comparisons show unchanged data, or `Changes` when any comparison finds changes. An unavailable comparison without known changes gets neither label. Keep version numbers in issue titles: the workflow checks open and closed issues to avoid announcing the same version again.

`mapping_changes.py` compares each new dump with the latest earlier dump of the same branch, using numeric version order. It ignores module IDs, property order, known translation tables, and singleton `0`/`version` constants. It retains duplicate module contents and detects changed property bindings even when the set of CSS values is unchanged. Counts cover distinct exported CSS values, including CSS constants, not confirmed old-to-new class pairs.

Class-change notices show up to five added and five removed values per version. Full, readable JSON differences, with module IDs omitted, are saved as `class-diffs/<previous>-to-<new>.diff` on `mapping-data`. The workflow pushes those files before creating the issue; a failed push leaves the versions unannounced for a later retry. Version-only notices need no new theme check for class-name changes; they are not a general Steam compatibility test.

To generate a notice locally without publishing or opening an issue:

```sh
uv run --locked python mapping_changes.py "$scratch/steamui-watch-mapping-data" \
  1792618285.stable 1792626604.beta \
  --repository-url https://github.com/beallio/steamui-watch \
  --run-url https://github.com/beallio/steamui-watch/actions \
  --deployment success --output-dir "$scratch/css-notice"
```

Use the versions and deployment result you want to report. The command writes `title.txt`, `body.md`, and `label.txt` to the output directory and any class diffs to the data checkout. `label.txt` is empty when a comparison is unavailable without known changes. The diff links become available only after those files are pushed to `mapping-data`.

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

[Watch Decky finders](.github/workflows/decky-watch.yml) runs the text and browser checks daily. The browser check installs the `@decky/ui` version locked by `beallio/decky-loader`. When npm's `latest` `@decky/ui` is newer, the browser check runs again with it as a pre-upgrade check and opens **"Decky finders failing with @decky/ui <version> in <branch> <client>"** issues. Fix those before the fork upgrades.

The workflow also compares the copied finder versions with the fork's lock file and changed frontend lines that search Steam's code or use its globals. This comparison is a heuristic: some reported changes need no check update, and it can miss relevant changes.

Each run also saves the finder snapshots to the `finder-data` branch as `snapshots/<stable|beta>-<version>.decky-ui-<version>.json`. If the branch does not exist, the run creates it. A run never replaces a file that already exists: the first snapshot of each client and `@decky/ui` version is the baseline. Use these files to find a broken finder's object again in a later build. Do not merge `finder-data` into `main`.

Before the browser check, the workflow fetches a separate read-only baseline checkout. A missing data branch seeds an empty baseline; a fetch error remains a failed step, but the browser warning still runs. Suggested repairs are included in runtime and pre-upgrade issue bodies. A later run can update an open issue's generated report; closed issues stay closed. Snapshot retention and automatic issue closing are unchanged.

When a **"Decky finder copies out of date"** issue opens:

1. Review the linked fork comparison.
2. Update the loader entries of `FINDERS` in `decky_watch.py` and the loader predicates in `tools/runtime_probe.ts` where dependencies changed. Include new uses of Steam globals, not just changed text finders.
3. Set `LOADER` to the reviewed fork commit in `decky_watch.py`. Advance the commit only after reviewing the changes; it is not a way to hide an alert.
4. Run the checks against current stable and beta bundles. Confirm checks that need Gaming Mode on a Deck or SteamOS VM.
5. Publish the reviewed changes. The issue closes by itself on the next run.

A new `@decky/ui` version in the fork needs no update here: each run reads the finders from the locked version. If the text check step fails with "Cannot read … predicate part(s)", teach `tools/finder_table.ts` the new form.

For **"Decky finders missing"** and **"Decky runtime finders failing"**, confirm the problem on the reported Steam version, fix the Decky finder or the incorrect local check, then close the issue. The workflow does not reopen a closed report with the same check and version.

The workflow closes reports by itself, with a comment that links the run:

- A finder report closes when the same check passes on the same branch at the same or a newer client version. A check that did not run, or that failed with an error, closes nothing.
- A pre-upgrade report closes when the pre-upgrade check passes on that branch with any `@decky/ui` version. A newer npm `latest` makes the older report moot. When the fork locks the npm `latest`, the locked browser check counts as the pre-upgrade check.
- A copies report closes when the copies match the fork again, after you update `LOADER`.

## Troubleshooting

- **"is not a CSSLoader-Mappings checkout":** pass the path to the `mapping-data` checkout, not this source checkout.
- **"SHA-256 does not match the manifest":** do not use the downloaded bundle. Retry the download; if it keeps failing, investigate the connection or Valve's files.
- **"only N class modules found":** the parser found too few modules and stopped. Steam's bundle format may have changed; investigate before publishing.
- **"has its own history"** or **"is used twice":** a hand-made match in `webpack-mappings/` is invalid. Remove or correct the match without discarding retained history.
- **"module ... is not in version ...":** a match refers to a module absent from its source or target dump. Check both dumps and correct the match.
- **HTTP 403 errors:** Valve refused the request. Check network restrictions and try another connection.

## Research scope

[Background and research notes](docs/background.md) cover cross-version finder matching, object-identity comparisons, component prop-surface checks, and discovery of Steam exports missing from `@decky/ui`. Finder-repair suggestions and extra-component prop reports are retained daily workflow features. The other retained tools are the mapping generator, source-text check, browser probe, and catalog. A rendered preview or passing finder does not replace testing a theme or plugin in Steam.
