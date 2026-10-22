#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseManifest } from "./match";

const { values } = parseArgs({ options: { outdir: { type: "string" } }, strict: true, allowPositionals: false });
const sourceDir = import.meta.dir;
const outdir = resolve(values.outdir ?? resolve(sourceDir, "dist"));
const manifest = parseManifest(JSON.parse(await readFile(resolve(sourceDir, "extras.json"), "utf8")));
const names = Object.keys(manifest.components);
const declaration = `import type * as React from "react";

export type ExtraName = ${names.map((name) => JSON.stringify(name)).join(" | ")};
export type ExtraProps = Record<string, unknown>;
export type ExtraComponent = React.ComponentType<ExtraProps> | React.ExoticComponent<ExtraProps>;
export type ExtraWrapper = React.ForwardRefExoticComponent<ExtraProps & React.RefAttributes<unknown>>;
export type Extras = { readonly [Name in ExtraName]: ExtraWrapper };
export declare const extras: Extras;
export declare function findExtra(name: ExtraName): ExtraComponent | null;
export declare function refreshExtras(): Promise<boolean>;
export declare function stopExtrasUpdates(): void;
`;

await mkdir(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(sourceDir, "index.ts")],
  outdir,
  target: "browser",
  format: "esm",
  external: ["react", "@decky/ui"],
});
if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
await Promise.all([
  writeFile(resolve(outdir, "index.d.ts"), declaration),
  writeFile(resolve(outdir, "package.json"), `${JSON.stringify(JSON.parse(await readFile(resolve(sourceDir, "package.json"), "utf8")), null, 2)}\n`),
  writeFile(resolve(outdir, "README.md"), await readFile(resolve(sourceDir, "README.md"), "utf8")),
]);
