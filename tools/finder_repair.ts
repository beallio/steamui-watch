import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";

export type Fingerprint = {
  at: string[];
  strings?: string[];
  names?: string[];
  methods?: string[];
  keys?: string[];
  error?: string;
};

export type Candidate = Fingerprint & { source?: string; via?: "value" | "render" | "type" };

const FIELDS = ["strings", "names", "methods", "keys"] as const;
const WEIGHTS = { strings: 45, names: 10, methods: 25, keys: 20 } as const;
const GENERIC_KEYS: Record<string, true> = {
  toString: true, render: true, type: true, prototype: true, constructor: true, length: true, call: true, apply: true,
  children: true, className: true, createElement: true, jsx: true, jsxs: true, component: true, fallback: true,
};
const STABLE_KEY = /^[A-Za-z_][A-Za-z_$-]{3,}$/;
const MIN_TEXT = 8;
const MAX_TEXT = 120;

const values = (record: Fingerprint, field: (typeof FIELDS)[number]) =>
  [...new Set((record[field] ?? []).filter((value) => typeof value === "string" && value.length > 0))];

function strongEvidence(previous: Fingerprint, candidate: Fingerprint): boolean {
  // A component name can move from a member access to a string when Valve changes its override hook.
  if (values(previous, "names").some((name) => name.length >= MIN_TEXT && !GENERIC_KEYS[name] && values(candidate, "strings").includes(name))
    || values(previous, "strings").some((text) => text.length >= MIN_TEXT && !GENERIC_KEYS[text] && values(candidate, "names").includes(text))) return true;
  return FIELDS.some((field) => {
    const right = new Set(values(candidate, field));
    const matches = values(previous, field).filter((value) => right.has(value));
    if (field === "strings") return matches.some((value) => value.length >= MIN_TEXT);
    if (field === "names") return matches.filter((value) => value.length >= 6 && !GENERIC_KEYS[value]).length >= 2;
    return matches.some((value) => value.length >= 5 && !GENERIC_KEYS[value]);
  });
}

function fingerprintScore(previous: Fingerprint, candidate: Fingerprint): number {
  let weighted = 0, weight = 0;
  for (const field of FIELDS) {
    const left = values(previous, field), right = values(candidate, field);
    if (!left.length) continue;
    weight += WEIGHTS[field];
    const rightSet = new Set(right);
    const overlap = left.filter((value) => rightSet.has(value)).length;
    weighted += WEIGHTS[field] * (2 * overlap / (left.length + right.length || 1));
  }
  return weight ? Math.round(weighted / weight * 100) : 0;
}

function locationScore(previous: string[], candidate: string[]): number {
  // A module ID or minified export key alone can be reused by unrelated code.
  return previous.some((at) => candidate.includes(at)) ? 220 : 0;
}

export function rankCandidates(previous: Fingerprint, candidates: Candidate[]): {
  candidate?: Candidate;
  reason: string;
  ranked: { at: string[]; score: number }[];
} {
  const ranked = candidates.map((candidate) => {
    const evidence = strongEvidence(previous, candidate);
    return {
      candidate,
      fingerprint: fingerprintScore(previous, candidate),
      location: evidence ? locationScore(previous.at, candidate.at) : 0,
      evidence,
    };
  }).map(({ candidate, fingerprint, location, evidence }) => ({
    candidate, score: fingerprint + location, fingerprint, location, evidence,
  }))
    .sort((a, b) => b.score - a.score || a.candidate.at.join("\0").localeCompare(b.candidate.at.join("\0")))
    .map(({ candidate, ...rank }) => ({ candidate, ...rank }));
  const publicRanked = ranked.map(({ candidate, score }) => ({ at: [...candidate.at], score }));
  if (!candidates.length) return { reason: "No replacement candidates were found.", ranked: publicRanked };
  if (previous.error !== undefined || !FIELDS.some((field) => values(previous, field).length))
    return { reason: "The baseline has no usable fingerprint evidence.", ranked: publicRanked };
  const usable = ranked.filter(({ candidate, evidence, fingerprint, location }) =>
    candidate.error === undefined && evidence && (location > 0 || fingerprint >= 18));
  const best = usable[0];
  if (!best) return { reason: "No candidate has strong enough fingerprint evidence.", ranked: publicRanked };
  const next = usable[1];
  if (next && best.score - next.score < 5)
    return { reason: "The strongest replacement candidates are ambiguous.", ranked: publicRanked };
  if (best.location && usable.some((other) => other.fingerprint >= best.fingerprint + 5))
    return { reason: "Replacement is ambiguous: location and stronger fingerprint evidence point to different objects.", ranked: publicRanked };
  return { candidate: best.candidate, reason: "One replacement candidate has a clear fingerprint match.", ranked: publicRanked };
}

type Scope = "export" | "module";
type Feature = { expression: (parameter: string) => string; matches: (candidate: Candidate) => boolean };
type Query = { scope: Scope; feature: Feature };

type TextFeature = { needles: string[]; via: "value" | "render" | "type" };
type PropertyFeature = { kind: "keys" | "methods"; names: string[]; via: "value" | "render" | "type" };

function sourceVia(candidate: Candidate): "value" | "render" | "type" {
  return candidate.via ?? "value";
}

function scopeContains(candidate: Candidate, scope: Scope): boolean {
  return candidate.at.some((at) => scope === "export" ? at.includes(":") : !at.includes(":"));
}

function parsedTextNeedles(source: string): string[] {
  let tree: unknown;
  try { tree = parse(`(${source})`, { ecmaVersion: "latest" }); }
  catch {
    try { tree = parse(`({${source}})`, { ecmaVersion: "latest" }); }
    catch { return []; }
  }
  const needles = new Set<string>();
  const add = (text: unknown) => {
    if (typeof text === "string" && text.length >= MIN_TEXT && text.length <= MAX_TEXT && source.includes(text)) needles.add(text);
  };
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if ("type" in node && node.type === "Literal" && "value" in node && typeof node.value === "string") {
      add(node.value);
      if ("raw" in node && typeof node.raw === "string") {
        add(node.raw);
        add(node.raw.slice(1, -1));
      }
    } else if ("type" in node && node.type === "TemplateLiteral" && "quasis" in node && Array.isArray(node.quasis)) {
      for (const quasi of node.quasis) {
        if (!quasi || typeof quasi !== "object" || !("value" in quasi) || !quasi.value || typeof quasi.value !== "object") continue;
        if ("cooked" in quasi.value) add(quasi.value.cooked);
        if ("raw" in quasi.value) add(quasi.value.raw);
      }
    } else if ("type" in node && node.type === "MemberExpression" && "computed" in node && !node.computed
      && "property" in node && node.property && typeof node.property === "object" && "name" in node.property) {
      add(`.${node.property.name}`);
    } else if ("type" in node && node.type === "Property" && "computed" in node && !node.computed
      && "key" in node && node.key && typeof node.key === "object" && "name" in node.key) {
      add(`${node.key.name}:`);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(tree);
  return [...needles].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

function propertyOptions(candidate: Candidate): PropertyFeature[] {
  const via = sourceVia(candidate);
  const result: PropertyFeature[] = [];
  for (const [kind, names] of [["methods", candidate.methods], ["keys", candidate.keys]] as const) {
    const stable = [...new Set((names ?? []).filter((name) => STABLE_KEY.test(name) && !GENERIC_KEYS[name]))];
    if (stable.length) result.push({ kind, names: stable, via });
  }
  return result;
}

function sourceFor(candidate: Candidate, via: TextFeature["via"]): string | undefined {
  return sourceVia(candidate) === via ? candidate.source : undefined;
}

function selectTextFeatures(target: Candidate, pool: Candidate[], oldTexts: string[]): Feature[] {
  if (!target.source) return [];
  const via = sourceVia(target), source = target.source;
  const candidates = pool.filter((candidate) => candidate.error === undefined && sourceFor(candidate, via) !== undefined);
  const options = [...new Set([
    ...oldTexts.filter((text) => text.length >= MIN_TEXT && text.length <= MAX_TEXT && source.includes(text)),
    ...parsedTextNeedles(source),
  ])];
  const unique = options.filter((needle) => {
    const matches = candidates.filter((candidate) => sourceFor(candidate, via)!.includes(needle));
    return matches.length === 1 && matches[0] === target;
  });
  const selectorGroups = unique.map((needle) => [needle]);
  if (!selectorGroups.length && options.length) {
    let remaining = candidates;
    const chosen: string[] = [];
    while (remaining.length > 1) {
      let best = "", bestMatches = remaining;
      for (const needle of options) {
        if (chosen.includes(needle)) continue;
        const matches = remaining.filter((candidate) => sourceFor(candidate, via)!.includes(needle));
        if (matches.includes(target) && matches.length < bestMatches.length) { best = needle; bestMatches = matches; }
      }
      if (!best) break;
      chosen.push(best);
      remaining = bestMatches;
    }
    if (remaining.length === 1 && remaining[0] === target) selectorGroups.push(chosen);
  }
  return selectorGroups.map((needles): Feature => ({
    expression: (parameter) => {
      const fn = via === "value" ? parameter : `${parameter}?.${via}`;
      return `(typeof ${fn} === "function" && ${needles.map((needle) => `Function.prototype.toString.call(${fn}).includes(${JSON.stringify(needle)})`).join(" && ")})`;
    },
    matches: (candidate) => {
      const candidateSource = sourceFor(candidate, via);
      return candidate.error === undefined && candidateSource !== undefined && needles.every((needle) => candidateSource.includes(needle));
    },
  }));
}

function selectPropertyFeatures(target: Candidate, pool: Candidate[]): Feature[] {
  const result: Feature[] = [];
  for (const option of propertyOptions(target)) {
    const matches = (candidate: Candidate, names: string[]) => candidate.error === undefined && sourceVia(candidate) === option.via
      && (option.kind === "methods" ? names.every((name) => candidate.methods?.includes(name))
        : !candidate.source && names.every((name) => candidate.keys?.includes(name)));
    const eligible = option.kind === "methods" ? pool.filter((candidate) => !!candidate.methods)
      : pool.filter((candidate) => !candidate.source && !!candidate.keys);
    const first = option.names[0];
    const chosen: string[] = eligible.length === 1 && eligible[0] === target && first ? [first] : [];
    let remaining = chosen.length ? eligible.filter((candidate) => matches(candidate, chosen)) : eligible;
    while (remaining.length > 1) {
      let best = "", bestMatches = remaining;
      for (const name of option.names) {
        if (chosen.includes(name)) continue;
        const next = remaining.filter((candidate) => matches(candidate, [...chosen, name]));
        if (next.includes(target) && next.length < bestMatches.length) { best = name; bestMatches = next; }
      }
      if (!best) break;
      chosen.push(best);
      remaining = bestMatches;
    }
    if (!chosen.length || remaining.length !== 1 || remaining[0] !== target) continue;
    result.push({
      expression: (parameter) => {
        const root = option.via === "value" ? parameter : `${parameter}?.${option.via}`;
        return option.kind === "methods"
          ? `(typeof ${root} === "function" && ${root}?.prototype != null && ${chosen.map((name) => `${JSON.stringify(name)} in ${root}.prototype`).join(" && ")})`
          : `(typeof ${parameter} === "object" && ${parameter} !== null && ${chosen.map((name) => `${JSON.stringify(name)} in ${parameter}`).join(" && ")})`;
      },
      matches: (candidate) => matches(candidate, chosen),
    });
  }
  return result;
}

function featureFor(target: Candidate, pool: Candidate[], oldTexts: string[]): Feature[] {
  const text = selectTextFeatures(target, pool, oldTexts);
  return text.length ? text : selectPropertyFeatures(target, pool);
}

export function makeRepair(
  targets: { label: string; candidate: Candidate; candidates: Candidate[] }[],
  oldTexts: string[] = [],
): { expression?: string; reason: string; checks: { label: string; at: string[]; matches: number }[] } {
  if (!targets.length) return { reason: "No selected candidates were supplied.", checks: [] };
  const queries: Query[] = [];
  let unsafe = "";
  for (const target of targets) {
    if (!target.candidates.includes(target.candidate)) unsafe ||= `${target.label}: selected object is absent from its catalog`;
    if (target.candidate.error !== undefined) unsafe ||= `${target.label}: selected object has no usable fingerprint`;
    for (const scope of ["export", "module"] as const) {
      const pool = [...new Set(target.candidates)].filter((candidate) => scopeContains(candidate, scope));
      if (!scopeContains(target.candidate, scope)) continue;
      const features = featureFor(target.candidate, pool, oldTexts);
      if (features.length) queries.push({ scope, feature: features[0] });
    }
  }
  for (const target of targets) {
    if (target.candidates.some((candidate) => candidate.error !== undefined && queries.some(({ scope }) => scopeContains(candidate, scope))))
      unsafe ||= `${target.label}: catalog contains an uninspectable candidate`;
  }
  const checked = targets.map((target) => {
    const candidates = [...new Set(target.candidates)];
    const matched = candidates.filter((candidate) => queries.some(({ scope, feature }) =>
      scopeContains(candidate, scope) && feature.matches(candidate)));
    return {
      check: { label: target.label, at: [...target.candidate.at], matches: matched.length },
      selected: matched.includes(target.candidate),
    };
  });
  const checks = checked.map(({ check }) => check);
  if (unsafe) return { reason: unsafe, checks };
  if (!queries.length) return { reason: "No safe text or stable property predicate identifies the selected objects.", checks };
  const failures = checked.filter(({ check, selected }) => check.matches !== 1 || !selected);
  if (failures.length) return {
    reason: `The combined predicate is not unique in every catalog (${failures.map(({ check }) => `${check.label}: ${check.matches} matches`).join(", ")}).`,
    checks,
  };
  const expressionFor = (scope: Scope, parameter: string) => {
    const features = [...new Set(queries.filter((query) => query.scope === scope).map((query) => query.feature.expression(parameter)))];
    return features.length ? `W.findModule${scope === "export" ? "Export" : ""}((${parameter}) => ${features.join(" || ")})` : "";
  };
  const expression = [expressionFor("export", "e"), expressionFor("module", "m")].filter(Boolean).join(" || ");
  return { expression, reason: "The generated predicate selects exactly one object in every supplied catalog.", checks };
}

function numericParts(version: string): string[] | undefined {
  if (!/^\d+(?:\.\d+)*$/.test(version)) return undefined;
  return version.split(".").map((part) => part.replace(/^0+(?=\d)/, ""));
}

function compareVersions(left: string[], right: string[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] ?? "0", b = right[i] ?? "0";
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function isFingerprint(value: unknown): value is Fingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.at) || !record.at.every((item: unknown) => typeof item === "string")) return false;
  for (const field of FIELDS) {
    if (record[field] !== undefined && (!Array.isArray(record[field]) || !record[field].every((item: unknown) => typeof item === "string"))) return false;
  }
  return record.error === undefined || typeof record.error === "string";
}

function validateSnapshot(value: unknown, file: string, branch: string, version: string, ui: string): asserts value is {
  client: string; decky_ui: string; finders: Record<string, Fingerprint>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Malformed finder baseline snapshot: ${file}`);
  const snapshot = value as Record<string, unknown>;
  const clientBranch = branch === "beta" ? "publicbeta" : "stable";
  const finders = snapshot.finders;
  if (snapshot.client !== `${clientBranch} ${version}` || snapshot.decky_ui !== ui
    || !finders || typeof finders !== "object" || Array.isArray(finders))
    throw new Error(`Malformed finder baseline snapshot: ${file}`);
  for (const [name, fingerprint] of Object.entries(finders as Record<string, unknown>)) {
    if (!isFingerprint(fingerprint)) throw new Error(`Malformed finder baseline snapshot: ${file} (finder ${name})`);
  }
}

export async function loadBaseline(dir: string, branch: string, version: string, ui: string): Promise<{
  file: string;
  snapshot: { client: string; decky_ui: string; finders: Record<string, Fingerprint> };
} | undefined> {
  const snapshotBranch = branch === "publicbeta" ? "beta" : branch;
  if (snapshotBranch !== "stable" && snapshotBranch !== "beta") throw new Error(`Unsupported finder baseline branch: ${branch}`);
  const current = numericParts(version);
  if (!current) throw new Error(`Client version must be numeric: ${version}`);
  let entries: Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const suffix = `.decky-ui-${ui}.json`, prefix = `${snapshotBranch}-`;
  const matching = entries.flatMap((entry) => {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) return [];
    const baselineVersion = entry.name.slice(prefix.length, -suffix.length);
    const parsed = numericParts(baselineVersion);
    return parsed && compareVersions(parsed, current) < 0 ? [{ name: entry.name, version: baselineVersion, parsed }] : [];
  }).sort((a, b) => compareVersions(b.parsed, a.parsed) || a.name.localeCompare(b.name));
  if (!matching.length) return undefined;
  const selected = matching[0];
  if (!selected) return undefined;
  const { name, version: baselineVersion } = selected;
  const file = join(dir, name);
  let snapshot: unknown;
  try { snapshot = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { throw new Error(`Could not read finder baseline snapshot ${file}: ${String(error)}`); }
  validateSnapshot(snapshot, file, snapshotBranch, baselineVersion, ui);
  return { file, snapshot };
}
