import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateReports, publicFeed, validatePublishedIcons } from "./icons_report";

let root: string, current: string, baseline: string, out: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "icons-report-"));
  current = join(root, "current");
  baseline = join(root, "baseline");
  out = join(root, "reports");
  await Promise.all([mkdir(current), mkdir(baseline)]);
});

afterEach(async () => rm(root, { recursive: true, force: true }));

function snapshot(branch: "stable" | "beta", version: string, names: string[], directional: string[] = []) {
  return { schema: 1, branch, version, names: [...names].sort(), directional: [...directional].sort() };
}

async function save(dir: string, branch: "stable" | "beta", version: string, names: string[], directional: string[] = []) {
  await writeFile(join(dir, `${branch}-${version}.json`), JSON.stringify(snapshot(branch, version, names, directional)));
}

test("first snapshots seed history without an alert", async () => {
  await save(current, "stable", "100", ["Arrow", "Spinner"], ["Arrow"]);
  await generateReports(current, baseline, out);
  expect(await readdir(out)).toEqual([]);
});

test("compares the newest strictly older snapshot on the same branch", async () => {
  await save(baseline, "stable", "100", ["Arrow", "Old"]);
  await save(baseline, "stable", "200", ["Arrow", "Carat", "Spinner"], ["Arrow", "Carat"]);
  await save(baseline, "stable", "300", ["Arrow", "Carat", "Spinner"]);
  await save(baseline, "beta", "250", ["Arrow", "BetaOnly"]);
  await save(current, "stable", "300", ["Arrow", "DoubleCarat", "Spinner"], ["DoubleCarat"]);
  await generateReports(current, baseline, out, "owner/repo");

  const report = await readFile(join(out, "stable-300.md"), "utf8");
  expect(report).toContain("stable 200");
  expect(report).toContain("Added names: `DoubleCarat`");
  expect(report).toContain("Removed names: `Carat`");
  expect(report).toContain("Now directional: `DoubleCarat`");
  expect(report).toContain("No longer directional: `Arrow`, `Carat`");
  expect(report).not.toContain("`Old`");
  expect(report).not.toContain("BetaOnly");
  expect(report).toContain("https://github.com/owner/repo/blob/finder-data/icons/stable-300.json");
});

test("an older-schema baseline seeds history and directional-only changes do not alert", async () => {
  const old = snapshot("stable", "100", ["Arrow", "Spinner"], ["Arrow"]);
  old.schema = 0;
  await writeFile(join(baseline, "stable-100.json"), JSON.stringify(old));
  await save(current, "stable", "200", ["Arrow", "Spinner"]);
  await generateReports(current, baseline, out);
  expect(await readdir(out)).toEqual([]);

  await rm(join(baseline, "stable-100.json"));
  await save(baseline, "stable", "100", ["Arrow", "Spinner"], ["Arrow"]);
  await generateReports(current, baseline, out);
  expect(await readdir(out)).toEqual([]);
});

test("rejects malformed snapshots and public feeds", async () => {
  await save(current, "stable", "100", ["Arrow"]);
  const malformed = snapshot("stable", "100", ["Arrow"]);
  malformed.directional = ["Missing"];
  await writeFile(join(current, "stable-100.json"), JSON.stringify(malformed));
  await expect(generateReports(current, baseline, out)).rejects.toThrow("snapshot.directional must be a subset of names");

  expect(() => validatePublishedIcons({
    schema: 1, stable: { version: "100", names: ["Arrow"], directional: [] },
    beta: { version: "200", names: ["Spinner"], directional: ["Missing"] },
  })).toThrow("beta.directional must be a subset of names");
});

test("builds a names-only public feed from the newest stable and beta snapshots", async () => {
  await save(current, "stable", "100", ["Arrow"], ["Arrow"]);
  await save(current, "stable", "200", ["Arrow", "Spinner"], ["Arrow"]);
  await save(current, "beta", "150", ["Carat"]);
  expect(await publicFeed(current)).toEqual({
    schema: 1,
    stable: { version: "200", names: ["Arrow", "Spinner"], directional: ["Arrow"] },
    beta: { version: "150", names: ["Carat"], directional: [] },
  });
});
