#!/usr/bin/env bun
// Writes the Pages feeds: decky-extras-v2.json for 0.4.0+ and its schema 1 copy, decky-extras.json, for 0.2.x/0.3.x.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseManifest, parseManifestV1, projectV1 } from "./match";

const { values } = parseArgs({ options: { outdir: { type: "string" }, previous: { type: "string" } }, strict: true, allowPositionals: false });
if (!values.outdir) throw new Error("usage: feed.ts --outdir DIR [--previous PUBLISHED_DECKY_EXTRAS_JSON]");
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const manifest = parseManifest(await read(resolve(import.meta.dir, "extras.json")));
const previous = values.previous ? parseManifestV1(await read(values.previous)) : null;
const v1 = projectV1(manifest, previous);
await mkdir(values.outdir, { recursive: true });
await writeFile(join(values.outdir, "decky-extras-v2.json"), `${JSON.stringify(manifest)}\n`);
await writeFile(join(values.outdir, "decky-extras.json"), `${JSON.stringify(v1)}\n`);
