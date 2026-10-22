#!/usr/bin/env bun
/**
 * Run the real @decky/ui finders and the decky-loader runtime finders against a Steam Deck
 * client bundle in headless Chrome, without Steam. decky-watch.yml runs it daily.
 *
 *   bun tools/runtime_probe.ts [--branch stable|publicbeta]... [--bundle-dir DIR]
 *                              [--decky-ui PATH] [--chrome PATH] [--report-dir DIR] [--snapshot-dir DIR] [--props-dir DIR] [--keep]
 *
 * Steam's page boots against a stand-in `SteamClient` that answers every call, then the stand-in
 * goes inert and each @decky/ui file is imported on its own, so one failing file cannot hide the
 * rest. Exit status 1 when any finder fails, unless --report-dir is given: then each branch
 * with failures gets REPORT_DIR/<stable|beta>-<version>.md, each passing branch an empty .ok file,
 * and the exit status only reports errors.
 * With --snapshot-dir, each branch whose finders all pass also gets SNAPSHOT_DIR/<stable|beta>-<version>.decky-ui-<version>.json:
 * for every finder result that is a Steam object, where Steam exports it and its fingerprint.
 * With --props-dir, it also records observed prop names for every extra component, following forwarded props.
 * Only names and analysis notes are saved; Valve's factory source stays in memory.
 * See docs/background.md, "Headless runtime trial" and "Finder snapshots". The loader's React-tree
 * finders need the Gaming Mode window, which this page never draws.
 */
import { $ } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import extrasData from "../packages/decky-extras/extras.json";
import { matchExtras, parseManifest } from "../packages/decky-extras/match";
import { analyzeProps } from "./prop_surface";

const extras = parseManifest(extrasData);


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
    "snapshot-dir": { type: "string" },
    "props-dir": { type: "string" },
  },
});

// Every property and call returns the stand-in; `.then(cb)` calls cb with a non-thenable copy, so
// awaited Steam calls finish (a thenable value would loop forever). Inert once __stubInert is set,
// or finders such as CommonUIModule would match it.
export const STUB = `(() => {
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

// Same globals decky-loader frontend/src/index.ts sets before importing @decky/ui. Needs `W` = /probe/webpack.js.
export const GLOBALS = `
  window.SP_REACT = W.findModule((m) => m.Component && m.PureComponent && m.useLayoutEffect);
  window.SP_REACTDOM = W.findModule((m) => m.createPortal && m.createRoot) || W.findModule((m) => m.createPortal && m.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE);
  const jsx = W.findModule((m) => (m.jsx && m.jsxs) || (m.jsx && Object.keys(m).length == 1));
  window.SP_JSX = jsx?.jsxs ? jsx : jsx && { jsx: jsx.jsx, jsxs: jsx.jsx, Fragment: window.SP_REACT?.Fragment };`;

/**
 * String literals and property names in minified source. Minification keeps both, so they identify
 * the same code in a later build. Names shorter than 3 characters are left out: webpack export keys
 * are minified. Runs in the page too, so it uses nothing from outside.
 */
export function fingerprint(source: string) {
  const strings = new Set<string>(), names = new Set<string>();
  // shortcut: a template literal counts as one string, `${…}` included; parse it if a matcher needs the parts.
  const code = source.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (s) => {
    strings.add(s.slice(1, -1).slice(0, 200));
    return '""';
  });
  for (const m of code.matchAll(/\.([A-Za-z_$][\w$]{2,})|[{,]([A-Za-z_$][\w$]{2,}):/g)) names.add(m[1] ?? m[2]);
  return { strings: [...strings].sort(), names: [...names].sort() };
}

const PROBE = (files: string[]) => `(async (files, manifest) => {
  window.__stubInert = true;
  const out = { boot: {}, files: {}, loader: {}, extras: Object.fromEntries(Object.keys(manifest.components).map((name) => [name, "unavailable"])), snapshot: {} };
  let W;
  try { W = await import("/probe/webpack.js"); } catch (e) { out.boot.webpack = "threw: " + e; return out; }
  ${GLOBALS}
  // Finder results are recorded by identity, so it does not matter how a finder searched.
  const fingerprint = ${fingerprint};
  const where = new Map(), moduleIds = new Map();
  for (const [id, m] of W.modules) {
    if (!m || (typeof m !== "object" && typeof m !== "function")) continue;
    moduleIds.set(m, id);
    for (const k of Object.keys(m)) {
      let v; try { v = m[k]; } catch { continue; }
      if (v && (typeof v === "object" || typeof v === "function")) { if (!where.has(v)) where.set(v, []); where.get(v).push(id + ":" + k); }
    }
  }
  const keysOf = (v) => {
    const keys = new Set();
    for (let o = v; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const k of Object.getOwnPropertyNames(o)) keys.add(k);
    keys.delete("constructor");
    return [...keys].sort();
  };
  const describe = (v) => {
    const f = v?.render ?? v?.type ?? v;
    if (typeof f !== "function") return { keys: keysOf(v) };
    const d = fingerprint(Function.prototype.toString.call(f));
    const methods = f.prototype ? Object.getOwnPropertyNames(f.prototype).filter((k) => k !== "constructor").sort() : [];
    return methods.length ? { ...d, methods } : d;
  };
  // Library-made objects (helpers, wrappers) are not Steam exports and are left out.
  const record = (name, v) => {
    if (!v || (typeof v !== "object" && typeof v !== "function")) return;
    const at = where.get(v) ?? (moduleIds.has(v) ? [moduleIds.get(v)] : null);
    if (!at) return;
    try { out.snapshot[name] = { at, ...describe(v) }; } catch (e) { out.snapshot[name] = { at, error: String(e).slice(0, 200) }; }
  };
  const matchExtras = ${matchExtras};
  for (const [name, matches] of Object.entries(matchExtras(W.modules, manifest))) {
    out.extras[name] = matches.length;
    if (matches.length === 1) record("extras:" + name, matches[0]);
  }
  for (const k of ["SP_REACT", "SP_REACTDOM", "SP_JSX"]) out.boot[k] = !!window[k];
  for (const k of ["CommonUIModule", "IconsModule", "ReactRouter"]) { out.boot[k] = W[k] != null; record(k, W[k]); }
  for (const f of files) {
    try {
      const m = await import("/probe/" + f);
      const missing = Object.entries(m).filter(([, v]) => v == null).map(([k]) => k);
      out.files[f] = missing.length ? "missing: " + missing.join(", ") : "ok";
      for (const [k, v] of Object.entries(m)) record(f + ":" + k, v);
    } catch (e) { out.files[f] = "threw: " + String(e).slice(0, 200); }
  }
  // decky-loader frontend/src predicates that run without a rendered Gaming Mode tree.
  const check = (name, fn) => {
    try { const v = fn(); out.loader[name] = v ? "ok" : "missing"; record(name, v); } catch (e) { out.loader[name] = "threw: " + e; }
  };
  const store = /^\\(\\)=>\\([\\w$]+\\|\\|(?:[\\w$]+\\(|\\([\\w$]+=)new [\\w$]+\\),[\\w$]+\\)$/;
  const backstack = () => W.findModuleByExport((e) => typeof e == "string" && e == "router-backstack", 20);
  const qam = () => W.findModuleByExport((e) => e?.type?.toString?.()?.includes("QuickAccessMenuBrowserView"));
  check("errorboundary-hook: error reporting store", () => W.findModuleExport((e) => typeof e == "function" && e?.toString && store.test(e.toString())));
  check("router-hook: Route", () => Object.values(backstack()).find((e) => typeof e == "function" && (/routePath:[\\w$]+\\.match\\?\\.path./.test(e.toString()) || /routePath:null===\\(.=.\\.match\\)/.test(e.toString()))));
  check("tabs-hook: QAM renderer", () => Object.values(qam()).find((e) => e?.type?.toString?.()?.includes("QuickAccessMenuBrowserView")));
  check("toaster: Valve toast renderer", () => W.findModuleExport((e) => e?.toString?.()?.includes('controller:"notification",method:')));
  check("toaster: NotificationStore removal methods", () => typeof window.NotificationStore?.RemoveGroupFromTray === "function"
    && typeof window.NotificationStore?.RemoveFromToastsWhere === "function");
  // library.ts needs a set m_history, which only the Gaming Mode router sets; check the store's shape.
  check("filepicker: history store", () => W.findModuleExport((e) => typeof e == "object" && "m_history" in e && "m_navigator" in e && "m_locationPathname" in e));
  check("DropdownMultiselect: classes", () => W.findModule((m) => m?.DropDownControlButton && m?.["duration-app-launch"]));
  check("Store: TabCount", () => W.findModule((m) => m?.TabCount && m?.TabTitle));
  // @decky/ui finders whose result is private, so a failure leaves no null export.
  // components/Modal.js: showModal is always a function; it calls the private showModalRaw.
  check("@decky/ui Modal.js: showModalRaw", () => W.findModuleExport((e) => typeof e === "function" && e.toString?.().includes("props.bDisableBackgroundDismiss") && !e?.prototype?.Cancel));
  out.boot.modules = W.modules.size;
  return out;
})(${JSON.stringify(files)}, ${JSON.stringify(extras)})`;

export async function fetchBundle(branch: string, dir: string) {
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

/** Bundle @decky/ui into ROOT/probe: webpack.js, the files PROBE checks, and `extra` entry files. */
export async function buildProbe(root: string, work: string, uiPackage = args["decky-ui"]!, extra: string[] = []) {
  const ui = join(uiPackage, "dist");
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
    entrypoints: ["webpack.js", ...files, ...extra].map((f) => join(ui, f)),
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
type ProbeResult = {
  boot: Record<string, boolean | number | string>;
  files: Record<string, string>;
  loader: Record<string, string>;
  extras: Record<string, number | string>;
  snapshot: Record<string, { at: string[]; [key: string]: unknown }>;
  factories?: Record<string, string>;
};

/** A CDP connection. `send`'s T is the protocol's result shape for `method`; it is not checked. */
export interface CdpClient {
  send<T = Record<string, unknown>>(method: string, params?: object, sessionId?: string): Promise<T>;
  close(): void;
}

/** A booted Steam page: `evaluate` runs an expression (awaited, returned by value); `close` stops Chrome and the server. */
export interface SteamPage {
  evaluate<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}

/** CDP client. A call rejects when the connection fails or closes, or after `timeoutMs` without a reply. */
export function cdp(url: string, timeoutMs = CDP_TIMEOUT_MS): CdpClient {
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

/**
 * Serve the extracted bundle at ROOT, open its page in headless Chrome with the stand-in `SteamClient`,
 * and wait for Steam's app to boot. `evaluate` runs an expression in the page (awaited, returned by value).
 */
export async function openSteamPage(root: string, work: string, chrome = args.chrome!): Promise<SteamPage> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = Bun.file(join(root, path));
    if (!path.includes("..") && await file.exists()) return new Response(file);
    // SharedJSContext runs at /routes/...; the app is a single page.
    return path.startsWith("/routes/") ? new Response(Bun.file(join(root, "index.html"))) : new Response(null, { status: 404 });
  } });
  const proc = Bun.spawn([chrome, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(work, "profile")}`,
    "--no-first-run", "--no-default-browser-check", "about:blank"], { stderr: "pipe", stdout: "ignore" });
  let browser: CdpClient | undefined;
  const close = async () => {
    browser?.close();
    proc.kill();
    await proc.exited;
    server.stop(true);
  };
  try {
    let log = "";
    const reader = proc.stderr.getReader();
    while (!/DevTools listening on (ws:\S+)/.test(log)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`Chrome exited before DevTools was ready:\n${log}`);
      log += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    browser = cdp(log.match(/DevTools listening on (ws:\S+)/)![1]);
    const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await browser.send("Page.enable", {}, sessionId);
    await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB }, sessionId);
    await browser.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/routes/library/home/` }, sessionId);
    await Bun.sleep(BOOT_MS);
    const page = browser;
    const evaluate = async <T>(expression: string): Promise<T> => {
      const { result, exceptionDetails } = await page.send<{ result: { value: T }; exceptionDetails?: unknown }>(
        "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (exceptionDetails) throw new Error(`page evaluation failed: ${JSON.stringify(exceptionDetails).slice(0, 500)}`);
      return result.value;
    };
    return { evaluate, close };
  } catch (e) {
    await close();
    throw e;
  }
}

async function probe(root: string, files: string[], work: string) {
  const page = await openSteamPage(root, work);
  try {
    const out = await page.evaluate<ProbeResult>(PROBE(files));
    if (args["props-dir"] && Object.values(out.extras).every((count) => count === 1)) {
      out.factories = await page.evaluate<Record<string, string>>(`(() => {
        let require;
        window.webpackChunksteamui.push([[Symbol("prop-surface")], {}, (r) => { require = r; }]);
        return Object.fromEntries(Object.entries(require.m).map(([id, factory]) => [id, Function.prototype.toString.call(factory)]));
      })()`);
    }
    return out;
  } finally {
    await page.close();
  }
}

function failures(label: string, out: ProbeResult) {
  const bad = [...Object.entries(out.boot), ...Object.entries(out.files), ...Object.entries(out.loader)]
    .filter(([k, v]) => k !== "modules" && v !== true && v !== "ok")
    .map(([k, v]) => `${k}: ${v === false ? "missing" : v}`);
  const extraResults = Object.entries(out.extras);
  bad.push(...extraResults.filter(([, count]) => count !== 1)
    .map(([name, count]) => `extras:${name}: ${typeof count === "number" ? `${count} matches` : count}`));
  console.log(`${label}: ${out.boot.modules ?? 0} modules; ${bad.length ? bad.length + " failing" : "all finders ok"}`);
  for (const [name, count] of extraResults) console.log(`  extras:${name}: ${typeof count === "number" ? `${count} matches` : count}`);
  for (const line of bad.filter((line) => !line.startsWith("extras:"))) console.log(`  ${line}`);
  return bad;
}

async function writeReport(name: string, label: string, ui: string, bad: string[]) {
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
    if (args["snapshot-dir"]) await mkdir(args["snapshot-dir"], { recursive: true });
    if (args["props-dir"]) await mkdir(args["props-dir"], { recursive: true });
    const ui = (await Bun.file(join(args["decky-ui"]!, "package.json")).json()).version;
    for (const { label, root, report } of bundles) {
      const files = await buildProbe(root, work);
      const out = await probe(root, files, work);
      const bad = failures(label, out);
      if (args["report-dir"]) await (bad.length ? writeReport(report, label, ui, bad) : Bun.write(join(args["report-dir"], `${report}.ok`), ""));
      // Only a clean run is a baseline: the workflow keeps the first file per version forever, so a
      // partial snapshot would hide the good one a later run makes. A broken build falls back to an older snapshot.
      if (args["snapshot-dir"] && bad.length === 0) {
        const snapshot = { client: label, decky_ui: ui, modules: out.boot.modules, finders: out.snapshot };
        await Bun.write(join(args["snapshot-dir"], `${report}.decky-ui-${ui}.json`), JSON.stringify(snapshot, null, 2) + "\n");
      }
      if (args["props-dir"] && out.factories) {
        const entries = Object.fromEntries(Object.keys(extras.components).map((name) => {
          const at = out.snapshot["extras:" + name]?.at;
          if (!at?.length) throw new Error(`${label}: ${name} has no exported identity for prop analysis`);
          return [name, at];
        }));
        const surfaces = analyzeProps(out.factories, entries);
        const [branch, version] = report === "local" ? ["local", "0"] : report.split("-");
        const components = Object.fromEntries(Object.entries(surfaces).map(([name, surface]) => [name, { at: entries[name], ...surface }]));
        await Bun.write(join(args["props-dir"], `${branch}-${version}.json`), JSON.stringify({
          schema: 1, branch, version, revision: extras.revision, components,
        }, null, 2) + "\n");
        console.log(`${label}: prop surfaces recorded for ${Object.keys(components).length} extras`);
      }
      ok &&= bad.length === 0;
    }
  } finally {
    if (args.keep) console.log(`kept ${work}`); else await rm(work, { recursive: true, force: true });
  }
  process.exit(ok || args["report-dir"] ? 0 : 1);
}
