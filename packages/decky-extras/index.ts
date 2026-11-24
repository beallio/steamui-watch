import * as React from "react";
import * as DeckyUI from "@decky/ui";
import bundled from "./extras.json";
import { componentsOf, type Manifest } from "./match";
import { createExtrasRuntime } from "./runtime";

type ExtraName = string;
type ExtraProps = Record<string, unknown>;
type WrapperProps = ExtraProps & React.RefAttributes<unknown>;
type RawComponent = React.ComponentType<ExtraProps> | React.ExoticComponent<ExtraProps>;

const names = Object.keys(bundled.extras);
const componentNames = Object.keys(componentsOf(bundled as Manifest));
const createScopeMapping = (DeckyUI as typeof DeckyUI & {
  createScopeMapping?: (filter: (module: unknown) => boolean) => Map<string, unknown>;
}).createScopeMapping;
const runtime = createExtrasRuntime({
  bundled,
  names,
  modules: () => (createScopeMapping ?? DeckyUI.createModuleMapping)(() => true),
});
const warned: Record<string, true> = Object.create(null);

function warnMissing(name: string) {
  if (warned[name]) return;
  warned[name] = true;
  console.warn(`[decky-extras] ${name} is unavailable or ambiguous in this Steam build.`);
}

function wrap(name: ExtraName): React.ForwardRefExoticComponent<WrapperProps> {
  const Wrapped = React.forwardRef<unknown, ExtraProps>((props, ref) => {
    const [, setRevision] = React.useState(0);
    React.useEffect(() => runtime.subscribe(() => setRevision((value) => value + 1)), []);
    const Component = runtime.get(name) as React.ElementType<Record<string, unknown>> | null;
    if (!Component) {
      warnMissing(name);
      return null;
    }
    return React.createElement(Component, ref == null ? props : { ...props, ref });
  });
  Wrapped.displayName = `DeckyExtra(${name})`;
  return Wrapped;
}

export const extras: Readonly<Record<ExtraName, React.ForwardRefExoticComponent<WrapperProps>>> = Object.freeze(
  Object.fromEntries(componentNames.map((name) => [name, wrap(name)])),
);

export function findExtra(name: ExtraName): RawComponent | null {
  runtime.start();
  const component = runtime.get(name) as RawComponent | null;
  if (!component) warnMissing(name);
  return component;
}

/** A Steam function or object (kind "function" or "object"), or `null` when missing or not unique. */
export function findSteamValue(name: string): unknown {
  runtime.start();
  const value = runtime.get(name);
  if (value == null) warnMissing(name);
  return value;
}

export function refreshExtras(): Promise<boolean> {
  return runtime.refresh();
}

export function stopExtrasUpdates(): void {
  runtime.dispose();
}

export { findSteamIcon, steamIconNames, SteamIcon, IconBrowser } from "./icons";
export type { SteamIconProps, IconBrowserProps } from "./icons";
export { DetailRow, ListHeader } from "./patterns";
export type { DetailItem, DetailRowProps, ListHeaderProps, SortOption } from "./patterns";
