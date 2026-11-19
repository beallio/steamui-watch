#!/usr/bin/env bun
/**
 * Apply decky-loader's `viteCompatDeckyUi()` Rollup transform to a copy of `@decky/ui`.
 *
 *   bun tools/apply_ui_compat.ts <rollup.config.js> <decky-ui-dir> <out-dir>
 *
 * Extracts the self-contained `viteCompatDeckyUi` function from the fork's `frontend/rollup.config.js`
 * using acorn (so Rollup devDependencies are not needed) and runs its `transform(code, id)` hook on
 * every JS file under `<out-dir>/dist`.
 */
import { parse } from "acorn";
import { cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

type TransformResult = string | { code: string } | null | undefined;
export type ViteCompatPlugin = { name?: string; transform: (code: string, id: string) => TransformResult };

export function extractViteCompatPlugin(rollupConfigSource: string): ViteCompatPlugin {
  const ast = parse(rollupConfigSource, { ecmaVersion: "latest", sourceType: "module" }) as { body: any[] };
  let fnNode: any;
  for (const stmt of ast.body) {
    const candidate = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (candidate?.type === "FunctionDeclaration" && candidate.id?.name === "viteCompatDeckyUi") {
      fnNode = candidate;
      break;
    }
  }
  if (!fnNode) throw new Error("viteCompatDeckyUi() function not found in rollup config");
  const fnSrc = rollupConfigSource.slice(fnNode.start, fnNode.end);
  const plugin = new Function(`${fnSrc}\nreturn viteCompatDeckyUi();`)() as ViteCompatPlugin;
  if (!plugin || typeof plugin.transform !== "function") {
    throw new Error("viteCompatDeckyUi() did not return a plugin with a transform() function");
  }
  return plugin;
}

export async function applyUiCompat(rollupConfigPath: string, srcDir: string, outDir: string): Promise<string[]> {
  const plugin = extractViteCompatPlugin(await Bun.file(rollupConfigPath).text());
  await rm(outDir, { recursive: true, force: true });
  await cp(srcDir, outDir, { recursive: true, dereference: true });
  const dist = join(outDir, "dist");
  const changed: string[] = [];
  for (const rel of [...new Bun.Glob("**/*.js").scanSync(dist)].sort()) {
    const filePath = join(dist, rel);
    const code = await Bun.file(filePath).text();
    const id = `/@decky/ui/dist/${rel.replace(/\\/g, "/")}`;
    const res = plugin.transform(code, id);
    const next = typeof res === "string" ? res : res && typeof res === "object" && typeof res.code === "string" ? res.code : null;
    if (next !== null && next !== code) {
      await Bun.write(filePath, next);
      changed.push(rel.replace(/\\/g, "/"));
    }
  }
  return changed;
}

if (import.meta.main) {
  const [rollupConfig, srcDir, outDir] = Bun.argv.slice(2);
  if (!rollupConfig || !srcDir || !outDir) {
    console.error("Usage: bun tools/apply_ui_compat.ts <rollup.config.js> <decky-ui-dir> <out-dir>");
    process.exit(1);
  }
  const changed = await applyUiCompat(resolve(rollupConfig), resolve(srcDir), resolve(outDir));
  console.log(`Applied viteCompatDeckyUi() to ${changed.length} file(s): ${changed.join(", ")}`);
}
