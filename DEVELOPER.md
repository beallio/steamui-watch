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

The retained pipeline is upstream plus reviewed history fixes. It excludes a fuzzy source while its same-ID module still meets the pipeline's key-overlap match threshold. A genuinely reused ID or split remainder is listed as a new identity. Stable and beta transitions follow their actual base version, and one history cannot hold two different modules at the same version. The source checkout rejects a retained match that moves a still-present source without an explicit new-identity record. When stable and beta share a client version, histories that reach the same module are joined. Record a split that affects both branches in each branch's transition; otherwise one history can own two current modules and publication stops.

Run its small, inline-data regressions from the data checkout:

```sh
uv run --no-project --python 3.14 python -m unittest discover -s tests
```

The `mapping-data` branch has its own PR/push check for those tests and the real retained pipeline. Keep its reviewed transition maps, raw inputs and legacy class-name seeds; do not regenerate all matches and overwrite hand corrections. For a history repair, compare every output, retain all older class names and aliases, and review changed destinations before publication.

The tool gets Valve's current stable and beta versions, downloads bundles it has not seen, checks their SHA-256 hashes, and extracts CSS class modules. For Vite/Rolldown bundles (where Webpack is absent and most CSS property names are tree-shaken out of JavaScript), `vite_css.py` matches classes against the previous retained dump using surviving JS objects, identity matches, and irreversible SHA-256 CSS-rule/keyframe fingerprints retained at `css-fingerprints/{stable,beta}.json.gz` (zero raw CSS stored). It then runs the DeckThemes pipeline to produce `stable.json` and `beta.json` in the data checkout. It checks that both outputs have the expected JSON structure. This takes a few minutes and does not publish anything.

| Option | What it does |
|---|---|
| `--branch stable` or `--branch publicbeta` | Download only the selected branch. The pipeline still runs unless disabled. |
| `--force` | Download and parse a version again, even if its dump already exists. |
| `--no-pipeline` | Save the new Steam dumps without generating the translation lists. |

A successful run does not prove that every theme translates correctly. The parser extracts string-valued CSS class objects, not every kind of module. The pipeline can leave modules unmatched; output validation checks structure, not visual results. Check representative themes on the target Steam version.

## Check Decky compatibility locally

A finder is the search code Decky uses to locate a Steam component or store. The two checks below cover different failure cases. Neither proves that plugins work in Gaming Mode.

The `beallio/decky-loader` fork picks its `@decky/ui` by the client's bundle format, not by its branch: Webpack clients boot `@decky/ui-legacy` (4.x) with the shims in `frontend/src/stable/boot.ts`, and ES-module (Vite/Rolldown) clients boot `@decky/ui-v5` (5.x), whose module system reads each module's scope over CDP. Both checks do the same. Use the versions locked in the fork's `frontend/pnpm-lock.yaml`.

### Source-text check

```sh
bun install
bun tools/finder_table.ts /path/to/@decky/ui-legacy > "$scratch/finders-webpack.json"
bun tools/finder_table.ts /path/to/@decky/ui-v5 > "$scratch/finders-esm.json"
python3 decky_watch.py --ui-finders-webpack "$scratch/finders-webpack.json" --ui-finders-esm "$scratch/finders-esm.json" "$scratch/decky-reports"
```

`tools/finder_table.ts` reads the `@decky/ui` package's `dist/` and writes its finders as JSON. Without a path, it uses `../decky-loader/frontend/node_modules/@decky/ui`. For each finder it lists the text, regexes, prop lists and property names the predicate needs. It stops with status 1 if a predicate uses a form it cannot read; then add that form to the tool. The loader's finders stay in `FINDERS` in `decky_watch.py`; the ones from `stable/boot.ts` are checked on Webpack clients only.

`decky_watch.py` needs no data checkout. It prints missing-finder counts and writes one report per failing branch as `<stable|beta>-<version>.md`, and an empty `<stable|beta>-<version>.ok` for each passing branch. It searches Steam's source as shipped: on ES-module clients, string literals use backticks. A text hit only proves that the text is somewhere in the bundle, not that the real finder selects the right object. Property and method checks see names only.

### Browser check

`tools/runtime_probe.ts` runs the real `@decky/ui` finders per file and copied loader predicates in headless Chrome. It needs Bun, `unzip`, Chrome, and installed copies of both `@decky/ui` packages. By default it uses `@decky/ui-legacy` and `@decky/ui-v5` from `../decky-loader/frontend/node_modules`, a Decky Loader checkout with its frontend packages installed. A package path that does not exist stops the probe with status 2; pass an empty path (`--decky-ui-webpack ''`) to skip that format's clients.

```sh
CHROME=/path/to/chrome bun tools/runtime_probe.ts
CHROME=/path/to/chrome bun tools/runtime_probe.ts --branch publicbeta --decky-ui-esm /path/to/@decky/ui-v5
```

The page is served at Steam's own origin, `https://steamloopback.host`, through CDP request interception. On ES-module clients, the probe answers `@decky/ui` 5's scope lookups the way the fork's backend does (`backend-rust/src/cef.rs`). Extras and repairs search module scopes there, as `@beallio/decky-extras` does.

The default checks stable and beta. It prints results for each version and lists failed finders. It exits with status 1 if any finder fails. With `--report-dir DIR`, it writes reports for failing versions and an empty `.ok` file for each passing version, and reserves nonzero exit status for execution errors, as the workflow does.

With `--snapshot-dir DIR`, it also writes `<stable|beta>-<version>.decky-ui-<version>.json` for each version whose finders all pass. A version with a failing finder gets no snapshot, because the workflow keeps the first snapshot forever; a later clean run writes it. For each finder result that is a Steam object, the file records where Steam exports it (`module:export`, or only the module for whole modules) and a fingerprint. The fingerprint holds string literals and property names for functions, plus prototype methods for classes. For objects, it holds the key names. Results are matched by identity, so the file includes finders that scan `CommonUIModule` directly. Helpers and wrappers that `@decky/ui` makes itself are left out, and so are loader checks that return only true or false.

With `--baseline-dir DIR`, failing browser reports also look for repairs. Point it at the retained `finder-data/snapshots` directory:

```sh
CHROME=/path/to/chrome bun tools/runtime_probe.ts \
  --baseline-dir "$scratch/finder-data/snapshots" --report-dir "$scratch/decky-runtime-reports"
```

The repair tool reads the newest strictly older snapshot from the same branch and exact `@decky/ui` version. It ranks distinct Steam objects using module/export locations and fingerprint overlap, including names that changed from member access to string literals. Re-exports of one object count once. Only a complete module/export location can receive priority, and it needs meaningful fingerprint evidence; a reused module ID, export key, or common rendering names such as `children` and `className` do not establish identity. If location conflicts with clearly stronger fingerprint evidence, or candidates are close, the result is ambiguous.

It builds a short source-text or stable property/method predicate, keeping old match text as an alternative where needed. After the catalog check, it scans the real `@decky/ui` helpers without stopping at the first match, including default objects and every helper in an OR search. On both stable and beta, exactly one distinct object must match and the normal search must return the expected object by identity (`===`). Re-exports of that same object count once. A single-branch or `--bundle-dir` run cannot produce a verified repair. Missing baselines, weak evidence, shared factory code, extra runtime matches and failed identity checks produce reasons, not guessed fixes.

The report includes the baseline name, old and candidate export locations, match scores, shared fingerprint atoms, the proposed search, and both real-helper match counts and identity results. Full function bodies stay in memory. Match scores are ranking evidence, not probabilities or a promise that a component behaves the same. Review and test suggestions in Gaming Mode before changing Decky code.

For toast dismissal, the browser check verifies that `NotificationStore.RemoveGroupFromTray` and `NotificationStore.RemoveFromToastsWhere` are callable. The source-text check looks for both method names.

The browser uses a `SteamClient` stand-in, not a real Steam client. React-tree finders still need Gaming Mode. The file picker's `m_history` store search (`patches/library.ts`) is not copied: the loader has that patch commented out. Prop recording (`--props-dir`) needs Webpack module factories and runs on Webpack clients only. Confirm failures on a Steam Deck or SteamOS VM.

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

## Discover and watch Steam icon names

The browser probe can save the names in Steam's `SteamIcons` registry. It also records which icons need a `direction` prop. It saves names only, not Valve's SVG paths, CSS, images, or source code.

```sh
CHROME=/path/to/chrome bun tools/runtime_probe.ts --icons-dir "$scratch/icon-names"
bun tools/icons_report.ts "$scratch/icon-names" \
  --baseline-dir "$scratch/steamui-watch-finder-data/icons" \
  --out-dir "$scratch/icon-reports"
```

`--icons-dir` also works with `--extras-only`. The probe writes `<stable|beta>-<version>.json` only when one `SteamIcons` match is the same object as `@decky/ui`'s `IconsModule`. With `--bundle-dir`, it writes `local-0.json`. Each schema 1 snapshot has `branch`, `version`, `names`, and `directional` fields.

The report compares each snapshot with the newest strictly older snapshot for the same branch. It writes `<branch>-<version>.md` only when icon names were added or removed. The report also lists changes in the directional names. A missing or older-schema baseline starts history without an alert.

The daily workflow keeps the first snapshot for each client version in [`finder-data/icons`](https://github.com/beallio/steamui-watch/tree/finder-data/icons). It opens **"Steam icon names changed in <branch> <version>"** issues after the snapshot is saved. These issues need human review and do not close automatically.

The publishing workflow also serves [`decky-icons.json`](https://beallio.github.io/steamui-watch/decky-icons.json). Its schema 1 data has `stable` and `beta` entries. Each entry contains a Steam version, icon names, and directional names. It does not contain icon drawings or other Valve assets. If the extras probe fails, the workflow keeps the last valid icon list. A 404 means no list was published yet; other download or validation errors stop deployment.

Review each reported name against the current Steam client before changing a plugin. Directional names need a direction such as `up`, `down`, `left`, or `right`.


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

Open the printed local address in Chrome or Chromium. The page runs Steam's code: toggles switch, sliders move, and supported menus and dialogs open. An event log shows callbacks. Stop it with Ctrl-C. Controller navigation, sounds, and features that need a running Steam client do not work there. `--serve` supports Webpack clients only: `@decky/ui` 5 on an ES-module client needs Steam's origin and the CDP scope lookup that only the headless run provides, so it stops with status 2. Use the static output for ES-module clients.

These tools also accept `--bundle-dir DIR` to use an extracted `steamui` directory, and `--decky-ui-webpack PATH` and `--decky-ui-esm PATH` to select the library for each bundle format. Finders and minified module/export keys must be checked on each Steam build; a unique match is not a guarantee of future compatibility.

Catalog output contains Valve's styles, icons, and images. `docs/local/` is Git-ignored; do not publish the generated files or commit downloaded bundles.

## Extra components for standard Decky plugins

[`@beallio/decky-extras`](packages/decky-extras/README.md) is bundled inside each plugin; official `@decky/ui` and React remain external and come from the user's loader. Do not add extras to `DFL` or require our fork. The package searches with `createScopeMapping` when the loader's `@decky/ui` has it (5.x, and the fork's Webpack boot, which maps it to modules), and otherwise with the public `createModuleMapping` API of official `@decky/ui` 4.15.1 or newer. On ES-module clients, module scopes hold components that a chunk does not export.

`packages/decky-extras/extras.json` (schema 2) is the single extras list for the package, catalog and runtime probe. Official components still come from the real `@decky/ui` package. Each entry has a stable name, a `kind`, a title, a description, and AND clauses of OR atoms:

- `component`: a React component (the value, its `render` or its `type`), found by `text` (literal text, including double- and backtick-quoted source spellings), `member` (a whole member name) or `binding` (a destructuring default) atoms. The package exposes it as `extras.<Name>` and `findExtra`.
- `function`: a function or class, found by the same source atoms or by `key` (a property name on its prototype chain, such as a class method). The package exposes it through `findSteamValue`.
- `object`: a non-function object such as a store, found only by `key` atoms (own and inherited property names; values and getters are never read). Exposed through `findSteamValue`.

`{ "not": <atom> }` matches when the atom is absent. It only narrows: every entry needs at least one clause without `not`. No downloaded JavaScript, regular expressions, module IDs, property paths, or remote URLs are allowed. Numbers, strings and other simple values are not searched: on ES-module clients a module scope is a copy taken when the loader reads it, so those values go out of date, while objects and functions stay the live ones.

To correct a finder, edit its clauses and increase `revision`. Run the probe on stable and beta. Every extra must match exactly one distinct Steam object. Re-exports of that same object count once. These checks establish identity and presence, not prop meaning or controller behavior. Do not change the `kind` of a published name: plugins reject such an update.

The publishing workflow runs the probe, then `packages/decky-extras/feed.ts` writes two files beside the CSS lists: `decky-extras-v2.json` (the schema 2 list, for package 0.4.0 and newer) and `decky-extras.json` (a schema 1 copy for 0.2.x and 0.3.x). The copy has the same revision and only the components. A component that uses `not` keeps its finder from the last published copy, or is left out if it has none; removing the `not` atom could leave an empty clause or an ambiguous finder. If extras validation fails, the workflow fetches and validates both published files, stages them beside the fresh CSS mappings, and skips the extras package release. A Decky finder failure therefore does not block CSS updates. If either published file cannot be retrieved or validated, deployment stops rather than erase it. The only exception is a 404 for `decky-extras-v2.json` (not published yet), which is left out with a warning.

Plugin packages download the definitions on first use, keep validated data in `localStorage`, refresh hourly while mounted, and retry after a minute on failure. Downloads that would lose a working finder are rejected before replacing the cache. See the package README for unload cleanup and explicit fallback behavior.

Before a package release that changes runtime code, test it in a plugin in Gaming Mode as [the guide describes](packages/decky-extras/GUIDE.md#4-test-in-gaming-mode): build a small plugin that uses the new package, install it from a ZIP on a Deck or the SteamOS VM, and check that the extras draw and respond, that `findSteamValue` returns live objects, and that the feed downloads. Uninstall the test plugin afterwards; the install adds it to the loader's `pluginOrder`, and uninstalling removes it again.

For a runtime implementation change, increase the package version and build it:

```sh
bun packages/decky-extras/build.ts --outdir "$scratch/decky-extras-package"
npm pack "$scratch/decky-extras-package" --pack-destination "$scratch"
```

After Pages deploys, the workflow creates a `decky-extras-v<version>` GitHub release with the installable tarball if the release does not exist. Old releases are never replaced, so existing plugin lock files keep working. Finder-only changes need a manifest revision bump but no package version bump. No npm credentials are needed.

## Publishing and retained history

[Publish CSS mappings](.github/workflows/publish-mappings.yml) runs every 6 hours, on relevant pushes to `main`, and by manual dispatch. It clones `mapping-data`, generates both lists, saves new `webpack/`, `webpack-mappings/` and `webpack-literals/` inputs back to that branch, then deploys both JSON files together through GitHub Pages. A generation or deployment failure leaves the previous site available.

Three local rules in `mapping-data`'s `backport_classname_mappings.py` differ from upstream:

- Each list ends on the class in that branch's own dump. A beta build can have a lower number than the current stable build without being part of it, so number order alone can give stable users a beta-only class.
- `webpack-literals/<version>.<branch>.json` lists the class names that Steam's own CSS uses as written (for example `SVGIcon_DialogCheck` or the context-menu action `Launch`). These names are removed from that branch's aliases, so CSS Loader leaves them unchanged instead of moving a theme's rule onto an unrelated module class. `css_mappings.py` writes the list with each dump, and adds it once for a retained dump that has none.
- The backport picks the newest stable and beta versions from the `webpack/` dumps. `classname_mappings.json` stores one branch type per timestamp, so it cannot select the stable dump when both branches share a version.

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

[Watch Decky finders](.github/workflows/decky-watch.yml) runs the text and browser checks daily. It installs the `@decky/ui-legacy` and `@decky/ui-v5` versions locked by `beallio/decky-loader` and uses each for its bundle format. When npm's `latest` `@decky/ui` differs from the locked `@decky/ui-v5`, the browser check runs again with it on ES-module clients as a pre-upgrade check and opens **"Decky finders failing with @decky/ui <version> in <branch> <client>"** issues. Fix those before the fork upgrades.

The workflow also compares the copied finder versions with the fork's lock file and changed frontend lines that search Steam's code or use its globals. This comparison is a heuristic: some reported changes need no check update, and it can miss relevant changes.

Each run also saves the finder snapshots to the `finder-data` branch as `snapshots/<stable|beta>-<version>.decky-ui-<version>.json`. If the branch does not exist, the run creates it. A run never replaces a file that already exists: the first snapshot of each client and `@decky/ui` version is the baseline. Use these files to find a broken finder's object again in a later build. Do not merge `finder-data` into `main`.

Before the browser check, the workflow fetches a separate read-only baseline checkout. A missing data branch seeds an empty baseline; a fetch error remains a failed step, but the browser warning still runs. Suggested repairs are included in runtime and pre-upgrade issue bodies. A later run can update an open issue's generated report; closed issues stay closed. Snapshot retention and automatic issue closing are unchanged.

When a **"Decky finder copies out of date"** issue opens:

1. Review the linked fork comparison.
2. Update the loader entries of `FINDERS` in `decky_watch.py` and the loader predicates in `tools/runtime_probe.ts` where dependencies changed. Include new uses of Steam globals, not just changed text finders.
3. Set `LOADER` to the reviewed fork commit in `decky_watch.py`. Advance the commit only after reviewing the changes; it is not a way to hide an alert.
4. Run the checks against current stable and beta bundles. Confirm checks that need Gaming Mode on a Deck or SteamOS VM.
5. Publish the reviewed changes. The issue closes by itself on the next run.

A new `@decky/ui-legacy` or `@decky/ui-v5` version in the fork needs no update here: each run reads the finders from the locked versions. If the text check step fails with "Cannot read … predicate part(s)", teach `tools/finder_table.ts` the new form.

For **"Decky finders missing"** and **"Decky runtime finders failing"**, confirm the problem on the reported Steam version, fix the Decky finder or the incorrect local check, then close the issue. The workflow does not reopen a closed report with the same check and version.

The workflow closes reports by itself, with a comment that links the run:

- A finder report closes when the same check passes on the same branch at the same or a newer client version. A check that did not run, or that failed with an error, closes nothing.
- A pre-upgrade report closes when the pre-upgrade check passes on that branch with any `@decky/ui` version. A newer npm `latest` makes the older report moot. When the fork locks the npm `latest`, the locked browser check counts as the pre-upgrade check.
- A copies report closes when the copies match the fork again, after you update `LOADER`.

## Generate the Vite/Rolldown semantic developer guide

`tools/dev_guide.ts` builds an interactive, virtualized HTML developer guide styled with Valve's Steam Deck / SteamUI color guide (`index.html` + `data.json`, plus optional `--single-file` offline HTML). It maps Steam Deck `publicbeta` Vite/Rolldown components, stores, `IconsModule` icons, and CSS classes back to semantic names and legacy pre-Vite Webpack equivalents (`1794536281`).

```sh
CHROME=/path/to/chrome bun tools/dev_guide.ts \
  --mapping-data "$scratch/steamui-watch-mapping-data" \
  --out-dir "$scratch/guide" \
  --single-file docs/local/steamui-vite-dev-guide.html \
  --save-webpack-baseline "$scratch/webpack-baseline.json"
```

On later runs, pass `--webpack-baseline "$scratch/webpack-baseline.json"` to reuse the metadata-only pre-Vite fingerprint baseline without re-booting the Webpack bundle. Outputs are validated by `validatePublicGuideData()` before writing and contain strict metadata and copy-paste recipes only (zero raw Valve JS bodies, verbatim CSS declarations, or SVGs).

For a local-only build with live rendered Steam Deck component previews (`ButtonItem`, `ToggleField`, `SliderField`, `ConfirmModal`, `decky-extras`, etc.) and all `IconsModule` SVG icons, pass `--with-previews` and keep the output in git-ignored `docs/local/` (never publish `--with-previews` output, as it embeds Valve's CSS and SVGs).

## Troubleshooting

- **"is not a CSSLoader-Mappings checkout":** pass the path to the `mapping-data` checkout, not this source checkout.
- **"SHA-256 does not match the manifest":** do not use the downloaded bundle. Retry the download; if it keeps failing, investigate the connection or Valve's files.
- **"only N class modules found":** the parser found too few modules and stopped. Steam's bundle format may have changed; investigate before publishing.
- **"has its own history"** or **"is used twice":** a hand-made match in `webpack-mappings/` is invalid. Remove or correct the match without discarding retained history.
- **"still exists":** a match moves a source whose numeric ID remains in the destination dump. Keep the continuing module's history. If the number belongs to a different module now, record that new identity in the transition's `new` list after checking its properties and class names.
- **"module ... is not in version ...":** a match refers to a module absent from its source or target dump. Check both dumps and correct the match.
- **HTTP 403 errors:** Valve refused the request. Check network restrictions and try another connection.

## Research scope

[Background and research notes](docs/background.md) cover cross-version finder matching, object-identity comparisons, component prop-surface checks, and discovery of Steam exports missing from `@decky/ui`. Finder-repair suggestions and extra-component prop reports are retained daily workflow features. The other retained tools are the mapping generator, source-text check, browser probe, and catalog. A rendered preview or passing finder does not replace testing a theme or plugin in Steam.
