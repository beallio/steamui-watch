# Phase 1 Plan: Steam Deck Beta (Vite/Rolldown) Semantic Developer Guide

## Problem Definition

With Steam Deck `publicbeta` `1795048523` (changelist `11255874`), Valve migrated `steamui` from Webpack to Vite + Rolldown + LightningCSS:

- `webpackChunksteamui` is gone and replaced by ~491 ESM chunks (`chunk~*.js`).
- ~85% of CSS module property names were tree-shaken out of JS and replaced by opaque 12–13 character trailing-dash hashes (`cpMYQEmzrwE-`).
- Most React components and internal stores (`m_*` singletons) now live under minified chunk bindings (`esm:chunk~1fa4b8f2ff.js:Fa`) rather than stable Webpack module IDs.

Decky plugin authors and CSS Loader theme authors lost the semantic names needed to understand, search, and migrate against the new Vite bundle.

This project builds a **cross-linked, exhaustive, metadata-only HTML developer guide** (plus machine-readable `data.json` and optional `--single-file` output) styled with **Valve's Steam Deck / SteamUI color guide**, mapping Steam components, stores, icons, and CSS classes to semantic names and bridging them back to the last Webpack release (`1794536281`).

Phase 1 delivers the core schema, data extractor, full dual-bundle Webpack→Vite export matcher, interactive virtualized HTML generator, and unit + live integration verification. (Phase 2 wires `/guide/` into GitHub Pages CI with failure isolation; Phase 3 adds local `--with-previews` headless React rendering reusing `tools/decky_catalog.ts`.)

---

## Architecture Overview

```
                    +-----------------------------+
                    |  mapping-data checkout      |
                    |  - webpack/<beta>.beta.json |
                    |  - webpack/<wp>.stable.json |
                    |  - beta.json (chains)       |
                    |  - webpack-literals/        |
                    |  - id_to_name.json          |
                    +--------------+--------------+
                                   |
+--------------------------+       v       +----------------------------------+
| Beta Vite Bundle (CDN)   |---> [dev_guide_extract.ts] <--- Webpack Baseline |
| - 491 ESM JS chunks      |       ^       | (live boot 1794536281 or cached  |
| - sp.css / *.css         |       |       |  metadata-only fingerprint JSON) |
+-------------+------------+       |       +----------------------------------+
              |                    |
              v                    |
  [Headless Chrome Runtime]        |
  - runtime_probe.ts boot          |
  - @decky/ui + viteCompatDeckyUi  |
  - decky-loader + decky-extras    |
  - IconsModule + CommonUIModule   |
  - all runtime exports & stores --+
                                   |
                                   v
                      +------------------------+
                      | GuideData (JSON)       |  <-- Strict Valve-asset validator
                      | (strict metadata only) |      (0 raw JS, 0 raw CSS, 0 SVGs)
                      +-----------+------------+
                                  |
                                  v
                      +------------------------+
                      | dev_guide_html.ts      |
                      | - Valve color guide UI |
                      | - Virtualized 13k+ UI  |
                      | - Omnibox + Translator |
                      | - Bidirectional Drawer |
                      +-----------+------------+
                                  |
                  +---------------+---------------+
                  v                               v
       guide/index.html + data.json      --single-file HTML
```

### Strict Valve-Asset Boundary

Public outputs (`guide/index.html`, `guide/data.json`, and cached Webpack baseline JSON) MUST contain **zero** raw Valve JS function bodies, **zero** verbatim Valve CSS rules/declarations, and **zero** SVG markup/images:

- Only identifiers, hashes, chunk:symbol locations, legacy Webpack `moduleId:exportKey` locations, observed prop names, method/store field names, cross-reference indices, confidence/migration tags, and short copy-paste recipes (`import { X } from "@decky/ui"`, `.hash-`, `findModuleExport(...)` predicates constructed from non-body metadata).
- `validatePublicGuideData()` enforces this boundary programmatically and fails on violations.

---

## Core Data Structures (`tools/dev_guide_schema.ts`)

- **`ConfidenceTier`**: `"verified" | "inferred" | "unmatched"`
- **`MigrationStatus`**: `"unchanged" | "changed" | "new" | "unmatched"`
- **`EntityKind`**: `"component" | "store" | "icon" | "helper" | "css-module" | "css-class" | "plain-class"`
- **`CssClassEntry`**:
  - `id`: canonical key (e.g. `css:Keyboard/KeyboardKey` or `css:unmatched/AbCdEfGhIjK-`)
  - `hash`: current Vite hash (or plain literal class name)
  - `semanticName`: recovered CSS property name (e.g. `KeyboardKey`) or `null`
  - `moduleId`: semantic/legacy CSS module ID (e.g. `27752`) or `null`
  - `moduleName`: human feature/module label (e.g. `Keyboard`, `BPMGameBackground`, `Settings`)
  - `featureArea`: top-level feature group (`CommonUI`, `Keyboard`, `Settings`, `Library`, `Overlay`, `Store`, `Broadcast`, `Friends & Chat`, `Gamepad & Input`, `Media & Recording`, `System & Misc`, `Unmatched`)
  - `webpackHash`: hash in last pre-Vite Webpack build (`1794536281`) or `null`
  - `chainId`: CSS Loader translation list key from `beta.json` (if present)
  - `chainHistoryCount`: number of historical hashes in `beta.json` chain
  - `confidence`: `ConfidenceTier`
  - `migration`: `MigrationStatus`
  - `isKeyframe`: boolean (true when class/symbol is a `@keyframes` animation)
  - `usedBy`: array of component/export IDs referencing this hash in Vite JS chunks
  - `cssSnippet`: copy-paste selector snippet (e.g. `.cpMYQEmzrwE- /* Keyboard.KeyboardKey */`)
- **`CssModuleEntry`**:
  - `id`: `mod:<moduleId>`
  - `moduleId`: string
  - `name`: derived semantic name (from `id_to_name.json`, dominant class prefix, or representative top class)
  - `featureArea`: string
  - `classCount`: number
  - `matchedCount`: number
  - `classes`: array of `CssClassEntry.id`
  - `usedBy`: array of component/export IDs referencing classes in this module
- **`JsExportEntry`**:
  - `id`: canonical slug (e.g. `comp:SliderField`, `store:NotificationStore`, `exp:chunk~1fa4b8f2ff.js:Fa`)
  - `name`: semantic name (verified API name or inferred name like `KeyboardKeyView` / `Store_AppOverview`) or chunk:symbol fallback
  - `kind`: `"component" | "store" | "icon" | "helper"`
  - `confidence`: `ConfidenceTier`
  - `evidence`: short human-readable tags explaining how the name was derived (e.g. `["@decky/ui"]`, `["displayName:RadioButton"]`, `["css:Keyboard"]`, `["store-fields:m_history"]`)
  - `featureArea`: string
  - `viteAt`: array of Vite runtime locations (`esm:chunk~....js:Fa`)
  - `chunk`: primary chunk filename (`chunk~....js`)
  - `webpackAt`: array of matched legacy Webpack locations (`50777:Kc`), empty if unmatched
  - `webpackMatchScore`: numeric score when matched by dual-bundle fingerprinting (optional)
  - `migration`: `MigrationStatus`
  - `sourcePackage`: `"@decky/ui" | "@beallio/decky-extras" | "decky-loader" | "IconsModule" | "CommonUIModule" | "steamui"`
  - `props`: observed prop names (sorted)
  - `storeFields`: `m_*` field names for stores (sorted)
  - `methods`: prototype method names (sorted)
  - `steamClientApis`: `SteamClient.<Namespace>.<Method>` strings referenced in chunk/export
  - `cssClasses`: array of `CssClassEntry.id` referenced by this export
  - `cssModules`: array of `CssModuleEntry.id` referenced by this export
  - `recipe`: copy-paste import or finder snippet
- **`WebpackExportBaseline`**:
  - Metadata-only fingerprint index of every runtime export from the last Webpack build (`1794536281`): `at`, `kind`, `strings`, `names`, `methods`, `keys`, `cssKeys` (zero raw JS bodies).
- **`GuideData`**:
  - `schemaVersion`: `1`
  - `generatedAt`: ISO-8601 timestamp
  - `beta`: `{ branch, version, isVite, chunkCount, moduleCount }`
  - `webpackBaseline`: `{ branch, version, exportCount }`
  - `stats`: counts by kind, confidence, migration status, matched/unmatched CSS percentages
  - `featureAreas`: ordered list of `{ id, name, componentCount, storeCount, cssModuleCount, cssClassCount }`
  - `cssModules`: `CssModuleEntry[]`
  - `cssClasses`: `CssClassEntry[]`
  - `plainClasses`: `string[]`
  - `exports`: `JsExportEntry[]`
  - `icons`: `{ name, viteAt, webpackAt, directional, recipe }[]`
  - `chunks`: `{ name, exportCount, cssClassCount, featureAreas }[]`

---

## Public Interfaces

### New Modules (`tools/`)

1. `tools/dev_guide_schema.ts`
   - Exports all schema types, `SCHEMA_VERSION`, `VALVE_PALETTE`, `classifyFeatureArea()`, and `validatePublicGuideData(data): string[]`.
2. `tools/dev_guide_extract.ts`
   - `extractCssClassesFromStylesheets(cssSources: Iterable<string>): { hashes: Set<string>; keyframes: Set<string> }`
   - `buildCssIndex(opts): { cssModules, cssClasses, plainClasses, hashToClassId, webpackHashToViteHash }`
   - `analyzeViteChunkAst(chunkName: string, source: string, knownHashes: Set<string>): ChunkAstAnalysis`
   - `matchWebpackToVite(webpackExports: WebpackExportRecord[], viteExports: ViteRuntimeExport[], hashToSemantic: Map<string, string>): Map<string, WebpackMatch>`
   - `inferExportSemantics(exp, astInfo, cssModulesById, cssClassesById): { name, kind, confidence, evidence, featureArea }`
   - `buildGuideData(inputs): GuideData`
3. `tools/dev_guide_html.ts`
   - `renderGuideHtml(opts: { embeddedData?: GuideData; dataUrl?: string }): string`
   - Valve Steam Deck / SteamUI Color Guide theme (`--gp-darkest: #0e141b`, `--gp-header: #171a21`, `--gp-store-dark: #1b2838`, `--gp-surface: #23262e`, `--gp-elevated: #2a475e`, `--gp-border: #3d4450`, `--gp-muted: #67707b`, `--gp-sub: #8b929a`, `--gp-body: #b8bcbf`, `--gp-text: #dcdedf`, `--gp-blue: #1a9fff`, `--gp-blue-hi: #66c0f4`, `--gp-blue-code: #c2e6ff`, `--gp-green: #5ba32b`, `--gp-green-hi: #a1bf07`, `--gp-amber: #ffc53d`, `--gp-red: #ec5d5e`).
   - Virtualized list viewport (renders only visible rows over 13k+ entries for 60fps scrolling & instant search).
   - Universal Omnibox Search, Theme/CSS Paste Translator, Filter Bar (Confidence, Kind, Migration, Feature Area), Cross-linked Detail Drawer, and Hash Deep-Links (`#comp/...`, `#css/...`, `#hash/...`, `#chunk/...`, `#translate`).
4. `tools/dev_guide.ts` (CLI)
   - `bun tools/dev_guide.ts --mapping-data DIR --out-dir DIR [--beta-bundle-dir DIR] [--webpack-bundle-dir DIR] [--webpack-baseline FILE] [--save-webpack-baseline FILE] [--decky-ui DIR] [--rollup-config FILE] [--chrome PATH] [--single-file FILE]`

---

## Dependency Requirements

- **Zero new dependencies.** Uses existing Bun runtime + pinned `acorn` (`8.19.0` in `package.json` / `bun.lock`) and existing local Chrome binary + `tools/runtime_probe.ts` / `tools/apply_ui_compat.ts` helpers.
- Python runtime & `pyproject.toml` / `uv.lock` remain untouched.

---

## Testing Strategy (Strict TDD)

1. **Unit tests (`tools/dev_guide.test.ts`)** — small inline fixtures only (zero downloaded bundles, per `AGENTS.md`):
   - CSS index assembly: matched semantic classes, old Webpack hash bridge, CSS Loader chain linkage, plain literal classes, keyframe detection, and unmatched Vite hashes (~12% bucket).
   - Vite chunk AST analysis: export-to-Vite-hash linkage (both direct string literals and chunk-level `const` bindings), observed prop extraction (destructuring, `props.x`, `this.props.x`, `forwardRef`/`memo`), `m_*` store fields, `SteamClient.*` API calls, and `displayName` hints.
   - Dual-bundle Webpack→Vite fingerprint matcher: exact fingerprint match, CSS-semantic-key overlap match (when CSS class hashes changed across Webpack→Vite), ambiguous candidate rejection, and weak-evidence rejection.
   - Semantic naming & confidence tiers: Verified (`@decky/ui`, `decky-loader`, `decky-extras`, `IconsModule`), Inferred (`displayName`, store fields, unique CSS module), Unmatched/Anonymous, and Feature Area grouping.
   - Valve-asset boundary validator: rejects raw JS bodies, verbatim CSS rules, and `<svg>` markup.
   - HTML renderer: verifies Valve color palette tokens, split mode (`data.json` fetch), `--single-file` embedded mode (with safe `</script>` escaping), deep-link router, paste translator helpers, and virtualized renderer structure.
2. **Live local integration verification** (scratch files in `/var/tmp/omp-1000`, never committed):
   - Run `bun tools/dev_guide.ts` against real `publicbeta 1795048523` + `stable 1794536281` + cloned `mapping-data` branch.
   - Inspect generated stats (CSS match coverage, Webpack→Vite JS match rate, cross-link coverage, public boundary check).
   - Open generated `guide/index.html` in headless Chrome to verify zero runtime JS errors, omnibox search, paste translator, filter chips, drawer cross-links, and deep-links.
3. **Full repo checks:**
   - `bun test tools/ packages/`
   - `uv run --locked python -m unittest`
   - `uv run --locked ty check`
