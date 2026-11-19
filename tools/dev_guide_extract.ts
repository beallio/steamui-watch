/**
 * Pure, testable data extraction, Vite AST cross-linking, dual-bundle Webpack -> Vite
 * fingerprint matching, and semantic GuideData assembly.
 */
import { parse } from "acorn";
import {
  classifyFeatureArea,
  SCHEMA_VERSION,
  slugifyArea,
  type ChunkEntry,
  type ConfidenceTier,
  type CssClassEntry,
  type CssModuleEntry,
  type ExportKind,
  type FeatureAreaSummary,
  type GuideData,
  type IconEntry,
  type JsExportEntry,
  type MigrationStatus,
  type SourcePackage,
} from "./dev_guide_schema";
import { describeCssModule, describeExport } from "./dev_guide_docs";

export const VITE_HASH_RE = /^_?[A-Za-z0-9_-]{11}-$/;
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const CSS_CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/g;
const KEYFRAMES_RE = /@keyframes\s+(-?[_a-zA-Z][\w-]*)\s*\{/g;
const JSX_CALLS = new Set(["jsx", "jsxs", "jsxDEV", "createElement"]);

const GENERIC_CSS_KEYS = new Set([
  "Active", "Background", "Body", "Bottom", "Button", "Buttons", "Center", "Centered", "Close",
  "Column", "Container", "Content", "Control", "Controls", "Current", "Default", "Description",
  "Disabled", "Divider", "Empty", "Enabled", "Error", "Fade", "Focus", "Focused", "Footer",
  "Group", "Header", "Hidden", "Hover", "Icon", "Image", "Img", "Info", "Inner", "Input",
  "Item", "Items", "Label", "Left", "Line", "Link", "List", "Loading", "Main", "Message",
  "Middle", "Modal", "Name", "Normal", "Open", "Outer", "Overlay", "Page", "Panel", "Parent",
  "Placeholder", "Primary", "Right", "Root", "Row", "Rows", "Scroll", "Secondary", "Section",
  "Selected", "Separator", "Show", "Showing", "Size", "Small", "Spacer", "State", "Status",
  "SubHeader", "SubTitle", "Subtitle", "Text", "Title", "Top", "Value", "Visible", "Warning",
  "Wrapper", "container", "wrapper", "active", "disabled", "selected", "hidden", "visible",
  "left", "right", "top", "bottom", "middle", "text", "label", "icon", "title", "content",
  "header", "footer", "button", "item", "row", "list", "root", "inner", "outer",
]);

const GENERIC_TOKENS = new Set([
  "toString", "render", "type", "prototype", "constructor", "length", "call", "apply", "bind",
  "children", "className", "style", "createElement", "jsx", "jsxs", "jsxDEV", "Fragment",
  "component", "fallback", "default", "value", "props", "state", "context", "displayName",
  "useState", "useEffect", "useMemo", "useCallback", "useRef", "useContext", "forwardRef", "memo",
  "onClick", "onChange", "onFocus", "onBlur", "disabled", "label", "title", "description",
  "div", "span", "button", "input", "img", "true", "false", "null", "undefined", "function",
  "object", "string", "number", "boolean", "return", "index", "width", "height", "class",
]);

export function isViteHash(name: string): boolean {
  return VITE_HASH_RE.test(name);
}

export function isMappableCssValue(value: string): boolean {
  return value.length > 0 && !/^\d/.test(value) && !value.includes(" ");
}

export interface CssStylesheetScan {
  hashes: Set<string>;
  keyframes: Set<string>;
}

export function extractCssClassesFromStylesheets(cssSources: Iterable<string>): CssStylesheetScan {
  const hashes = new Set<string>();
  const keyframes = new Set<string>();
  for (const raw of cssSources) {
    const clean = raw.replace(CSS_COMMENT_RE, "");
    for (const m of clean.matchAll(CSS_CLASS_RE)) {
      if (isViteHash(m[1])) hashes.add(m[1]);
    }
    for (const m of clean.matchAll(KEYFRAMES_RE)) {
      if (isViteHash(m[1])) keyframes.add(m[1]);
    }
  }
  return { hashes, keyframes };
}

export interface CssIndex {
  cssModules: CssModuleEntry[];
  cssClasses: CssClassEntry[];
  plainClasses: string[];
  hashToClassId: Map<string, string>;
  hashToSemantic: Map<string, string>;
  webpackHashToViteHash: Map<string, string>;
  moduleById: Map<string, CssModuleEntry>;
  classById: Map<string, CssClassEntry>;
}

function deriveModuleName(moduleId: string, keys: string[], idToName: Record<string, string>): string {
  if (idToName[moduleId]) return idToName[moduleId];
  const meaningful = keys.filter((k) => !GENERIC_CSS_KEYS.has(k) && k.length >= 4);
  const pool = meaningful.length ? meaningful : keys;
  if (!pool.length) return `Module_${moduleId}`;

  // Look for a shared CamelCase / snake_case prefix across >= 2 keys.
  const prefixCounts = new Map<string, number>();
  for (const k of pool) {
    const words = k.split(/(?=[A-Z][a-z])|_|-/).filter(Boolean);
    if (words.length >= 1 && words[0].length >= 4 && !GENERIC_CSS_KEYS.has(words[0])) {
      prefixCounts.set(words[0], (prefixCounts.get(words[0]) ?? 0) + 1);
    }
    if (words.length >= 2) {
      const two = words[0] + words[1];
      if (two.length >= 6 && !GENERIC_CSS_KEYS.has(two)) {
        prefixCounts.set(two, (prefixCounts.get(two) ?? 0) + 1);
      }
    }
  }
  let bestPrefix = "";
  let bestScore = 0;
  for (const [prefix, count] of prefixCounts) {
    if (count < 2) continue;
    const score = count * 10 + Math.min(prefix.length, 20);
    if (score > bestScore) {
      bestPrefix = prefix;
      bestScore = score;
    }
  }
  if (bestPrefix) return bestPrefix;

  // Prefer a key ending in Container/Modal/Dialog/Section/Panel/Page/Bar/View/Ctn, else shortest descriptive PascalCase key.
  const containerLike = pool.find((k) => /(?:Container|Modal|Dialog|Panel|Page|Section|View|Keyboard|Overlay|Menu|Store|Broadcast|Library|Ctn)$/.test(k));
  if (containerLike) return containerLike.replace(/(?:Container|Ctn)$/, "") || containerLike;
  return [...pool].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

export function buildCssIndex(opts: {
  betaDump: Record<string, Record<string, string>>;
  webpackDump: Record<string, Record<string, string>>;
  betaChains: Record<string, string[]>;
  idToName: Record<string, string>;
  plainLiterals: string[];
  cssScan: CssStylesheetScan;
}): CssIndex {
  const { betaDump, webpackDump, betaChains, idToName, plainLiterals, cssScan } = opts;

  // Map current (newest) hash -> chain metadata, and old webpack hash -> chain metadata.
  const newestToChain = new Map<string, { chainId: string; count: number; prev: string | null }>();
  const webpackHashToViteHash = new Map<string, string>();
  for (const [chainId, list] of Object.entries(betaChains)) {
    if (!Array.isArray(list) || !list.length) continue;
    const newest = list[list.length - 1];
    const prev = list.length >= 2 ? list[list.length - 2] : null;
    if (!newestToChain.has(newest) || list.length > newestToChain.get(newest)!.count) {
      newestToChain.set(newest, { chainId, count: list.length, prev });
    }
    for (let i = 0; i < list.length - 1; i++) {
      webpackHashToViteHash.set(list[i], newest);
    }
  }

  // Index webpack dump by moduleId:propName and by propName (fallback when moduleId changed).
  const wpByModProp = new Map<string, string>();
  for (const [modId, entries] of Object.entries(webpackDump)) {
    for (const [prop, val] of Object.entries(entries)) {
      if (typeof val === "string" && isMappableCssValue(val)) {
        wpByModProp.set(`${modId}:${prop}`, val);
      }
    }
  }

  const cssModules: CssModuleEntry[] = [];
  const cssClasses: CssClassEntry[] = [];
  const hashToClassId = new Map<string, string>();
  const hashToSemantic = new Map<string, string>();
  const moduleById = new Map<string, CssModuleEntry>();
  const classById = new Map<string, CssClassEntry>();
  const coveredHashes = new Set<string>();

  for (const modId of Object.keys(betaDump).sort((a, b) => a.localeCompare(b))) {
    const rawEntries = betaDump[modId] ?? {};
    const mappableEntries = Object.entries(rawEntries)
      .filter(([, v]) => typeof v === "string" && isMappableCssValue(v))
      .sort(([a], [b]) => a.localeCompare(b));
    if (!mappableEntries.length) continue;

    const keys = mappableEntries.map(([k]) => k);
    const modName = deriveModuleName(modId, keys, idToName);
    const featureArea = classifyFeatureArea([modName, ...keys]);
    const classIds: string[] = [];

    for (const [prop, hash] of mappableEntries) {
      coveredHashes.add(hash);
      const isKeyframe = cssScan.keyframes.has(hash);
      const chain = newestToChain.get(hash);
      const directWp = wpByModProp.get(`${modId}:${prop}`) ?? null;
      const wpHash = directWp ?? (chain?.prev && chain.prev !== hash ? chain.prev : null);
      if (wpHash && wpHash !== hash) webpackHashToViteHash.set(wpHash, hash);

      let migration: MigrationStatus;
      if (wpHash) {
        migration = wpHash === hash ? "unchanged" : "changed";
      } else if (chain && chain.count >= 2) {
        migration = "changed";
      } else {
        migration = "new";
      }

      const id = `css:${modId}/${prop}`;
      const snippet = isKeyframe
        ? `@keyframes ${hash} /* ${modName}.${prop} */`
        : `.${hash} /* ${modName}.${prop} */`;

      const entry: CssClassEntry = {
        id,
        hash,
        semanticName: prop,
        moduleId: modId,
        moduleName: modName,
        featureArea,
        webpackHash: wpHash,
        chainId: chain?.chainId ?? null,
        chainHistoryCount: chain?.count ?? 0,
        confidence: "verified",
        migration,
        isKeyframe,
        usedBy: [],
        cssSnippet: snippet,
      };
      cssClasses.push(entry);
      classIds.push(id);
      classById.set(id, entry);
      if (!hashToClassId.has(hash)) hashToClassId.set(hash, id);
      if (!hashToSemantic.has(hash)) hashToSemantic.set(hash, prop);
    }

    const modDoc = describeCssModule(modName, featureArea, keys);
    const modEntry: CssModuleEntry = {
      id: `mod:${modId}`,
      moduleId: modId,
      name: modName,
      featureArea,
      classCount: classIds.length,
      matchedCount: classIds.length,
      classes: classIds,
      usedBy: [],
      description: modDoc.description,
      placements: modDoc.placements,
    };
    for (const cid of classIds) {
      const cEntry = classById.get(cid);
      if (cEntry) {
        cEntry.placements = modDoc.placements;
        cEntry.description = cEntry.isKeyframe
          ? `CSS @keyframes animation "${cEntry.semanticName}" in ${modName} (${featureArea}).`
          : `Styles the "${cEntry.semanticName}" element inside ${modName} (${featureArea}).`;
      }
    }
    cssModules.push(modEntry);
    moduleById.set(modEntry.id, modEntry);
  }

  // Include all remaining unmatched Vite hashes and keyframes observed in stylesheets.
  const unmatchedHashes = [...new Set([...cssScan.hashes, ...cssScan.keyframes])]
    .filter((h) => !coveredHashes.has(h))
    .sort((a, b) => a.localeCompare(b));

  for (const hash of unmatchedHashes) {
    const isKeyframe = cssScan.keyframes.has(hash);
    const id = `css:unmatched/${hash}`;
    const entry: CssClassEntry = {
      id,
      hash,
      semanticName: null,
      moduleId: null,
      moduleName: "Unmatched",
      featureArea: "Unmatched",
      webpackHash: null,
      chainId: null,
      chainHistoryCount: 0,
      confidence: "unmatched",
      migration: "unmatched",
      isKeyframe,
      usedBy: [],
      cssSnippet: isKeyframe ? `@keyframes ${hash} /* unmatched in Vite */` : `.${hash} /* unmatched in Vite */`,
    };
    cssClasses.push(entry);
    classById.set(id, entry);
    hashToClassId.set(hash, id);
  }

  const plainClasses = [...new Set(plainLiterals.filter((c) => typeof c === "string" && c.length > 0 && !isViteHash(c)))]
    .sort((a, b) => a.localeCompare(b));

  return {
    cssModules,
    cssClasses,
    plainClasses,
    hashToClassId,
    hashToSemantic,
    webpackHashToViteHash,
    moduleById,
    classById,
  };
}

// --- Single-pass Vite ESM chunk AST analyzer ---

type Ast = any;

export interface SymbolAstInfo {
  name: string;
  cssHashes: string[];
  props: string[];
  storeFields: string[];
  steamClientApis: string[];
  displayName: string | null;
  rendersJsx: boolean;
  isClass: boolean;
  methods: string[];
}

export interface ChunkAstAnalysis {
  chunk: string;
  symbols: Map<string, SymbolAstInfo>;
  exportAliasToLocal: Map<string, string>;
  chunkCssHashes: string[];
}

function isAstNode(v: unknown): v is Ast {
  return !!v && typeof v === "object" && typeof (v as Ast).type === "string";
}

function walkAst(node: Ast, visit: (n: Ast) => boolean | void): void {
  if (!isAstNode(node)) return;
  if (visit(node) === false) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "type" || k === "start" || k === "end" || k === "loc") continue;
    if (isAstNode(v)) walkAst(v, visit);
    else if (Array.isArray(v)) {
      for (const item of v) if (isAstNode(item)) walkAst(item, visit);
    }
  }
}

function staticPropKey(node: Ast, computed = false): string | null {
  if (!node) return null;
  if (node.type === "Identifier" && !computed) return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) return String(node.value);
  return null;
}

function literalString(node: Ast): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw ?? null;
  }
  return null;
}

function unwrapComponentInit(node: Ast): Ast {
  let cur = node;
  while (cur) {
    if (cur.type === "ParenthesizedExpression" || cur.type === "ChainExpression") {
      cur = cur.expression;
    } else if (cur.type === "SequenceExpression" && cur.expressions.length) {
      cur = cur.expressions[cur.expressions.length - 1];
    } else if (cur.type === "CallExpression" && cur.arguments.length >= 1) {
      const callee = cur.callee;
      const calleeName = callee?.type === "Identifier"
        ? callee.name
        : callee?.type === "MemberExpression"
          ? staticPropKey(callee.property, callee.computed)
          : null;
      if (calleeName && /^(?:forwardRef|memo|observer|withRouter)$/.test(calleeName)) {
        cur = cur.arguments[0];
      } else {
        // Also unwrap minified HOC wrappers like `(0,r.forwardRef)((props,ref)=>...)` or `memo(fn)` when arg 0 is a function/class
        const arg0 = cur.arguments[0];
        if (cur.arguments.length <= 2 && arg0 && (arg0.type === "ArrowFunctionExpression" || arg0.type === "FunctionExpression" || arg0.type === "ClassExpression")) {
          cur = arg0;
        } else {
          break;
        }
      }
    } else {
      break;
    }
  }
  return cur;
}

function extractPropsFromFunction(fn: Ast, props: Set<string>): void {
  const firstParam = fn.params?.[0];
  if (!firstParam) return;
  const paramAliases = new Set<string>();

  const inspectPattern = (pat: Ast) => {
    if (!pat) return;
    if (pat.type === "AssignmentPattern") {
      inspectPattern(pat.left);
    } else if (pat.type === "Identifier") {
      paramAliases.add(pat.name);
    } else if (pat.type === "ObjectPattern") {
      for (const prop of pat.properties) {
        if (prop.type === "RestElement" && prop.argument?.type === "Identifier") {
          paramAliases.add(prop.argument.name);
        } else if (prop.type === "Property") {
          const k = staticPropKey(prop.key, prop.computed);
          if (k) props.add(k);
        }
      }
    }
  };
  inspectPattern(firstParam);

  if (!paramAliases.size) return;
  walkAst(fn.body, (n) => {
    if (n.type === "MemberExpression" && n.object?.type === "Identifier" && paramAliases.has(n.object.name)) {
      const k = staticPropKey(n.property, n.computed);
      if (k) props.add(k);
    } else if (n.type === "VariableDeclarator" && n.init?.type === "Identifier" && paramAliases.has(n.init.name) && n.id?.type === "ObjectPattern") {
      inspectPattern(n.id);
    }
  });
}

function extractSteamClientPath(node: Ast): string | null {
  const parts: string[] = [];
  let cur = node;
  while (cur?.type === "MemberExpression") {
    const k = staticPropKey(cur.property, cur.computed);
    if (!k) return null;
    parts.push(k);
    cur = cur.object;
  }
  if (cur?.type === "Identifier" && cur.name === "SteamClient") {
    parts.push("SteamClient");
  } else if (cur?.type === "MemberExpression" && cur.object?.type === "Identifier" && cur.object.name === "window" && staticPropKey(cur.property, cur.computed) === "SteamClient") {
    parts.push("SteamClient");
  } else {
    return null;
  }
  parts.reverse();
  return parts.length >= 3 ? parts.slice(0, 3).join(".") : null;
}

export function analyzeViteChunkAst(chunk: string, source: string, knownHashes: Set<string>): ChunkAstAnalysis {
  let ast: Ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    try {
      ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
    } catch {
      return { chunk, symbols: new Map(), exportAliasToLocal: new Map(), chunkCssHashes: [] };
    }
  }

  // Pass 1: collect top-level CSS hash variable bindings, style objects, displayName assignments, and export aliases.
  const varToHash = new Map<string, string>();
  const objToHashMap = new Map<string, Map<string, string>>();
  const displayNames = new Map<string, string>();
  const exportAliasToLocal = new Map<string, string>();
  const chunkCssSet = new Set<string>();
  const declNodes = new Map<string, Ast>();

  const recordHashString = (val: string | null) => {
    if (val && (knownHashes.has(val) || isViteHash(val))) {
      chunkCssSet.add(val);
      return val;
    }
    return null;
  };

  const inspectDecl = (stmt: Ast) => {
    if (stmt.type === "FunctionDeclaration" && stmt.id?.name) {
      declNodes.set(stmt.id.name, stmt);
    } else if (stmt.type === "ClassDeclaration" && stmt.id?.name) {
      declNodes.set(stmt.id.name, stmt);
    } else if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations) {
        if (d.id?.type !== "Identifier" || !d.init) continue;
        const name = d.id.name;
        const str = literalString(d.init);
        if (str) {
          const h = recordHashString(str);
          if (h) varToHash.set(name, h);
          continue;
        }
        if (d.init.type === "ObjectExpression") {
          const map = new Map<string, string>();
          for (const p of d.init.properties) {
            if (p.type !== "Property") continue;
            const k = staticPropKey(p.key, p.computed);
            if (!k) continue;
            const direct = recordHashString(literalString(p.value));
            const viaVar = p.value?.type === "Identifier" ? varToHash.get(p.value.name) : null;
            const resolved = direct ?? viaVar ?? null;
            if (resolved) map.set(k, resolved);
          }
          if (map.size > 0) {
            objToHashMap.set(name, map);
            continue;
          }
        }
        declNodes.set(name, d.init);
      }
    }
  };

  for (const stmt of ast.body) {
    if (stmt.type === "ExportNamedDeclaration") {
      if (stmt.declaration) {
        inspectDecl(stmt.declaration);
        if (stmt.declaration.id?.name) exportAliasToLocal.set(stmt.declaration.id.name, stmt.declaration.id.name);
        if (stmt.declaration.declarations) {
          for (const d of stmt.declaration.declarations) {
            if (d.id?.type === "Identifier") exportAliasToLocal.set(d.id.name, d.id.name);
          }
        }
      }
      for (const spec of stmt.specifiers ?? []) {
        const expName = staticPropKey(spec.exported);
        const locName = staticPropKey(spec.local);
        if (expName && locName) exportAliasToLocal.set(expName, locName);
      }
    } else if (stmt.type === "ExpressionStatement") {
      const expr = stmt.expression;
      // Handle `Foo.displayName = "Bar"` (and comma-separated assignment chains in minified code)
      const visitAssign = (e: Ast) => {
        if (e?.type === "SequenceExpression") {
          for (const sub of e.expressions) visitAssign(sub);
        } else if (e?.type === "AssignmentExpression" && e.operator === "=" && e.left?.type === "MemberExpression") {
          if (e.left.object?.type === "Identifier" && staticPropKey(e.left.property, e.left.computed) === "displayName") {
            const dn = literalString(e.right);
            if (dn) displayNames.set(e.left.object.name, dn);
          }
        }
      };
      visitAssign(expr);
    } else {
      inspectDecl(stmt);
    }
  }

  // Pass 2: analyze each top-level symbol declaration.
  const symbols = new Map<string, SymbolAstInfo>();
  for (const [name, rawNode] of declNodes) {
    const node = unwrapComponentInit(rawNode);
    const cssHashes = new Set<string>();
    const props = new Set<string>();
    const storeFields = new Set<string>();
    const steamClientApis = new Set<string>();
    const methods = new Set<string>();
    let rendersJsx = false;
    let isClass = false;
    let displayName = displayNames.get(name) ?? null;

    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      extractPropsFromFunction(node, props);
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      isClass = true;
      for (const el of node.body?.body ?? []) {
        if (el.type === "PropertyDefinition") {
          const k = staticPropKey(el.key, el.computed);
          if (k === "displayName" && el.static) {
            const dn = literalString(el.value);
            if (dn) displayName = dn;
          } else if (k?.startsWith("m_")) {
            storeFields.add(k);
          }
        } else if (el.type === "MethodDefinition") {
          const k = staticPropKey(el.key, el.computed);
          if (k && k !== "constructor") methods.add(k);
          if (k === "render") rendersJsx = true;
        }
      }
    }

    walkAst(rawNode, (n) => {
      const lit = literalString(n);
      if (lit && (knownHashes.has(lit) || isViteHash(lit))) {
        cssHashes.add(lit);
        chunkCssSet.add(lit);
      } else if (n.type === "Identifier" && varToHash.has(n.name)) {
        cssHashes.add(varToHash.get(n.name)!);
      } else if (n.type === "MemberExpression") {
        // styles.Keyboard -> hash
        if (n.object?.type === "Identifier" && objToHashMap.has(n.object.name)) {
          const k = staticPropKey(n.property, n.computed);
          const h = k ? objToHashMap.get(n.object.name)!.get(k) : undefined;
          if (h) cssHashes.add(h);
        }
        // this.props.foo
        if (n.object?.type === "MemberExpression" && n.object.object?.type === "ThisExpression" && staticPropKey(n.object.property, n.object.computed) === "props") {
          const k = staticPropKey(n.property, n.computed);
          if (k) props.add(k);
        }
        // this.m_foo
        if (n.object?.type === "ThisExpression") {
          const k = staticPropKey(n.property, n.computed);
          if (k?.startsWith("m_")) storeFields.add(k);
        }
        // SteamClient.Ns.Method
        const sc = extractSteamClientPath(n);
        if (sc) steamClientApis.add(sc);
      } else if (n.type === "CallExpression") {
        const callee = n.callee;
        const cname = callee?.type === "Identifier"
          ? callee.name
          : callee?.type === "MemberExpression"
            ? staticPropKey(callee.property, callee.computed)
            : null;
        if (cname && JSX_CALLS.has(cname)) rendersJsx = true;
      }
    });

    symbols.set(name, {
      name,
      cssHashes: [...cssHashes].sort(),
      props: [...props].sort(),
      storeFields: [...storeFields].sort(),
      steamClientApis: [...steamClientApis].sort(),
      displayName,
      rendersJsx,
      isClass,
      methods: [...methods].sort(),
    });
  }

  return {
    chunk,
    symbols,
    exportAliasToLocal,
    chunkCssHashes: [...chunkCssSet].sort(),
  };
}

// --- Full dual-bundle Webpack -> Vite export matcher ---

export interface WebpackExportRecord {
  at: string[];
  kind: ExportKind;
  strings: string[];
  names: string[];
  methods: string[];
  keys: string[];
  cssKeys: string[];
}

export interface ViteRuntimeExport {
  id: string;
  at: string[];
  kind: ExportKind;
  strings: string[];
  names: string[];
  methods: string[];
  keys: string[];
  cssHashes: string[];
}

export interface WebpackMatch {
  webpackAt: string[];
  score: number;
}

const MATCH_WEIGHTS = {
  strings: 40,
  cssKeys: 25,
  methods: 20,
  keys: 20,
  names: 10,
} as const;

type TokenBag = {
  strings: Set<string>;
  cssKeys: Set<string>;
  methods: Set<string>;
  keys: Set<string>;
  names: Set<string>;
};

function informativeTokens(values: Iterable<string>, minLen: number): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    if (!v || v.length < minLen || GENERIC_TOKENS.has(v)) continue;
    // Skip raw Vite/Webpack hashes from direct string comparison (we compare via semantic cssKeys instead)
    if (isViteHash(v)) continue;
    out.add(v);
  }
  return out;
}

function buildWebpackBag(rec: WebpackExportRecord): TokenBag {
  return {
    strings: informativeTokens(rec.strings, 4),
    cssKeys: informativeTokens(rec.cssKeys, 3),
    methods: informativeTokens(rec.methods, 4),
    keys: informativeTokens(rec.keys, 3),
    names: informativeTokens(rec.names, 4),
  };
}

function buildViteBag(rec: ViteRuntimeExport, hashToSemantic: Map<string, string>): TokenBag {
  const cssKeys = new Set<string>();
  for (const h of rec.cssHashes) {
    const sem = hashToSemantic.get(h);
    if (sem && !GENERIC_TOKENS.has(sem) && sem.length >= 3) cssKeys.add(sem);
  }
  for (const s of rec.strings) {
    const sem = hashToSemantic.get(s);
    if (sem && !GENERIC_TOKENS.has(sem) && sem.length >= 3) cssKeys.add(sem);
  }
  return {
    strings: informativeTokens(rec.strings, 4),
    cssKeys,
    methods: informativeTokens(rec.methods, 4),
    keys: informativeTokens(rec.keys, 3),
    names: informativeTokens(rec.names, 4),
  };
}

function scoreBags(a: TokenBag, b: TokenBag): { score: number; strong: boolean } {
  let weighted = 0;
  let totalWeight = 0;
  let strong = false;

  const fields: (keyof TokenBag)[] = ["strings", "cssKeys", "methods", "keys", "names"];
  for (const f of fields) {
    const left = a[f];
    const right = b[f];
    if (!left.size && !right.size) continue;
    const w = MATCH_WEIGHTS[f];
    totalWeight += w;
    if (!left.size || !right.size) continue;
    let overlap = 0;
    let longOverlap = 0;
    for (const tok of left) {
      if (right.has(tok)) {
        overlap++;
        if (tok.length >= 7) longOverlap++;
      }
    }
    if (f === "strings" && (longOverlap >= 1 || overlap >= 2)) strong = true;
    if (f === "cssKeys" && overlap >= 2) strong = true;
    if (f === "methods" && overlap >= 1) strong = true;
    if (f === "keys" && overlap >= 2) strong = true;
    if (f === "names" && overlap >= 3) strong = true;
    weighted += w * ((2 * overlap) / (left.size + right.size));
  }

  // Cross-field check: Webpack property name (styles.Foo / ctx.SliderField) became Vite string literal
  if (!strong) {
    for (const n of a.names) {
      if (n.length >= 8 && b.strings.has(n)) {
        strong = true;
        break;
      }
    }
  }

  const score = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) : 0;
  return { score, strong };
}

/**
 * Inverted-index dual-bundle matcher: matches Vite runtime exports back to legacy Webpack exports.
 * Rejects weak matches (< 25) and ambiguous ties (top2 within 5 points).
 */
export function matchWebpackToVite(
  webpackExports: WebpackExportRecord[],
  viteExports: ViteRuntimeExport[],
  hashToSemantic: Map<string, string>,
): Map<string, WebpackMatch> {
  const wpBags = webpackExports.map(buildWebpackBag);
  const inverted = new Map<string, number[]>();
  const addPost = (key: string, idx: number) => {
    let list = inverted.get(key);
    if (!list) {
      list = [];
      inverted.set(key, list);
    }
    list.push(idx);
  };

  for (let i = 0; i < wpBags.length; i++) {
    const bag = wpBags[i];
    for (const s of bag.strings) addPost(`s:${s}`, i);
    for (const c of bag.cssKeys) addPost(`c:${c}`, i);
    for (const m of bag.methods) addPost(`m:${m}`, i);
    for (const k of bag.keys) addPost(`k:${k}`, i);
    for (const n of bag.names) addPost(`n:${n}`, i);
  }

  // Drop ultra-high-frequency tokens (> 80 exports) from candidate seeding to stay fast.
  for (const [k, list] of inverted) {
    if (list.length > 80) inverted.delete(k);
  }

  const results = new Map<string, WebpackMatch>();
  for (const vExp of viteExports) {
    const vBag = buildViteBag(vExp, hashToSemantic);
    const candidateIdx = new Set<number>();
    for (const s of vBag.strings) for (const i of inverted.get(`s:${s}`) ?? []) candidateIdx.add(i);
    for (const c of vBag.cssKeys) for (const i of inverted.get(`c:${c}`) ?? []) candidateIdx.add(i);
    for (const m of vBag.methods) for (const i of inverted.get(`m:${m}`) ?? []) candidateIdx.add(i);
    for (const k of vBag.keys) for (const i of inverted.get(`k:${k}`) ?? []) candidateIdx.add(i);
    for (const n of vBag.names) for (const i of inverted.get(`n:${n}`) ?? []) candidateIdx.add(i);

    let bestScore = -1;
    let secondScore = -1;
    let bestIdx = -1;

    for (const idx of candidateIdx) {
      // Avoid matching a store to a component or vice versa unless both are helpers/components.
      if ((vExp.kind === "store") !== (webpackExports[idx].kind === "store")) continue;
      const { score, strong } = scoreBags(wpBags[idx], vBag);
      if (!strong || score < 25) continue;
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestIdx = idx;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }

    if (bestIdx >= 0 && (secondScore < 0 || bestScore - secondScore >= 5)) {
      results.set(vExp.id, {
        webpackAt: [...webpackExports[bestIdx].at],
        score: bestScore,
      });
    }
  }

  return results;
}

// --- Semantic inference & GuideData builder ---

function toPascalCase(raw: string): string {
  return raw
    .replace(/^m_(?:b|n|fl|str|vec|map|set|rg|e|un|ul|p|fn|h|o)?(?=[A-Z])/, "")
    .replace(/^m_/, "")
    .replace(/^#/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
}

function isReadableSymbol(name: string): boolean {
  return name.length >= 5 && /^[A-Z][A-Za-z0-9_]+$/.test(name) && !GENERIC_TOKENS.has(name);
}

export function inferExportSemantics(
  exp: ViteRuntimeExport,
  astInfo: SymbolAstInfo | undefined,
  cssModulesById: Map<string, CssModuleEntry>,
  cssClassesById: Map<string, CssClassEntry>,
  hashToClassId?: Map<string, string>,
): { name: string; kind: ExportKind; confidence: ConfidenceTier; evidence: string[]; featureArea: string } {
  const storeFields = [...new Set([
    ...exp.keys.filter((k) => k.startsWith("m_")),
    ...(astInfo?.storeFields ?? []),
  ])].sort();
  const kind: ExportKind = storeFields.length >= 2 || exp.kind === "store"
    ? "store"
    : (astInfo?.rendersJsx || exp.kind === "component" ? "component" : exp.kind);

  const cssIds = new Set<string>();
  const cssModCounts = new Map<string, number>();
  const semanticClassNames: string[] = [];

  for (const h of [...exp.cssHashes, ...(astInfo?.cssHashes ?? []), ...exp.strings]) {
    const cid = hashToClassId?.get(h);
    if (!cid) continue;
    cssIds.add(cid);
    const cEntry = cssClassesById.get(cid);
    if (cEntry?.semanticName) semanticClassNames.push(cEntry.semanticName);
    if (cEntry?.moduleId) {
      const mid = `mod:${cEntry.moduleId}`;
      cssModCounts.set(mid, (cssModCounts.get(mid) ?? 0) + 1);
    }
  }

  const topModId = [...cssModCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const topMod = topModId ? cssModulesById.get(topModId) : undefined;
  const featureHints = [
    astInfo?.displayName ?? "",
    astInfo?.name ?? "",
    topMod?.name ?? "",
    ...semanticClassNames,
    ...storeFields,
    ...(astInfo?.steamClientApis ?? []),
    ...exp.methods,
  ];
  const featureArea = classifyFeatureArea(featureHints);

  // 1. displayName
  if (astInfo?.displayName && astInfo.displayName.length >= 3) {
    return {
      name: astInfo.displayName,
      kind,
      confidence: "inferred",
      evidence: [`displayName:${astInfo.displayName}`, ...(topMod ? [`css:${topMod.name}`] : [])],
      featureArea,
    };
  }

  // 2. Surviving readable symbol name
  if (astInfo?.name && isReadableSymbol(astInfo.name)) {
    return {
      name: astInfo.name,
      kind,
      confidence: "inferred",
      evidence: [`symbol:${astInfo.name}`, ...(topMod ? [`css:${topMod.name}`] : [])],
      featureArea,
    };
  }

  // 3. Store with m_* fields or SteamClient namespaces
  if (kind === "store" && (storeFields.length > 0 || (astInfo?.steamClientApis.length ?? 0) > 0)) {
    const scNs = astInfo?.steamClientApis[0]?.split(".")[1];
    const leadField = storeFields.find((f) => f.length >= 5) ?? storeFields[0] ?? "";
    const base = scNs || toPascalCase(leadField) || "Internal";
    const storeName = /Store$/i.test(base) ? base : `${base}Store`;
    return {
      name: storeName,
      kind: "store",
      confidence: "inferred",
      evidence: [
        ...(storeFields.length ? [`store-fields:${storeFields.slice(0, 3).join(",")}`] : []),
        ...(scNs ? [`SteamClient.${scNs}`] : []),
      ],
      featureArea,
    };
  }

  // 4. Component/export linked to semantic CSS module/classes
  if (topMod && semanticClassNames.length > 0) {
    const leadClass = semanticClassNames.find((c) => !GENERIC_CSS_KEYS.has(c)) ?? semanticClassNames[0];
    const baseName = leadClass.startsWith(topMod.name) ? leadClass : `${topMod.name}_${leadClass}`;
    return {
      name: baseName,
      kind,
      confidence: "inferred",
      evidence: [`css:${topMod.name}.${leadClass}`],
      featureArea,
    };
  }

  // 5. Localization string token (e.g., #Settings_Audio_Output)
  const locToken = exp.strings.find((s) => /^#[A-Z][A-Za-z0-9_]{4,48}$/.test(s));
  if (locToken) {
    return {
      name: toPascalCase(locToken),
      kind,
      confidence: "inferred",
      evidence: [`loc:${locToken}`],
      featureArea,
    };
  }

  // 6. Prototype methods on a class (skip private _-prefixed and protobuf boilerplate methods)
  const PROTO_NOISE = new Set(["toObject", "serializeBinary", "deserializeBinary", "fromObject", "getClassName", "toBinary", "cloneMessage", "componentDidMount", "componentDidUpdate", "componentWillUnmount", "shouldComponentUpdate", "componentDidCatch"]);
  const strongMethod = exp.methods.find((m) => m.length >= 6 && !m.startsWith("_") && !GENERIC_TOKENS.has(m) && !PROTO_NOISE.has(m));
  if (strongMethod) {
    return {
      name: strongMethod.replace(/^(?:Get|Set|On|Update|Handle|Init|Show|Hide)/, "") || strongMethod,
      kind,
      confidence: "inferred",
      evidence: [`method:${strongMethod}`],
      featureArea,
    };
  }

  // 7. Truly opaque / unmatched
  const fallbackAt = exp.at[0]?.replace(/^esm:/, "") ?? exp.id;
  return {
    name: fallbackAt,
    kind,
    confidence: "unmatched",
    evidence: [],
    featureArea: featureArea === "System & Misc" ? "Unmatched" : featureArea,
  };
}

export interface VerifiedRuntimeEntry {
  at: string[];
  sourcePackage: SourcePackage;
  kind: ExportKind;
  webpackAt?: string[];
  props?: string[];
  strings?: string[];
  names?: string[];
  methods?: string[];
  keys?: string[];
}

function buildExportRecipe(entry: {
  name: string;
  sourcePackage: SourcePackage;
  kind: ExportKind;
  viteAt: string[];
  storeFields: string[];
  methods: string[];
  props: string[];
  strings?: string[];
}): string {
  if (entry.sourcePackage === "@decky/ui") {
    return `import { ${entry.name} } from "@decky/ui";`;
  }
  if (entry.sourcePackage === "@beallio/decky-extras") {
    return `import { ${entry.name} } from "@beallio/decky-extras";`;
  }
  if (entry.sourcePackage === "IconsModule") {
    return `import { IconsModule } from "@decky/ui"; // <IconsModule.${entry.name} />`;
  }
  if (entry.storeFields.length >= 2) {
    const f1 = entry.storeFields[0];
    const f2 = entry.storeFields[1];
    return `findModuleExport((e) => e && typeof e === "object" && "${f1}" in e && "${f2}" in e)`;
  }
  const SAFE_RECIPE_STRING = /^[A-Za-z0-9_.:/# -]{6,48}$/;
  const uniqStr = (entry.strings ?? []).find(
    (s) => SAFE_RECIPE_STRING.test(s) && !isViteHash(s) && !GENERIC_TOKENS.has(s),
  );
  if (uniqStr) {
    return `findModuleExport((e) => e?.toString?.().includes(${JSON.stringify(uniqStr)}))`;
  }
  if (entry.methods.length >= 1) {
    return `findModuleExport((e) => typeof e?.prototype?.${entry.methods[0]} === "function")`;
  }
  return `// Vite ESM location: ${entry.viteAt[0] ?? entry.name}`;
}

function primaryChunk(at: string[]): string {
  for (const loc of at) {
    const m = loc.match(/^esm:([^:]+)/);
    if (m) return m[1];
  }
  return "unknown";
}

function extractSymbolFromAt(loc: string): { chunk: string; sym: string } | null {
  const m = loc.match(/^esm:([^:]+):([^:]+)$/);
  return m ? { chunk: m[1], sym: m[2] } : null;
}

export interface CapturedPreviews {
  components: Record<string, { html: string; width: number; note?: string; error?: string | null }>;
  icons: Record<string, string>;
  css: string;
}

export function buildGuideData(inputs: {
  betaMeta: GuideData["beta"];
  webpackMeta: GuideData["webpackBaseline"];
  cssIndex: CssIndex;
  verifiedRuntime: Record<string, VerifiedRuntimeEntry>;
  icons: Omit<IconEntry, "recipe">[];
  runtimeExports: ViteRuntimeExport[];
  chunkAnalyses: Map<string, ChunkAstAnalysis>;
  webpackMatches: Map<string, WebpackMatch>;
  previews?: CapturedPreviews;
}): GuideData {
  const { betaMeta, webpackMeta, cssIndex, verifiedRuntime, icons, runtimeExports, chunkAnalyses, webpackMatches, previews } = inputs;

  // Map each Vite runtime location `esm:chunk:sym` to any verified name claiming that object.
  const atToVerified = new Map<string, { label: string; entry: VerifiedRuntimeEntry }>();
  for (const [label, entry] of Object.entries(verifiedRuntime)) {
    for (const loc of entry.at) {
      if (!atToVerified.has(loc)) atToVerified.set(loc, { label, entry });
    }
  }

  const exportsList: JsExportEntry[] = [];
  const usedIds = new Set<string>();
  const makeUniqueId = (prefix: string, rawName: string): string => {
    const slug = rawName.replace(/[^A-Za-z0-9_.:-]+/g, "_");
    let candidate = `${prefix}:${slug}`;
    let i = 2;
    while (usedIds.has(candidate)) {
      candidate = `${prefix}:${slug}_${i++}`;
    }
    usedIds.add(candidate);
    return candidate;
  };

  // Deduplicate runtimeExports by primary location set and merge verifiedRuntime entries.
  const seenViteLocs = new Set<string>();
  const allExportsInput: Array<{
    runtime?: ViteRuntimeExport;
    verified?: { label: string; entry: VerifiedRuntimeEntry };
  }> = [];

  for (const rExp of runtimeExports) {
    let matchedVerified: { label: string; entry: VerifiedRuntimeEntry } | undefined;
    for (const loc of rExp.at) {
      const v = atToVerified.get(loc);
      if (v) {
        matchedVerified = v;
        break;
      }
    }
    for (const loc of rExp.at) seenViteLocs.add(loc);
    allExportsInput.push({ runtime: rExp, verified: matchedVerified });
  }

  // Also add any verified runtime entry that wasn't already covered by runtimeExports.
  for (const [label, vEntry] of Object.entries(verifiedRuntime)) {
    if (vEntry.at.some((loc) => seenViteLocs.has(loc))) continue;
    allExportsInput.push({ verified: { label, entry: vEntry } });
  }

  for (const item of allExportsInput) {
    const viteAt = [...new Set([...(item.verified?.entry.at ?? []), ...(item.runtime?.at ?? [])])].sort();
    const chunk = primaryChunk(viteAt);

    // Resolve AST symbol info across all viteAt locations.
    let astInfo: SymbolAstInfo | undefined;
    for (const loc of viteAt) {
      const parsed = extractSymbolFromAt(loc);
      if (!parsed) continue;
      const analysis = chunkAnalyses.get(parsed.chunk);
      if (!analysis) continue;
      const localName = analysis.exportAliasToLocal.get(parsed.sym) ?? parsed.sym;
      const info = analysis.symbols.get(localName);
      if (info) {
        astInfo = info;
        break;
      }
    }

    const rawHashes = new Set<string>([
      ...(item.runtime?.cssHashes ?? []),
      ...(astInfo?.cssHashes ?? []),
      ...(item.runtime?.strings ?? []).filter(isViteHash),
      ...(item.verified?.entry.strings ?? []).filter(isViteHash),
    ]);
    const cssClassIds = new Set<string>();
    const cssModuleIds = new Set<string>();
    for (const h of rawHashes) {
      const cid = cssIndex.hashToClassId.get(h);
      if (!cid) continue;
      cssClassIds.add(cid);
      const cEntry = cssIndex.classById.get(cid);
      if (cEntry?.moduleId) cssModuleIds.add(`mod:${cEntry.moduleId}`);
    }

    const props = [...new Set([
      ...(item.verified?.entry.props ?? []),
      ...(astInfo?.props ?? []),
    ])].sort();
    const storeFields = [...new Set([
      ...(item.runtime?.keys ?? []).filter((k) => k.startsWith("m_")),
      ...(item.verified?.entry.keys ?? []).filter((k) => k.startsWith("m_")),
      ...(astInfo?.storeFields ?? []),
    ])].sort();
    const methods = [...new Set([
      ...(item.runtime?.methods ?? []),
      ...(item.verified?.entry.methods ?? []),
      ...(astInfo?.methods ?? []),
    ])].sort();
    const steamClientApis = [...new Set(astInfo?.steamClientApis ?? [])].sort();

    let name: string;
    let kind: ExportKind;
    let confidence: ConfidenceTier;
    let evidence: string[];
    let featureArea: string;
    let sourcePackage: SourcePackage;

    if (item.verified) {
      const rawLabel = item.verified.label;
      name = rawLabel.includes(":") ? rawLabel.split(":").slice(1).join(":") : rawLabel;
      kind = item.verified.entry.kind;
      confidence = "verified";
      sourcePackage = item.verified.entry.sourcePackage;
      evidence = [sourcePackage];
      const modNames = [...cssModuleIds].map((mid) => cssIndex.moduleById.get(mid)?.name ?? "");
      featureArea = classifyFeatureArea([name, ...modNames, ...storeFields, ...steamClientApis]);
    } else {
      const inferred = inferExportSemantics(
        item.runtime!,
        astInfo,
        cssIndex.moduleById,
        cssIndex.classById,
        cssIndex.hashToClassId,
      );
      name = inferred.name;
      kind = inferred.kind;
      confidence = inferred.confidence;
      evidence = inferred.evidence;
      featureArea = inferred.featureArea;
      sourcePackage = "steamui";
    }

    const wpMatch = item.runtime ? webpackMatches.get(item.runtime.id) : undefined;
    const webpackAt = [...new Set([
      ...(item.verified?.entry.webpackAt ?? []),
      ...(wpMatch?.webpackAt ?? []),
    ])].sort();

    let migration: MigrationStatus;
    if (webpackAt.length > 0) {
      migration = "changed";
    } else if (confidence === "verified" || confidence === "inferred") {
      migration = "new";
    } else {
      migration = "unmatched";
    }

    const idPrefix = kind === "store" ? "store" : kind === "component" ? "comp" : "exp";
    const id = makeUniqueId(idPrefix, name);

    const recipe = buildExportRecipe({
      name,
      sourcePackage,
      kind,
      viteAt,
      storeFields,
      methods,
      props,
      strings: item.runtime?.strings ?? item.verified?.entry.strings,
    });

    const cssModuleNames = [...cssModuleIds]
      .map((mid) => cssIndex.moduleById.get(mid)?.name ?? "")
      .filter(Boolean);
    const doc = describeExport({
      name,
      kind,
      sourcePackage,
      featureArea,
      props,
      storeFields,
      steamClientApis,
      cssModuleNames,
    });
    const prev = previews?.components[name];
    const hasPreviewHtml = Boolean(prev?.html && !prev.error);

    const entry: JsExportEntry = {
      id,
      name,
      kind,
      confidence,
      evidence,
      featureArea,
      viteAt,
      chunk,
      webpackAt,
      ...(wpMatch ? { webpackMatchScore: wpMatch.score } : {}),
      migration,
      sourcePackage,
      props,
      storeFields,
      methods,
      steamClientApis,
      cssClasses: [...cssClassIds].sort(),
      cssModules: [...cssModuleIds].sort(),
      recipe,
      description: doc.description,
      placements: doc.placements,
      ...(hasPreviewHtml ? { previewHtml: prev!.html, previewWidth: prev!.width } : {}),
      ...(prev?.note ? { previewNote: prev.note } : {}),
    };

    exportsList.push(entry);

    // Populate bidirectional backlinks onto CSS classes and CSS modules.
    for (const cid of cssClassIds) {
      const cEntry = cssIndex.classById.get(cid);
      if (cEntry && !cEntry.usedBy.includes(id)) cEntry.usedBy.push(id);
    }
    for (const mid of cssModuleIds) {
      const mEntry = cssIndex.moduleById.get(mid);
      if (mEntry && !mEntry.usedBy.includes(id)) mEntry.usedBy.push(id);
    }
  }

  // Include any @decky/ui library-made components that rendered a preview (e.g. DropdownItem, ReorderableList)
  if (previews) {
    const existingNames = new Set(exportsList.map((e) => e.name));
    for (const [compName, prev] of Object.entries(previews.components)) {
      if (existingNames.has(compName) || !prev.html || prev.error) continue;
      const doc = describeExport({
        name: compName,
        kind: "component",
        sourcePackage: "@decky/ui",
        featureArea: "CommonUI",
        props: [],
        storeFields: [],
        steamClientApis: [],
        cssModuleNames: [],
      });
      exportsList.push({
        id: makeUniqueId("comp", compName),
        name: compName,
        kind: "component",
        confidence: "verified",
        evidence: ["@decky/ui (library wrapper)"],
        featureArea: "CommonUI",
        viteAt: ["@decky/ui"],
        chunk: "@decky/ui",
        webpackAt: [],
        migration: "unchanged",
        sourcePackage: "@decky/ui",
        props: [],
        storeFields: [],
        methods: [],
        steamClientApis: [],
        cssClasses: [],
        cssModules: [],
        recipe: `import { ${compName} } from "@decky/ui";`,
        description: doc.description,
        placements: doc.placements,
        previewHtml: prev.html,
        previewWidth: prev.width,
        ...(prev.note ? { previewNote: prev.note } : {}),
      });
    }
  }

  for (const c of cssIndex.cssClasses) c.usedBy.sort();
  for (const m of cssIndex.cssModules) m.usedBy.sort();

  // Sort exports: verified first, then inferred, then unmatched; alphabetical within tier.
  const tierRank: Record<ConfidenceTier, number> = { verified: 0, inferred: 1, unmatched: 2 };
  exportsList.sort((a, b) => tierRank[a.confidence] - tierRank[b.confidence] || a.name.localeCompare(b.name));

  // Build IconEntry list
  const iconEntries: IconEntry[] = icons
    .map((ic) => {
      const svg = previews?.icons[ic.name];
      return {
        ...ic,
        recipe: ic.directional
          ? `import { IconsModule } from "@decky/ui"; // <IconsModule.${ic.name} direction="right" />`
          : `import { IconsModule } from "@decky/ui"; // <IconsModule.${ic.name} />`,
        ...(svg ? { previewSvg: svg } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Build ChunkEntry summaries
  const chunkMap = new Map<string, { exportCount: number; cssClassCount: number; areas: Set<string> }>();
  for (const e of exportsList) {
    let c = chunkMap.get(e.chunk);
    if (!c) {
      c = { exportCount: 0, cssClassCount: 0, areas: new Set() };
      chunkMap.set(e.chunk, c);
    }
    c.exportCount++;
    if (e.featureArea !== "Unmatched") c.areas.add(e.featureArea);
  }
  for (const [chunkName, analysis] of chunkAnalyses) {
    let c = chunkMap.get(chunkName);
    if (!c) {
      c = { exportCount: 0, cssClassCount: 0, areas: new Set() };
      chunkMap.set(chunkName, c);
    }
    c.cssClassCount = analysis.chunkCssHashes.length;
  }
  const chunks: ChunkEntry[] = [...chunkMap.entries()]
    .map(([name, c]) => ({
      name,
      exportCount: c.exportCount,
      cssClassCount: c.cssClassCount,
      featureAreas: [...c.areas].sort(),
    }))
    .sort((a, b) => b.exportCount - a.exportCount || a.name.localeCompare(b.name));

  // Build FeatureAreaSummary counts
  const areaMap = new Map<string, FeatureAreaSummary>();
  const getArea = (areaName: string) => {
    let a = areaMap.get(areaName);
    if (!a) {
      a = { id: slugifyArea(areaName), name: areaName, componentCount: 0, storeCount: 0, cssModuleCount: 0, cssClassCount: 0 };
      areaMap.set(areaName, a);
    }
    return a;
  };
  for (const e of exportsList) {
    const a = getArea(e.featureArea);
    if (e.kind === "store") a.storeCount++;
    else a.componentCount++;
  }
  for (const m of cssIndex.cssModules) getArea(m.featureArea).cssModuleCount++;
  for (const c of cssIndex.cssClasses) getArea(c.featureArea).cssClassCount++;
  const featureAreas = [...areaMap.values()].sort((a, b) => {
    if (a.name === "Unmatched") return 1;
    if (b.name === "Unmatched") return -1;
    return (b.componentCount + b.cssClassCount) - (a.componentCount + a.cssClassCount) || a.name.localeCompare(b.name);
  });

  const cssMatched = cssIndex.cssClasses.filter((c) => c.confidence !== "unmatched").length;
  const renderedPreviews = exportsList.filter((e) => Boolean(e.previewHtml)).length;
  const renderedIcons = iconEntries.filter((i) => Boolean(i.previewSvg)).length;
  const stats = {
    cssModules: cssIndex.cssModules.length,
    cssClasses: cssIndex.cssClasses.length,
    cssMatched,
    cssUnmatched: cssIndex.cssClasses.length - cssMatched,
    plainClasses: cssIndex.plainClasses.length,
    exports: exportsList.length,
    verifiedExports: exportsList.filter((e) => e.confidence === "verified").length,
    inferredExports: exportsList.filter((e) => e.confidence === "inferred").length,
    unmatchedExports: exportsList.filter((e) => e.confidence === "unmatched").length,
    webpackMatchedExports: exportsList.filter((e) => e.webpackAt.length > 0).length,
    icons: iconEntries.length,
    chunks: chunks.length,
    ...(renderedPreviews ? { renderedPreviews } : {}),
    ...(renderedIcons ? { renderedIcons } : {}),
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    beta: betaMeta,
    webpackBaseline: webpackMeta,
    stats,
    featureAreas,
    cssModules: cssIndex.cssModules,
    cssClasses: cssIndex.cssClasses,
    plainClasses: cssIndex.plainClasses,
    exports: exportsList,
    icons: iconEntries,
    chunks,
    ...(previews?.css ? { previewCss: previews.css } : {}),
  };
}
