import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { applyUiCompat, extractViteCompatPlugin } from "./apply_ui_compat";

const SAMPLE_ROLLUP = `
import fakePlugin from 'nonexistent-rollup-plugin';

function viteCompatDeckyUi() {
  return {
    name: 'vite-compat-decky-ui',
    transform(code, id) {
      const norm = id.replace(/\\\\/g, '/');
      if (!norm.includes('/@decky/ui/dist/')) return null;
      if (norm.endsWith('/@decky/ui/dist/utils/static-classes.js')) {
        return code.replace(/findClassModule\\(([^;\\n]+)\\);/g, '(findClassModule($1) || {});');
      }
      if (norm.endsWith('/@decky/ui/dist/webpack.js')) {
        return { code: code.replace('export const IconsModule = findModuleByExport(', 'export const IconsModule = findModule((m) => m?.Spinner) || findModuleByExport(') };
      }
      return null;
    },
  };
}

export default [{ plugins: [fakePlugin(), viteCompatDeckyUi()] }];
`;

test("extractViteCompatPlugin ignores rollup imports and extracts viteCompatDeckyUi()", () => {
  const plugin = extractViteCompatPlugin(SAMPLE_ROLLUP);
  expect(plugin.name).toBe("vite-compat-decky-ui");
  expect(plugin.transform("export const A = findClassModule((m) => m.Foo);", "/@decky/ui/dist/utils/static-classes.js"))
    .toBe("export const A = (findClassModule((m) => m.Foo) || {});");
  expect(plugin.transform("export const X = 1;", "/@decky/ui/dist/other.js")).toBeNull();
});

test("extractViteCompatPlugin rejects configs without viteCompatDeckyUi()", () => {
  expect(() => extractViteCompatPlugin("export default [];")).toThrow("viteCompatDeckyUi() function not found");
});

test("applyUiCompat copies package and transforms matching dist files without mutating source", async () => {
  const tempRoot = process.env.TMPDIR || "/var/tmp/omp-1000";
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(tempRoot, "apply-ui-compat-test-"));
  try {
    const rollup = join(dir, "rollup.config.js");
    const src = join(dir, "src-ui");
    const out = join(dir, "out-ui");
    await mkdir(join(src, "dist", "utils"), { recursive: true });
    await Bun.write(rollup, SAMPLE_ROLLUP);
    await Bun.write(join(src, "package.json"), JSON.stringify({ name: "@decky/ui", version: "4.16.4" }));
    await Bun.write(join(src, "dist", "webpack.js"), "export const IconsModule = findModuleByExport((e) => e);\n");
    await Bun.write(join(src, "dist", "utils", "static-classes.js"), "export const A = findClassModule((m) => m.Foo);\n");
    await Bun.write(join(src, "dist", "unchanged.js"), "export const B = 42;\n");

    const changed = await applyUiCompat(rollup, src, out);
    expect(changed).toEqual(["utils/static-classes.js", "webpack.js"]);
    expect(await Bun.file(join(out, "dist", "utils", "static-classes.js")).text())
      .toBe("export const A = (findClassModule((m) => m.Foo) || {});\n");
    expect(await Bun.file(join(out, "dist", "webpack.js")).text())
      .toBe("export const IconsModule = findModule((m) => m?.Spinner) || findModuleByExport((e) => e);\n");
    expect(await Bun.file(join(out, "dist", "unchanged.js")).text()).toBe("export const B = 42;\n");
    // Original source package must be untouched, even when srcDir is a symlink (as under pnpm).
    const link = join(dir, "src-link");
    const out2 = join(dir, "out-ui-2");
    await symlink(src, link);
    await applyUiCompat(rollup, link, out2);
    expect(await Bun.file(join(src, "dist", "utils", "static-classes.js")).text())
      .toBe("export const A = findClassModule((m) => m.Foo);\n");
    expect(await Bun.file(join(out2, "dist", "utils", "static-classes.js")).text())
      .toBe("export const A = (findClassModule((m) => m.Foo) || {});\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
