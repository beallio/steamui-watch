#!/usr/bin/env bun
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import extrasData from "../packages/decky-extras/extras.json";

type Surface = { at: string[]; props: string[]; notes: string[] };
type Snapshot = {
  schema: 1;
  branch: "stable" | "beta" | "local";
  version: string;
  revision: number;
  components: Record<string, Surface>;
};
type Change = { name: string; added: string[]; removed: string[]; notes: string[] };

const canonical = Object.entries(extrasData.components) as [string, { title: string; description: string }][];
const canonicalNames = Object.keys(extrasData.components);
const snapshotName = /^(stable|beta|local)-(0|[1-9]\d*)\.json$/;
const generatedName = /^(stable|beta|local)-(0|[1-9]\d*)(\.reference)?\.md$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

function strings(value: unknown, file: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    return invalid(file, `${field} must be an array of non-empty strings`);
  }
  return value;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[], file: string, field: string) {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) invalid(file, `${field} contains unsupported field ${JSON.stringify(extra)}`);
}

function validateSnapshot(value: unknown, file: string, expected: { branch: string; version: string }, baseline = false): Snapshot {
  if (!object(value)) return invalid(file, "snapshot must be an object");
  hasOnlyKeys(value, ["schema", "branch", "version", "revision", "components"], file, "snapshot");
  if (value.schema !== 1) return invalid(file, `unsupported schema ${JSON.stringify(value.schema)} (expected 1)`);
  if (typeof value.branch !== "string" || value.branch !== expected.branch ||
      value.branch !== "stable" && value.branch !== "beta" && value.branch !== "local") {
    return invalid(file, `branch must match filename ${expected.branch}`);
  }
  if (typeof value.version !== "string" || value.version !== expected.version) {
    return invalid(file, `version must match filename ${expected.version}`);
  }
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    return invalid(file, "revision must be a positive safe integer");
  }
  if (!object(value.components)) return invalid(file, "components must be an object");

  const components = Object.create(null) as Record<string, Surface>;
  for (const [name, raw] of Object.entries(value.components)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return invalid(file, `invalid component name ${JSON.stringify(name)}`);
    if (!object(raw)) return invalid(file, `components.${name} must be an object`);
    hasOnlyKeys(raw, ["at", "props", "notes"], file, `components.${name}`);
    const at = strings(raw.at, file, `components.${name}.at`);
    if (!at.length || at.some((location) => !/^[\w$.-]+:[\w$.-]+$/.test(location))) {
      return invalid(file, `components.${name}.at must contain export locations`);
    }
    components[name] = {
      at,
      props: strings(raw.props, file, `components.${name}.props`),
      notes: strings(raw.notes, file, `components.${name}.notes`),
    };
  }
  if (!baseline && (canonicalNames.some((name) => !components[name]) ||
      Object.keys(components).some((name) => !canonicalNames.includes(name)))) {
    return invalid(file, "current snapshot components must match the canonical manifest");
  }
  return {
    schema: 1,
    branch: value.branch,
    version: value.version,
    revision: value.revision as number,
    components,
  };
}

async function loadSnapshots(dir: string, isBaseline = false): Promise<Snapshot[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isBaseline && object(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const files = names.filter((name) => name.endsWith(".json")).sort();
  const snapshots: Snapshot[] = [];
  for (const name of files) {
    const match = snapshotName.exec(name);
    if (!match) return invalid(join(dir, name), "filename must be <stable|beta>-<numeric-version>.json");
    const file = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      return invalid(file, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isBaseline && object(parsed) && parsed.schema !== 1) continue;
    snapshots.push(validateSnapshot(parsed, file, { branch: match[1], version: match[2] }, isBaseline));
  }
  return snapshots;
}

function markdownCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function reference(snapshot: Snapshot): string {
  const components = canonical.map(([name, metadata]) => {
    const surface = snapshot.components[name];
    const props = surface?.props.length ? surface.props.map(markdownCode).join(", ") : "None observed";
    const notes = surface?.notes.length ? surface.notes.map((note) => `- ${note}`).join("\n") : "None recorded.";
    return `## ${name} — ${metadata.title}\n\n${metadata.description}\n\n**Observed prop names:** ${props}\n\n**Analysis uncertainty:**\n${surface ? notes : "- No prop surface was recorded in this snapshot."}`;
  }).join("\n\n");
  return `# Plugin-author reference: Decky extra prop observations\n\nSteam client **${snapshot.branch} ${snapshot.version}**.\n\n> These are names observed by static analysis, not a guaranteed API contract or proof of runtime behavior. Types, requiredness, defaults, and intended meaning are unknown. Review analysis uncertainty before relying on a name.\n\n${components}\n`;
}

function compare(current: Snapshot, baseline: Snapshot): Change[] {
  const changes: Change[] = [];
  for (const [name] of canonical) {
    const now = current.components[name];
    const before = baseline.components[name];
    if (!now || !before) continue;
    const oldProps = new Set(before.props), newProps = new Set(now.props);
    const added = [...newProps].filter((prop) => !oldProps.has(prop)).sort();
    const removed = [...oldProps].filter((prop) => !newProps.has(prop)).sort();
    if (added.length || removed.length) {
      const notes = [...new Set([...before.notes.map((note) => `Previous ${baseline.version}: ${note}`),
        ...now.notes.map((note) => `Current ${current.version}: ${note}`)])];
      changes.push({ name, added, removed, notes });
    }
  }
  return changes;
}


function changeReport(current: Snapshot, baseline: Snapshot, changes: Change[], link: string): string {
  const body = changes.map(({ name, added, removed, notes }) => [
    `## ${name}`,
    `- Added: ${added.length ? added.map(markdownCode).join(", ") : "none"}`,
    `- Removed: ${removed.length ? removed.map(markdownCode).join(", ") : "none"}`,
    `- Analysis uncertainty: ${notes.length ? notes.join("; ") : "No additional uncertainty was recorded for this component."}`,
  ].join("\n")).join("\n\n");
  return `# Decky extra props changed in ${current.branch} ${current.version}\n\nCompared with the newest strictly older retained snapshot, ${baseline.branch} ${baseline.version}. These are observed names, not a guaranteed API contract or proof of runtime behavior; types, requiredness, defaults, and meaning are unknown. Removed observed reads are not proof that a prop stopped working: other code paths may consume it.\n\n${body}\n\nReview these changes against the current Steam UI before changing a plugin. This alert remains open until a person reviews it.\n\n[Plugin-author reference for ${current.branch} ${current.version}](${link})\n`;
}

export async function generateReports(currentDir: string, baselineDir: string, outDir: string, repository = process.env.GITHUB_REPOSITORY) {
  const [currentSnapshots, baselineSnapshots] = await Promise.all([
    loadSnapshots(currentDir),
    loadSnapshots(baselineDir, true),
  ]);
  await mkdir(outDir, { recursive: true });
  for (const name of await readdir(outDir)) if (generatedName.test(name)) await rm(join(outDir, name));

  const byVersion = new Map(baselineSnapshots.map((snapshot) => [`${snapshot.branch}-${snapshot.version}`, snapshot]));
  for (const current of currentSnapshots) {
    const stem = `${current.branch}-${current.version}`;
    const retained = byVersion.get(stem);
    const referenceSnapshot = retained ?? current;
    const referenceFile = `${stem}.reference.md`;
    await writeFile(join(outDir, referenceFile), reference(referenceSnapshot));

    let baseline: Snapshot | undefined;
    for (const candidate of baselineSnapshots) {
      if (candidate.branch === current.branch && BigInt(candidate.version) < BigInt(current.version) &&
          (!baseline || BigInt(candidate.version) > BigInt(baseline.version))) baseline = candidate;
    }
    if (!baseline) continue;
    const changes = compare(current, baseline);
    if (changes.length) {
      const link = repository ? `https://github.com/${repository}/blob/finder-data/props/${referenceFile}` : referenceFile;
      await writeFile(join(outDir, `${stem}.md`), changeReport(current, baseline, changes, link));
    }
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { "baseline-dir": { type: "string" }, "out-dir": { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1 || !values["baseline-dir"] || !values["out-dir"]) {
    throw new Error("usage: bun tools/props_report.ts CURRENT_DIR --baseline-dir DATA/props --out-dir REPORT_DIR");
  }
  await generateReports(positionals[0], values["baseline-dir"], values["out-dir"]);
}
