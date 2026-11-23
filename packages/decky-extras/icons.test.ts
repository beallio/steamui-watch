import { expect, mock, spyOn, test } from "bun:test";

class FakeReactComponent {
  props: unknown;

  constructor(props: unknown) {
    this.props = props;
  }
}
const Clock = function Clock() {};
const uiIcons = { Clock };
mock.module("react", () => ({
  Component: FakeReactComponent,
  Fragment: Symbol.for("react.fragment"),
  createElement: () => null,
  forwardRef: (component: unknown) => component,
  useEffect: () => undefined,
  useState: (value: unknown) => [value, () => undefined],
}));
mock.module("@decky/ui", () => ({
  IconsModule: uiIcons,
  createModuleMapping: () => new Map(),
}));
mock.module("./index", () => ({ findSteamValue: () => null }));

// Load after the module mocks because this package's peers are supplied by Steam.
const {
  canRenderIcon,
  filterIconCells,
  findSteamIcon,
  IconErrorBoundary,
  lookupIcon,
  propsForSteamIcon,
  selectIconRegistry,
  steamIconNames,
} = await import("./icons");

test("Steam icon registry selection and name lookup use the live value first", () => {
  const steamIcons = { Arrow: function Arrow() {} };
  const deckyIcons = { Clock: function Clock() {} };
  expect(selectIconRegistry(steamIcons, deckyIcons)).toBe(steamIcons);
  expect(selectIconRegistry(null, deckyIcons)).toBe(deckyIcons);
  expect(selectIconRegistry("not an object", null)).toBeNull();
  expect(lookupIcon(steamIcons, "Arrow")).toBe(steamIcons.Arrow);
  expect(lookupIcon(steamIcons, "toString")).toBeNull();
  expect(steamIconNames()).toEqual(["Clock"]);
  expect(findSteamIcon("Clock")).toBe(Clock);
});

test("missing icon names warn once", () => {
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    expect(findSteamIcon("__missing_test_icon__")).toBeNull();
    expect(findSteamIcon("__missing_test_icon__")).toBeNull();
    expect(warning).toHaveBeenCalledTimes(1);
  } finally {
    warning.mockRestore();
  }
});

test("directional icons default up and size sets SVG dimensions", () => {
  expect(propsForSteamIcon("Arrow", { title: "move" }, 20)).toEqual({
    title: "move",
    direction: "up",
    width: 20,
    height: 20,
  });
  // Without `size`, icons follow the text size unless the caller sets width or height.
  expect(propsForSteamIcon("Arrow", { direction: "left" })).toEqual({ direction: "left", width: "1em", height: "1em" });
  expect(propsForSteamIcon("Clock", { width: 30 })).toEqual({ width: 30, height: "1em" });
  expect(propsForSteamIcon("Clock", { direction: "right" }, 16)).toEqual({
    direction: "right",
    width: 16,
    height: 16,
  });
});

test("FrameControllerPairing needs a controller role", () => {
  expect(canRenderIcon("FrameControllerPairing", {})).toBe(false);
  expect(canRenderIcon("FrameControllerPairing", { controllerProps: {} })).toBe(false);
  expect(canRenderIcon("FrameControllerPairing", { controllerProps: { role: "left" } })).toBe(true);
  expect(canRenderIcon("Clock", {})).toBe(true);
});

test("search is case-insensitive and expands directional icons", () => {
  expect(filterIconCells(["Arrow", "Clock", "Carat"], "AR")).toEqual([
    { name: "Arrow", direction: "up" },
    { name: "Arrow", direction: "down" },
    { name: "Arrow", direction: "left" },
    { name: "Arrow", direction: "right" },
    { name: "Carat", direction: "up" },
    { name: "Carat", direction: "down" },
    { name: "Carat", direction: "left" },
    { name: "Carat", direction: "right" },
  ]);
  expect(filterIconCells(["Clock"], "CLOCK")).toEqual([{ name: "Clock" }]);
});

test("icon error boundary derives an error state", () => {
  expect(IconErrorBoundary.getDerivedStateFromError(new Error("icon failed"))).toEqual({ hasError: true });
});
