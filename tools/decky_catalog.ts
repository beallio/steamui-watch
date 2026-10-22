#!/usr/bin/env bun
/**
 * Build a self-contained HTML catalog of what @decky/ui finds in a Steam Deck client bundle: each component drawn by
 * Steam's own React and CSS, every IconsModule icon, the class maps and helpers, and Steam components that
 * @decky/ui does not name, each found by the shared data-only finder definitions.
 *
 *   bun tools/decky_catalog.ts [--branch stable|publicbeta] [--bundle-dir DIR] [--decky-ui PATH] [--chrome PATH] [--out FILE]
 *   bun tools/decky_catalog.ts --serve [--port N] [--branch …] [--bundle-dir DIR] [--decky-ui PATH]
 *
 * The file contains Valve's CSS, icons and images, so it goes to docs/local/ (git-ignored) by default. Do not
 * publish it. Its previews are static snapshots drawn headless (see tools/runtime_probe.ts); text uses a fallback font.
 * --serve instead serves a live page that runs Steam's code in the browser, so the components can be clicked;
 * an event log shows each callback.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildProbe, fetchBundle, GLOBALS, openSteamPage, STUB } from "./runtime_probe";
import extrasData from "../packages/decky-extras/extras.json";
import { matchExtras } from "../packages/decky-extras/match";

const repo = resolve(import.meta.dir, "..");

/**
 * A @decky/ui component to draw. `make` is JS source run with h, L (@decky/ui), K (candidates), withRouter, withQuery,
 * S (stateful demo) and on (logged callback); see pageSetup. `live` replaces it in the --serve page; `skip` explains a missing static preview.
 */
interface Entry { group: string; name: string; use: string; make: string; live?: string; width?: number; note?: string; skip?: string }
interface Candidate { id: string; name: string; why: string; find: unknown[][]; make?: string; width?: number }
interface Rendered { html: string; height: number; error: string | null }
type CandidateData = { title: string; description: string; find: unknown[][] };
interface PageResult {
  modules: number;
  entries: Record<string, Rendered & { where: string[] }>;
  candidates: Record<string, Rendered & { matches: string[] }>;
  icons: { name: string; note?: string; html: string }[];
  css: string;
  classMaps: { name: string; count: number; keys: string[] }[];
  enums: { name: string; keys: string[] }[];
  functions: string[];
  routerMethods: string[];
  navigation: string[];
}

const lib = (n: string, how = "") => `import { ${n} } from "@decky/ui"${how}`;
const notches = `[{notchIndex:0,label:"Low"},{notchIndex:1,label:"Mid"},{notchIndex:2,label:"High"}]`;
const options = `[{data:1,label:"Option one"},{data:2,label:"Option two"}]`;
export const ENTRIES: Entry[] = [
  { group: "Panel layout", name: "PanelSection", use: lib("PanelSection"), make: `h(L.PanelSection,{title:"Panel section"},h(L.PanelSectionRow,null,h(L.ButtonItem,{layout:"below"},"Row button")))` },
  { group: "Panel layout", name: "PanelSectionRow", use: lib("PanelSectionRow"), make: `h(L.PanelSectionRow,null,"Row content")` },
  { group: "Panel layout", name: "Field", use: lib("Field"), make: `h(L.Field,{label:"Field label",description:"Field description",bottomSeparator:"standard"},h("span",null,"value"))` },
  { group: "Panel layout", name: "ControlsList", use: lib("ControlsList"), make: `h(L.ControlsList,{spacing:"standard"},h(L.DialogButton,null,"One"),h(L.DialogButton,null,"Two"))` },
  { group: "Panel layout", name: "ScrollPanel", use: lib("ScrollPanel"), make: `h(L.ScrollPanel,null,h("div",{style:{height:60}},"Scrollable content"))` },
  { group: "Panel layout", name: "ScrollPanelGroup", use: lib("ScrollPanelGroup"), make: `h(L.ScrollPanelGroup,null,h("div",{style:{height:60}},"Scrollable group content"))` },
  { group: "Panel layout", name: "Focusable", use: lib("Focusable"), make: `h(L.Focusable,{style:{padding:8,border:"1px dashed #555"}},"Focusable area (gamepad focus target)")` },
  { group: "Panel layout", name: "FocusRing", use: lib("FocusRing"), make: "", skip: "Wrapper only: draws nothing by itself." },
  { group: "Panel layout", name: "ErrorBoundary", use: lib("ErrorBoundary"), make: `h(L.ErrorBoundary,null,"Children render normally; a crash shows Steam's error panel")` },
  { group: "Buttons", name: "ButtonItem", use: lib("ButtonItem"), make: `h(L.ButtonItem,{label:"Button item",description:"With a description",layout:"below",onClick:on("ButtonItem onClick")},"Run")` },
  { group: "Buttons", name: "DialogButton", use: lib("DialogButton"), make: `h(L.DialogButton,{onClick:on("DialogButton onClick")},"Secondary button")`, note: "DialogButtonSecondary is the same object." },
  { group: "Buttons", name: "DialogButtonPrimary", use: lib("DialogButtonPrimary"), make: `h(L.DialogButtonPrimary,{onClick:on("DialogButtonPrimary onClick")},"Primary button")` },
  { group: "Buttons", name: "Button", use: lib("Button"), make: `h(L.Button,null,"Button")`, note: "Made by @decky/ui, not a Steam object." },
  { group: "Controls", name: "ToggleField", use: lib("ToggleField"), make: `S("ToggleField onChange",true,(v,set)=>h(L.ToggleField,{label:"Toggle field",description:"Description",checked:v,onChange:set}))` },
  { group: "Controls", name: "Toggle", use: lib("Toggle"), make: `S("Toggle onChange",true,(v,set)=>h(L.Toggle,{value:v,onChange:set}))` },
  { group: "Controls", name: "DialogCheckbox", use: lib("DialogCheckbox"), make: `S("DialogCheckbox onChange",true,(v,set)=>h(L.DialogCheckbox,{label:"Checkbox",description:"Description",checked:v,controlled:true,onChange:set}))` },
  { group: "Controls", name: "SliderField", use: lib("SliderField"),
    make: `S("SliderField onChange",40,(v,set)=>h(L.SliderField,{label:"Slider field",value:v,min:0,max:100,step:10,showValue:true,notchCount:3,notchTicksVisible:true,notchLabels:${notches},onChange:set}))` },
  { group: "Controls", name: "TextField", use: lib("TextField"),
    make: `S("TextField onChange","Some text",(v,set)=>h(L.TextField,{label:"Text field",description:"Description",value:v,bShowClearAction:true,onChange:(e)=>set(e.target.value)}))` },
  { group: "Controls", name: "Dropdown", use: lib("Dropdown"), make: `S("Dropdown onChange",1,(v,set)=>h(L.Dropdown,{rgOptions:${options},selectedOption:v,onChange:(o)=>set(o.data)}))` },
  { group: "Controls", name: "DropdownItem", use: lib("DropdownItem"), note: "Made by @decky/ui around DropdownItemInternal.",
    make: `S("DropdownItem onChange",2,(v,set)=>h(L.DropdownItem,{label:"Dropdown item",rgOptions:${options},selectedOption:v,onChange:(o)=>set(o.data)}))` },
  { group: "Controls", name: "DropdownItemInternal", use: lib("DropdownItemInternal"),
    make: `S("DropdownItemInternal onChange",1,(v,set)=>h(L.DropdownItemInternal,{label:"Dropdown item (internal)",rgOptions:${options},selectedOption:v,onChange:(o)=>set(o.data)}))` },
  { group: "Progress and loading", name: "ProgressBar", use: lib("ProgressBar"), make: `h(L.ProgressBar,{nProgress:60})` },
  { group: "Progress and loading", name: "ProgressBarWithInfo", use: lib("ProgressBarWithInfo"), make: `h(L.ProgressBarWithInfo,{label:"Downloading",nProgress:45,sOperationText:"45%"})` },
  { group: "Progress and loading", name: "ProgressBarItem", use: lib("ProgressBarItem"), make: `h(L.ProgressBarItem,{label:"Progress item",nProgress:70})` },
  { group: "Progress and loading", name: "Spinner", use: lib("Spinner"), make: `h("div",{style:{width:48}},h(L.Spinner,null))` },
  { group: "Progress and loading", name: "SteamSpinner", use: lib("SteamSpinner"), make: `withQuery(h("div",{style:{height:160,position:"relative"}},h(L.SteamSpinner,null)))` },
  { group: "Progress and loading", name: "Marquee", use: lib("Marquee"), make: `h("div",{style:{width:200}},h(L.Marquee,{play:true},"A long line of text that scrolls when it does not fit"))` },
  ...["DialogHeader", "DialogSubHeader", "DialogLabel", "DialogBodyText"].map((n) =>
    ({ group: "Dialog parts", name: n, use: lib(n), make: `h(L.${n},null,"${n}")` })),
  { group: "Dialog parts", name: "DialogBody", use: lib("DialogBody"), make: `h(L.DialogBody,null,h(L.DialogBodyText,null,"Body text inside DialogBody"))` },
  { group: "Dialog parts", name: "DialogControlsSection", use: lib("DialogControlsSection"), width: 480, note: "Shown with DialogControlsSectionHeader.",
    make: `h(L.DialogControlsSection,null,h(L.DialogControlsSectionHeader,null,"Section header"),h(L.ToggleField,{label:"Inside a section",checked:false}))` },
  { group: "Dialog parts", name: "DialogFooter", use: lib("DialogFooter"), make: `h(L.DialogFooter,null,h(L.DialogButtonPrimary,null,"OK"))` },
  { group: "Modals and menus", name: "ConfirmModal", use: lib("ConfirmModal", "  // show with showModal"), width: 640,
    make: `h(L.ConfirmModal,{strTitle:"Confirm",strDescription:"Do the thing?",strOKButtonText:"Yes",strCancelButtonText:"No",closeModal:()=>{}})`,
    live: `h(L.DialogButton,{onClick:()=>L.showModal(h(L.ConfirmModal,{strTitle:"Confirm",strDescription:"Do the thing?",strOKButtonText:"Yes",strCancelButtonText:"No",onOK:on("ConfirmModal onOK"),onCancel:on("ConfirmModal onCancel")}))},"Open with showModal")` },
  { group: "Modals and menus", name: "ModalRoot", use: lib("ModalRoot"), width: 640, make: `h(L.ModalRoot,{closeModal:()=>{}},h(L.DialogHeader,null,"Modal root"),h(L.DialogBodyText,null,"Custom modal content"))` },
  { group: "Modals and menus", name: "SimpleModal", use: lib("SimpleModal"), make: "", skip: "Fixed-position overlay; not captured as a static preview. ModalPosition is its content frame." },
  { group: "Modals and menus", name: "Menu", use: lib("Menu", "  // show with showContextMenu"), make: "",
    skip: "Menu, MenuGroup, MenuItem and MenuSeparator need the context menu instance that showContextMenu creates.",
    live: `h(L.DialogButton,{onClick:(e)=>L.showContextMenu(h(L.Menu,{label:"Menu"},h(L.MenuItem,{onClick:on("MenuItem onClick")},"Item"),h(L.MenuItem,{tone:"destructive",onClick:on("MenuItem (destructive) onClick")},"Destructive item"),h(L.MenuSeparator,null),h(L.MenuGroup,{label:"Group"},h(L.MenuItem,{onClick:on("MenuItem (in group) onClick")},"Sub item"))),e.currentTarget)},"Open with showContextMenu")` },
  { group: "Navigation", name: "Tabs", use: lib("Tabs"), make: "", skip: "Needs Gaming Mode page state (scroll and footer)." },
  { group: "Navigation", name: "SidebarNavigation", use: lib("SidebarNavigation"), width: 800,
    make: `withRouter(h("div",{style:{height:300}},h(L.SidebarNavigation,{title:"Settings",showTitle:true,disableRouteReporting:true,pages:[{title:"General",content:h("div",null,"General page")},{title:"About",content:"About page"}]})))` },
  { group: "Navigation", name: "Carousel", use: lib("Carousel"), make: "", skip: "Needs measured layout from the live Gaming Mode window." },
  { group: "Made by @decky/ui", name: "ReorderableList", use: lib("ReorderableList"), width: 480, make: `h(L.ReorderableList,{entries:[{label:"First",position:0},{label:"Second",position:1}],onSave:()=>{}})` },
  { group: "Made by @decky/ui", name: "SuspensefulImage", use: lib("SuspensefulImage"), make: `h(L.SuspensefulImage,{src:"",suspenseWidth:120,suspenseHeight:60})` },
  { group: "Made by @decky/ui", name: "ColorPickerModal", use: lib("ColorPickerModal", "  // show with showModal"), width: 640,
    make: `h(L.ColorPickerModal,{closeModal:()=>{},title:"Pick a colour",defaultH:200,defaultS:80,defaultL:50})` },
];

// Demo code remains local; finder definitions and display text come from the shared data manifest.
const demos: Record<string, Pick<Candidate, "make" | "width">> = {
  RadioGroup: { make: `S("Radio group onChange","b",(v,set)=>h(K.RadioGroup,{value:v,onChange:set},h(K.RadioButton,{value:"a"},"Left"),h(K.RadioButton,{value:"b"},"Middle"),h(K.RadioButton,{value:"c"},"Right")))` },
  TextButton: { make: `h(C,{onClick:on("TextButton onClick")},"Text button")` },
  DialogSettingsSection: { width: 480, make: `h(C,{label:"Settings section"},h(L.ToggleField,{label:"Option",checked:true}))` },
  DialogRoundCheckboxField: { make: `h(C,{label:"Round checkbox",checked:true})` },
  ToggleRow: { make: `S("ToggleRow onChange",true,(v,set)=>h(C,{label:"Toggle row",value:v,onChange:set}))` },
  DiscreteSlider: { make: `S("Discrete-value slider onChange",4,(v,set)=>h(C,{label:"Discrete slider",rValues:[1,2,4,8,16],value:v,onChange:set,showValue:true}))` },
  PinInput: { make: `S("PIN input onChange","12",(v,set)=>h(C,{digits:4,value:v,onChange:set}))` },
  PasswordInput: { make: `S("Password input onChange","secret",(v,set)=>h(C,{value:v,onChange:set}))` },
  TextArea: { make: `S("TextArea onChange","Line one\\nLine two",(v,set)=>h(C,{value:v,onChange:set}))` },
  DialogHBar: { make: `h(C,null)` },
  BottomButtons: { width: 480, make: `h(C,null,h(L.DialogButton,null,"Cancel"),h(L.DialogButtonPrimary,null,"Save"))` },
  StackedConfirmButtons: { make: `h(C,{onPrimary:()=>{},onCancel:()=>{},strPrimaryButtonText:"Continue",strCancelButtonText:"Cancel"})` },
  FieldDescription: { make: `h(C,null,"Field description text")` },
  LabelValueField: { make: `h(C,{label:"Version"},"1.2.3")` },
  FieldSeparator: { make: `h(C,null)` },
  LoadingThrobber: { make: `h(C,{size:"medium"})` },
  WarningBox: { make: `h(C,{type:"Warning",body:"Something needs your attention."})` },
  SectionHeader: { make: `h(C,{showRule:true,label:"Section header"},"Section header")` },
  SegmentedCharacterInput: { make: `S("Segmented character input onChange","AB",(v,set)=>h(C,{length:5,value:v,onChange:set}))` },
  CalloutMessage: { make: `h(C,null,"Callout message")` },
};
export const CANDIDATES: Candidate[] = Object.entries(extrasData.components as Record<string, CandidateData>).map(([id, data]) => ({
  id, name: data.title, why: data.description, find: data.find, ...demos[id],
}));

/** True when SELECTOR names one of USED's classes as a whole class name (`.Panel` does not match `.PanelSection`). */
export function selectorUsesClass(selector: string, used: Set<string>): boolean {
  for (const m of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) if (used.has(m[1])) return true;
  return false;
}

/** What pageSetup gives the in-page renderers. Members are Steam or @decky/ui objects, so they stay untyped. */
interface PageContext {
  W: any; L: any; R: any; D: any;
  src(v: unknown): string;
  where: Map<unknown, string[]>;
  createRoot(el: Element): any;
  /** Canonical component id to its Steam export, when its finder matched exactly once. */
  K: Record<string, unknown>;
  matches: Record<string, string[]>;
  /** Wrap in an error boundary and Steam's Gaming Mode component provider. */
  wrap(el: unknown): unknown;
  /** Turn an Entry or Candidate `make` into a function that returns the element. */
  run(make: string, C?: unknown): () => unknown;
}

/**
 * Runs inside the Steam page; stringified, so it may use only its arguments and browser globals. Boots @decky/ui and
 * resolves the candidates. `make` code gets h, L, K, C and: withRouter/withQuery (contexts some components need),
 * S(name, initial, (value, set) => element) for a component that keeps its own state, and on(name) for a callback.
 * S and on report to window.__catalogLog(name, args) when it exists.
 */
async function pageSetup(globals: string, candidates: Candidate[], matcher: typeof matchExtras, manifest: typeof extrasData): Promise<PageContext> {
  const w = window as any;
  w.__stubInert = true;
  const webpackUrl = "/probe/webpack.js", libUrl = "/probe/index.js";
  const W = await import(webpackUrl);
  eval(globals);
  const L = await import(libUrl);
  const R = w.SP_REACT, D = w.SP_REACTDOM;
  const src = (v: any) => { const f = v?.render ?? v?.type ?? v; try { return typeof f === "function" ? Function.prototype.toString.call(f) : ""; } catch { return ""; } };
  // Every distinct export, with all module:key places it is exported from.
  const where = new Map<any, string[]>();
  for (const [id, m] of W.modules) {
    if (!m || (typeof m !== "object" && typeof m !== "function")) continue;
    for (const k of Object.keys(m)) {
      let v; try { v = m[k]; } catch { continue; }
      if (v && (typeof v === "object" || typeof v === "function")) { if (!where.has(v)) where.set(v, []); where.get(v)!.push(`${id}:${k}`); }
    }
  }
  const findAll = (test: (s: string) => boolean) => [...where.keys()].filter((v) => { const s = src(v); return s !== "" && test(s); });
  const one = (test: (s: string) => boolean) => { const all = findAll(test); return all.length === 1 ? all[0] : undefined; };
  const createRoot = W.findModule((m: any) => typeof m?.createRoot === "function" && Object.keys(m).length === 1)?.createRoot;
  const provider = Object.values(W.CommonUIModule ?? {}).find((v) => typeof v === "function" && /SliderField:/.test(src(v)) && /\.Provider/.test(src(v)));
  const Router = Object.values(L.ReactRouter ?? {}).find((v) => /history\.location/.test(src(v)) && /_isMounted/.test(src(v)));
  const memoryHistory = one((s) => s.includes("initialEntries") && s.includes("getUserConfirmation"));
  const QueryProvider = one((s) => s.length < 600 && s.includes("client:") && s.includes(".mount()"));
  const QueryClient = one((s) => s.startsWith("class") && s.includes("getQueryCache(){"));
  const h = R.createElement;
  const withRouter = (el: any) => h(Router, { history: memoryHistory({ initialEntries: ["/"] }) }, el);
  const withQuery = (el: any) => h(QueryProvider, { client: new QueryClient() }, el);
  const report = (name: string, args: unknown[]) => w.__catalogLog?.(name, args);
  const on = (name: string) => (...args: unknown[]) => report(name, args);
  const Stateful = ({ name, initial, render }: any) => {
    const [value, setValue] = R.useState(initial);
    // Inputs call onChange with an event; keep its target's value.
    return render(value, (...args: any[]) => { setValue(args[0]?.target ? args[0].target.value : args[0]); report(name, args); });
  };
  const S = (name: string, initial: unknown, render: unknown) => h(Stateful, { name, initial, render });
  class Boundary extends R.Component {
    state = { e: null as unknown };
    static getDerivedStateFromError(e: unknown) { return { e }; }
    render() { return this.state.e ? h("pre", { "data-error": "" }, String((this.state.e as Error)?.message ?? this.state.e)) : (this as any).props.children; }
  }
  const K: Record<string, unknown> = {}, matches: Record<string, string[]> = {};
  const found = matcher(W.modules, manifest);
  for (const c of candidates) {
    const all = found[c.id] ?? [];
    if (all.length === 1) K[c.id] = all[0];
    matches[c.name] = all.map((v) => (where.get(v) ?? []).join(" = "));
  }
  return {
    W, L, R, D, src, where, createRoot, K, matches,
    wrap: (el) => h(Boundary, null, provider ? h(provider, null, el) : el),
    run: (make, C) => () => new Function("h", "L", "K", "C", "withRouter", "withQuery", "S", "on", `return ${make}`)(h, L, K, C, withRouter, withQuery, S, on),
  };
}

/** Runs inside the Steam page: draws every entry, candidate and icon once and returns static HTML and the CSS it uses. */
async function pageCatalog(setup: typeof pageSetup, globals: string, entries: Entry[], candidates: Candidate[], selectorUses: string, matcher: typeof matchExtras, manifest: typeof extrasData): Promise<PageResult> {
  const { W, L, R, D, src, where, createRoot, K, matches, wrap, run } = await setup(globals, candidates, matcher, manifest);
  const uses = eval(`(${selectorUses})`) as (s: string, u: Set<string>) => boolean;
  const draw = async (make: () => unknown, width: number): Promise<Rendered> => {
    const host = document.createElement("div");
    host.style.cssText = `position:absolute;left:0;top:0;width:${width}px`;
    document.body.appendChild(host);
    const root = createRoot(host);
    const quiet = console.error; console.error = () => {};
    let error: string | null = null;
    try { D.flushSync(() => root.render(wrap(make()))); }
    catch (e) { error = String(e).slice(0, 300); }
    await new Promise((r) => setTimeout(r, 120));
    console.error = quiet;
    const html = host.innerHTML, height = Math.round(host.getBoundingClientRect().height);
    root.unmount(); host.remove();
    const caught = html.match(/<pre data-error="">([\s\S]*?)<\/pre>/)?.[1];
    return { html, height, error: error ?? (caught === undefined ? null : caught.slice(0, 300)) };
  };
  const out: PageResult = { modules: W.modules.size, entries: {}, candidates: {}, icons: [], css: "", classMaps: [], enums: [], functions: [], routerMethods: [], navigation: [] };
  for (const e of entries) {
    const r = e.skip ? { html: "", height: 0, error: null } : await draw(run(e.make), e.width ?? 360);
    out.entries[e.name] = { ...r, where: where.get(L[e.name]) ?? [] };
  }
  for (const c of candidates) {
    const n = matches[c.name].length;
    out.candidates[c.name] = { matches: matches[c.name], html: "", height: 0, error: n === 1 ? null : `${n} matches` };
    if (c.make && K[c.id]) Object.assign(out.candidates[c.name], await draw(run(c.make, K[c.id]), c.width ?? 360));
  }
  // Icons: one drawing each; directional icons once per direction.
  const icons = L.IconsModule ?? {};
  for (const name of Object.keys(icons).sort((a, b) => a.localeCompare(b))) {
    const directional = /direction:[\w$]+/.test(src(icons[name])) && /case"up"/.test(src(icons[name]));
    for (const direction of directional ? ["up", "down", "left", "right"] : [undefined]) {
      const r = await draw(() => R.createElement(icons[name], direction ? { direction } : null), 60);
      out.icons.push({ name, note: direction && `direction="${direction}"`, html: r.error || !r.html.includes("<svg") ? "" : r.html });
    }
  }
  // Steam CSS rules that name a class the drawings use, :root variables, and the keyframes they animate with.
  const used = new Set<string>();
  const drawn = [...Object.values(out.entries), ...Object.values(out.candidates)].map((r) => r.html).join("") + out.icons.map((i) => i.html).join("");
  for (const m of drawn.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  const animations = new Set<string>();
  const keep = (rules: CSSRuleList): string[] => [...rules].flatMap((r): string[] => {
    if (r instanceof CSSStyleRule) {
      if (!uses(r.selectorText, used) && !(/^(:root|html|body)\b/.test(r.selectorText) && r.style.cssText.includes("--"))) return [];
      for (const a of (r.style.animationName || "").split(/[\s,]+/)) if (a) animations.add(a);
      return [r.cssText];
    }
    if (r instanceof CSSMediaRule || r instanceof CSSSupportsRule) {
      const inner = keep(r.cssRules);
      return inner.length ? [`@${r instanceof CSSMediaRule ? "media" : "supports"} ${r.conditionText}{${inner.join("\n")}}`] : [];
    }
    return [];
  });
  const sheets = [...document.styleSheets];
  const css = sheets.flatMap((s) => keep(s.cssRules));
  const frames = sheets.flatMap((s) => [...s.cssRules].filter((r) => r instanceof CSSKeyframesRule && animations.has(r.name)).map((r) => r.cssText));
  out.css = [...css, ...frames].join("\n");
  for (const [k, v] of Object.entries(L) as [string, any][]) {
    if (/Classes$/.test(k) && v && typeof v === "object") out.classMaps.push({ name: k, count: Object.keys(v).length, keys: Object.keys(v).slice(0, 12) });
    else if (/^(E[A-Z]|GamepadButton$|NavEntryPositionPreferences$|QuickAccessTab$|SideMenu$)/.test(k)) out.enums.push({ name: k, keys: Object.keys(v).filter((x) => isNaN(Number(x))) });
    else if (typeof v === "function" && /^[a-z]/.test(k)) out.functions.push(k);
  }
  out.routerMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(L.Router ?? {})).filter((n) => n !== "constructor");
  out.navigation = Object.keys(L.Navigation ?? {});
  return out;
}

const LAYOUT_CSS = `
.cat-body{margin:0;background:#0e141b;color:#dcdedf;font-family:"Motiva Sans",Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45}
.cat-wrap{max-width:1500px;margin:0 auto;padding:24px}.cat-wrap h1{font-size:26px;margin:0 0 4px}
.cat-wrap h2{font-size:21px;margin:40px 0 8px;border-bottom:1px solid #3d4450;padding-bottom:6px}.cat-wrap h3{font-size:16px;color:#b8bcbf;margin:24px 0 8px}
.cat-sub,.cat-meta{color:#8b929a}.cat-meta{font-size:12px;margin:4px 0}
.cat-callout{background:#1a2029;border-left:4px solid #1a9fff;padding:12px 16px;margin:16px 0;max-width:1000px}
.cat-toc a{color:#1a9fff;margin-right:16px}
.cat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:16px}
.cat-card{background:#1a2029;border:1px solid #2a313b;border-radius:6px;padding:12px;overflow:hidden}.cat-card h4{margin:0 0 4px;font-size:15px;color:#fff}
.cat-wrap code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#9fd3ff;word-break:break-word}
.cat-preview{margin-top:10px;background:#23262e;border-radius:4px;padding:12px;overflow:auto;position:relative}.cat-stage{position:relative;max-width:100%}
.cat-none{color:#c7a24a;font-size:12px;margin:0}
.cat-icons{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-top:12px}
.cat-icon{margin:0;background:#1a2029;border:1px solid #2a313b;border-radius:4px;padding:10px 6px;text-align:center;color:#dcdedf}
.cat-icon svg{width:40px!important;height:40px!important;display:block;margin:0 auto 6px;position:static!important}
.cat-icon>div{position:relative!important;width:40px!important;height:40px!important;margin:0 auto 6px!important;top:auto!important;left:auto!important}.cat-icon>div svg{margin:0}
.cat-icon figcaption{font-size:11px;word-break:break-word;color:#b8bcbf}
#cat-filter{margin-top:8px;padding:8px;width:320px;background:#23262e;border:1px solid #3d4450;color:#fff;border-radius:4px}
.cat-table{border-collapse:collapse;width:100%;max-width:1200px}.cat-table td,.cat-table th{border:1px solid #2a313b;padding:6px 8px;vertical-align:top;text-align:left}
.cat-live{position:fixed;inset:0;overflow:auto;z-index:1}
.cat-log{position:fixed;right:16px;bottom:16px;width:380px;max-height:220px;overflow:auto;background:#000c;border:1px solid #3d4450;border-radius:6px;padding:8px;font:12px ui-monospace,Menlo,Consolas,monospace;color:#9fd3ff;z-index:2}
.cat-log div{white-space:pre-wrap;word-break:break-word}`;

/** Runs in the --serve page: renders every entry, candidate and icon live, with an event log. */
async function pageLive(setup: typeof pageSetup, globals: string, entries: Entry[], candidates: Candidate[], meta: { label: string; ui: string }, matcher: typeof matchExtras, manifest: typeof extrasData) {
  const { L, R, createRoot, K, matches, wrap, run } = await setup(globals, candidates, matcher, manifest);
  const h = R.createElement;
  const el = (tag: string, attrs: Record<string, string>, ...kids: (Node | string)[]) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    e.append(...kids);
    return e;
  };
  const log = el("div", { class: "cat-log", "aria-live": "polite" }, el("div", {}, "Events from the components appear here."));
  const show = (v: unknown): string => {
    if (v === undefined || v === null || typeof v !== "object") return JSON.stringify(v) ?? String(v);
    // DOM events and React's synthetic events: show the event type, not the (circular) object.
    if (v instanceof Event || ("nativeEvent" in v && "type" in v)) return `event(${(v as Event).type})`;
    try { return JSON.stringify(v); } catch { return Object.prototype.toString.call(v); }
  };
  (window as any).__catalogLog = (name: string, args: unknown[]) => {
    log.prepend(el("div", {}, `${new Date().toLocaleTimeString()} ${name}(${args.map(show).join(", ")})`));
  };
  const mount = (make: () => unknown) => {
    const host = el("div", { class: "cat-stage" });
    createRoot(host).render(wrap(make()));
    return host;
  };
  const card = (title: string, metas: string[], body: Node) =>
    el("article", { class: "cat-card" }, el("h4", {}, title), ...metas.map((m) => el("div", { class: "cat-meta" }, m)), el("div", { class: "cat-preview" }, body));
  const none = (text: string) => el("p", { class: "cat-none" }, text);
  const app = el("div", { class: "cat-wrap" },
    el("h1", {}, "@decky/ui catalog (live)"),
    el("p", { class: "cat-sub" }, `Steam Deck client ${meta.label} · @decky/ui ${meta.ui} · running Steam's own code in this browser, without Steam`),
    el("div", { class: "cat-callout" }, "Click, drag and type: the components run Steam's real code. Controller navigation, sounds and Steam data are not available outside Steam, and some components need Gaming Mode state this page does not have."),
  );
  for (const group of [...new Set(entries.map((e) => e.group))]) {
    const grid = el("div", { class: "cat-grid" });
    for (const e of entries.filter((x) => x.group === group)) {
      const make = e.live ?? (e.skip ? undefined : e.make);
      grid.append(card(e.name, [e.use, ...(e.note ? [e.note] : [])], make ? mount(run(make)) : none(`No live demo: ${e.skip}`)));
    }
    app.append(el("h3", {}, group), grid);
  }
  const cgrid = el("div", { class: "cat-grid" });
  for (const c of candidates) {
    const found = K[c.id];
    const body = !c.make ? none("Used inside another entry.") : found ? mount(run(c.make, found)) : none(`Finder matched ${matches[c.name].length} exports on this build.`);
    cgrid.append(card(c.name, [c.why, `Finder: ${JSON.stringify(c.find)}`], body));
  }
  app.append(el("h2", {}, "Steam components not in @decky/ui"), cgrid);
  const icons = L.IconsModule ?? {};
  const iconGrid = el("div", { class: "cat-icons" });
  createRoot(iconGrid).render(Object.keys(icons).sort((a, b) => a.localeCompare(b)).map((name) =>
    h("figure", { key: name, className: "cat-icon" }, wrap(h(icons[name], { direction: "up" })), h("figcaption", null, name))));
  app.append(el("h2", {}, `Icons: IconsModule (${Object.keys(icons).length})`), iconGrid);
  document.body.style.overflow = "auto";
  document.body.classList.add("cat-body");
  document.body.append(el("div", { class: "cat-live" }, app), log);
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const code = (xs: string[]) => xs.map((x) => `<code>${esc(x)}</code>`).join(" ");

/** Replace `src="/images/…"` with data URLs from the bundle so the file works alone. */
async function inlineImages(html: string, root: string) {
  let out = html;
  for (const path of new Set([...html.matchAll(/src="(\/images\/[^"]+)"/g)].map((m) => m[1]))) {
    const file = Bun.file(join(root, path));
    if (await file.exists()) out = out.replaceAll(`src="${path}"`, `src="data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}"`);
  }
  return out;
}

function page(label: string, ui: string, r: PageResult) {
  const preview = (x: Rendered, width = 360, skip?: string) => skip || x.error || !x.html
    ? `<p class="cat-none">No preview: ${esc(skip ?? x.error ?? "nothing drawn")}</p>`
    : `<div class="cat-stage" style="width:${width}px">${x.html}</div>`;
  const groups = [...new Set(ENTRIES.map((e) => e.group))].map((g) => `<h3>${esc(g)}</h3><div class="cat-grid">${ENTRIES.filter((e) => e.group === g).map((e) => {
    const x = r.entries[e.name];
    return `<article class="cat-card" id="${slug(e.name)}"><h4>${esc(e.name)}</h4><code>${esc(e.use)}</code>
<div class="cat-meta">Steam object on this build: ${x.where.length ? esc(x.where.join(", ")) : "none (made by @decky/ui)"}</div>
${e.note ? `<div class="cat-meta">${esc(e.note)}</div>` : ""}<div class="cat-preview">${preview(x, e.width, e.skip)}</div></article>`;
  }).join("\n")}</div>`).join("\n");
  const candidates = CANDIDATES.map((c) => {
    const x = r.candidates[c.name];
    return `<article class="cat-card" id="${slug(c.name)}"><h4>${esc(c.name)}</h4><div class="cat-meta">${esc(c.why)}</div>
<div class="cat-meta">Finder clauses (OR within each clause): <code>${esc(JSON.stringify(c.find))}</code></div>
<div class="cat-meta">Matches on this build: ${x.matches.length ? esc(x.matches.join("; ")) : "none"}</div>
<div class="cat-preview">${c.make ? preview(x, c.width) : `<p class="cat-none">Drawn inside another entry.</p>`}</div></article>`;
  }).join("\n");
  const icons = r.icons.map((i) => `<figure class="cat-icon" data-name="${esc(i.name.toLowerCase())}">${i.html || `<span class="cat-none">needs props</span>`}<figcaption>${esc(i.name)}${i.note ? `<br><small>${esc(i.note)}</small>` : ""}</figcaption></figure>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>@decky/ui catalog: Steam Deck ${esc(label)}</title>
<style>${r.css}</style>
<style>${LAYOUT_CSS}</style></head><body class="cat-body"><div class="cat-wrap">
<h1>@decky/ui catalog</h1>
<p class="cat-sub">Steam Deck client ${esc(label)} · @decky/ui ${esc(ui)} · ${r.modules} webpack modules · generated ${new Date().toISOString().slice(0, 10)} by tools/decky_catalog.ts</p>
<div class="cat-callout"><b>Do plugins have to use these?</b> No. A plugin can render any React or HTML. These components make a plugin match SteamOS: its styles, CSS Loader themes, sounds and, on a Deck, controller navigation. Steam's components take part in its gamepad focus system; plain elements need a <code>Focusable</code> wrapper to get controller focus.</div>
<div class="cat-callout"><b>Previews</b> are static snapshots of the real components, drawn by Steam's React and CSS inside Steam's Gaming Mode component provider, in a headless browser without Steam. Nothing is interactive here; to click them, run <code>bun tools/decky_catalog.ts --serve</code>. Text uses a fallback font. Hashed class names and module:export places are valid for this build only. This file contains Valve's CSS, icons and images: do not publish it.</div>
<nav class="cat-toc"><a href="#lib">Components @decky/ui finds</a><a href="#candidates">Steam components not in @decky/ui</a><a href="#icons">Icons</a><a href="#other">Class maps, objects, helpers</a></nav>
<h2 id="lib">Components @decky/ui finds</h2>${groups}
<h2 id="candidates">Steam components not in @decky/ui</h2>
<div class="cat-callout">Steam exports with no @decky/ui name. Module:export keys change between Steam builds; these data-only clauses identify components from their source. A finder that matches exactly one export can find the component; check it on each new build.</div>
<div class="cat-grid">${candidates}</div>
<h2 id="icons">Icons: IconsModule (${r.icons.length} drawings)</h2>
<p><code>import { IconsModule } from "@decky/ui"</code> then <code>&lt;IconsModule.Settings /&gt;</code>. Icon names are real names. Directional icons are shown once per <code>direction</code>.</p>
<input id="cat-filter" type="search" placeholder="Filter icons by name" aria-label="Filter icons by name"><div class="cat-icons">${icons}</div>
<h2 id="other">Class maps, objects and helpers</h2>
<h3>CSS class maps (${r.classMaps.length})</h3><p>Steam's CSS-module objects: readable key to this build's hashed class name.</p>
<table class="cat-table"><thead><tr><th>Export</th><th>Classes</th><th>First keys</th></tr></thead><tbody>${r.classMaps.map((c) => `<tr><td><code>${esc(c.name)}</code></td><td>${c.count}</td><td>${code(c.keys)}</td></tr>`).join("")}</tbody></table>
<h3>Objects and enums</h3><table class="cat-table"><tbody>
<tr><td><code>Router</code></td><td>Steam's window and navigation store, ${r.routerMethods.length} methods: ${code(r.routerMethods.filter((m) => /^Navigate|Running|Window/.test(m)).slice(0, 12))} …</td></tr>
<tr><td><code>Navigation</code></td><td>@decky/ui helpers over Steam navigation: ${code(r.navigation)}</td></tr>
${r.enums.map((e) => `<tr><td><code>${esc(e.name)}</code></td><td>${e.keys.length} values: ${code(e.keys.slice(0, 30))}${e.keys.length > 30 ? " …" : ""}</td></tr>`).join("")}
</tbody></table>
<h3>Helper functions</h3><p>${code(r.functions)}</p>
</div><script>
document.getElementById("cat-filter").addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); for (const f of document.querySelectorAll(".cat-icon")) f.style.display = f.dataset.name.includes(q) ? "" : "none"; });
</script></body></html>`;
}

/** Serve the bundle with a live catalog page at /: Steam's page plus the stand-in, then pageLive once Steam has booted. */
function serveLive(root: string, port: number, label: string, ui: string) {
  const live = `(${pageLive})((${pageSetup}), ${JSON.stringify(GLOBALS)}, ${JSON.stringify(ENTRIES)}, ${JSON.stringify(CANDIDATES)}, ${JSON.stringify({ label, ui })}, (${matchExtras.toString()}), ${JSON.stringify(extrasData)})`;
  // Steam renders into #root once its chunks have loaded; @decky/ui must import after that.
  const script = `const t0 = Date.now();
while (!document.getElementById("root")?.childElementCount && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 250));
await new Promise((r) => setTimeout(r, 1500));
${live};`;
  return Bun.serve({ port, hostname: "127.0.0.1", async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path === "/" || path.startsWith("/routes/")) {
      const html = (await Bun.file(join(root, "index.html")).text())
        .replace("<head>", `<head><script>${STUB}</script><style>${LAYOUT_CSS}</style>`)
        .replace("</body>", `<script type="module" src="/probe/live.js"></script></body>`);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (path === "/probe/live.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
    const file = Bun.file(join(root, path));
    return !path.includes("..") && await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  } });
}

if (import.meta.main) {
  const { values: args } = parseArgs({ args: Bun.argv.slice(2), options: {
    branch: { type: "string", default: "stable" },
    "bundle-dir": { type: "string" },
    "decky-ui": { type: "string", default: resolve(repo, "../decky-loader/frontend/node_modules/@decky/ui") },
    chrome: { type: "string", default: process.env.CHROME ?? "google-chrome" },
    out: { type: "string" },
    serve: { type: "boolean", default: false },
    port: { type: "string", default: "8642" },
  } });
  // Project convention (AGENTS.md): $TMPDIR, else /var/tmp/omp-1000, never /tmp.
  const temp = process.env.TMPDIR || "/var/tmp/omp-1000";
  await mkdir(temp, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(temp, "decky-catalog-"));
  const cleanup = () => rm(work, { recursive: true, force: true });
  try {
    const bundle = args["bundle-dir"]
      ? { label: "local", root: resolve(args["bundle-dir"]), report: "local" }
      : await fetchBundle(args.branch!, work);
    await buildProbe(bundle.root, work, args["decky-ui"], ["index.js"]);
    const ui = (await Bun.file(join(args["decky-ui"]!, "package.json")).json()).version;
    if (args.serve) {
      const server = serveLive(bundle.root, Number(args.port), bundle.label, ui);
      console.log(`${bundle.label}: live catalog at http://127.0.0.1:${server.port}/ (Chrome or Chromium). Ctrl-C stops it.`);
      const stop = async () => { server.stop(true); await cleanup(); process.exit(0); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await new Promise(() => {});
    }
    const steam = await openSteamPage(bundle.root, work, args.chrome);
    let result: PageResult;
    try {
      result = await steam.evaluate<PageResult>(`(${pageCatalog})((${pageSetup}), ${JSON.stringify(GLOBALS)}, ${JSON.stringify(ENTRIES)}, ${JSON.stringify(CANDIDATES)}, ${JSON.stringify(selectorUsesClass.toString())}, (${matchExtras.toString()}), ${JSON.stringify(extrasData)})`);
    } finally {
      await steam.close();
    }
    const out = resolve(args.out ?? join(repo, "docs/local", `decky-ui-catalog-${bundle.report}.html`));
    await mkdir(dirname(out), { recursive: true });
    await Bun.write(out, await inlineImages(page(bundle.label, ui, result), bundle.root));
    const drawn = Object.values(result.entries).filter((x) => x.html && !x.error).length;
    console.log(`${bundle.label}: ${drawn}/${ENTRIES.length} components drawn, ${result.icons.filter((i) => i.html).length}/${result.icons.length} icon drawings`);
    for (const c of CANDIDATES) {
      const x = result.candidates[c.name];
      console.log(`  ${x.matches.length === 1 ? "ok " : "!! "} ${c.name}: ${x.matches.length} match${x.matches.length === 1 ? "" : "es"}${x.error && x.matches.length === 1 ? ` (draw: ${x.error})` : ""}`);
    }
    console.log(`wrote ${out}`);
  } finally {
    await cleanup();
  }
}
