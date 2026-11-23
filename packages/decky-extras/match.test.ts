import { expect, test } from "bun:test";
import { componentsOf, matchExtras, parseManifest, parseManifestV1, projectV1 } from "./match";
import bundled from "./extras.json";

const one = (kind: string, find: unknown[][]) => ({
  schema: 2, revision: 1, extras: { Target: { kind, title: "Target", description: "", find } },
});

test("bundled finders match backtick-source Steam components", () => {
  const component = new Function("return `RadioButton`");
  const matches = matchExtras([["module", { component }]], parseManifest(bundled));
  expect(matches.RadioButton).toEqual([component]);
});

test("executable-style, misplaced and negative-only atoms are rejected", () => {
  for (const [kind, find] of [
    ["component", [[{ regex: ".*" }]]],
    ["class", [[{ text: "x" }]]],
    ["component", [[{ key: "m_history" }]]],
    ["object", [[{ text: "x" }]]],
    ["object", [[{ key: "a.b" }]]],
    ["object", [[{ key: "__proto__" }]]],
    ["function", [[{ not: { text: "x" } }]]],
    ["function", [[{ text: "x" }], [{ not: { not: { text: "y" } } }]]],
  ] as const) expect(() => parseManifest(one(kind, find as unknown as unknown[][]))).toThrow();
  expect(() => parseManifest({ schema: 1, revision: 1, components: {} })).toThrow();
});

test("AND clauses, OR atoms, identity deduplication, and ambiguity are preserved", () => {
  const manifest = parseManifest({
    schema: 2,
    revision: 1,
    extras: {
      Unique: { kind: "component", title: "Unique", description: "", find: [[{ text: "needle" }, { member: "unused" }], [{ binding: "mode" }]] },
      Ambiguous: { kind: "component", title: "Ambiguous", description: "", find: [[{ text: "needle" }]] },
    },
  });
  const unique = { render: new Function("p", "const{mode:x=0}=p;return 'needle'+x") };
  const other = { render() { return "needle"; } };
  const found = matchExtras([
    ["one", { unique, other }],
    ["reexport", { again: unique }],
  ], manifest);

  expect(found.Unique).toEqual([unique]);
  expect(found.Ambiguous).toEqual([unique, other]);
});

test("member names stop at identifier boundaries and throwing exports are skipped", () => {
  const manifest = parseManifest(one("component", [[{ member: "ToggleRow" }]]));
  const yes = new Function("return x.ToggleRow");
  const no = new Function("return x.ToggleRowExtra");
  const module = { yes, no, get broken() { throw new Error("uninitialized"); } };
  expect(matchExtras([["m", module]], manifest).Target).toEqual([yes]);
});

test("objects match inherited property names without running getters", () => {
  class Store { get m_history(): never { throw new Error("getter ran"); } m_navigator() {} }
  const store = Object.assign(new Store(), { m_locationPathname: "/" });
  const lookalike = { m_history: 1, m_navigator: 1 };
  const manifest = parseManifest(one("object", [[{ key: "m_history" }], [{ key: "m_navigator" }], [{ key: "m_locationPathname" }]]));
  expect(matchExtras([["m", { store, lookalike, Store }]], manifest).Target).toEqual([store]);
});

test("functions match by source or prototype names, never objects with the same text", () => {
  class Toaster { Show() { return 1; } }
  const render = () => "notification";
  const wrapped = { render };
  const bySource = parseManifest(one("function", [[{ text: "notification" }]]));
  expect(matchExtras([["m", { Toaster, render, wrapped }]], bySource).Target).toEqual([render]);
  const byMethod = parseManifest(one("function", [[{ key: "Show" }]]));
  expect(matchExtras([["m", { Toaster, render, instance: new Toaster() }]], byMethod).Target).toEqual([Toaster]);
});

test("not atoms remove a second match", () => {
  const a = () => "callout pulse";
  const b = () => "callout pulse wiggle";
  const manifest = parseManifest(one("function", [[{ text: "callout" }], [{ not: { text: "wiggle" } }]]));
  expect(matchExtras([["m", { a, b }]], manifest).Target).toEqual([a]);
});

test("the schema 1 copy keeps components and earlier finders for schema 2 atoms", () => {
  const manifest = parseManifest(bundled);
  const copy = projectV1(manifest, null);
  expect(copy.revision).toBe(manifest.revision);
  expect(copy.components).toEqual(Object.fromEntries(Object.entries(componentsOf(manifest))
    .map(([name, { title, description, find }]) => [name, { title, description, find }])));
  expect(parseManifestV1(copy)).toBe(copy);

  const next = parseManifest({ schema: 2, revision: 3, extras: {
    Old: { kind: "component", title: "Old", description: "", find: [[{ text: "x" }], [{ not: { text: "y" } }]] },
    New: { kind: "component", title: "New", description: "", find: [[{ text: "z" }], [{ not: { text: "y" } }]] },
    Plain: { kind: "component", title: "Plain", description: "", find: [[{ text: "p" }]] },
    Store: { kind: "object", title: "Store", description: "", find: [[{ key: "m_x" }]] },
  } });
  const previous = parseManifestV1({ schema: 1, revision: 2, components: {
    Old: { title: "Old", description: "", find: [[{ text: "x" }, { text: "old" }]] },
  } });
  expect(projectV1(next, previous).components).toEqual({
    Old: { title: "Old", description: "", find: [[{ text: "x" }, { text: "old" }]] },
    Plain: { title: "Plain", description: "", find: [[{ text: "p" }]] },
  });
  expect(() => projectV1(next, { ...previous, revision: 4 })).toThrow("older");
});
