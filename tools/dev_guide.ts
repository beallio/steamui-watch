#!/usr/bin/env bun
/**
 * Generate the Steam Deck Beta (Vite/Rolldown) Semantic Developer Guide.
 *
 *   bun tools/dev_guide.ts --mapping-data DIR --out-dir DIR
 *     [--beta-bundle-dir DIR] [--beta-version VER]
 *     [--webpack-bundle-dir DIR] [--webpack-version VER]
 *     [--webpack-baseline FILE] [--save-webpack-baseline FILE]
 *     [--decky-ui-webpack DIR] [--decky-ui-esm DIR] [--chrome PATH]
 *     [--single-file FILE] [--keep]
 *
 * Outputs strict metadata-only `index.html` + `data.json` (zero raw Valve JS bodies,
 * zero verbatim CSS declarations, zero SVGs) styled with Valve's Steam Deck / SteamUI color guide.
 */
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import extrasData from "../packages/decky-extras/extras.json";
import { matchExtras, parseManifest } from "../packages/decky-extras/match";
import { CANDIDATES, ENTRIES, selectorUsesClass } from "./decky_catalog";
import {
  analyzeViteChunkAst,
  buildCssIndex,
  buildGuideData,
  extractCssClassesFromStylesheets,
  iconRows,
  isViteHash,
  matchWebpackToVite,
  type CapturedPreviews,
  type ChunkAstAnalysis,
  type VerifiedRuntimeEntry,
  type ViteRuntimeExport,
  type WebpackExportRecord,
} from "./dev_guide_extract";
import { renderGuideHtml } from "./dev_guide_html";
import {
  validatePublicGuideData,
  type ExportKind,
  type IconEntry,
  type SourcePackage,
} from "./dev_guide_schema";
import { validatePublishedIcons } from "./icons_report";
import { BOOT, buildProbe, fetchBundle, fingerprint, isViteHtml, openSteamPage } from "./runtime_probe";

const repo = resolve(import.meta.dir, "..");
const extras = parseManifest(extrasData);

export interface WebpackBaselineFile {
  schemaVersion: 1;
  branch: string;
  version: string;
  verifiedAt: Record<string, string[]>;
  iconsAt: Record<string, string[]>;
  exports: WebpackExportRecord[];
}

export function isViteDump(dump: Record<string, Record<string, string>>): boolean {
  let hits = 0;
  let checked = 0;
  for (const entries of Object.values(dump)) {
    for (const val of Object.values(entries)) {
      if (typeof val !== "string" || !val || val.includes(" ") || /^\d/.test(val)) continue;
      checked++;
      if (isViteHash(val)) hits++;
      if (checked >= 100) break;
    }
    if (checked >= 100) break;
  }
  return checked > 0 && hits / checked >= 0.5;
}

export async function loadMappingDataFiles(
  mappingDir: string,
  preferredBetaVersion?: string,
  preferredWebpackVersion?: string,
): Promise<{
  betaVersion: string;
  webpackVersion: string;
  betaDump: Record<string, Record<string, string>>;
  webpackDump: Record<string, Record<string, string>>;
  betaChains: Record<string, string[]>;
  idToName: Record<string, string>;
  plainLiterals: string[];
}> {
  const webpackDir = join(mappingDir, "webpack");
  const files = (await readdir(webpackDir)).filter((f) => f.endsWith(".json")).sort();
  const betaFiles = files.filter((f) => f.endsWith(".beta.json"));
  const stableFiles = files.filter((f) => f.endsWith(".stable.json"));

  const pickFile = (list: string[], preferred?: string) => {
    if (preferred) {
      const exact = list.find((f) => f.startsWith(`${preferred}.`));
      if (exact) return exact;
    }
    return list[list.length - 1];
  };

  const betaFile = pickFile(betaFiles, preferredBetaVersion);
  if (!betaFile) throw new Error(`No *.beta.json dump found in ${webpackDir}`);
  const betaVersion = betaFile.split(".")[0];
  const betaDump = await Bun.file(join(webpackDir, betaFile)).json();

  // Pick newest pre-Vite Webpack dump (stable preferred, fallback to beta before Vite)
  let webpackFile = pickFile(stableFiles, preferredWebpackVersion);
  let webpackDump: Record<string, Record<string, string>> = {};
  let webpackVersion = preferredWebpackVersion ?? "unknown";
  const candidates = webpackFile
    ? [webpackFile, ...stableFiles.filter((f) => f !== webpackFile).reverse(), ...betaFiles.slice().reverse()]
    : [...betaFiles.slice().reverse()];

  for (const cand of candidates) {
    const parsed = await Bun.file(join(webpackDir, cand)).json();
    if (!isViteDump(parsed)) {
      webpackFile = cand;
      webpackVersion = cand.split(".")[0];
      webpackDump = parsed;
      break;
    }
  }

  const readJsonIfExists = async <T>(p: string, fallback: T): Promise<T> => {
    const f = Bun.file(p);
    return (await f.exists()) ? await f.json() : fallback;
  };

  const betaChains = await readJsonIfExists<Record<string, string[]>>(join(mappingDir, "beta.json"), {});
  const idToName = await readJsonIfExists<Record<string, string>>(join(mappingDir, "id_to_name.json"), {});
  const plainLiterals = await readJsonIfExists<string[]>(join(mappingDir, "webpack-literals", `${betaVersion}.beta.json`), []);

  return { betaVersion, webpackVersion, betaDump, webpackDump, betaChains, idToName, plainLiterals };
}

interface PageRuntimeCollection {
  moduleCount: number;
  verified: Record<string, {
    at: string[];
    sourcePackage: SourcePackage;
    kind: ExportKind;
    strings: string[];
    names: string[];
    methods: string[];
    keys: string[];
  }>;
  icons: { name: string; at: string[]; directional: boolean }[];
  exports: Array<{
    at: string[];
    kind: ExportKind;
    strings: string[];
    names: string[];
    methods: string[];
    keys: string[];
  }>;
}

function buildRuntimeCollectorScript(files: string[], isVite: boolean): string {
  return `(async (files, manifest, isVite) => {
    window.__stubInert = true;
    ${BOOT(isVite)}
    const fingerprint = ${fingerprint};
    const JSX_HINT = /\\b(?:jsx|jsxs|jsxDEV|createElement)\\s*\\(/;
    const VITE_HASH = /^_?[A-Za-z0-9_-]{11}-$/;

    const where = new Map();
    const moduleIds = new Map();
    for (const [id, m] of W.scan) {
      if (!m || (typeof m !== "object" && typeof m !== "function")) continue;
      moduleIds.set(m, id);
      for (const k of Object.keys(m)) {
        let v;
        try { v = m[k]; } catch { continue; }
        if (!v || v === window || v === document || (typeof v !== "object" && typeof v !== "function")) continue;
        if (!where.has(v)) where.set(v, []);
        const loc = id + ":" + k;
        if (!where.get(v).includes(loc)) where.get(v).push(loc);
      }
    }

    const keysOf = (v) => {
      const keys = new Set();
      for (let o = v; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        for (const k of Object.getOwnPropertyNames(o)) {
          if (k !== "constructor" && !k.startsWith("__")) keys.add(k);
        }
      }
      return [...keys].sort();
    };

    const classifyAndDescribe = (v) => {
      const isReactWrapped = !!(v && typeof v === "object" && v.$$typeof);
      const f = v?.render ?? v?.type ?? v;
      if (typeof f === "function") {
        let src = "";
        try { src = Function.prototype.toString.call(f); } catch {}
        const fp = fingerprint(src);
        const methods = f.prototype
          ? Object.getOwnPropertyNames(f.prototype).filter((k) => k !== "constructor").sort()
          : [];
        const isComp = isReactWrapped
          || Boolean(f.prototype?.isReactComponent)
          || methods.includes("render")
          || JSX_HINT.test(src);
        const isStoreClass = !isComp && (fp.names.filter((n) => n.startsWith("m_")).length >= 2);
        const kind = isStoreClass ? "store" : (isComp ? "component" : "helper");
        return { kind, strings: fp.strings, names: fp.names, methods, keys: [] };
      }
      const keys = keysOf(v);
      const mFields = keys.filter((k) => k.startsWith("m_"));
      const kind = mFields.length >= 2 ? "store" : "helper";
      return { kind, strings: [], names: [], methods: [], keys };
    };

    const verified = {};
    const recordVerified = (label, sourcePackage, v) => {
      if (!v || (typeof v !== "object" && typeof v !== "function")) return;
      const at = where.get(v) ?? (moduleIds.has(v) ? [moduleIds.get(v)] : null);
      if (!at || !at.length) return;
      try {
        const desc = classifyAndDescribe(v);
        verified[label] = { at, sourcePackage, ...desc };
      } catch {}
    };

    for (const k of ["CommonUIModule", "IconsModule", "ReactRouter"]) {
      if (C[k]) recordVerified(k, "@decky/ui", C[k]);
    }
    for (const f of files) {
      try {
        const m = await import("/probe/" + f);
        for (const [k, v] of Object.entries(m)) {
          recordVerified(f + ":" + k, "@decky/ui", v);
        }
      } catch {}
    }

    // decky-extras
    try {
      const matchExtras = ${matchExtras};
      for (const [name, matches] of Object.entries(matchExtras(W.scan, manifest))) {
        if (matches.length === 1) recordVerified("extras:" + name, "@beallio/decky-extras", matches[0]);
      }
    } catch {}

    // decky-loader finders
    const tryCheck = (label, fn) => {
      try { const v = fn(); if (v) recordVerified(label, "decky-loader", v); } catch {}
    };
    const storeRx = /^\\(\\)=>\\([\\w$]+(?:\\|\\|=|\\|\\|(?:[\\w$]+\\(|\\([\\w$]+=))new [\\w$]+\\)?,[\\w$]+\\)$/;
    const backstack = () => W.findModuleByExport((e) => typeof e == "string" && e == "router-backstack", 20);
    const qam = () => W.findModuleByExport((e) => e?.type?.toString?.()?.includes("QuickAccessMenuBrowserView"));
    tryCheck("loader:ErrorReportingStore", () => W.findModuleExport((e) => typeof e == "function" && e?.toString && storeRx.test(e.toString())));
    tryCheck("loader:RouterRoute", () => Object.values(backstack() || {}).find((e) => typeof e == "function" && (/routePath:[\\w$]+\\.match\\?\\.path./.test(e.toString()) || /routePath:null===\\(.=.\\.match\\)/.test(e.toString()))));
    tryCheck("loader:QuickAccessMenuRenderer", () => Object.values(qam() || {}).find((e) => e?.type?.toString?.()?.includes("QuickAccessMenuBrowserView")));
    tryCheck("loader:ToastRenderer", () => W.findModuleExport((e) => e?.toString?.()?.includes('controller:"notification",method:')));
    tryCheck("loader:HistoryStore", () => W.findModuleExport((e) => typeof e == "object" && "m_history" in e && "m_navigator" in e && "m_locationPathname" in e));
    tryCheck("components/Modal.js:showModalRaw", () => W.findModuleExport((e) => typeof e === "function" && e.toString?.().includes("props.bDisableBackgroundDismiss") && !e?.prototype?.Cancel));

    // IconsModule
    const iconObjs = new Set();
    const icons = [];
    const iconsMod = C.IconsModule ?? {};
    for (const name of Object.keys(iconsMod).sort()) {
      const v = iconsMod[name];
      if (!v) continue;
      iconObjs.add(v);
      let src = "";
      try { src = Function.prototype.toString.call(v?.render ?? v?.type ?? v); } catch {}
      const directional = /direction:[\\w$]+/.test(src) && /case["'\`]up["'\`]/.test(src);
      icons.push({ name, at: where.get(v) ?? [], directional });
    }

    // Collect every distinct component, store, and meaningful helper export across SteamUI
    const exportsOut = [];
    for (const [v, at] of where) {
      if (iconObjs.has(v)) continue;
      if (v === window.SP_REACT || v === window.SP_REACTDOM || v === window.SP_JSX) continue;
      try {
        const desc = classifyAndDescribe(v);
        // Skip plain CSS class bags, protobuf generated message classes, and trivial private helpers
        if (desc.kind === "helper" && typeof v === "object" && !v.$$typeof) {
          const vals = Object.values(v);
          if (vals.length === 0 || vals.every((x) => typeof x === "string" || typeof x === "number")) continue;
          if (desc.keys.length < 3) continue;
        }
        if (desc.kind === "helper" && typeof v === "function") {
          if (desc.methods.includes("serializeBinary") || desc.methods.includes("toObject")) continue;
          const hasCss = desc.strings.some((s) => VITE_HASH.test(s));
          const hasSteamClient = desc.names.includes("SteamClient");
          const hasStrongString = desc.strings.some((s) => s.length >= 8 && !s.startsWith("http"));
          if (!hasCss && !hasSteamClient && !hasStrongString) continue;
        }
        exportsOut.push({ at, ...desc });
      } catch {}
    }

    return {
      moduleCount: W.scan.size,
      verified,
      icons,
      exports: exportsOut,
    };
  })(${JSON.stringify(files)}, ${JSON.stringify(extras)}, ${JSON.stringify(isVite)})`;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

/**
 * Inline ephemeral `http://127.0.0.1:<port>/...` or relative `/images/...` asset URLs
 * inside captured preview HTML/CSS as base64 `data:` URIs so offline previews (like SteamSpinner) render cleanly.
 */
export async function inlineLocalPreviewAssets(
  previews: CapturedPreviews,
  bundleRoot: string,
): Promise<CapturedPreviews> {
  const cache = new Map<string, string | null>();
  const toDataUri = async (rawUrl: string): Promise<string | null> => {
    const clean = rawUrl.trim().replace(/^['"]|['"]$/g, "");
    if (!clean || clean.startsWith("data:")) return null;
    let rel = clean;
    const localMatch = clean.match(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/(.+)$/i);
    if (localMatch) {
      rel = localMatch[1];
    } else if (clean.startsWith("/")) {
      rel = clean.slice(1);
    } else if (clean.startsWith("../")) {
      rel = clean.replace(/^(?:\.\.\/)+/, "");
    } else {
      return null;
    }
    rel = decodeURIComponent(rel.split(/[?#]/)[0]);
    if (rel.includes("..")) return null;
    if (cache.has(rel)) return cache.get(rel)!;
    const file = Bun.file(join(bundleRoot, rel));
    if (!(await file.exists())) {
      cache.set(rel, null);
      return null;
    }
    const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const uri = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    cache.set(rel, uri);
    return uri;
  };

  const replaceHtml = async (html: string): Promise<string> => {
    const matches = [...html.matchAll(/\b(src|href)="([^"]+)"/g)];
    let out = html;
    for (const m of matches) {
      const uri = await toDataUri(m[2]);
      if (uri) out = out.replaceAll(m[0], `${m[1]}="${uri}"`);
    }
    return out;
  };

  const replaceCssUrls = async (css: string): Promise<string> => {
    const matches = [...css.matchAll(/url\(([^)]+)\)/g)];
    let out = css;
    for (const m of matches) {
      const uri = await toDataUri(m[1]);
      if (uri) out = out.replaceAll(m[0], `url("${uri}")`);
    }
    return out;
  };

  const components: CapturedPreviews["components"] = {};
  for (const [k, v] of Object.entries(previews.components)) {
    components[k] = { ...v, html: v.html ? await replaceHtml(v.html) : v.html };
  }
  const icons: CapturedPreviews["icons"] = {};
  for (const [k, v] of Object.entries(previews.icons)) {
    icons[k] = await replaceHtml(v);
  }
  const css = await replaceCssUrls(previews.css);
  return { components, icons, css };
}

/**
 * Scope Steam Deck Gaming Mode root selectors (`html.GamepadMode`, `html.responsive`, `body`)
 * onto `.preview-stage` so Gaming Mode styling applies accurately inside preview cards without affecting guide chrome.
 */
export function scopePreviewCssForGamepadMode(css: string): string {
  return css
    .replace(/\bhtml((?:\.[A-Za-z0-9_-]+)+)(?=[\s>+~:{,])/g, ".preview-stage$1")
    .replace(/\bbody((?:\.[A-Za-z0-9_-]+)+)(?=[\s>+~:{,])/g, ".preview-stage$1");
}

function buildPreviewCollectorScript(isVite: boolean): string {
  return `(async (entries, candidates, manifest) => {
    const w = window;
    w.__stubInert = true;
    document.documentElement.classList.add("GamepadMode", "responsive");
    document.body.classList.add("GamepadMode", "BasicUI");
    ${BOOT(isVite)}
    const L = await import("/probe/index.js");
    const R = w.SP_REACT, D = w.SP_REACTDOM;
    if (!R || !D) return { components: {}, icons: {}, css: "" };

    const src = (v) => {
      const f = v?.render ?? v?.type ?? v;
      try { return typeof f === "function" ? Function.prototype.toString.call(f) : ""; } catch { return ""; }
    };
    const where = new Map();
    for (const [id, m] of W.scan) {
      if (!m || (typeof m !== "object" && typeof m !== "function")) continue;
      for (const k of Object.keys(m)) {
        let v; try { v = m[k]; } catch { continue; }
        if (v && (typeof v === "object" || typeof v === "function")) {
          if (!where.has(v)) where.set(v, []);
          where.get(v).push(id + ":" + k);
        }
      }
    }
    const findAll = (test) => [...where.keys()].filter((v) => { const s = src(v); return s !== "" && test(s); });
    const one = (test) => { const all = findAll(test); return all.length === 1 ? all[0] : all[0]; };
    const createRoot = D.createRoot
      ?? W.findModule((m) => typeof m?.createRoot === "function" && Object.keys(m).length === 1)?.createRoot
      ?? W.findModule((m) => typeof m?.createRoot === "function")?.createRoot;
    if (typeof createRoot !== "function") return { components: {}, icons: {}, css: "" };

    const provider = Object.values(C.CommonUIModule ?? {}).find((v) => typeof v === "function" && /SliderField:/.test(src(v)) && /\\.Provider/.test(src(v)))
      ?? [...where.keys()].find((v) => typeof v === "function" && /SliderField:/.test(src(v)) && /\\.Provider/.test(src(v)));
    const Router = Object.values(C.ReactRouter ?? {}).find((v) => /history\\.location/.test(src(v)) && /_isMounted/.test(src(v)));
    const memoryHistory = one((s) => s.includes("initialEntries") && s.includes("getUserConfirmation"));
    const QueryProvider = one((s) => s.length < 600 && s.includes("client:") && s.includes(".mount()"));
    const QueryClient = one((s) => s.startsWith("class") && s.includes("getQueryCache(){"));

    const h = R.createElement;
    const withRouter = (el) => (Router && memoryHistory ? h(Router, { history: memoryHistory({ initialEntries: ["/"] }) }, el) : el);
    const withQuery = (el) => (QueryProvider && QueryClient ? h(QueryProvider, { client: new QueryClient() }, el) : el);
    const on = () => () => {};
    const Stateful = ({ initial, render }) => {
      const [value, setValue] = R.useState(initial);
      return render(value, (...args) => setValue(args[0]?.target ? args[0].target.value : args[0]));
    };
    const S = (_name, initial, render) => h(Stateful, { initial, render });
    class Boundary extends R.Component {
      state = { e: null };
      static getDerivedStateFromError(e) { return { e }; }
      render() { return this.state.e ? h("pre", { "data-error": "" }, String(this.state.e?.message ?? this.state.e)) : this.props.children; }
    }

    const matchExtras = ${matchExtras};
    const found = matchExtras(W.scan, manifest);
    const K = {};
    for (const c of candidates) {
      const all = found[c.id] ?? [];
      if (all.length === 1) K[c.id] = all[0];
    }

    const wrap = (el) => h(Boundary, null, provider ? h(provider, null, el) : el);
    const run = (make, C) => () => new Function("h", "L", "K", "C", "withRouter", "withQuery", "S", "on", "return " + make)(h, L, K, C, withRouter, withQuery, S, on);

    const draw = async (make, width) => {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;width:" + width + "px";
      document.body.appendChild(host);
      const root = createRoot(host);
      const quiet = console.error; console.error = () => {};
      let error = null;
      try { D.flushSync(() => root.render(wrap(make()))); }
      catch (e) { error = String(e).slice(0, 300); }
      await new Promise((r) => setTimeout(r, 40));
      console.error = quiet;
      const html = host.innerHTML;
      root.unmount(); host.remove();
      const caught = html.match(/<pre data-error="">([\\s\\S]*?)<\\/pre>/)?.[1];
      return { html, width, error: error ?? (caught === undefined ? null : caught.slice(0, 300)) };
    };

    const components = {};
    for (const e of entries) {
      if (e.skip || !e.make) {
        if (e.skip) components[e.name] = { html: "", width: e.width ?? 360, note: e.skip, error: null };
        continue;
      }
      const r = await draw(run(e.make), e.width ?? 360);
      components[e.name] = { ...r, ...(e.note ? { note: e.note } : {}) };
    }
    for (const c of candidates) {
      if (!c.make || !K[c.id]) continue;
      const r = await draw(run(c.make, K[c.id]), c.width ?? 360);
      components[c.id] = r;
    }

    const icons = {};
    const iconsMod = C.IconsModule ?? {};
    for (const name of Object.keys(iconsMod).sort()) {
      const fn = iconsMod[name];
      if (!fn) continue;
      const directional = /direction:[\\w$]+/.test(src(fn)) && /case["'\`]up["'\`]/.test(src(fn));
      const r = await draw(() => R.createElement(fn, directional ? { direction: "right" } : null), 48);
      if (!r.error && r.html.includes("<svg")) icons[name] = r.html;
    }

    // Collect minimal Steam CSS rules that match rendered class names + :root CSS variables + referenced @keyframes
    const uses = ${selectorUsesClass};
    const used = new Set();
    const allHtml = Object.values(components).map((r) => r.html).join("") + Object.values(icons).join("");
    for (const m of allHtml.matchAll(/class="([^"]*)"/g)) {
      for (const cls of m[1].split(/\\s+/)) if (cls) used.add(cls);
    }
    const animations = new Set();
    const keep = (rules) => [...rules].flatMap((r) => {
      if (r instanceof CSSStyleRule) {
        const isRootVars = /^:root\\b/.test(r.selectorText) && r.style.cssText.includes("--");
        if (!uses(r.selectorText, used) && !isRootVars) return [];
        for (const a of (r.style.animationName || "").split(/[\\s,]+/)) if (a) animations.add(a);
        return [r.cssText];
      }
      if (r instanceof CSSMediaRule || r instanceof CSSSupportsRule) {
        const inner = keep(r.cssRules);
        return inner.length ? ["@" + (r instanceof CSSMediaRule ? "media" : "supports") + " " + r.conditionText + "{" + inner.join("\\n") + "}"] : [];
      }
      return [];
    });
    const sheets = [...document.styleSheets];
    const cssRules = sheets.flatMap((s) => { try { return keep(s.cssRules); } catch { return []; } });
    const frames = sheets.flatMap((s) => {
      try {
        return [...s.cssRules].filter((r) => r instanceof CSSKeyframesRule && animations.has(r.name)).map((r) => r.cssText);
      } catch { return []; }
    });
    return { components, icons, css: [...cssRules, ...frames].join("\\n") };
  })(${JSON.stringify(ENTRIES)}, ${JSON.stringify(CANDIDATES)}, ${JSON.stringify(extras)})`;
}

async function runBundleRuntimeProbe(opts: {
  root: string;
  work: string;
  uiWebpackPackage: string;
  uiEsmPackage: string;
  chrome: string;
  withPreviews?: boolean;
}): Promise<{ isVite: boolean; data: PageRuntimeCollection; previews?: CapturedPreviews }> {
  const isVite = isViteHtml(await Bun.file(join(opts.root, "index.html")).text());
  const uiPackage = isVite ? opts.uiEsmPackage : opts.uiWebpackPackage;
  const files = await buildProbe(opts.root, opts.work, uiPackage, isVite, opts.withPreviews ? ["index.js"] : []);
  const page = await openSteamPage(opts.root, opts.work, opts.chrome);
  try {
    const data = await page.evaluate<PageRuntimeCollection>(buildRuntimeCollectorScript(files, page.isVite));
    let previews: CapturedPreviews | undefined;
    if (opts.withPreviews) {
      const rawPreviews = await page.evaluate<CapturedPreviews>(buildPreviewCollectorScript(page.isVite));
      const inlined = await inlineLocalPreviewAssets(rawPreviews, opts.root);
      previews = { ...inlined, css: scopePreviewCssForGamepadMode(inlined.css) };
    }
    return { isVite: page.isVite, data, previews };
  } finally {
    await page.close();
  }
}

async function scanBundleFiles(root: string): Promise<{
  jsChunks: Map<string, string>;
  cssTexts: string[];
}> {
  const jsChunks = new Map<string, string>();
  const cssTexts: string[] = [];

  for (const rel of new Bun.Glob("**/*.js").scanSync(root)) {
    const norm = rel.replace(/\\/g, "/");
    if (norm.startsWith("probe/")) continue;
    jsChunks.set(basename(norm), await Bun.file(join(root, rel)).text());
  }
  for (const rel of new Bun.Glob("**/*.css").scanSync(root)) {
    cssTexts.push(await Bun.file(join(root, rel)).text());
  }
  return { jsChunks, cssTexts };
}

function buildWebpackBaselineFromProbe(
  version: string,
  probe: PageRuntimeCollection,
  webpackCssKeys: Set<string>,
): WebpackBaselineFile {
  const verifiedAt: Record<string, string[]> = {};
  for (const [label, info] of Object.entries(probe.verified)) {
    verifiedAt[label] = info.at;
  }
  const iconsAt: Record<string, string[]> = {};
  for (const ic of probe.icons) {
    iconsAt[ic.name] = ic.at;
  }
  const exports: WebpackExportRecord[] = probe.exports.map((e) => ({
    at: e.at,
    kind: e.kind,
    strings: e.strings,
    names: e.names,
    methods: e.methods,
    keys: e.keys,
    cssKeys: e.names.filter((n) => webpackCssKeys.has(n)),
  }));

  return {
    schemaVersion: 1,
    branch: "stable",
    version,
    verifiedAt,
    iconsAt,
    exports,
  };
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "mapping-data": { type: "string" },
      "out-dir": { type: "string" },
      "single-file": { type: "string" },
      "beta-bundle-dir": { type: "string" },
      "beta-version": { type: "string" },
      "webpack-bundle-dir": { type: "string" },
      "webpack-version": { type: "string" },
      "webpack-baseline": { type: "string" },
      "icon-names": { type: "string" },
      "save-webpack-baseline": { type: "string" },
      "decky-ui-webpack": { type: "string", default: resolve(repo, "../decky-loader/frontend/node_modules/@decky/ui-legacy") },
      "decky-ui-esm": { type: "string", default: resolve(repo, "../decky-loader/frontend/node_modules/@decky/ui-v5") },
      chrome: { type: "string", default: process.env.CHROME ?? "google-chrome" },
      "with-previews": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
    },
  });

  if (!values["mapping-data"] || !values["out-dir"]) {
    console.error("Usage: bun tools/dev_guide.ts --mapping-data DIR --out-dir DIR [options]");
    process.exit(1);
  }

  const mappingDir = resolve(values["mapping-data"]);
  const outDir = resolve(values["out-dir"]);
  const scratchBase = process.env.TMPDIR || "/var/tmp/omp-1000";
  await mkdir(scratchBase, { recursive: true });
  const work = await mkdtemp(join(scratchBase, "dev-guide-"));

  try {
    // 1. Load mapping-data CSS dumps & chains
    console.log("Loading mapping-data CSS history...");
    const mapData = await loadMappingDataFiles(mappingDir, values["beta-version"], values["webpack-version"]);
    console.log(`  beta dump: ${mapData.betaVersion} (${Object.keys(mapData.betaDump).length} CSS modules)`);
    console.log(`  webpack dump: ${mapData.webpackVersion} (${Object.keys(mapData.webpackDump).length} CSS modules)`);

    // 2. Acquire and probe the Beta bundle, using the package for its detected format.
    let betaRoot: string;
    let betaVersion = values["beta-version"] ?? mapData.betaVersion;
    if (values["beta-bundle-dir"]) {
      betaRoot = resolve(values["beta-bundle-dir"]);
    } else {
      console.log("Downloading publicbeta bundle from Valve CDN...");
      const fetched = await fetchBundle("publicbeta", join(work, "beta-bundle"));
      betaRoot = fetched.root;
      betaVersion = fetched.label.split(" ").pop() ?? betaVersion;
    }

    console.log("Scanning Beta stylesheets & Vite ESM chunks...");
    const { jsChunks, cssTexts } = await scanBundleFiles(betaRoot);
    const cssScan = extractCssClassesFromStylesheets(cssTexts);
    const cssIndex = buildCssIndex({
      betaDump: mapData.betaDump,
      webpackDump: mapData.webpackDump,
      betaChains: mapData.betaChains,
      idToName: mapData.idToName,
      plainLiterals: mapData.plainLiterals,
      cssScan,
    });
    console.log(`  stylesheets: ${cssScan.hashes.size} Vite class hashes, ${cssScan.keyframes.size} @keyframes`);
    console.log(`  CSS index: ${cssIndex.cssClasses.length} total (${cssIndex.cssClasses.filter((c) => c.confidence !== "unmatched").length} semantic, ${cssIndex.cssClasses.filter((c) => c.confidence === "unmatched").length} unmatched)`);

    console.log(`Parsing ${jsChunks.size} Vite JS chunks (single-pass AST)...`);
    const chunkAnalyses = new Map<string, ChunkAstAnalysis>();
    const allKnownHashes = new Set([...cssScan.hashes, ...cssIndex.hashToClassId.keys()]);
    for (const [chunkName, src] of jsChunks) {
      chunkAnalyses.set(chunkName, analyzeViteChunkAst(chunkName, src, allKnownHashes));
    }

    console.log("Booting Beta Vite bundle in headless Chrome...");
    const withPreviews = Boolean(values["with-previews"]);
    const betaProbe = await runBundleRuntimeProbe({
      root: betaRoot,
      work: join(work, "beta-chrome"),
      uiWebpackPackage: resolve(values["decky-ui-webpack"]!),
      uiEsmPackage: resolve(values["decky-ui-esm"]!),
      chrome: values.chrome!,
      withPreviews,
    });
    console.log(`  Beta runtime: ${betaProbe.data.moduleCount} modules, ${Object.keys(betaProbe.data.verified).length} verified finders, ${betaProbe.data.exports.length} runtime exports, ${betaProbe.data.icons.length} icons`);
    if (betaProbe.previews) {
      const okComps = Object.values(betaProbe.previews.components).filter((c) => c.html && !c.error).length;
      console.log(`  Visual previews captured: ${okComps} components, ${Object.keys(betaProbe.previews.icons).length} SVG icons, ${Math.round(betaProbe.previews.css.length / 1024)} KB scoped Steam CSS`);
    }

    // 3. Load or generate Webpack baseline (1794536281)
    let webpackBaseline: WebpackBaselineFile;
    if (values["webpack-baseline"]) {
      console.log(`Loading cached Webpack baseline from ${values["webpack-baseline"]}...`);
      webpackBaseline = await Bun.file(resolve(values["webpack-baseline"])).json();
    } else {
      let wpRoot: string;
      let wpVersion = values["webpack-version"] ?? mapData.webpackVersion;
      if (values["webpack-bundle-dir"]) {
        wpRoot = resolve(values["webpack-bundle-dir"]);
      } else {
        console.log("Downloading stable (Webpack) bundle from Valve CDN...");
        const fetched = await fetchBundle("stable", join(work, "webpack-bundle"));
        wpRoot = fetched.root;
        wpVersion = fetched.label.split(" ").pop() ?? wpVersion;
      }
      console.log("Booting Webpack bundle in headless Chrome for dual-bundle baseline...");
      const wpProbe = await runBundleRuntimeProbe({
        root: wpRoot,
        work: join(work, "webpack-chrome"),
        uiWebpackPackage: resolve(values["decky-ui-webpack"]!),
        uiEsmPackage: resolve(values["decky-ui-esm"]!),
        chrome: values.chrome!,
      });
      const wpCssKeys = new Set<string>();
      for (const entries of Object.values(mapData.webpackDump)) {
        for (const k of Object.keys(entries)) wpCssKeys.add(k);
      }
      webpackBaseline = buildWebpackBaselineFromProbe(wpVersion, wpProbe.data, wpCssKeys);
      console.log(`  Webpack baseline (${wpVersion}): ${webpackBaseline.exports.length} exports, ${Object.keys(webpackBaseline.verifiedAt).length} verified`);
      if (values["save-webpack-baseline"]) {
        const dest = resolve(values["save-webpack-baseline"]);
        await mkdir(dirname(dest), { recursive: true });
        await Bun.write(dest, JSON.stringify(webpackBaseline));
        console.log(`  saved Webpack baseline to ${dest}`);
      }
    }

    // 4. Run dual-bundle Webpack -> Vite export matching
    console.log("Matching unnamed exports across Webpack -> Vite...");
    const viteRuntimeExports: ViteRuntimeExport[] = betaProbe.data.exports.map((e, i) => ({
      id: `rt:${i}:${e.at[0] ?? i}`,
      at: e.at,
      kind: e.kind,
      strings: e.strings,
      names: e.names,
      methods: e.methods,
      keys: e.keys,
      cssHashes: e.strings.filter(isViteHash),
    }));
    const webpackMatches = matchWebpackToVite(webpackBaseline.exports, viteRuntimeExports, cssIndex.hashToSemantic);
    console.log(`  matched ${webpackMatches.size} / ${viteRuntimeExports.length} runtime exports back to Webpack`);

    // 5. Merge verified runtime entries with Webpack baseline verified locations
    const verifiedRuntime: Record<string, VerifiedRuntimeEntry> = {};
    for (const [label, info] of Object.entries(betaProbe.data.verified)) {
      verifiedRuntime[label] = {
        at: info.at,
        sourcePackage: info.sourcePackage,
        kind: info.kind,
        webpackAt: webpackBaseline.verifiedAt[label] ?? [],
        strings: info.strings,
        names: info.names,
        methods: info.methods,
        keys: info.keys,
      };
    }

    // Stable availability comes from the published Stable name list (decky-icons.json); Beta is the live probe.
    const iconFeed = values["icon-names"]
      ? validatePublishedIcons(await Bun.file(resolve(values["icon-names"])).json(), values["icon-names"])
      : undefined;
    const icons = iconRows(betaProbe.data.icons, webpackBaseline.iconsAt, iconFeed);

    // 6. Assemble & validate public GuideData
    const guideData = buildGuideData({
      betaMeta: {
        branch: "publicbeta",
        version: betaVersion,
        isVite: betaProbe.isVite,
        chunkCount: jsChunks.size,
        moduleCount: betaProbe.data.moduleCount,
      },
      webpackMeta: {
        branch: webpackBaseline.branch,
        version: webpackBaseline.version,
        exportCount: webpackBaseline.exports.length,
      },
      cssIndex,
      verifiedRuntime,
      icons,
      runtimeExports: viteRuntimeExports,
      chunkAnalyses,
      webpackMatches,
      previews: betaProbe.previews,
    });
    if (iconFeed) guideData.iconStableVersion = iconFeed.stable.version;

    const violations = validatePublicGuideData(guideData, { allowPreviews: withPreviews });
    if (violations.length) {
      throw new Error(`Public Valve-asset boundary validation failed:\n${violations.slice(0, 10).join("\n")}`);
    }

    // 7. Write outputs
    await mkdir(outDir, { recursive: true });
    await Bun.write(join(outDir, "data.json"), JSON.stringify(guideData));
    await Bun.write(join(outDir, "index.html"), renderGuideHtml({ dataUrl: "./data.json" }));
    console.log(`Wrote ${join(outDir, "index.html")} and ${join(outDir, "data.json")}`);

    if (values["single-file"]) {
      const sf = resolve(values["single-file"]);
      await mkdir(dirname(sf), { recursive: true });
      await Bun.write(sf, renderGuideHtml({ embeddedData: guideData }));
      console.log(`Wrote self-contained single-file HTML to ${sf}`);
    }

    console.log("Summary:", JSON.stringify(guideData.stats, null, 2));
  } finally {
    if (!values.keep) await rm(work, { recursive: true, force: true });
    else console.log(`Kept scratch directory: ${work}`);
  }
}

if (import.meta.main) {
  await main();
}
