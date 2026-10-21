import { expect, test } from "bun:test";
import { selectorUsesClass } from "./decky_catalog";

test("keeps a rule only when a whole class name is used", () => {
  const used = new Set(["Panel", "_3xy45At7o_lkxcLoSTF6e0", "gpfocus"]);
  expect(selectorUsesClass(".Panel", used)).toBe(true);
  expect(selectorUsesClass(".PanelSection", used)).toBe(false); // prefix of another class
  expect(selectorUsesClass(".Other .Panel:hover > span", used)).toBe(true); // any compound part
  expect(selectorUsesClass("._3xy45At7o_lkxcLoSTF6e0.gpfocus", used)).toBe(true);
  expect(selectorUsesClass(":root", used)).toBe(false);
});
