import { expect, mock, test } from "bun:test";

// The peers come from Steam at runtime; only the pure helpers run here.
mock.module("react", () => ({ createElement: () => null, Fragment: Symbol.for("react.fragment"), Component: class {} }));
mock.module("@decky/ui", () => ({}));
mock.module("./icons", () => ({ SteamIcon: () => null }));
const { nextSortValue, sortLabel } = await import("./patterns");

const options = [{ label: "Date", value: "date" }, { label: "Name", value: "name" }, { label: "Size", value: "size" }] as const;

test("the sort selector moves to the next option and wraps around", () => {
  expect(nextSortValue(options, "date")).toBe("name");
  expect(nextSortValue(options, "size")).toBe("date");
  // An unknown or missing value starts at the first option.
  expect(nextSortValue(options, "other" as "date")).toBe("date");
  expect(nextSortValue(options, undefined)).toBe("date");
  expect(nextSortValue([], undefined)).toBeUndefined();
});

test("the selector label falls back to the first option", () => {
  expect(sortLabel(options, "name")).toBe("Name");
  expect(sortLabel(options, undefined)).toBe("Date");
  expect(sortLabel([], undefined)).toBe("");
});
