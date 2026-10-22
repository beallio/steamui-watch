import * as React from "react";
import { createModuleMapping } from "@decky/ui";
import bundled from "./extras.json";
import { createExtrasRuntime } from "./runtime";

type ExtraName = keyof typeof bundled.components;
type ExtraProps = Record<string, unknown>;
type WrapperProps = ExtraProps & React.RefAttributes<unknown>;
type RawComponent = React.ComponentType<ExtraProps> | React.ExoticComponent<ExtraProps>;

const names = Object.keys(bundled.components) as ExtraName[];
const runtime = createExtrasRuntime({
  bundled,
  names,
  modules: () => createModuleMapping(() => true),
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
  Object.fromEntries(names.map((name) => [name, wrap(name)])) as Record<ExtraName, React.ForwardRefExoticComponent<WrapperProps>>,
);

export function findExtra(name: ExtraName): RawComponent | null {
  runtime.start();
  const component = runtime.get(name) as RawComponent | null;
  if (!component) warnMissing(name);
  return component;
}

export function refreshExtras(): Promise<boolean> {
  return runtime.refresh();
}

export function stopExtrasUpdates(): void {
  runtime.dispose();
}
