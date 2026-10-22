export type Atom = { text: string } | { member: string } | { binding: string };
export type Component = { title: string; description: string; find: Atom[][] };
export type Manifest = { schema: 1; revision: number; components: Record<string, Component> };

// Downloads are data only: no JavaScript, regexes, module IDs, URLs, or arbitrary property paths.
export function parseManifest(value: unknown): Manifest {
  const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
  const keys = (v: object, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k));
  const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(v)
    && !["constructor", "prototype", "__proto__"].includes(v);
  if (!object(value) || !keys(value, ["schema", "revision", "components"]) || value.schema !== 1
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !object(value.components)) throw new Error("Invalid extras manifest header");
  const entries = Object.entries(value.components);
  if (!entries.length || entries.length > 256) throw new Error("Invalid extras component count");
  for (const [name, component] of entries) {
    if (!identifier(name) || !/^[A-Z]/.test(name) || !object(component) || !keys(component, ["title", "description", "find"])
      || typeof component.title !== "string" || !component.title.length || component.title.length > 120
      || typeof component.description !== "string" || component.description.length > 500
      || !Array.isArray(component.find) || !component.find.length || component.find.length > 16) throw new Error(`Invalid extra: ${name}`);
    for (const clause of component.find) {
      if (!Array.isArray(clause) || !clause.length || clause.length > 16) throw new Error(`Invalid finder clause: ${name}`);
      for (const atom of clause) {
        if (!object(atom) || Object.keys(atom).length !== 1) throw new Error(`Invalid finder atom: ${name}`);
        const [kind, text] = Object.entries(atom)[0];
        if (kind === "text" ? typeof text !== "string" || !text.length || text.length > 300
          : !["member", "binding"].includes(kind) || !identifier(text)) throw new Error(`Invalid finder atom: ${name}`);
      }
    }
  }
  return value as Manifest;
}

/** All matches, deduplicated by identity. Self-contained so the probe can run the same function in Steam's page. */
export function matchExtras(modules: Iterable<readonly [unknown, unknown]>, manifest: Manifest): Record<string, unknown[]> {
  const sources = new Map<unknown, string>();
  for (const [, module] of modules) {
    if (!module || (typeof module !== "object" && typeof module !== "function")) continue;
    for (const key of Object.keys(module)) {
      try {
        const value = (module as any)[key];
        if (!value || sources.has(value)) continue;
        const fn = value.render ?? value.type ?? value;
        if (typeof fn === "function") sources.set(value, Function.prototype.toString.call(fn));
      } catch { /* Some webpack getters belong to modules that did not initialize. */ }
    }
  }
  const hits = (source: string, atom: Atom): boolean => {
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
  const matches: Record<string, unknown[]> = {};
  for (const [name, component] of Object.entries(manifest.components)) {
    matches[name] = [];
    for (const [value, source] of sources) if (component.find.every((clause) => clause.some((atom) => hits(source, atom)))) matches[name].push(value);
  }
  return matches;
}
