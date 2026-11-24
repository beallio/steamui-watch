import * as React from "react";
import * as DeckyUI from "@decky/ui";
import { findSteamValue } from "./index";

type IconRegistry = Record<string, unknown>;
type IconComponent = React.ComponentType<Record<string, unknown>> | React.ExoticComponent<Record<string, unknown>>;
type IconDirection = "up" | "down" | "left" | "right";
type IconCell = { name: string; direction?: IconDirection };

const directions: IconDirection[] = ["up", "down", "left", "right"];
const directionalIcons: Record<string, true> = Object.assign(Object.create(null), {
  Arrow: true,
  Carat: true,
  DirectionalButton: true,
  DoubleCarat: true,
});
const warned: Record<string, true> = Object.create(null);

function isObject(value: unknown): value is IconRegistry {
  return typeof value === "object" && value !== null;
}

export function selectIconRegistry(steamIcons: unknown, deckyIcons: unknown): IconRegistry | null {
  if (isObject(steamIcons)) return steamIcons;
  return isObject(deckyIcons) ? deckyIcons : null;
}

export function lookupIcon(registry: IconRegistry | null, name: string): unknown | null {
  if (!registry || !Object.prototype.hasOwnProperty.call(registry, name)) return null;
  return registry[name] ?? null;
}

export function canRenderIcon(name: string, props: Record<string, unknown>): boolean {
  if (name !== "FrameControllerPairing") return true;
  const controllerProps = props.controllerProps;
  return isObject(controllerProps) && controllerProps.role != null;
}

export function propsForSteamIcon(
  name: string,
  props: Record<string, unknown>,
  size?: number,
): Record<string, unknown> {
  const iconProps = { ...props };
  if (directionalIcons[name] && iconProps.direction === undefined) iconProps.direction = "up";
  // Most Steam icons have no size of their own and fill their container; 1em follows the text size like other icon sets.
  const dimension = size ?? "1em";
  if (size !== undefined || iconProps.width === undefined) iconProps.width = dimension;
  if (size !== undefined || iconProps.height === undefined) iconProps.height = dimension;
  return iconProps;
}

export function filterIconCells(names: readonly string[], query: string): IconCell[] {
  const needle = query.toLowerCase();
  return names.filter((name) => name.toLowerCase().includes(needle)).flatMap((name) =>
    directionalIcons[name] ? directions.map((direction) => ({ name, direction })) : [{ name }],
  );
}

type BoundaryProps = { fallback?: React.ReactNode; children?: React.ReactNode };
type BoundaryState = { hasError: boolean };

export class IconErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(_error: unknown): BoundaryState {
    return { hasError: true };
  }

  render(): React.ReactNode {
    return this.state.hasError ? this.props.fallback ?? null : this.props.children ?? null;
  }
}

function iconRegistry(): IconRegistry | null {
  return selectIconRegistry(findSteamValue("SteamIcons"), DeckyUI.IconsModule);
}

function warnMissingIcon(name: string): void {
  if (warned[name]) return;
  warned[name] = true;
  console.warn(`[decky-extras] Steam icon ${name} is unavailable in this Steam build.`);
}

export function findSteamIcon(name: string): IconComponent | null {
  const icon = lookupIcon(iconRegistry(), name);
  if (typeof icon !== "function" && (typeof icon !== "object" || icon === null)) {
    warnMissingIcon(name);
    return null;
  }
  return icon as IconComponent;
}

export function steamIconNames(): string[] {
  return Object.keys(iconRegistry() ?? {}).sort();
}

export type SteamIconProps = {
  name: string;
  size?: number;
  fallback?: React.ReactNode;
  [prop: string]: unknown;
};

function resolveIcon(name: string, props: Record<string, unknown>): IconComponent | null {
  return canRenderIcon(name, props) ? findSteamIcon(name) : null;
}

/**
 * Draws the icon inside a span that also sizes its <svg> directly: some Steam icons (for example SortByGeneric)
 * set their own width and height and ignore those props.
 */
function iconElement(Icon: IconComponent, iconProps: Record<string, unknown>): React.ReactElement {
  const css = (value: unknown) => typeof value === "number" ? `${value}px` : String(value);
  const fit = (element: HTMLElement | null) => {
    const svg = element?.querySelector("svg");
    if (!svg) return;
    svg.style.width = css(iconProps.width);
    svg.style.height = css(iconProps.height);
  };
  return React.createElement("span", { ref: fit, style: { display: "inline-flex", lineHeight: 0 } }, React.createElement(Icon, iconProps));
}

export function SteamIcon(props: SteamIconProps): React.ReactElement | null {
  const { fallback: fallbackProp, name, size, ...passedProps } = props;
  const fallback = fallbackProp ?? null;
  const Icon = resolveIcon(props.name, props);
  if (!Icon) return React.createElement(React.Fragment, null, fallback);
  return React.createElement(
    IconErrorBoundary,
    { key: props.name, fallback },
    iconElement(Icon, propsForSteamIcon(name, passedProps, size)),
  );
}

function snippetFor(cell: IconCell): string {
  const direction = cell.direction ? ` direction=${JSON.stringify(cell.direction)}` : "";
  return `<SteamIcon name=${JSON.stringify(cell.name)}${direction} />`;
}

export type IconBrowserProps = { onSelect?: (name: string, snippet: string) => void };

type CopyWindow = {
  top?: CopyWindow | null;
  document?: Document;
  navigator?: Navigator;
  SteamClient?: { Browser?: { NotifyUserActivation?: () => void } };
};

/**
 * Copies text the way Steam's own CopyTextToClipboard does. Gaming Mode windows have no DOM focus during gamepad
 * navigation, so the Clipboard API refuses; execCommand("copy") works after SteamClient.Browser.NotifyUserActivation.
 * Outside Steam it uses the Clipboard API.
 */
export async function copySnippet(text: string, win: CopyWindow = globalThis as CopyWindow): Promise<boolean> {
  const top = win.top ?? win;
  const notify = top.SteamClient?.Browser?.NotifyUserActivation;
  const doc = top.document;
  if (typeof notify === "function" && doc?.body) {
    const area = doc.createElement("textarea");
    area.textContent = text;
    area.style.position = "fixed";
    doc.body.appendChild(area);
    area.select();
    try {
      notify.call(top.SteamClient!.Browser);
      return doc.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
  try {
    await top.navigator!.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function IconBrowser({ onSelect }: IconBrowserProps): React.ReactElement {
  const [search, setSearch] = React.useState("");
  const [selectedSnippet, setSelectedSnippet] = React.useState("");
  const [copyStatus, setCopyStatus] = React.useState("");
  const registry = iconRegistry();
  const cells = filterIconCells(Object.keys(registry ?? {}).sort(), search);
  const TextField = DeckyUI.TextField;
  const Focusable = DeckyUI.Focusable;

  return React.createElement(
    "div",
    null,
    React.createElement(TextField, {
      label: "Search Steam icons",
      value: search,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSearch(event.target.value),
    }),
    React.createElement(
      "div",
      { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8 } },
      ...cells.map((cell) => {
        const snippet = snippetFor(cell);
        const fallback = cell.name === "FrameControllerPairing" ? "Requires controllerProps.role" : null;
        const found = canRenderIcon(cell.name, {}) ? lookupIcon(registry, cell.name) : null;
        const Icon = typeof found === "function" || (typeof found === "object" && found !== null) ? found as IconComponent : null;
        const icon = Icon
          ? iconElement(Icon, propsForSteamIcon(cell.name, cell.direction ? { direction: cell.direction } : {}, 24))
          : fallback;
        const activate = () => {
          setSelectedSnippet(snippet);
          setCopyStatus("");
          void copySnippet(snippet).then((copied) => setCopyStatus(copied ? "Copied" : "Not copied: select the text"));
          onSelect?.(cell.name, snippet);
        };
        return React.createElement(
          Focusable,
          {
            key: `${cell.name}:${cell.direction ?? ""}`,
            // Focusable calls onActivate for the A button and for clicks; an onClick too would run it twice.
            onActivate: activate,
            style: { minHeight: 64, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 },
          },
          React.createElement(
            IconErrorBoundary,
            { fallback },
            icon,
          ),
          React.createElement("span", null, cell.direction ? `${cell.name} (${cell.direction})` : cell.name),
        );
      }),
    ),
    selectedSnippet && React.createElement("code", { style: { display: "block", marginTop: 8, userSelect: "text" } }, selectedSnippet),
    copyStatus && React.createElement("div", { "data-copy-status": "" }, copyStatus),
  );
}
