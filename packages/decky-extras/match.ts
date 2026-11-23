export type Atom = { text: string } | { member: string } | { binding: string } | { key: string };
export type Clause = Array<Atom | { not: Atom }>;
export type Kind = "component" | "function" | "object";
export type Extra = { kind: Kind; title: string; description: string; find: Clause[] };
export type Manifest = { schema: 2; revision: number; extras: Record<string, Extra> };

type AtomV1 = { text: string } | { member: string } | { binding: string };
export type ComponentV1 = { title: string; description: string; find: AtomV1[][] };
/** What @beallio/decky-extras 0.2.x and 0.3.x accept from decky-extras.json. */
export type ManifestV1 = { schema: 1; revision: number; components: Record<string, ComponentV1> };

// Atoms each kind may use: source atoms need a function body, `key` needs property names.
const ATOMS: Record<Kind, string[]> = {
  component: ["text", "member", "binding"],
  function: ["text", "member", "binding", "key"],
  object: ["key"],
};

const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (v: object, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k));
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(v)
  && !["constructor", "prototype", "__proto__"].includes(v);

function checkEntry(name: string, entry: unknown, fields: string[], atoms: string[], negation: boolean) {
  if (!identifier(name) || !/^[A-Z]/.test(name) || !object(entry) || !onlyKeys(entry, fields)
    || typeof entry.title !== "string" || !entry.title.length || entry.title.length > 120
    || typeof entry.description !== "string" || entry.description.length > 500
    || !Array.isArray(entry.find) || !entry.find.length || entry.find.length > 16) throw new Error(`Invalid extra: ${name}`);
  const atom = (a: unknown, inner = false): boolean => {
    if (!object(a) || Object.keys(a).length !== 1) return false;
    const [kind, value] = Object.entries(a)[0];
    if (kind === "not") return negation && !inner && atom(value, true);
    if (!atoms.includes(kind)) return false;
    return kind === "text" ? typeof value === "string" && value.length > 0 && value.length <= 300 : identifier(value);
  };
  for (const clause of entry.find) {
    if (!Array.isArray(clause) || !clause.length || clause.length > 16 || !clause.every((a) => atom(a))) throw new Error(`Invalid finder clause: ${name}`);
  }
  // `not` only narrows: at least one clause must pick candidates by what they contain.
  if (!entry.find.some((clause: object[]) => clause.every((a) => !("not" in a)))) throw new Error(`Invalid finder clause: ${name}`);
}

function checkCount(entries: unknown[]) {
  if (!entries.length || entries.length > 256) throw new Error("Invalid extras entry count");
}

// Downloads are data only: no JavaScript, regexes, module IDs, URLs, or arbitrary property paths.
export function parseManifest(value: unknown): Manifest {
  if (!object(value) || !onlyKeys(value, ["schema", "revision", "extras"]) || value.schema !== 2
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !object(value.extras)) throw new Error("Invalid extras manifest header");
  const entries = Object.entries(value.extras);
  checkCount(entries);
  for (const [name, entry] of entries) {
    if (!object(entry) || !Object.hasOwn(ATOMS, entry.kind)) throw new Error(`Invalid extra: ${name}`);
    checkEntry(name, entry, ["kind", "title", "description", "find"], ATOMS[entry.kind as Kind], true);
  }
  return value as Manifest;
}

/** The schema 1 validator of 0.2.x and 0.3.x, for the copy published to those versions. */
export function parseManifestV1(value: unknown): ManifestV1 {
  if (!object(value) || !onlyKeys(value, ["schema", "revision", "components"]) || value.schema !== 1
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !object(value.components)) throw new Error("Invalid extras manifest header");
  const entries = Object.entries(value.components);
  checkCount(entries);
  for (const [name, entry] of entries) checkEntry(name, entry, ["title", "description", "find"], ATOMS.component, false);
  return value as ManifestV1;
}

export function componentsOf(manifest: Manifest): Record<string, Extra> {
  return Object.fromEntries(Object.entries(manifest.extras).filter(([, extra]) => extra.kind === "component"));
}

/**
 * The schema 1 copy for 0.2.x and 0.3.x. Removing a `not` atom can leave an empty clause or make a
 * finder ambiguous, so such a component keeps its finder from the last published copy, or is left out.
 */
export function projectV1(manifest: Manifest, previous: ManifestV1 | null): ManifestV1 {
  if (previous && previous.revision > manifest.revision) throw new Error("Extras revision is older than the published copy");
  const components: Record<string, ComponentV1> = {};
  for (const [name, { title, description, find }] of Object.entries(componentsOf(manifest))) {
    const plain = find.every((clause) => clause.every((atom) => !("not" in atom)));
    const kept = plain ? find as AtomV1[][] : previous?.components[name]?.find;
    if (kept) components[name] = { title, description, find: kept };
  }
  return parseManifestV1({ schema: 1, revision: manifest.revision, components });
}

/** All matches, deduplicated by identity. Self-contained so the probe can run the same function in Steam's page. */
export function matchExtras(modules: Iterable<readonly [unknown, unknown]>, manifest: Manifest): Record<string, unknown[]> {
  const values = new Set<any>();
  // A Webpack module's exports object can itself be the target (Steam's icon registry on Stable): only `object` entries see these.
  const moduleObjects = new Set<any>();
  for (const [, module] of modules) {
    if (!module || (typeof module !== "object" && typeof module !== "function")) continue;
    if (typeof module === "object") moduleObjects.add(module);
    for (const key of Object.keys(module)) {
      try {
        const value = (module as any)[key];
        if (value && (typeof value === "object" || typeof value === "function")) values.add(value);
      } catch { /* Some webpack getters belong to modules that did not initialize. */ }
    }
  }
  // Source text and property names are read once per value, and only when an entry needs them.
  const memo = new Map<any, { component?: string | null; source?: string | null; keys?: Set<string> }>();
  const facts = (v: any) => {
    let f = memo.get(v);
    if (!f) memo.set(v, f = {});
    return f;
  };
  const sourceOf = (v: any, kind: string): string | null => {
    const f = facts(v);
    if (kind === "component") {
      if (f.component === undefined) {
        f.component = null;
        try {
          const fn = v.render ?? v.type ?? v;
          if (typeof fn === "function") f.component = Function.prototype.toString.call(fn);
        } catch { /* Not readable: not a component. */ }
      }
      return f.component;
    }
    if (f.source === undefined) {
      f.source = null;
      try { if (typeof v === "function") f.source = Function.prototype.toString.call(v); } catch { /* Not readable. */ }
    }
    return f.source;
  };
  // Names only, never values: Steam getters do not run. A function's names are its prototype chain's (class methods).
  const keysOf = (v: any): Set<string> => {
    const f = facts(v);
    if (!f.keys) {
      f.keys = new Set();
      try {
        for (let o = typeof v === "function" ? v.prototype : v; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
          for (const k of Object.getOwnPropertyNames(o)) f.keys.add(k);
        }
      } catch { /* Exotic objects keep the names read so far. */ }
    }
    return f.keys;
  };
  const candidate = (v: any, kind: string) => kind === "component" ? sourceOf(v, kind) !== null
    : kind === "function" ? typeof v === "function" : typeof v === "object";
  const hits = (v: any, kind: string, atom: any): boolean => {
    if ("not" in atom) return !hits(v, kind, atom.not);
    if ("key" in atom) return keysOf(v).has(atom.key);
    const source = sourceOf(v, kind);
    if (source === null) return false;
    if ("text" in atom) return source.includes(atom.text);
    if ("member" in atom) {
      const text = "." + atom.member;
      let at = source.indexOf(text);
      while (at !== -1) {
        const next = source[at + text.length];
        if (!next || !/[\w$]/.test(next)) return true;
        at = source.indexOf(text, at + text.length);
      }
      return false;
    }
    const text = atom.binding + ":";
    let at = source.indexOf(text);
    while (at !== -1) {
      const start = at + text.length;
      let end = start;
      while (end < source.length && /[\w$]/.test(source[end])) end++;
      if (end > start && source[end] === "=") return true;
      at = source.indexOf(text, start);
    }
    return false;
  };
  const objects = [...values, ...[...moduleObjects].filter((m) => !values.has(m))];
  const matches: Record<string, unknown[]> = {};
  for (const [name, { kind, find }] of Object.entries(manifest.extras)) {
    matches[name] = [];
    for (const v of kind === "object" ? objects : values) {
      if (candidate(v, kind) && find.every((clause) => clause.some((atom) => hits(v, kind, atom)))) matches[name].push(v);
    }
  }
  return matches;
}
