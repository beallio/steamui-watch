import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { selectorUsesClass } from "./decky_catalog";

test("keeps a rule only when a whole class name is used", () => {
  const used = new Set(["Panel", "_3xy45At7o_lkxcLoSTF6e0", "gpfocus"]);
  expect(selectorUsesClass(".Panel", used)).toBe(true);
  expect(selectorUsesClass(".PanelSection", used)).toBe(false); // prefix of another class
  expect(selectorUsesClass(".Other .Panel:hover > span", used)).toBe(true); // any compound part
  expect(selectorUsesClass("._3xy45At7o_lkxcLoSTF6e0.gpfocus", used)).toBe(true);
  expect(selectorUsesClass(":root", used)).toBe(false);
});

test("--serve refuses ES-module clients before building anything", async () => {
  // Project convention (AGENTS.md): $TMPDIR, else /var/tmp/omp-1000, created on first use.
  const base = process.env.TMPDIR || "/var/tmp/omp-1000";
  await mkdir(base, { recursive: true, mode: 0o700 });
  const tmp = await mkdtemp(join(base, "catalog-test-"));
  try {
    await Bun.write(join(tmp, "bundle/index.html"), '<script type="module" src="/library.js"></script>');
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "decky_catalog.ts"), "--serve", "--bundle-dir", join(tmp, "bundle"),
      "--decky-ui-esm", join(tmp, "missing")], { env: { ...process.env, TMPDIR: tmp } });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("--serve supports Webpack clients only");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
