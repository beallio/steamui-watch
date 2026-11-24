import { describe, expect, test } from "bun:test";
import {
  classifyFeatureArea,
  SCHEMA_VERSION,
  VALVE_PALETTE,
  validatePublicGuideData,
  type GuideData,
} from "./dev_guide_schema";
import { describeExport, describeCssModule, PLACEMENT_LABELS } from "./dev_guide_docs";
import {
  analyzeViteChunkAst,
  buildCssIndex,
  buildGuideData,
  extractCssClassesFromStylesheets,
  iconRows,
  inferExportSemantics,
  matchWebpackToVite,
  type ViteRuntimeExport,
  type WebpackExportRecord,
} from "./dev_guide_extract";
import { renderGuideHtml } from "./dev_guide_html";
import { inlineLocalPreviewAssets, isViteDump, loadMappingDataFiles, scopePreviewCssForGamepadMode } from "./dev_guide";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("icon rows add Stable-only names and each name's branches from decky-icons.json", () => {
  const beta = [{ name: "Clock", at: ["esm:c:Clock"], directional: false }, { name: "NewThing", at: ["esm:c:N"], directional: false }];
  const feed = {
    stable: { names: ["Arrow", "Clock"], directional: ["Arrow"] },
    beta: { names: ["Clock", "NewThing"], directional: [] },
  };
  const rows = iconRows(beta, { Clock: ["9:Clock"] }, feed);
  expect(rows).toEqual([
    { name: "Clock", viteAt: ["esm:c:Clock"], webpackAt: ["9:Clock"], directional: false, branches: ["stable", "beta"] },
    { name: "NewThing", viteAt: ["esm:c:N"], webpackAt: [], directional: false, branches: ["beta"] },
    { name: "Arrow", viteAt: [], webpackAt: [], directional: true, branches: ["stable"] },
  ]);
  // Without the published lists the guide keeps the beta registry and claims no branches.
  expect(iconRows(beta, {}).every((row) => !("branches" in row))).toBe(true);
});

describe("dev_guide_schema", () => {
  test("exports Valve Steam Deck / SteamUI palette tokens", () => {
    expect(VALVE_PALETTE.bgDarkest).toBe("#0e141b");
    expect(VALVE_PALETTE.bgHeader).toBe("#171a21");
    expect(VALVE_PALETTE.bgStoreDark).toBe("#1b2838");
    expect(VALVE_PALETTE.bgSurface).toBe("#23262e");
    expect(VALVE_PALETTE.accentBlue).toBe("#1a9fff");
    expect(VALVE_PALETTE.accentBlueHi).toBe("#66c0f4");
    expect(VALVE_PALETTE.verifiedGreen).toBe("#5ba32b");
    expect(VALVE_PALETTE.inferredAmber).toBe("#ffc53d");
    expect(VALVE_PALETTE.unmatchedRed).toBe("#ec5d5e");
  });

  test("classifies feature areas from semantic module and symbol names", () => {
    expect(classifyFeatureArea(["Keyboard", "KeyboardKey", "VirtualKeyboardContainer"])).toBe("Keyboard");
    expect(classifyFeatureArea(["SettingsModal", "SettingsDialogSubHeader"])).toBe("Settings");
    expect(classifyFeatureArea(["BroadcastPlayerContainer", "ChatContainer"])).toBe("Broadcast");
    expect(classifyFeatureArea(["SliderField", "DialogButton", "ToggleField"])).toBe("CommonUI");
    expect(classifyFeatureArea(["QuickAccessMenu", "MainMenu", "OverlayPinned"])).toBe("Overlay & Menus");
    expect(classifyFeatureArea(["AppDetailsHeader", "LibraryHome", "GameListEntry"])).toBe("Library");
    expect(classifyFeatureArea(["StoreSaleWidgetContainer", "DiscoveryQueueApp"])).toBe("Store");
    expect(classifyFeatureArea(["UnrelatedWidgetFoo"])).toBe("System & Misc");
  });

  test("validatePublicGuideData accepts strict metadata and rejects raw Valve assets/code", () => {
    const clean: GuideData = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-11-19T00:00:00.000Z",
      beta: { branch: "publicbeta", version: "1795048523", isVite: true, chunkCount: 2, moduleCount: 10 },
      webpackBaseline: { branch: "stable", version: "1794536281", exportCount: 10 },
      stats: {
        cssModules: 1,
        cssClasses: 1,
        cssMatched: 1,
        cssUnmatched: 0,
        plainClasses: 1,
        exports: 1,
        verifiedExports: 1,
        inferredExports: 0,
        unmatchedExports: 0,
        webpackMatchedExports: 1,
        icons: 1,
        chunks: 1,
      },
      featureAreas: [{ id: "commonui", name: "CommonUI", componentCount: 1, storeCount: 0, cssModuleCount: 1, cssClassCount: 1 }],
      cssModules: [{ id: "mod:50777", moduleId: "50777", name: "CommonControls", featureArea: "CommonUI", classCount: 1, matchedCount: 1, classes: ["css:50777/SliderTrack"], usedBy: ["comp:SliderField"] }],
      cssClasses: [{
        id: "css:50777/SliderTrack",
        hash: "AbCdEfGhIjK-",
        semanticName: "SliderTrack",
        moduleId: "50777",
        moduleName: "CommonControls",
        featureArea: "CommonUI",
        webpackHash: "_2OldWebpackHash123456",
        chainId: "uuid-1",
        chainHistoryCount: 3,
        confidence: "verified",
        migration: "changed",
        isKeyframe: false,
        usedBy: ["comp:SliderField"],
        cssSnippet: ".AbCdEfGhIjK- /* CommonControls.SliderTrack */",
      }],
      plainClasses: ["Focusable"],
      exports: [{
        id: "comp:SliderField",
        name: "SliderField",
        kind: "component",
        confidence: "verified",
        evidence: ["@decky/ui"],
        featureArea: "CommonUI",
        viteAt: ["esm:chunk~aaa.js:Kc"],
        chunk: "chunk~aaa.js",
        webpackAt: ["50777:Kc"],
        webpackMatchScore: 100,
        migration: "changed",
        sourcePackage: "@decky/ui",
        props: ["label", "max", "min", "value"],
        storeFields: [],
        methods: [],
        steamClientApis: [],
        cssClasses: ["css:50777/SliderTrack"],
        cssModules: ["mod:50777"],
        recipe: 'import { SliderField } from "@decky/ui";',
      }],
      icons: [{ name: "SteamLogo", viteAt: ["esm:chunk~ico.js:SteamLogo"], webpackAt: ["111:SteamLogo"], directional: false, recipe: 'import { IconsModule } from "@decky/ui"; // <IconsModule.SteamLogo />' }],
      chunks: [{ name: "chunk~aaa.js", exportCount: 1, cssClassCount: 1, featureAreas: ["CommonUI"] }],
    };
    expect(validatePublicGuideData(clean)).toEqual([]);

    const leakySvg = structuredClone(clean);
    leakySvg.exports[0].recipe = "<svg><path d='M0 0'/></svg>";
    expect(validatePublicGuideData(leakySvg).some((e) => /svg/i.test(e))).toBe(true);

    const leakyCss = structuredClone(clean);
    leakyCss.cssClasses[0].cssSnippet = ".AbCdEfGhIjK-{display:flex;background-color:#123456;padding:12px}";
    expect(validatePublicGuideData(leakyCss).some((e) => /raw CSS/i.test(e))).toBe(true);

    const leakyJs = structuredClone(clean);
    leakyJs.exports[0].recipe = "function(e){const t=useState(0);return jsx('div',{className:'x',children:e.label})}";
    expect(validatePublicGuideData(leakyJs).some((e) => /JS body/i.test(e))).toBe(true);
  });
});

describe("dev_guide_extract: CSS index", () => {
  test("extracts Vite hashes and @keyframes from stylesheets", () => {
    const css = `
      .cpMYQEmzrwE-.KYyL28hMlIs-:hover { opacity: 1; }
      .PlainGlobalClass { display: block; }
      @keyframes _3FYz4ttcnbo- { from { opacity: 0; } to { opacity: 1; } }
      .Unmatched01- { color: red; }
    `;
    const res = extractCssClassesFromStylesheets([css]);
    expect(res.hashes.has("cpMYQEmzrwE-")).toBe(true);
    expect(res.hashes.has("KYyL28hMlIs-")).toBe(true);
    expect(res.hashes.has("Unmatched01-")).toBe(true);
    expect(res.hashes.has("PlainGlobalClass")).toBe(false);
    expect(res.keyframes.has("_3FYz4ttcnbo-")).toBe(true);
  });

  test("joins beta dump, webpack dump, translation chains, id_to_name, and unmatched hashes", () => {
    const betaDump = {
      "27752": {
        "duration-app-launch": "800ms",
        Keyboard: "cpMYQEmzrwE-",
        KeyboardKey: "XAg5S4OXHfs-",
        shine: "_3FYz4ttcnbo-",
      },
      "99999": {
        BrandNewBetaPanel: "NewBetaHash1-",
      },
    };
    const webpackDump = {
      "27752": {
        "duration-app-launch": "800ms",
        Keyboard: "_1OldKbHash1234567890",
        KeyboardKey: "_2OldKeyHash123456789",
        shine: "_3OldShineHash1234567",
      },
    };
    const betaChains = {
      "chain-kb": ["_0AncientKb", "_1OldKbHash1234567890", "cpMYQEmzrwE-"],
      "chain-key": ["_2OldKeyHash123456789", "XAg5S4OXHfs-"],
    };
    const idToName = { "27752": "VirtualKeyboard" };
    const cssScan = {
      hashes: new Set(["cpMYQEmzrwE-", "XAg5S4OXHfs-", "NewBetaHash1-", "OrphanHash12-"]),
      keyframes: new Set(["_3FYz4ttcnbo-"]),
    };

    const idx = buildCssIndex({
      betaDump,
      webpackDump,
      betaChains,
      idToName,
      plainLiterals: ["Focusable", "GamepadMode"],
      cssScan,
    });

    // Matched semantic class with Webpack bridge & chain
    const kb = idx.cssClasses.find((c) => c.hash === "cpMYQEmzrwE-");
    expect(kb).toBeDefined();
    expect(kb!.semanticName).toBe("Keyboard");
    expect(kb!.moduleName).toBe("VirtualKeyboard");
    expect(kb!.featureArea).toBe("Keyboard");
    expect(kb!.webpackHash).toBe("_1OldKbHash1234567890");
    expect(kb!.chainId).toBe("chain-kb");
    expect(kb!.chainHistoryCount).toBe(3);
    expect(kb!.confidence).toBe("verified");
    expect(kb!.migration).toBe("changed");
    expect(kb!.isKeyframe).toBe(false);

    // Keyframe flag preserved
    const shine = idx.cssClasses.find((c) => c.hash === "_3FYz4ttcnbo-");
    expect(shine?.isKeyframe).toBe(true);

    // Non-mappable CSS constant like "800ms" is excluded from CSS class entries
    expect(idx.cssClasses.some((c) => c.semanticName === "duration-app-launch")).toBe(false);

    // Brand-new semantic class in beta (no Webpack counterpart) -> migration: "new"
    const brandNew = idx.cssClasses.find((c) => c.hash === "NewBetaHash1-");
    expect(brandNew?.migration).toBe("new");
    expect(brandNew?.webpackHash).toBeNull();

    // Unmatched Vite hash from stylesheet -> included in exhaustive index with confidence/migration "unmatched"
    const orphan = idx.cssClasses.find((c) => c.hash === "OrphanHash12-");
    expect(orphan).toBeDefined();
    expect(orphan!.semanticName).toBeNull();
    expect(orphan!.confidence).toBe("unmatched");
    expect(orphan!.migration).toBe("unmatched");
    expect(idx.plainClasses).toEqual(["Focusable", "GamepadMode"]);
  });
});

describe("dev_guide_extract: Vite chunk AST analysis", () => {
  test("extracts component-to-CSS-hash edges, observed props, store fields, SteamClient APIs, and displayName", () => {
    const chunkSrc = `
      const s_kb = "cpMYQEmzrwE-";
      const s_key = "XAg5S4OXHfs-";
      const styles = { Keyboard: s_kb, KeyboardKey: s_key };
      function KbKey({ label, disabled = false, ...rest }) {
        const active = rest.isPressed;
        return jsx("button", { className: s_key, "data-label": label, disabled });
      }
      KbKey.displayName = "VirtualKeyboardKey";
      const KbPanel = forwardRef((props, ref) => {
        SteamClient.Input.ShowVirtualKeyboard();
        return jsxs("div", { ref, className: styles.Keyboard, children: [props.header, jsx(KbKey, { label: props.title })] });
      });
      class KbStore {
        m_bVisible = false;
        m_strLayout = "qwerty";
        ShowKeyboard() {
          SteamClient.Overlay.SetNotificationPosition(1);
        }
      }
      const g_kbStore = new KbStore();
      export { KbKey as Ka, KbPanel as Kp, g_kbStore as Ks };
    `;
    const knownHashes = new Set(["cpMYQEmzrwE-", "XAg5S4OXHfs-"]);
    const ast = analyzeViteChunkAst("chunk~kb123.js", chunkSrc, knownHashes);

    const keyInfo = ast.symbols.get("KbKey");
    expect(keyInfo).toBeDefined();
    expect(keyInfo!.cssHashes).toContain("XAg5S4OXHfs-");
    expect(keyInfo!.props).toContain("label");
    expect(keyInfo!.props).toContain("disabled");
    expect(keyInfo!.props).toContain("isPressed");
    expect(keyInfo!.displayName).toBe("VirtualKeyboardKey");
    expect(keyInfo!.rendersJsx).toBe(true);

    const panelInfo = ast.symbols.get("KbPanel");
    expect(panelInfo).toBeDefined();
    expect(panelInfo!.cssHashes).toContain("cpMYQEmzrwE-");
    expect(panelInfo!.props).toContain("header");
    expect(panelInfo!.props).toContain("title");
    expect(panelInfo!.steamClientApis).toContain("SteamClient.Input.ShowVirtualKeyboard");

    // Export alias resolution (Ka -> KbKey)
    expect(ast.exportAliasToLocal.get("Ka")).toBe("KbKey");
    expect(ast.exportAliasToLocal.get("Kp")).toBe("KbPanel");

    const storeClass = ast.symbols.get("KbStore");
    expect(storeClass).toBeDefined();
    expect(storeClass!.storeFields).toEqual(["m_bVisible", "m_strLayout"]);
    expect(storeClass!.steamClientApis).toContain("SteamClient.Overlay.SetNotificationPosition");
  });
});

describe("dev_guide_extract: Dual-bundle Webpack -> Vite matcher", () => {
  test("matches unnamed exports across Webpack -> Vite using fingerprints and semantic CSS overlap", () => {
    const webpackExports: WebpackExportRecord[] = [
      {
        at: ["27752:Kb"],
        kind: "component",
        strings: ["VirtualKeyboardRow", "aria-keyshortcuts"],
        names: ["onKeyPress", "bShifted", "rgKeys"],
        methods: [],
        keys: [],
        cssKeys: ["Keyboard", "KeyboardKey", "KeyboardRow"],
      },
      {
        at: ["65982:z"],
        kind: "store",
        strings: [],
        names: [],
        methods: ["UpdateRoutingInfo", "PushPath"],
        keys: ["m_history", "m_navigator", "m_locationPathname"],
        cssKeys: [],
      },
      {
        at: ["99999:AmbigA"],
        kind: "component",
        strings: ["DuplicateToastMessage"],
        names: ["onCloseToast", "toastTimeout"],
        methods: [],
        keys: [],
        cssKeys: [],
      },
      {
        at: ["99998:AmbigB"],
        kind: "component",
        strings: ["DuplicateToastMessage"],
        names: ["onCloseToast", "toastTimeout"],
        methods: [],
        keys: [],
        cssKeys: [],
      },
    ];

    const viteExports: ViteRuntimeExport[] = [
      {
        id: "exp:chunk~kb.js:Xa",
        at: ["esm:chunk~kb.js:Xa"],
        kind: "component",
        strings: ["VirtualKeyboardRow", "aria-keyshortcuts", "cpMYQEmzrwE-", "XAg5S4OXHfs-"],
        names: ["onKeyPress", "bShifted", "rgKeys"],
        methods: [],
        keys: [],
        cssHashes: ["cpMYQEmzrwE-", "XAg5S4OXHfs-"],
      },
      {
        id: "exp:chunk~nav.js:Hz",
        at: ["esm:chunk~nav.js:Hz"],
        kind: "store",
        strings: [],
        names: [],
        methods: ["UpdateRoutingInfo", "PushPath"],
        keys: ["m_history", "m_navigator", "m_locationPathname"],
        cssHashes: [],
      },
      {
        id: "exp:chunk~dup.js:Da",
        at: ["esm:chunk~dup.js:Da"],
        kind: "component",
        strings: ["DuplicateToastMessage"],
        names: ["onCloseToast", "toastTimeout"],
        methods: [],
        keys: [],
        cssHashes: [],
      },
    ];

    const hashToSemantic = new Map<string, string>([
      ["cpMYQEmzrwE-", "Keyboard"],
      ["XAg5S4OXHfs-", "KeyboardKey"],
    ]);

    const matches = matchWebpackToVite(webpackExports, viteExports, hashToSemantic);

    expect(matches.get("exp:chunk~kb.js:Xa")?.webpackAt).toEqual(["27752:Kb"]);
    expect(matches.get("exp:chunk~kb.js:Xa")!.score).toBeGreaterThanOrEqual(70);
    expect(matches.get("exp:chunk~nav.js:Hz")?.webpackAt).toEqual(["65982:z"]);
    // Ambiguous duplicate webpack targets must NOT be force-matched
    expect(matches.has("exp:chunk~dup.js:Da")).toBe(false);
  });
});

describe("dev_guide_extract: Semantic naming & end-to-end GuideData assembly", () => {
  test("infers semantic names with explicit confidence tiers and builds bidirectional cross-links", () => {
    const betaDump = {
      "27752": { Keyboard: "cpMYQEmzrwE-", KeyboardKey: "XAg5S4OXHfs-" },
      "50777": { SliderTrack: "SlTrAcKhAsH-" },
    };
    const webpackDump = {
      "27752": { Keyboard: "_1OldKbHash", KeyboardKey: "_2OldKeyHash" },
      "50777": { SliderTrack: "_3OldSliderHash" },
    };
    const cssIndex = buildCssIndex({
      betaDump,
      webpackDump,
      betaChains: { "c1": ["_1OldKbHash", "cpMYQEmzrwE-"] },
      idToName: { "27752": "Keyboard" },
      plainLiterals: ["Focusable"],
      cssScan: { hashes: new Set(["cpMYQEmzrwE-", "XAg5S4OXHfs-", "SlTrAcKhAsH-", "NewUnkHash1-"]), keyframes: new Set() },
    });

    const data = buildGuideData({
      betaMeta: { branch: "publicbeta", version: "1795048523", isVite: true, chunkCount: 2, moduleCount: 4 },
      webpackMeta: { branch: "stable", version: "1794536281", exportCount: 2 },
      cssIndex,
      verifiedRuntime: {
        "components/SliderField.js:SliderField": {
          at: ["esm:chunk~ui.js:Kc"],
          sourcePackage: "@decky/ui",
          kind: "component",
          webpackAt: ["50777:Kc"],
          props: ["label", "value"],
          strings: ["SliderField", "SlTrAcKhAsH-"],
          names: ["label", "value"],
          methods: [],
          keys: [],
        },
      },
      icons: [{ name: "SteamLogo", viteAt: ["esm:chunk~ico.js:SteamLogo"], webpackAt: ["111:SteamLogo"], directional: false }],
      runtimeExports: [
        {
          id: "exp:chunk~ui.js:Kc",
          at: ["esm:chunk~ui.js:Kc"],
          kind: "component",
          strings: ["SliderField", "SlTrAcKhAsH-"],
          names: ["label", "value"],
          methods: [],
          keys: [],
          cssHashes: ["SlTrAcKhAsH-"],
        },
        {
          id: "exp:chunk~kb.js:Ka",
          at: ["esm:chunk~kb.js:Ka"],
          kind: "component",
          strings: ["cpMYQEmzrwE-", "XAg5S4OXHfs-"],
          names: ["onKeyPress"],
          methods: [],
          keys: [],
          cssHashes: ["cpMYQEmzrwE-", "XAg5S4OXHfs-"],
        },
        {
          id: "exp:chunk~kb.js:zt",
          at: ["esm:chunk~kb.js:zt"],
          kind: "helper",
          strings: [],
          names: ["foo"],
          methods: [],
          keys: [],
          cssHashes: [],
        },
      ],
      chunkAnalyses: new Map([
        ["chunk~kb.js", analyzeViteChunkAst("chunk~kb.js", `
          function Ka({ onKeyPress }) { return jsx("div", { className: "cpMYQEmzrwE-", children: jsx("span", { className: "XAg5S4OXHfs-" }) }); }
          Ka.displayName = "KeyboardSurface";
          function zt(x) { return x.foo; }
        `, new Set(["cpMYQEmzrwE-", "XAg5S4OXHfs-"]))],
      ]),
      webpackMatches: new Map([
        ["exp:chunk~kb.js:Ka", { webpackAt: ["27752:Kb"], score: 88 }],
      ]),
    });

    expect(validatePublicGuideData(data)).toEqual([]);

    // Verified component
    const slider = data.exports.find((e) => e.name === "SliderField");
    expect(slider).toBeDefined();
    expect(slider!.confidence).toBe("verified");
    expect(slider!.recipe).toContain('import { SliderField } from "@decky/ui"');
    expect(slider!.cssClasses).toContain("css:50777/SliderTrack");

    // Bidirectional backlink from CSS class -> component
    const sliderTrack = data.cssClasses.find((c) => c.hash === "SlTrAcKhAsH-");
    expect(sliderTrack?.usedBy).toContain(slider!.id);

    // Inferred component named via displayName + CSS module
    const kbSurface = data.exports.find((e) => e.name === "KeyboardSurface");
    expect(kbSurface).toBeDefined();
    expect(kbSurface!.confidence).toBe("inferred");
    expect(kbSurface!.featureArea).toBe("Keyboard");
    expect(kbSurface!.webpackAt).toEqual(["27752:Kb"]);
    expect(kbSurface!.cssClasses).toContain("css:27752/Keyboard");

    // Unmatched helper stays honestly tagged unmatched
    const opaque = data.exports.find((e) => e.viteAt.includes("esm:chunk~kb.js:zt"));
    expect(opaque?.confidence).toBe("unmatched");
  });

  test("dev_guide_docs provides plain-English descriptions and UI placements for components, stores, and CSS modules", () => {
    const btnDoc = describeExport({
      name: "ButtonItem",
      kind: "component",
      sourcePackage: "@decky/ui",
      featureArea: "CommonUI",
      props: ["label", "description", "onClick"],
      storeFields: [],
      steamClientApis: [],
      cssModuleNames: [],
    });
    expect(btnDoc.description.length).toBeGreaterThan(20);
    expect(btnDoc.placements).toContain("qam-drawer");
    expect(btnDoc.placements).toContain("settings-panel");
    expect(PLACEMENT_LABELS["qam-drawer"]).toBeTruthy();

    const inferredStore = describeExport({
      name: "KeyboardStore",
      kind: "store",
      sourcePackage: "steamui",
      featureArea: "Keyboard",
      props: [],
      storeFields: ["m_bVisible", "m_strLayout"],
      steamClientApis: ["SteamClient.Input.ShowVirtualKeyboard"],
      cssModuleNames: [],
    });
    expect(inferredStore.description).toContain("m_bVisible");
    expect(inferredStore.placements).toContain("virtual-keyboard");

    const cssDoc = describeCssModule("Keyboard", "Keyboard", ["KeyboardKey", "KeyboardRow"]);
    expect(cssDoc.description.length).toBeGreaterThan(15);
    expect(cssDoc.placements).toContain("virtual-keyboard");
  });

  test("validatePublicGuideData rejects local previews in public mode but allows them in local preview mode", () => {
    const withPrev: GuideData = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-11-19T00:00:00.000Z",
      beta: { branch: "publicbeta", version: "1795048523", isVite: true, chunkCount: 1, moduleCount: 1 },
      webpackBaseline: { branch: "stable", version: "1794536281", exportCount: 1 },
      stats: {
        cssModules: 0, cssClasses: 0, cssMatched: 0, cssUnmatched: 0, plainClasses: 0,
        exports: 1, verifiedExports: 1, inferredExports: 0, unmatchedExports: 0, webpackMatchedExports: 1, icons: 1, chunks: 1,
      },
      featureAreas: [],
      cssModules: [],
      cssClasses: [],
      plainClasses: [],
      exports: [{
        id: "comp:ButtonItem", name: "ButtonItem", kind: "component", confidence: "verified", evidence: ["@decky/ui"],
        featureArea: "CommonUI", viteAt: ["esm:chunk~a.js:ac"], chunk: "chunk~a.js", webpackAt: ["23477:xh"],
        migration: "changed", sourcePackage: "@decky/ui", props: ["onClick"], storeFields: [], methods: [],
        steamClientApis: [], cssClasses: [], cssModules: [], recipe: 'import { ButtonItem } from "@decky/ui";',
        description: "Full-width clickable action button row.", placements: ["qam-drawer"],
        previewHtml: '<div class="DialogButton">Run</div>', previewWidth: 360,
      }],
      icons: [{
        name: "SteamLogo", viteAt: ["esm:chunk~ico.js:SteamLogo"], webpackAt: [], directional: false,
        recipe: 'import { IconsModule } from "@decky/ui"; // <IconsModule.SteamLogo />',
        previewSvg: '<svg viewBox="0 0 32 32"><path d="M0 0"/></svg>',
      }],
      chunks: [],
      previewCss: ".DialogButton { background: #3d4450; }",
    };
    expect(validatePublicGuideData(withPrev).length).toBeGreaterThan(0);
    expect(validatePublicGuideData(withPrev, { allowPreviews: true })).toEqual([]);
  });

  test("buildGuideData never embeds CSS/SVG/JS strings into auto-generated finder recipes", () => {
    const cssIndex = buildCssIndex({
      betaDump: {},
      webpackDump: {},
      betaChains: {},
      idToName: {},
      plainLiterals: [],
      cssScan: { hashes: new Set(), keyframes: new Set() },
    });
    const data = buildGuideData({
      betaMeta: { branch: "publicbeta", version: "1795048523", isVite: true, chunkCount: 1, moduleCount: 1 },
      webpackMeta: { branch: "stable", version: "1794536281", exportCount: 0 },
      cssIndex,
      verifiedRuntime: {},
      icons: [],
      runtimeExports: [
        {
          id: "rt:0",
          at: ["esm:chunk~bad.js:hrt"],
          kind: "component",
          strings: ["{color:red;padding:4px}", "<svg><path d='M0 0'/></svg>", "SafeComponentMarker"],
          names: [],
          methods: [],
          keys: [],
          cssHashes: [],
        },
      ],
      chunkAnalyses: new Map(),
      webpackMatches: new Map(),
    });
    expect(validatePublicGuideData(data)).toEqual([]);
    expect(data.exports[0].recipe).toContain("SafeComponentMarker");
  });

  test("inferExportSemantics derives store name from m_* fields and SteamClient namespace", () => {
    const inferred = inferExportSemantics(
      {
        id: "exp:chunk~st.js:Hs",
        at: ["esm:chunk~st.js:Hs"],
        kind: "store",
        strings: [],
        names: [],
        methods: ["UpdateRoutingInfo"],
        keys: ["m_history", "m_navigator", "m_locationPathname"],
        cssHashes: [],
      },
      undefined,
      new Map(),
      new Map(),
    );
    expect(inferred.confidence).toBe("inferred");
    expect(inferred.kind).toBe("store");
    expect(inferred.name).toMatch(/History|Routing|Navigator/i);
    expect(inferred.evidence.some((e) => e.startsWith("store-fields:"))).toBe(true);

    // Private _-prefixed methods and protobuf boilerplate should not produce noisy inferred names
    const noisy = inferExportSemantics(
      {
        id: "exp:chunk~p.js:aa",
        at: ["esm:chunk~p.js:aa"],
        kind: "helper",
        strings: [],
        names: [],
        methods: ["_internalHelper", "serializeBinary", "toObject"],
        keys: [],
        cssHashes: [],
      },
      undefined,
      new Map(),
      new Map(),
    );
    expect(noisy.confidence).toBe("unmatched");
  });

  test("recovers semantic names and Webpack namespace bridge for 4-segment ESM namespace exports like ExportClip", () => {
    const exp: ViteRuntimeExport = {
      id: "rt:exportclip",
      at: ["esm:chunk~198b531c82.js:$:ExportClip"],
      kind: "helper",
      strings: ["GameRecording.ExportClip#1"],
      names: [],
      methods: [],
      keys: [],
      cssHashes: [],
    };
    const inferred = inferExportSemantics(exp, undefined, new Map(), new Map());
    expect(inferred.confidence).toBe("inferred");
    expect(inferred.name).toBe("GameRecording.ExportClip");
    expect(inferred.featureArea).toBe("Media & Recording");
    expect(inferred.evidence).toContain("namespace:ExportClip");
    expect(inferred.evidence).toContain("rpc:GameRecording.ExportClip#1");

    const wpRecords: WebpackExportRecord[] = [
      {
        at: ["40326:xM"],
        kind: "helper",
        strings: [],
        names: [],
        methods: [],
        keys: ["ExportClip", "ExportClipHandler", "DeleteClip", "SaveClip"],
        cssKeys: [],
      },
    ];
    const matches = matchWebpackToVite(wpRecords, [exp], new Map());
    expect(matches.get("rt:exportclip")?.webpackAt).toEqual(["40326:xM.ExportClip"]);
  });
});

describe("dev_guide_html", () => {
  const sampleData: GuideData = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-11-19T00:00:00.000Z",
    beta: { branch: "publicbeta", version: "1795048523", isVite: true, chunkCount: 1, moduleCount: 1 },
    webpackBaseline: { branch: "stable", version: "1794536281", exportCount: 1 },
    stats: {
      cssModules: 1, cssClasses: 1, cssMatched: 1, cssUnmatched: 0, plainClasses: 0,
      exports: 1, verifiedExports: 1, inferredExports: 0, unmatchedExports: 0, webpackMatchedExports: 1, icons: 0, chunks: 1,
    },
    featureAreas: [{ id: "commonui", name: "CommonUI", componentCount: 1, storeCount: 0, cssModuleCount: 1, cssClassCount: 1 }],
    cssModules: [{ id: "mod:50777", moduleId: "50777", name: "CommonUI", featureArea: "CommonUI", classCount: 1, matchedCount: 1, classes: ["css:50777/Track"], usedBy: ["comp:SliderField"] }],
    cssClasses: [{
      id: "css:50777/Track", hash: "AbCdEfGhIjK-", semanticName: "Track", moduleId: "50777", moduleName: "CommonUI",
      featureArea: "CommonUI", webpackHash: "_1OldTrack", chainId: "c1", chainHistoryCount: 2, confidence: "verified",
      migration: "changed", isKeyframe: false, usedBy: ["comp:SliderField"], cssSnippet: ".AbCdEfGhIjK- /* CommonUI.Track */",
    }],
    plainClasses: [],
    exports: [{
      id: "comp:SliderField", name: "SliderField", kind: "component", confidence: "verified", evidence: ["@decky/ui"],
      featureArea: "CommonUI", viteAt: ["esm:chunk~a.js:Kc"], chunk: "chunk~a.js", webpackAt: ["50777:Kc"],
      webpackMatchScore: 100, migration: "changed", sourcePackage: "@decky/ui", props: ["value"], storeFields: [],
      methods: [], steamClientApis: [], cssClasses: ["css:50777/Track"], cssModules: ["mod:50777"],
      recipe: 'import { SliderField } from "@decky/ui";',
    }],
    icons: [],
    chunks: [{ name: "chunk~a.js", exportCount: 1, cssClassCount: 1, featureAreas: ["CommonUI"] }],
  };

  test("renders split-mode HTML fetching data.json using Valve color guide tokens", () => {
    const html = renderGuideHtml({ dataUrl: "./data.json" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(VALVE_PALETTE.bgDarkest);
    expect(html).toContain(VALVE_PALETTE.accentBlue);
    expect(html).toContain(VALVE_PALETTE.bgStoreDark);
    expect(html).toContain("./data.json");
    expect(html).toContain("id=\"omnibox\"");
    expect(html).toContain("id=\"translator-input\"");
    expect(html).toContain("id=\"virtual-viewport\"");
    expect(html).toContain("id=\"detail-drawer\"");
  });

  test("renders --single-file HTML with safely escaped embedded JSON and valid client JS", async () => {
    const { parse } = await import("acorn");
    const tricky = structuredClone(sampleData);
    tricky.exports[0].recipe = 'import { X } from "@decky/ui"; // </script><img onerror=1>';
    const html = renderGuideHtml({ embeddedData: tricky });
    expect(html).toContain('id="guide-data"');
    expect(html).not.toContain("</script><img");
    expect(html).toContain("\\u003c/script\\u003e");
    const clientJs = await Bun.file(new URL("./dev_guide_client.js", import.meta.url)).text();
    expect(() => parse(clientJs, { ecmaVersion: "latest", sourceType: "script" })).not.toThrow();
  });
});

describe("dev_guide CLI helpers", () => {
  test("isViteDump distinguishes Vite trailing-dash dumps from Webpack dumps", () => {
    expect(isViteDump({ "1": { A: "cpMYQEmzrwE-", B: "XAg5S4OXHfs-", C: "800ms" } })).toBe(true);
    expect(isViteDump({ "1": { A: "_1OldWebpackHash123456", B: "_2AnotherOldHash99999" } })).toBe(false);
  });

  test("loadMappingDataFiles picks newest beta dump and newest pre-Vite Webpack dump", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dev-guide-test-"));
    try {
      await mkdir(join(dir, "webpack"), { recursive: true });
      await mkdir(join(dir, "webpack-literals"), { recursive: true });
      await Bun.write(join(dir, "webpack/1794536281.stable.json"), JSON.stringify({ "10": { Foo: "_1OldFooHash" } }));
      await Bun.write(join(dir, "webpack/1795048523.beta.json"), JSON.stringify({ "10": { Foo: "cpMYQEmzrwE-" } }));
      await Bun.write(join(dir, "webpack-literals/1795048523.beta.json"), JSON.stringify(["Focusable"]));
      await Bun.write(join(dir, "id_to_name.json"), JSON.stringify({ "10": "FooModule" }));
      await Bun.write(join(dir, "beta.json"), JSON.stringify({ "id-1": ["_1OldFooHash", "cpMYQEmzrwE-"] }));

      const loaded = await loadMappingDataFiles(dir);
      expect(loaded.betaVersion).toBe("1795048523");
      expect(loaded.webpackVersion).toBe("1794536281");
      expect(loaded.idToName["10"]).toBe("FooModule");
      expect(loaded.plainLiterals).toEqual(["Focusable"]);
      expect(loaded.betaChains["id-1"]).toEqual(["_1OldFooHash", "cpMYQEmzrwE-"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inlineLocalPreviewAssets converts ephemeral localhost image URLs to base64 data URIs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dev-guide-assets-"));
    try {
      await mkdir(join(dir, "images"), { recursive: true });
      const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await Bun.write(join(dir, "images/steam_spinner.png"), fakePng);

      const previews = {
        components: {
          SteamSpinner: {
            html: '<img alt="Steam Spinner" src="http://127.0.0.1:41395/images/steam_spinner.png">',
            width: 360,
          },
        },
        icons: {},
        css: '.foo { background-image: url("http://127.0.0.1:41395/images/steam_spinner.png"); }',
      };

      const inlined = await inlineLocalPreviewAssets(previews, dir);
      expect(inlined.components.SteamSpinner.html).toContain("data:image/png;base64,iVBORw0KGgo=");
      expect(inlined.components.SteamSpinner.html).not.toContain("127.0.0.1");
      expect(inlined.css).toContain("data:image/png;base64,iVBORw0KGgo=");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("scopePreviewCssForGamepadMode scopes html.GamepadMode and body selectors onto .preview-stage", () => {
    const raw = `
      html.GamepadMode .DialogButton { background: #3d4450; }
      html.responsive.GamepadMode .Field { padding: 12px; }
      :root { --gpColor-Blue: #1a9fff; }
    `;
    const scoped = scopePreviewCssForGamepadMode(raw);
    expect(scoped).toContain(".preview-stage.GamepadMode .DialogButton");
    expect(scoped).toContain(".preview-stage.responsive.GamepadMode .Field");
    expect(scoped).toContain(":root { --gpColor-Blue: #1a9fff; }");
  });
});
