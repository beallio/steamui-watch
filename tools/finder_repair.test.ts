import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRepair, loadBaseline, makeRepair, rankCandidates, type Candidate, type Fingerprint } from "./finder_repair";

const candidate = (source: string, at: string[], extra: Partial<Candidate> = {}): Candidate => ({
  at, source, via: "value", ...extra,
});

function runtimeValue(value: Candidate): unknown {
  if (!value.source) return Object.fromEntries((value.keys ?? []).map((key) => [key, true]));
  const create = new Function(`return (${value.source})`) as () => Function;
  const fn = create();
  if (value.via === "render") return { render: fn };
  if (value.via === "type") return { type: fn };
  return fn;
}

type RuntimeWorld = {
  findModuleExport(predicate: (value: unknown) => boolean): unknown;
  findModule(predicate: (value: unknown) => boolean): unknown;
};

function runRepair(expression: string, candidates: Candidate[]): { result: unknown; runtime: Map<Candidate, unknown> } {
  const runtime = new Map<Candidate, unknown>();
  for (const item of candidates) runtime.set(item, runtimeValue(item));
  const find = (scope: "export" | "module", predicate: (value: unknown) => boolean) => {
    const match = candidates.find((item) => item.at.some((at) => scope === "export" ? at.includes(":") : !at.includes(":"))
      && predicate(runtime.get(item)));
    return match ? runtime.get(match) : undefined;
  };
  const world: RuntimeWorld = {
    findModuleExport: (predicate) => find("export", predicate),
    findModule: (predicate) => find("module", predicate),
  };
  const execute = new Function("W", `return ${expression}`) as (value: RuntimeWorld) => unknown;
  return { result: execute(world), runtime };
}


async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "finder-repair-"));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function saveSnapshot(directory: string, branch: string, version: string, ui: string, snapshot: unknown) {
  await writeFile(join(directory, `${branch}-${version}.decky-ui-${ui}.json`), JSON.stringify(snapshot));
}

function baseline(client: string, ui: string, finders: Record<string, unknown>) {
  return { client, decky_ui: ui, finders };
}

test("ranks the matching object over a similar decoy after its module moves, retaining re-exports", () => {
  const previous: Fingerprint = {
    at: ["old:Panel"],
    strings: ["selected panel marker", "additional target signal"],
    names: ["children", "onClick", "className"],
    methods: ["ResetSelection"],
    keys: ["contextType", "displayName"],
  };
  const selected = candidate("", ["new:Panel", "new-alias:Panel"], {
    strings: ["selected panel marker", "additional target signal"],
    names: ["children", "onClick", "className"],
    methods: ["ResetSelection"],
    keys: ["contextType", "displayName"],
  });
  const decoy = candidate("", ["new:Decoy"], {
    strings: ["selected panel marker"], names: ["children"], keys: ["contextType"],
  });

  const result = rankCandidates(previous, [decoy, selected]);
  expect(result.candidate).toBe(selected);
  expect(result.ranked[0]?.at).toEqual(["new:Panel", "new-alias:Panel"]);
  expect(result.ranked[0]?.score ?? -1).toBeGreaterThan(result.ranked[1]?.score ?? 0);
  expect(result.ranked).toHaveLength(2);
});

test("does not favor a reused export key or module over an exact fingerprint after renumbering", () => {
  const previous = { at: ["1:a"], strings: ["unique target marker"], names: ["children", "className"] };
  const selected = candidate("", ["2:b"], { strings: [...previous.strings], names: [...previous.names] });
  for (const at of ["3:a", "1:c", "1:a"]) {
    const decoy = candidate("", [at], { names: [...previous.names] });
    expect(rankCandidates(previous, [decoy, selected]).candidate).toBe(selected);
  }
});

test("withholds a location match when another object has clearly stronger fingerprint evidence", () => {
  const previous = {
    at: ["1:a"], strings: ["shared component label", "unique target marker"], names: ["ResetSelection", "RenderDetails"],
  };
  const located = candidate("", ["1:a"], { strings: ["shared component label"], names: [...previous.names] });
  const moved = candidate("", ["2:b"], { strings: [...previous.strings], names: [...previous.names] });
  expect(rankCandidates(previous, [located, moved]).candidate).toBeUndefined();
});

test("keeps the same export when its component name changes from member access to a literal", () => {
  const previous = { at: ["28816:Kc"], names: ["SliderField", "component", "createElement", "fallback"] };
  const selected = candidate('function(e){return a("SliderField",e)}', ["28816:Kc"], {
    strings: ["SliderField"], names: ["createElement"],
  });
  const provider = candidate("", ["28816:J1"], {
    names: ["SliderField", "ToggleField", "Provider", "children", "createElement"],
  });
  expect(rankCandidates(previous, [provider, selected]).candidate).toBe(selected);
});

test("refuses tied replacement candidates", () => {
  const previous: Fingerprint = { at: ["old:Panel"], strings: ["ambiguous component phrase"], keys: ["componentState"] };
  const first = candidate("", ["one:Panel"], { strings: [...previous.strings!], keys: [...previous.keys!] });
  const second = candidate("", ["two:Panel"], { strings: [...previous.strings!], keys: [...previous.keys!] });
  const result = rankCandidates(previous, [first, second]);
  expect(result.candidate).toBeUndefined();
  expect(result.reason).toContain("ambiguous");
});

test("uses the same source needle across re-exports without counting aliases as matches", () => {
  const selected = candidate('function Panel(){ return "stable original marker"; }', ["42:Panel", "84:PanelAlias"]);
  const decoy = candidate('function Other(){ return "unrelated component marker"; }', ["43:Other"]);
  const repair = makeRepair([{ label: "stable", candidate: selected, candidates: [selected, decoy] }], ["stable original marker"]);
  expect(repair.expression).toContain("W.findModuleExport");
  expect(repair.checks).toEqual([{ label: "stable", at: ["42:Panel", "84:PanelAlias"], matches: 1 }]);
  expect(repair.expression).toContain(JSON.stringify("stable original marker"));
  const run = runRepair(repair.expression!, [selected, decoy]);
  expect(run.result).toBe(run.runtime.get(selected));
});

test("retains the old finder needle when the new branch needs another alternative", () => {
  const old = candidate("function Panel(e){return h({component:e.ToggleField,fallback:r})}", ["42:RF"]);
  const updated = candidate('function Panel(e){return h("ToggleField",r)}', ["42:RF"]);
  const repair = makeRepair([
    { label: "stable", candidate: old, candidates: [old] },
    { label: "beta", candidate: updated, candidates: [updated] },
  ], ["ToggleField,fallback"]);
  expect(repair.expression).toContain(JSON.stringify("ToggleField,fallback"));
  const stable = runRepair(repair.expression!, [old]);
  const beta = runRepair(repair.expression!, [updated]);
  expect(stable.result).toBe(stable.runtime.get(old));
  expect(beta.result).toBe(beta.runtime.get(updated));
});

test("rejects a shared factory that cannot distinguish distinct exports", () => {
  const sharedSource = 'function Shared(){ return "shared factory output"; }';
  const selected = candidate(sharedSource, ["1:First"]);
  const decoy = candidate(sharedSource, ["2:Second"]);
  const repair = makeRepair([{ label: "stable", candidate: selected, candidates: [selected, decoy] }]);
  expect(repair.expression).toBeUndefined();
  expect(repair.reason).toContain("No safe");
});

test("does not claim uniqueness when another export could not be inspected", () => {
  const selected = candidate('function Panel(){return "distinct component marker"}', ["1:Panel"]);
  const unknown: Candidate = { at: ["2:Unknown"], error: "getter threw" };
  const repair = makeRepair([{ label: "stable", candidate: selected, candidates: [selected, unknown] }]);
  expect(repair.expression).toBeUndefined();
  expect(repair.reason).toContain("uninspectable");
});

test("generates stable and beta text alternatives and selects each exact target", () => {
  const stableTarget = candidate('function Panel(){ return "stable replacement marker"; }', ["10:Panel", "11:Alias"]);
  const stableDecoy = candidate('function Panel(){ return "stable decoy marker"; }', ["12:Decoy"]);
  const betaTarget = candidate('function Panel(){ return "beta replacement marker"; }', ["20:Panel"]);
  const betaDecoy = candidate('function Panel(){ return "beta decoy marker"; }', ["21:Decoy"]);
  const repair = makeRepair([
    { label: "stable", candidate: stableTarget, candidates: [stableTarget, stableDecoy] },
    { label: "beta", candidate: betaTarget, candidates: [betaTarget, betaDecoy] },
  ], ["stable replacement marker"]);

  expect(repair.expression).toContain(JSON.stringify("stable replacement marker"));
  expect(repair.expression).toContain(JSON.stringify("beta replacement marker"));
  expect(repair.checks.map(({ matches }) => matches)).toEqual([1, 1]);
  const stableRun = runRepair(repair.expression!, [stableTarget, stableDecoy]);
  const betaRun = runRepair(repair.expression!, [betaTarget, betaDecoy]);
  expect(stableRun.result).toBe(stableRun.runtime.get(stableTarget));
  expect(betaRun.result).toBe(betaRun.runtime.get(betaTarget));
});

test("rejects a union whose beta alternative collides in the stable catalog", () => {
  const stableTarget = candidate('function Panel(){ return "stable unique marker"; }', ["10:Panel"]);
  const stableDecoy = candidate('function Panel(){ return "stable decoy marker"; }', ["11:Decoy"]);
  const betaTarget = candidate('function Panel(){ return "beta unique marker"; }', ["20:Panel"]);
  const betaDecoy = candidate('function Panel(){ return "beta decoy marker"; }', ["21:Decoy"]);
  const repair = makeRepair([
    { label: "stable", candidate: stableTarget, candidates: [stableTarget, stableDecoy, betaTarget] },
    { label: "beta", candidate: betaTarget, candidates: [betaTarget, betaDecoy] },
  ]);
  expect(repair.expression).toBeUndefined();
  expect(repair.checks[0].matches).toBe(2);
  expect(repair.reason).toContain("not unique");
});

test("uses module lookup for bare module identities rather than treating modules as exports", () => {
  const selected = candidate('function Module(){ return "bare module marker"; }', ["100"]);
  const exported = candidate('function Export(){ return "bare module marker"; }', ["101:Export"]);
  const repair = makeRepair([{ label: "stable", candidate: selected, candidates: [selected] }]);
  expect(repair.expression).toContain("W.findModule(");
  expect(repair.expression).not.toContain("W.findModuleExport");
  const run = runRepair(repair.expression!, [selected, exported]);
  expect(run.result).toBe(run.runtime.get(selected));
});

test("real module search rejects a second matching default object despite a correct first result", () => {
  const target = { TargetMarker: true }, other = { TargetMarker: true };
  const modules = [target, { default: other }];
  const helpers = {
    findModule(predicate: (value: unknown) => unknown) {
      for (const module of modules) {
        if ("default" in module && module.default && predicate(module.default)) return module.default;
        if (predicate(module)) return module;
      }
    },
    findModuleExport() { return undefined; },
  };
  const find = (W: Parameters<typeof checkRepair>[1]) => W.findModule((value) => !!value && typeof value === "object" && "TargetMarker" in value);
  expect(find(helpers)).toBe(target);
  expect(checkRepair(find, helpers, target)).toEqual({ same: true, matches: 2 });
});

test("real module search counts aliases of the same object only once", () => {
  const target = { TargetMarker: true };
  const helpers = {
    findModule(predicate: (value: unknown) => unknown) {
      for (const value of [target, target]) if (predicate(value)) return value;
    },
    findModuleExport() { return undefined; },
  };
  const find = (W: Parameters<typeof checkRepair>[1]) => W.findModule((value) => !!value && typeof value === "object" && "TargetMarker" in value);
  expect(checkRepair(find, helpers, target)).toEqual({ same: true, matches: 1 });
});

test("real match counting visits both helpers of an OR search", () => {
  const target = { TargetMarker: true }, other = { TargetMarker: true };
  const helpers = {
    findModule(predicate: (value: unknown) => unknown) { return predicate(other) ? other : undefined; },
    findModuleExport(predicate: (value: unknown) => unknown) { return predicate(target) ? target : undefined; },
  };
  const predicate = (value: unknown) => !!value && typeof value === "object" && "TargetMarker" in value;
  const find = (W: Parameters<typeof checkRepair>[1]) => W.findModuleExport(predicate) || W.findModule(predicate);
  expect(checkRepair(find, helpers, target)).toEqual({ same: true, matches: 2 });
});

test("matches actual render and type function sources", () => {
  const render = candidate('function Render(){ return "render target marker"; }', ["31:Panel"], { via: "render" });
  const renderDecoy = candidate('function Render(){ return "render decoy marker"; }', ["32:Panel"]);
  const type = candidate('function Type(){ return "type target marker"; }', ["41:Panel"], { via: "type" });
  const typeDecoy = candidate('function Type(){ return "type decoy marker"; }', ["42:Panel"]);
  const repair = makeRepair([
    { label: "stable", candidate: render, candidates: [render, renderDecoy] },
    { label: "beta", candidate: type, candidates: [type, typeDecoy] },
  ]);
  expect(repair.expression).toContain("e?.render");
  expect(repair.expression).toContain("e?.type");
  const renderRun = runRepair(repair.expression!, [render, renderDecoy]);
  const typeRun = runRepair(repair.expression!, [type, typeDecoy]);
  expect(renderRun.result).toBe(renderRun.runtime.get(render));
  expect(typeRun.result).toBe(typeRun.runtime.get(type));
});

test("generates stable object-key predicates", () => {
  const selected = candidate("", ["50:Store"], { keys: ["HistoryController", "CurrentNavigator"] });
  const decoy = candidate("", ["51:Store"], { keys: ["HistoryController", "SearchResults"] });
  const repair = makeRepair([{ label: "stable", candidate: selected, candidates: [selected, decoy] }]);
  expect(repair.expression).toContain('"CurrentNavigator" in e');
  const run = runRepair(repair.expression!, [selected, decoy]);
  expect(run.result).toBe(run.runtime.get(selected));
});

test("refuses minified object-key predicates", () => {
  const selected = candidate("", ["52:Store"], { keys: ["a", "bc"] });
  const repair = makeRepair([{ label: "stable", candidate: selected, candidates: [selected] }]);
  expect(repair.expression).toBeUndefined();
});

test("uses stable class-method checks when source text cannot distinguish exports", () => {
  const selected = candidate("class Panel { ClosePanel() {} RenderDetails() {} }", ["60:Panel"], {
    methods: ["ClosePanel", "RenderDetails"],
  });
  const decoy = candidate("class Panel { ClosePanel() {} SearchResults() {} }", ["61:Panel"], {
    methods: ["ClosePanel", "SearchResults"],
  });
  const repair = makeRepair([{ label: "stable", candidate: selected, candidates: [selected, decoy] }]);
  expect(repair.expression).toContain('"RenderDetails" in e.prototype');
  const run = runRepair(repair.expression!, [selected, decoy]);
  expect(run.result).toBe(run.runtime.get(selected));
});

test("loads the newest strictly older numeric baseline with an exact UI version", async () => {
  await withTempDirectory(async (directory) => {
    await saveSnapshot(directory, "stable", "9", "1.2.0", baseline("stable 9", "1.2.0", { panel: { at: ["9:Panel"] } }));
    await saveSnapshot(directory, "stable", "10", "1.2.0", baseline("stable 10", "1.2.0", { panel: { at: ["10:Panel"], keys: ["contextType"] } }));
    await saveSnapshot(directory, "stable", "19", "1.2.1", baseline("stable 19", "1.2.1", {}));
    await saveSnapshot(directory, "stable", "20", "1.2.0", baseline("stable 20", "1.2.0", {}));

    const result = await loadBaseline(directory, "stable", "20", "1.2.0");
    expect(result?.file).toBe(join(directory, "stable-10.decky-ui-1.2.0.json"));
    expect(result?.snapshot.finders.panel).toEqual({ at: ["10:Panel"], keys: ["contextType"] });
  });
});

test("loads beta snapshots for the publicbeta runtime branch", async () => {
  await withTempDirectory(async (directory) => {
    await saveSnapshot(directory, "beta", "9", "1.2.0", baseline("publicbeta 9", "1.2.0", {}));
    const result = await loadBaseline(directory, "publicbeta", "10", "1.2.0");
    expect(result?.file).toBe(join(directory, "beta-9.decky-ui-1.2.0.json"));
  });
});

test("returns no baseline for a missing directory and rejects a malformed latest record", async () => {
  await withTempDirectory(async (directory) => {
    const missing = join(directory, "missing");
    expect(await loadBaseline(missing, "stable", "20", "1.2.0")).toBeUndefined();
    await saveSnapshot(directory, "stable", "9", "1.2.0", baseline("stable 9", "1.2.0", { panel: { at: ["9:Panel"] } }));
    await saveSnapshot(directory, "stable", "10", "1.2.0", baseline("stable 10", "1.2.0", { panel: { at: "10:Panel" } }));
    await expect(loadBaseline(directory, "stable", "20", "1.2.0")).rejects.toThrow("Malformed finder baseline snapshot");
  });
});
