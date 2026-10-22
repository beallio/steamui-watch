import { expect, test } from "bun:test";
import { matchExtras, parseManifest } from "./match";

test("executable-style finder atoms are rejected", () => {
  expect(() => parseManifest({
    schema: 1,
    revision: 1,
    components: { RadioButton: { title: "Radio button", description: "", find: [[{ regex: ".*" }]] } },
  })).toThrow();
});

test("AND clauses, OR atoms, identity deduplication, and ambiguity are preserved", () => {
  const manifest = parseManifest({
    schema: 1,
    revision: 1,
    components: {
      Unique: { title: "Unique", description: "", find: [[{ text: "needle" }, { member: "unused" }], [{ binding: "mode" }]] },
      Ambiguous: { title: "Ambiguous", description: "", find: [[{ text: "needle" }]] },
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
  const manifest = parseManifest({
    schema: 1, revision: 1,
    components: { ToggleRow: { title: "Toggle", description: "", find: [[{ member: "ToggleRow" }]] } },
  });
  const yes = new Function("return x.ToggleRow");
  const no = new Function("return x.ToggleRowExtra");
  const module = { yes, no, get broken() { throw new Error("uninitialized"); } };
  expect(matchExtras([["m", module]], manifest).ToggleRow).toEqual([yes]);
});
