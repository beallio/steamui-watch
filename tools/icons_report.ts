#!/usr/bin/env bun
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

type Branch = "stable" | "beta" | "local";
type Snapshot = { schema: 1; branch: Branch; version: string; names: string[]; directional: string[] };
type PublishedBranch = { version: string; names: string[]; directional: string[] };
export type PublishedIcons = { schema: 1; stable: PublishedBranch; beta: PublishedBranch };

const snapshotName = /^(stable|beta|local)-(0|[1-9]\d*)\.json$/;
const generatedName = /^(stable|beta|local)-(0|[1-9]\d*)\.md$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[], file: string, field: string) {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) invalid(file, `${field} contains unsupported field ${JSON.stringify(extra)}`);
}

function names(value: unknown, file: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !/^[A-Za-z_$][\w$]*$/.test(name))) {
    return invalid(file, `${field} must be an array of icon names`);
  }
  for (let i = 1; i < value.length; i++) {
    if (value[i] <= value[i - 1]) return invalid(file, `${field} must be sorted and unique`);
  }
  return value;
}

function iconLists(value: Record<string, unknown>, file: string, field: string) {
  const all = names(value.names, file, `${field}.names`);
  const directional = names(value.directional, file, `${field}.directional`);
  const available = new Set(all);
  if (directional.some((name) => !available.has(name))) {
    return invalid(file, `${field}.directional must be a subset of names`);
  }
  return { names: all, directional };
}

function validateSnapshot(value: unknown, file: string, expected: { branch: string; version: string }): Snapshot {
  if (!object(value)) return invalid(file, "snapshot must be an object");
  hasOnlyKeys(value, ["schema", "branch", "version", "names", "directional"], file, "snapshot");
  if (value.schema !== 1) return invalid(file, `unsupported schema ${JSON.stringify(value.schema)} (expected 1)`);
  if (value.branch !== expected.branch || !["stable", "beta", "local"].includes(String(value.branch))) {
    return invalid(file, `branch must match filename ${expected.branch}`);
  }
  if (typeof value.version !== "string" || value.version !== expected.version) {
    return invalid(file, `version must match filename ${expected.version}`);
  }
  return { schema: 1, branch: value.branch as Branch, version: expected.version, ...iconLists(value, file, "snapshot") };
}

async function loadSnapshots(dir: string, isBaseline = false): Promise<Snapshot[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (isBaseline && object(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const snapshots: Snapshot[] = [];
  for (const name of files) {
    const match = snapshotName.exec(name);
    if (!match) return invalid(join(dir, name), "filename must be <stable|beta|local>-<numeric-version>.json");
    const file = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      return invalid(file, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isBaseline && object(parsed) && parsed.schema !== 1) continue;
    snapshots.push(validateSnapshot(parsed, file, { branch: match[1], version: match[2] }));
  }
  return snapshots;
}

function difference(current: string[], previous: string[]) {
  const before = new Set(previous);
  return current.filter((name) => !before.has(name)).sort();
}


function changeReport(current: Snapshot, baseline: Snapshot, added: string[], removed: string[], link: string) {
  const directionalAdded = difference(current.directional, baseline.directional);
  const directionalRemoved = difference(baseline.directional, current.directional);
  const list = (values: string[]) => values.length ? values.map((value) => `\`${value.replaceAll("`", "\\`")}\``).join(", ") : "none";
  return `# Steam icon names changed in ${current.branch} ${current.version}\n\nCompared with the newest strictly older retained snapshot, ${baseline.branch} ${baseline.version}. Names identify Steam icons; no SVG, CSS, or image data is included.\n\n- Added names: ${list(added)}\n- Removed names: ${list(removed)}\n- Now directional: ${list(directionalAdded)}\n- No longer directional: ${list(directionalRemoved)}\n\nReview these names against the current Steam client before changing a plugin. This alert remains open until a person reviews it.\n\n[Current icon-name snapshot](${link})\n`;
}

export async function generateReports(currentDir: string, baselineDir: string, outDir: string, repository = process.env.GITHUB_REPOSITORY) {
  const [currentSnapshots, baselineSnapshots] = await Promise.all([
    loadSnapshots(currentDir),
    loadSnapshots(baselineDir, true),
  ]);
  await mkdir(outDir, { recursive: true });
  for (const name of await readdir(outDir)) if (generatedName.test(name)) await rm(join(outDir, name));

  for (const current of currentSnapshots) {
    let baseline: Snapshot | undefined;
    for (const candidate of baselineSnapshots) {
      if (candidate.branch === current.branch && BigInt(candidate.version) < BigInt(current.version) &&
          (!baseline || BigInt(candidate.version) > BigInt(baseline.version))) baseline = candidate;
    }
    if (!baseline) continue;
    const added = difference(current.names, baseline.names);
    const removed = difference(baseline.names, current.names);
    if (!added.length && !removed.length) continue;
    const stem = `${current.branch}-${current.version}`;
    const link = repository ? `https://github.com/${repository}/blob/finder-data/icons/${stem}.json` : `${stem}.json`;
    await writeFile(join(outDir, `${stem}.md`), changeReport(current, baseline, added, removed, link));
  }
}

export function validatePublishedIcons(value: unknown, file = "decky-icons.json"): PublishedIcons {
  if (!object(value)) return invalid(file, "feed must be an object");
  hasOnlyKeys(value, ["schema", "stable", "beta"], file, "feed");
  if (value.schema !== 1) return invalid(file, `unsupported schema ${JSON.stringify(value.schema)} (expected 1)`);
  const branch = (name: "stable" | "beta"): PublishedBranch => {
    const raw = value[name];
    if (!object(raw)) return invalid(file, `${name} must be an object`);
    hasOnlyKeys(raw, ["version", "names", "directional"], file, name);
    if (typeof raw.version !== "string" || !/^(0|[1-9]\d*)$/.test(raw.version)) {
      return invalid(file, `${name}.version must be a numeric string`);
    }
    return { version: raw.version, ...iconLists(raw, file, name) };
  };
  return { schema: 1, stable: branch("stable"), beta: branch("beta") };
}

export async function publicFeed(snapshotDir: string): Promise<PublishedIcons> {
  const snapshots = await loadSnapshots(snapshotDir);
  const latest = (branch: "stable" | "beta") => {
    const found = snapshots.filter((snapshot) => snapshot.branch === branch)
      .sort((a, b) => BigInt(a.version) < BigInt(b.version) ? 1 : BigInt(a.version) > BigInt(b.version) ? -1 : 0)[0];
    if (!found) throw new Error(`${snapshotDir}: no ${branch} icon snapshot`);
    return { version: found.version, names: found.names, directional: found.directional };
  };
  return validatePublishedIcons({ schema: 1, stable: latest("stable"), beta: latest("beta") });
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { "baseline-dir": { type: "string" }, "out-dir": { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1 || !values["baseline-dir"] || !values["out-dir"]) {
    throw new Error("usage: bun tools/icons_report.ts CURRENT_DIR --baseline-dir DATA/icons --out-dir REPORT_DIR");
  }
  await generateReports(positionals[0], values["baseline-dir"], values["out-dir"]);
}
