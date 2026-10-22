import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extrasData from "../packages/decky-extras/extras.json";
import { generateReports } from "./props_report";

const names = Object.keys(extrasData.components);
let root: string, current: string, baseline: string, out: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "props-report-"));
  current = join(root, "current");
  baseline = join(root, "baseline");
  out = join(root, "reports");
  await Promise.all([mkdir(current), mkdir(baseline)]);
});

afterEach(async () => rm(root, { recursive: true, force: true }));

function snapshot(branch: "stable" | "beta", version: string, radioProps: string[], radioNotes: string[] = []) {
  return {
    schema: 1,
    branch,
    version,
    revision: 1,
    components: Object.fromEntries(names.map((name) => [name, {
      at: ["50777:abc"],
      props: name === "RadioButton" ? radioProps : ["children"],
      notes: name === "RadioButton" ? radioNotes : [],
    }])),
  };
}

async function save(dir: string, branch: "stable" | "beta", version: string, radioProps: string[], radioNotes: string[] = []) {
  await writeFile(join(dir, `${branch}-${version}.json`), JSON.stringify(snapshot(branch, version, radioProps, radioNotes)));
}

test("first run generates all component references without a baseline alarm", async () => {
  await save(current, "stable", "100", ["children", "checked"], ["forwarding helper could not be resolved"]);
  await generateReports(current, baseline, out, "owner/repo");

  const files = await readdir(out);
  expect(files).toEqual(["stable-100.reference.md"]);
  const reference = await readFile(join(out, files[0]), "utf8");
  for (const name of names) expect(reference).toContain(`## ${name} —`);
});

test("an old baseline schema seeds a reference without a change alarm", async () => {
  const oldSchema = snapshot("stable", "90", ["children", "previous"]);
  oldSchema.schema = 0;
  await writeFile(join(baseline, "stable-90.json"), JSON.stringify(oldSchema));
  await save(current, "stable", "100", ["children", "current"]);
  await generateReports(current, baseline, out);
  expect(await readdir(out)).toEqual(["stable-100.reference.md"]);
});

test("compares the newest strictly older same-branch version and keeps same-version evidence reference-only", async () => {
  await save(baseline, "stable", "100", ["children", "old"]);
  await save(baseline, "stable", "200", ["children", "previous"]);
  await save(baseline, "stable", "300", ["children", "retained"]);
  await save(baseline, "beta", "250", ["children", "beta-only"]);
  await save(current, "stable", "300", ["children", "current"]);
  await generateReports(current, baseline, out, "owner/repo");

  const report = await readFile(join(out, "stable-300.md"), "utf8");
  expect(report).toContain("stable 200");
  expect(report).toContain("Added: `current`");
  expect(report).toContain("Removed: `previous`");
  expect(report).not.toContain("`old`");
  expect(report).not.toContain("beta-only");
  expect(report).toContain("https://github.com/owner/repo/blob/finder-data/props/stable-300.reference.md");

  const reference = await readFile(join(out, "stable-300.reference.md"), "utf8");
  expect(reference).toContain("`retained`");
  expect(reference).not.toContain("`current`");
});

test("ignores component additions and removals when comparing prop names", async () => {
  const old = snapshot("stable", "100", ["children"]);
  const now = snapshot("stable", "200", ["children", "checked"]);
  delete old.components.RadioButton;
  delete old.components.TextButton;
  old.components.RemovedComponent = { at: ["50777:abc"], props: ["legacy"], notes: [] };
  await writeFile(join(baseline, "stable-100.json"), JSON.stringify(old));
  await writeFile(join(current, "stable-200.json"), JSON.stringify(now));
  await generateReports(current, baseline, out);
  expect(await readdir(out)).toEqual(["stable-200.reference.md"]);
});

test("rejects unsupported schema and malformed component data", async () => {
  const unsupported = snapshot("stable", "100", ["children"]);
  unsupported.schema = 2;
  await writeFile(join(current, "stable-100.json"), JSON.stringify(unsupported));
  await expect(generateReports(current, baseline, out)).rejects.toThrow("unsupported schema 2");

  await rm(join(current, "stable-100.json"));
  const malformed = snapshot("stable", "100", ["children"]);
  malformed.components.RadioGroup.props = "value" as unknown as string[];
  await writeFile(join(current, "stable-100.json"), JSON.stringify(malformed));
  await expect(generateReports(current, baseline, out)).rejects.toThrow("components.RadioGroup.props must be an array");
});
