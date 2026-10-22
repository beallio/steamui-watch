import { expect, test } from "bun:test";
import { readSource } from "./finder_table";

const table = (src: string) => readSource(src, "f.js");

test("&& makes clauses, || makes alternatives, and negations and generic names add nothing", () => {
  const { entries, unread } = table(`
    const re = createPropListRegex(["a", "b"], false);
    export const A = findModuleExport((e) => (e?.toString?.()?.includes('x') && e.toString().includes("y")) || e?.render?.toString().includes(\`z\`));
    export const B = Object.values(CommonUIModule).find((m) => m?.prototype?.Reset && "SetChecked" in m.prototype && !m.prototype.Cancel
      && typeof m == "function" && (re.test(m.toString()) || /q.+?r/.test(m)));`);
  expect(unread).toEqual([]);
  expect(entries).toEqual([
    { name: "f.js: A", code: [[{ text: "x" }, { text: "z" }], [{ text: "y" }, { text: "z" }]] },
    { name: "f.js: B", code: [[{ name: "Reset" }], [{ name: "SetChecked" }], [{ props: ["a", "b"], from_start: false }, { regex: "q.+?r" }]] },
  ]);
});

test("block predicates, chained private searches and class finders", () => {
  const { entries } = table(`
    export const Common = findModule((m) => {
      if (typeof m !== 'object') return false;
      for (let p in m) { if (m[p]?.contextType && Object.keys(m).length > 60) return true; }
      return false;
    });
    const Mod = findModuleByExport((e) => window.SP_REACT?.x && e.toString().includes('k'));
    export const C = Mod && Object.values(Mod).find((e) => e?.type?.toString?.()?.includes('(function()'));
    export const Row = Object.values(Mod).filter((e) => !e.toString().includes('k'))[0];
    export const D = (props) => findModuleExport((e) => e.includes('runs later'));
    export const cls = findClassModule((m) => m.Title && !m['vr-bar']);`);
  expect(entries).toEqual([
    { name: "f.js: Common", code: [[{ name: "contextType" }]] },
    { name: "f.js: Mod", code: [[{ text: "k" }]] },
    { name: "f.js: C", code: [[{ text: "(function()" }]] },
    { name: "f.js: cls", classes: { has: ["Title"], lacks: ["vr-bar"] } },
  ]);
});

test("unknown predicate forms are reported, not dropped", () => {
  const { unread } = table(`
    const needle = "x";
    export const A = findModuleExport((e) => e.toString().includes(needle));
    export const B = findModuleExport((e) => someRegex.test(e.toString()));
    export const C = findClass("1", "Name");`);
  expect(unread.map((u) => u.replace(/ at offset \d+$/, ""))).toEqual([
    "f.js: A: `.includes()` with a non-literal argument",
    "f.js: B: `.test()` on an unknown regex",
    "f.js: C: findClass is not supported",
  ]);
});
