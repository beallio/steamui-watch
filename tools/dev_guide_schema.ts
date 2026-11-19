/**
 * Schema, Valve Steam Deck / SteamUI color guide tokens, feature-area classifier,
 * and strict public-repo Valve-asset validator for the Beta Vite Developer Guide.
 */

export const SCHEMA_VERSION = 1;

/**
 * Valve Steam Deck GamepadUI (--gpSystem* / --gpStore* / --gpColor-*) and Steam Brand color guide.
 */
export const VALVE_PALETTE = {
  // Neutrals & Surfaces (GamepadUI / Steam Store dark hierarchy)
  bgDarkest: "#0e141b",     // --gpSystemDarkestGrey
  bgHeader: "#171a21",      // Steam header / rail chrome
  bgStoreDark: "#1b2838",   // --gpStoreDarkerGrey / classic Steam deep blue
  bgSurface: "#23262e",     // --gpSystemDarkerGrey / card surface
  bgCard: "#1a2029",        // intermediate SteamUI panel
  bgElevated: "#2a475e",    // --gpStoreDarkGrey / hover & active blue-slate
  border: "#3d4450",        // --gpSystemDarkGrey
  borderSubtle: "#2a313b",
  textMuted: "#67707b",     // --gpSystemGrey
  textSub: "#8b929a",       // --gpSystemLightGrey
  textBody: "#b8bcbf",      // --gpSystemLighterGrey
  textPrimary: "#dcdedf",   // --gpSystemLightestGrey
  textBright: "#ffffff",

  // Valve Semantic Accents
  accentBlue: "#1a9fff",    // --gpColor-Blue / --color-blue-8
  accentBlueHi: "#66c0f4",  // --gpColor-ChalkyBlue / Steam brand light blue
  accentBlueSoft: "#c2e6ff",// --color-blue-12 (code highlights)
  accentBlueTint: "#0d2847",// --color-blue-3
  verifiedGreen: "#5ba32b", // --gpColor-Green
  verifiedGreenHi: "#a1bf07",
  verifiedGreenTint: "#1c2e14",
  inferredAmber: "#ffc53d", // --color-amber-9 / --gpColor-Yellow
  inferredAmberTint: "#302008",
  unmatchedRed: "#ec5d5e",  // --color-red-10 / --gpColor-Red
  unmatchedRedTint: "#3b1219",
} as const;

export type ConfidenceTier = "verified" | "inferred" | "unmatched";
export type MigrationStatus = "unchanged" | "changed" | "new" | "unmatched";
export type ExportKind = "component" | "store" | "icon" | "helper";
export type SourcePackage =
  | "@decky/ui"
  | "@beallio/decky-extras"
  | "decky-loader"
  | "IconsModule"
  | "CommonUIModule"
  | "steamui";

export interface CssClassEntry {
  id: string;
  hash: string;
  semanticName: string | null;
  moduleId: string | null;
  moduleName: string;
  featureArea: string;
  webpackHash: string | null;
  chainId: string | null;
  chainHistoryCount: number;
  confidence: ConfidenceTier;
  migration: MigrationStatus;
  isKeyframe: boolean;
  usedBy: string[];
  cssSnippet: string;
}

export interface CssModuleEntry {
  id: string;
  moduleId: string;
  name: string;
  featureArea: string;
  classCount: number;
  matchedCount: number;
  classes: string[];
  usedBy: string[];
}

export interface JsExportEntry {
  id: string;
  name: string;
  kind: ExportKind;
  confidence: ConfidenceTier;
  evidence: string[];
  featureArea: string;
  viteAt: string[];
  chunk: string;
  webpackAt: string[];
  webpackMatchScore?: number;
  migration: MigrationStatus;
  sourcePackage: SourcePackage;
  props: string[];
  storeFields: string[];
  methods: string[];
  steamClientApis: string[];
  cssClasses: string[];
  cssModules: string[];
  recipe: string;
}

export interface IconEntry {
  name: string;
  viteAt: string[];
  webpackAt: string[];
  directional: boolean;
  recipe: string;
}

export interface ChunkEntry {
  name: string;
  exportCount: number;
  cssClassCount: number;
  featureAreas: string[];
}

export interface FeatureAreaSummary {
  id: string;
  name: string;
  componentCount: number;
  storeCount: number;
  cssModuleCount: number;
  cssClassCount: number;
}

export interface GuideStats {
  cssModules: number;
  cssClasses: number;
  cssMatched: number;
  cssUnmatched: number;
  plainClasses: number;
  exports: number;
  verifiedExports: number;
  inferredExports: number;
  unmatchedExports: number;
  webpackMatchedExports: number;
  icons: number;
  chunks: number;
}

export interface GuideData {
  schemaVersion: number;
  generatedAt: string;
  beta: {
    branch: string;
    version: string;
    isVite: boolean;
    chunkCount: number;
    moduleCount: number;
  };
  webpackBaseline: {
    branch: string;
    version: string;
    exportCount: number;
  };
  stats: GuideStats;
  featureAreas: FeatureAreaSummary[];
  cssModules: CssModuleEntry[];
  cssClasses: CssClassEntry[];
  plainClasses: string[];
  exports: JsExportEntry[];
  icons: IconEntry[];
  chunks: ChunkEntry[];
}

const FEATURE_RULES: [string, RegExp][] = [
  ["Keyboard", /keyboard|virtualkeyboard|emojikeyboard|numpad|numerickeypad|touchpadpointer|trackpad/i],
  ["Settings", /settings|preferences|systeminfo|softwareupdate|hostname|bluetooth|wifi|network|display|audio|microphone|hotkey|power|storage|customization|license/i],
  ["Overlay & Menus", /quickaccess|qam|mainmenu|contextmenu|menu(?:item|group|separator|popup)?|overlay|pinned|footer|headerbar|topbar|toast|notification|modal|popover|tooltip/i],
  ["Broadcast", /broadcast|multistream|streamcapsule|streamicon|viewer_?bar|vod_?title|embedded_?player/i],
  ["Store", /store|salewidget|discoveryqueue|wishlist|capsule|bundle|cart|checkout|price|discount|microtrailer|trailer/i],
  ["Friends & Chat", /friend|chat|voice|party|invite|avatar|persona|clan|groupchat|emoticon|sticker/i],
  ["Media & Recording", /gamerecording|recording|timeline|clip|screenshot|video|playback|media|music|soundtrack/i],
  ["Gamepad & Input", /gamepad|controller|configurator|chord|gyro|actionglyph|binding|haptic|calibration|deck/i],
  ["Library", /library|appdetails|appgrid|appoverview|gamelist|collection|shelf|hero|carousel|achievement|badge|playbar|download|install|workshop|cloud|compat|proton|bpmgame/i],
  ["CommonUI", /commonui|dialog|slider|toggle|checkbox|dropdown|buttonitem|textfield|progressbar|spinner|marquee|scrollpanel|focusable|focusring|field|radio|pininput|callout|tab|sidebar|panelsection|controlslist|reorderable|errorboundary|router/i],
];

export function classifyFeatureArea(hints: Iterable<string>): string {
  const counts = new Map<string, number>();
  for (const raw of hints) {
    if (!raw) continue;
    for (const [area, rx] of FEATURE_RULES) {
      if (rx.test(raw)) {
        counts.set(area, (counts.get(area) ?? 0) + 1);
      }
    }
  }
  let best = "System & Misc";
  let bestScore = 0;
  for (const [area, count] of counts) {
    if (count > bestScore) {
      best = area;
      bestScore = count;
    }
  }
  return best;
}

export function slugifyArea(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const SVG_LEAK = /<svg\b|<\/svg>|<path\b[^>]*\bd=/i;
const RAW_CSS_BLOCK = /\{[^}]*:[^{};]+;[^}]*\}/;
const RAW_JS_BODY = /\b(?:function\s*\([^)]*\)\s*\{[^}]*\breturn\b|=>\s*\{[^}]*\breturn\b|\bjsx(?:s|DEV)?\s*\(\s*["'])/;

/**
 * Enforce the strict public-repo Valve-asset boundary:
 * zero raw Valve JS bodies, zero verbatim CSS rule declarations, zero SVG markup.
 */
export function validatePublicGuideData(data: GuideData): string[] {
  const errors: string[] = [];
  if (data.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion: ${data.schemaVersion}`);
  }
  const checkStr = (label: string, value: string | null | undefined) => {
    if (!value) return;
    if (SVG_LEAK.test(value)) errors.push(`${label} contains SVG markup`);
    if (RAW_CSS_BLOCK.test(value)) errors.push(`${label} contains raw CSS declarations`);
    if (RAW_JS_BODY.test(value)) errors.push(`${label} contains raw JS body`);
    if (value.length > 1000) errors.push(`${label} exceeds metadata length limit (${value.length} > 1000)`);
  };

  for (const c of data.cssClasses) {
    checkStr(`cssClass[${c.id}].cssSnippet`, c.cssSnippet);
    checkStr(`cssClass[${c.id}].semanticName`, c.semanticName);
  }
  for (const e of data.exports) {
    checkStr(`export[${e.id}].recipe`, e.recipe);
    checkStr(`export[${e.id}].name`, e.name);
    for (const ev of e.evidence) checkStr(`export[${e.id}].evidence`, ev);
  }
  for (const icon of data.icons) {
    checkStr(`icon[${icon.name}].recipe`, icon.recipe);
  }
  return errors;
}
