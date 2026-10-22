# `@beallio/decky-extras`

This package provides stable React wrappers for selected Steam UI components that are not exported by name from the public `@decky/ui` API. It uses Steam's module map and a small, validated finder manifest; it does not evaluate downloaded code or depend on fork-only APIs.

## Install in a plugin

Install the immutable package tarball as a dependency (no npm login is required):

```sh
npm install https://github.com/beallio/steamui-watch/releases/download/decky-extras-v0.1.0/beallio-decky-extras-0.1.0.tgz
```

Keep `react` and `@decky/ui` as the plugin's runtime peers. The standard Decky Rollup setup maps `react` to Steam's `SP_REACT` and `@decky/ui` to the installed Decky frontend library; bundle `@beallio/decky-extras` itself into the plugin. The supported minimum is official `@decky/ui` 4.15.1 (public `createModuleMapping`) and React 16.8 (hooks and `forwardRef`). The package does not import a bundled copy of either peer.

Use a wrapper where an extra is needed:

```tsx
import { useState } from "react";
import { extras } from "@beallio/decky-extras";

const { RadioGroup, RadioButton } = extras;

export function Choice() {
  const [value, setValue] = useState("a");
  return <RadioGroup value={value} onChange={setValue}>
    <RadioButton value="a">First</RadioButton>
    <RadioButton value="b">Second</RadioButton>
  </RadioGroup>;
}
```

The wrapper has stable identity, forwards props and `ref`, and renders nothing if the finder has no unique match. It subscribes while mounted, so a later successful definition download can resolve a missing component and re-render the wrapper. Missing or ambiguous results are warned once per component name.

For an explicit fallback, `findExtra(name)` returns the raw matched Steam component or `null` and starts a refresh if one is due:

```tsx
import { findExtra } from "@beallio/decky-extras";

const RadioGroup = findExtra("RadioGroup") ?? MyRadioGroupFallback;
```

This is a snapshot, not a reactive wrapper. Call `refreshExtras()` and then `findExtra()` again if an imperative consumer needs to observe a later recovery. `refreshExtras(): Promise<boolean>` forces a request and returns `true` for a valid, current response (including no change), or `false` on HTTP, parsing, size, revision, or network failure.

Call `stopExtrasUpdates()` from the plugin's unload hook. Automatic retry/hourly refresh timers exist only while one or more `extras` wrappers are mounted; unmounting the last wrapper stops the timer. A one-off `findExtra` still performs its due request but does not keep a background timer alive.

Import `stopExtrasUpdates` from the same package and call it from the plugin unload callback:

```ts
onDismount() {
  stopExtrasUpdates();
}
```

## Definitions and cache

The package ships with the canonical finder definitions in its bundle and fetches newer data from:

`https://beallio.github.io/steamui-watch/decky-extras.json`

The request is deferred until the first wrapper mount, `findExtra` call, or explicit `refreshExtras` call, so importing the package does not block plugin startup. Each response must be successful, readable within 10 seconds, no larger than 64 KiB, valid UTF-8 JSON, and valid schema-1 finder data before it can change the in-memory definitions or `localStorage` cache. The browser request uses `cache: "no-cache"`; no ETag is required.

Validated downloaded definitions are cached in localStorage. If storage is blocked, unavailable, full, or malformed, the package continues with the bundled or in-memory definitions. On startup it uses only a cache revision newer than the bundle. Older downloads never replace newer definitions; a changed payload must increment `revision`, even if the change is only a finder correction. Failed requests retain the last-good definitions, retry after one minute while wrappers are mounted, and retry hourly after success while mounted. Definitions are data only: clauses combine with AND and each clause's fixed `text`/`member`/`binding` atoms combine with OR; downloads cannot provide regexes or executable code.

If a downloaded update makes a working finder missing or ambiguous, the entire update is rejected before it replaces the cache. The previous definitions stay usable across plugin reloads. A component that never uniquely matched remains unavailable.

Runtime implementation changes require a new package version and immutable release asset. Finder-only changes require a monotonic manifest revision and can be picked up by already installed packages.

## Compatibility limits

Steam components are internal, version-dependent implementations. A finder must identify exactly one distinct Steam object; zero or multiple matches are exposed as unavailable, never guessed. The generated declarations use the exact component-name union but intentionally accept open props as `unknown`: this package does not promise undocumented Steam prop names, callback types, or compatibility across Steam updates. A unique source match does not prove that a component's prop contract stayed the same.

These components are intended for the normal Decky plugin tree in Steam Gaming Mode. Some rely on Steam's React context, CSS, controller-focus setup, or live Steam state and may render incorrectly or do nothing in a browser, desktop mode, or a tree without the corresponding native providers. The package does not create those providers or substitute fake official APIs.

## Building the package

With Bun available, build the npm-packable directory (default: `packages/decky-extras/dist`):

```sh
bun packages/decky-extras/build.ts
# or choose an output directory
bun packages/decky-extras/build.ts --outdir "$TMPDIR/decky-extras-package"
```

The output contains `index.js`, generated `index.d.ts`, `package.json`, and this README; `index.js` bundles the runtime and manifest while leaving `react` and `@decky/ui` external. From that output directory, `npm pack` creates the installable tarball.
