#!/usr/bin/env bun
/**
 * Run the real @decky/ui finders and the decky-loader runtime finders against a Steam Deck
 * client bundle in headless Chrome, without Steam. decky-watch.yml runs it daily.
 *
 *   bun tools/runtime_probe.ts [--branch stable|publicbeta]... [--bundle-dir DIR]
 *                              [--decky-ui PATH] [--chrome PATH] [--report-dir DIR] [--keep]
 *
 * Steam's page boots against a stand-in `SteamClient` that answers every call, then the stand-in
 * goes inert and each @decky/ui file is imported on its own, so one failing file cannot hide the
 * rest. Exit status 1 when any finder fails, unless --report-dir is given: then each branch
 * with failures gets REPORT_DIR/<stable|beta>-<version>.md and the exit status only reports errors.
 * See docs/background.md, "Headless runtime trial". The loader's React-tree finders need the
 * Gaming Mode window, which this page never draws.
 */
import { $ } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const CDN = "https://client-update.steamstatic.com";
const BOOT_MS = 12_000;
// Longest wait for one CDP reply. The full probe evaluation takes a few seconds.
const CDP_TIMEOUT_MS = 120_000;
const repo = resolve(import.meta.dir, "..");
const { values: args } = parseArgs({
  // Imported by the tests: then there are no command-line options to read.
  args: import.meta.main ? Bun.argv.slice(2) : [],
  options: {
    branch: { type: "string", multiple: true },
    "bundle-dir": { type: "string" },
    "decky-ui": { type: "string", default: resolve(repo, "../decky-loader/frontend/node_modules/@decky/ui") },
    chrome: { type: "string", default: process.env.CHROME ?? "google-chrome" },
    keep: { type: "boolean", default: false },
    "report-dir": { type: "string" },
  },
});

// Every property and call returns the stand-in; `.then(cb)` calls cb with a non-thenable copy, so
// awaited Steam calls finish (a thenable value would loop forever). Inert once __stubInert is set,
// or finders such as CommonUIModule would match it.
const STUB = `(() => {
  const mk = (thenable) => {
    const f = function () { return window.__stubInert ? undefined : self; };
    const self = new Proxy(f, { get: (t, k) => {
      if (window.__stubInert || k === Symbol.toPrimitive || k === Symbol.iterator) return undefined;
      if (k === "toString") return () => "";
      if (k === "then") return thenable ? (res) => { if (typeof res === "function") res(q); return p; } : undefined;
      return self;
    } });
    return self;
  };
  const q = mk(false), p = mk(true);
  window.SteamClient = p;
})();`;

const PROBE = (files: string[]) => `(async (files) => {
  window.__stubInert = true;
  const out = { boot: {}, files: {}, loader: {} };
  let W;
  try { W = await import("/probe/webpack.js"); } catch (e) { out.boot.webpack = "threw: " + e; return out; }
  out.boot.modules = W.modules.size;
  // Same globals decky-loader frontend/src/index.ts sets before importing @decky/ui.
  window.SP_REACT = W.findModule((m) => m.Component && m.PureComponent && m.useLayoutEffect);
  window.SP_REACTDOM = W.findModule((m) => m.createPortal && m.createRoot) || W.findModule((m) => m.createPortal && m.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE);
  const jsx = W.findModule((m) => (m.jsx && m.jsxs) || (m.jsx && Object.keys(m).length == 1));
  window.SP_JSX = jsx?.jsxs ? jsx : jsx && { jsx: jsx.jsx, jsxs: jsx.jsx, Fragment: window.SP_REACT?.Fragment };
  for (const k of ["SP_REACT", "SP_REACTDOM", "SP_JSX"]) out.boot[k] = !!window[k];
  for (const k of ["CommonUIModule", "IconsModule", "ReactRouter"]) out.boot[k] = W[k] != null;
  for (const f of files) {
    try {
      const m = await import("/probe/" + f);
      const missing = Object.entries(m).filter(([, v]) => v == null).map(([k]) => k);
      out.files[f] = missing.length ? "missing: " + missing.join(", ") : "ok";
    } catch (e) { out.files[f] = "threw: " + String(e).slice(0, 200); }
  }
  // decky-loader frontend/src predicates that run without a rendered Gaming Mode tree.
  const check = (name, fn) => { try { out.loader[name] = fn() ? "ok" : "missing"; } catch (e) { out.loader[name] = "threw: " + e; } };
  const store = /^\\(\\)=>\\([\\w$]+\\|\\|(?:[\\w$]+\\(|\\([\\w$]+=)new [\\w$]+\\),[\\w$]+\\)$/;
  const backstack = () => W.findModuleByExport((e) => typeof e == "string" && e == "router-backstack", 20);
  const qam = () => W.findModuleByExport((e) => e?.type?.toString?.()?.includes("QuickAccessMenuBrowserView"));
  check("errorboundary-hook: error reporting store", () => W.findModuleExport((e) => typeof e == "function" && e?.toString && store.test(e.toString())));
  check("router-hook: Route", () => Object.values(backstack()).find((e) => typeof e == "function" && (/routePath:[\\w$]+\\.match\\?\\.path./.test(e.toString()) || /routePath:null===\\(.=.\\.match\\)/.test(e.toString()))));
  check("tabs-hook: QAM renderer", () => Object.values(qam()).find((e) => e?.type?.toString?.()?.includes("QuickAccessMenuBrowserView")));
  check("toaster: Valve toast renderer", () => W.findModuleExport((e) => e?.toString?.()?.includes('controller:"notification",method:')));
  // library.ts needs a set m_history, which only the Gaming Mode router sets; check the store's shape.
  check("filepicker: history store", () => W.findModuleExport((e) => typeof e == "object" && "m_history" in e && "m_navigator" in e && "m_locationPathname" in e));
  check("DropdownMultiselect: classes", () => W.findModule((m) => m?.DropDownControlButton && m?.["duration-app-launch"]));
  check("Store: TabCount", () => W.findModule((m) => m?.TabCount && m?.TabTitle));
  return out;
})(${JSON.stringify(files)})`;

async function fetchBundle(branch: string, dir: string) {
  const get = (url: string) => fetch(url, { headers: { "User-Agent": "steamui-watch" } });
  const manifest = await (await get(`${CDN}/steam_client_steamdeck_${branch}_steamrt64`)).text();
  const version = manifest.match(/"version"\s+"(\d+)"/)?.[1];
  const block = manifest.match(/"steamui_websrc_all"\s*\{([^}]*)\}/)?.[1] ?? "";
  const fields = Object.fromEntries([...block.matchAll(/"(\w+)"\s+"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (!version || !fields.file || !fields.sha2) throw new Error(`${branch}: manifest has no version or steamui_websrc_all entry`);
  const zip = new Uint8Array(await (await get(`${CDN}/${fields.file}`)).arrayBuffer());
  if (new Bun.CryptoHasher("sha256").update(zip).digest("hex") !== fields.sha2.toLowerCase())
    throw new Error(`${fields.file}: SHA-256 does not match the manifest`);
  await Bun.write(join(dir, "bundle.zip"), zip);
  await $`unzip -q ${join(dir, "bundle.zip")} -d ${dir}`;
  return { label: `${branch} ${version}`, root: join(dir, "steamui"), report: `${branch === "publicbeta" ? "beta" : branch}-${version}` };
}

async function buildProbe(root: string, work: string) {
  const ui = join(args["decky-ui"]!, "dist");
  const shims = join(work, "shims");
  // decky-loader's rollup maps these imports to the globals PROBE sets.
  await Bun.write(join(shims, "react.js"), `export default window.SP_REACT; const R = () => window.SP_REACT;
export const useState = (...a) => R().useState(...a); export const useEffect = (...a) => R().useEffect(...a);
export const createElement = (...a) => R().createElement(...a); export const Fragment = window.SP_REACT?.Fragment;`);
  await Bun.write(join(shims, "jsx.js"), `export const jsx = (...a) => window.SP_JSX.jsx(...a);
export const jsxs = (...a) => window.SP_JSX.jsxs(...a);`);
  const files = ["modules/Router.js", "utils/static-classes.js", "deck-hooks/useParams.js",
    ...[...new Bun.Glob("components/*.js").scanSync(ui)].filter((f) => !f.endsWith("index.js")).sort()];
  const result = await Bun.build({
    entrypoints: ["webpack.js", ...files].map((f) => join(ui, f)),
    root: ui, outdir: join(root, "probe"), format: "esm", target: "browser", splitting: true,
    plugins: [{ name: "react-globals", setup(build) {
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: join(shims, "jsx.js") }));
      build.onResolve({ filter: /^react$/ }, () => ({ path: join(shims, "react.js") }));
    } }],
  });
  if (!result.success) throw new AggregateError(result.logs, "bundling @decky/ui failed");
  return files;
}

type CdpReply = { id: number; result?: Record<string, unknown>; error?: { message: string } };
type ProbeResult = { boot: Record<string, boolean | number | string>; files: Record<string, string>; loader: Record<string, string> };

/** CDP client. A call rejects when the connection fails or closes, or after `timeoutMs` without a reply. */
export function cdp(url: string, timeoutMs = CDP_TIMEOUT_MS) {
  const ws = new WebSocket(url);
  const pending = new Map<number, PromiseWithResolvers<CdpReply>>();
  const opened = Promise.withResolvers<void>();
  opened.promise.catch(() => {}); // a send() call reports the failure
  let lost: Error | undefined;
  const fail = (reason: string) => {
    lost ??= new Error(`CDP connection ${reason}`);
    opened.reject(lost);
    for (const call of pending.values()) call.reject(lost);
    pending.clear();
  };
  ws.onopen = () => opened.resolve();
  ws.onerror = () => fail("failed");
  ws.onclose = () => fail("closed");
  ws.onmessage = (m) => {
    const reply: CdpReply = JSON.parse(String(m.data));
    pending.get(reply.id)?.resolve(reply);
    pending.delete(reply.id);
  };
  let id = 0;
  // T: the CDP result shape for `method`; the protocol defines it, so it is not checked here.
  const send = async <T = Record<string, unknown>>(method: string, params = {}, sessionId?: string): Promise<T> => {
    await opened.promise;
    if (lost) throw lost;
    const callId = ++id;
    const call = Promise.withResolvers<CdpReply>();
    pending.set(callId, call);
    const timer = setTimeout(() => call.reject(new Error(`${method}: no CDP reply within ${timeoutMs} ms`)), timeoutMs);
    try {
      ws.send(JSON.stringify({ id: callId, method, params, sessionId }));
      const { result, error } = await call.promise;
      if (error) throw new Error(`${method}: ${error.message}`);
      return result as unknown as T;
    } finally {
      clearTimeout(timer);
      pending.delete(callId);
    }
  };
  return { send, close: () => ws.close() };
}

async function probe(root: string, files: string[], work: string) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = Bun.file(join(root, path));
    if (!path.includes("..") && await file.exists()) return new Response(file);
    // SharedJSContext runs at /routes/...; the app is a single page.
    return path.startsWith("/routes/") ? new Response(Bun.file(join(root, "index.html"))) : new Response(null, { status: 404 });
  } });
  const chrome = Bun.spawn([args.chrome!, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(work, "profile")}`,
    "--no-first-run", "--no-default-browser-check", "about:blank"], { stderr: "pipe", stdout: "ignore" });
  try {
    let log = "";
    const reader = chrome.stderr.getReader();
    while (!/DevTools listening on (ws:\S+)/.test(log)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`Chrome exited before DevTools was ready:\n${log}`);
      log += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const browser = cdp(log.match(/DevTools listening on (ws:\S+)/)![1]);
    const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await browser.send("Page.enable", {}, sessionId);
    await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB }, sessionId);
    await browser.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/routes/library/home/` }, sessionId);
    await Bun.sleep(BOOT_MS);
    const { result, exceptionDetails } = await browser.send<{ result: { value: ProbeResult }; exceptionDetails?: unknown }>(
      "Runtime.evaluate", { expression: PROBE(files), awaitPromise: true, returnByValue: true }, sessionId);
    browser.close();
    if (exceptionDetails) throw new Error(`probe failed: ${JSON.stringify(exceptionDetails).slice(0, 500)}`);
    return result.value;
  } finally {
    chrome.kill();
    await chrome.exited;
    server.stop(true);
  }
}

function failures(label: string, out: ProbeResult) {
  const bad = [...Object.entries(out.boot), ...Object.entries(out.files), ...Object.entries(out.loader)]
    .filter(([k, v]) => k !== "modules" && v !== true && v !== "ok")
    .map(([k, v]) => `${k}: ${v === false ? "missing" : v}`);
  console.log(`${label}: ${out.boot.modules ?? 0} modules; ${bad.length ? bad.length + " failing" : "all finders ok"}`);
  for (const line of bad) console.log(`  ${line}`);
  return bad;
}

async function writeReport(name: string, label: string, bad: string[]) {
  const ui = (await Bun.file(join(args["decky-ui"]!, "package.json")).json()).version;
  await Bun.write(join(args["report-dir"]!, `${name}.md`), [
    `Headless runtime check of the Steam Deck client \`${label}\` with \`@decky/ui\` ${ui}.`, "",
    ...bad.map((line) => `- ${line.replace(/^([^:]+):/, "**$1**:")}`), "",
    "The page ran without Steam, against a stand-in `SteamClient`. Confirm on the SteamOS VM, then update the finder "
      + "or `tools/runtime_probe.ts`. Close this issue when done.", "",
  ].join("\n"));
}

if (import.meta.main) {
  let ok = true;
  // Project convention (AGENTS.md): $TMPDIR, else /var/tmp/omp-1000, never /tmp.
  const temp = process.env.TMPDIR || "/var/tmp/omp-1000";
  await mkdir(temp, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(temp, "runtime-probe-"));
  try {
    const bundles = args["bundle-dir"]
      ? [{ label: resolve(args["bundle-dir"]), root: resolve(args["bundle-dir"]), report: "local" }]
      : await Promise.all((args.branch ?? ["stable", "publicbeta"]).map(async (b) => {
          await mkdir(join(work, b));
          return fetchBundle(b, join(work, b));
        }));
    if (args["report-dir"]) await mkdir(args["report-dir"], { recursive: true });
    for (const { label, root, report } of bundles) {
      const files = await buildProbe(root, work);
      const bad = failures(label, await probe(root, files, work));
      if (bad.length && args["report-dir"]) await writeReport(report, label, bad);
      ok &&= bad.length === 0;
    }
  } finally {
    if (args.keep) console.log(`kept ${work}`); else await rm(work, { recursive: true, force: true });
  }
  process.exit(ok || args["report-dir"] ? 0 : 1);
}
