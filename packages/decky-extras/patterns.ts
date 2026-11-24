import * as React from "react";
import * as DeckyUI from "@decky/ui";
import { SteamIcon } from "./icons";

// Steam Deck GamepadUI color variables, with fallbacks where Steam does not set them.
const COLORS = {
  textPrimary: "var(--gpSystemLightestGrey, #dcdedf)",
  textBody: "var(--gpSystemLighterGrey, #b8bcbf)",
  textSub: "var(--gpSystemLightGrey, #8b929a)",
  rule: "rgba(103, 112, 123, 0.3)",
};
const FOCUS_CLASS = "decky-extras-focus";
// A plain Focusable has no gamepad focus ring of its own; Steam's controls do. The doubled class outranks
// Steam's `div:focus { outline: none }`.
const FOCUS_CSS = `.${FOCUS_CLASS}.${FOCUS_CLASS}{outline:2px solid rgba(255,255,255,0.8);outline-offset:2px;border-radius:4px}`;
const CAPS: React.CSSProperties = { fontSize: 12, fontWeight: 700, lineHeight: "22px", letterSpacing: "0.5px", textTransform: "uppercase" };
const h = React.createElement;

export type SortOption<T extends string = string> = { label: string; value: T };

/** The label of the selected option, or of the first one when the value is not listed. */
export function sortLabel<T extends string>(options: readonly SortOption<T>[], value: T | undefined): string {
  return (options.find((option) => option.value === value) ?? options[0])?.label ?? "";
}

/** The option after the selected one, wrapping around; the first one when the value is not listed. */
export function nextSortValue<T extends string>(options: readonly SortOption<T>[], value: T | undefined): T | undefined {
  const index = options.findIndex((option) => option.value === value);
  return options[(index + 1) % options.length]?.value;
}

/** The sort controls are controlled: each appears only with its current value and its change handler. */
export type ListHeaderProps<T extends string = string> = {
  label: React.ReactNode;
  count?: number;
  /** The sort selector needs sortOptions, sort and onSortChange. */
  sortOptions?: readonly SortOption<T>[];
  sort?: T;
  // T comes from sortOptions and sort; inferring from the callback would widen a useState setter's T to string.
  onSortChange?: (value: NoInfer<T>) => void;
  /** The direction button needs descending and onDescendingChange. */
  descending?: boolean;
  onDescendingChange?: (descending: boolean) => void;
  /** Accessible names for the direction button; English defaults. */
  ascendingLabel?: string;
  descendingLabel?: string;
};

/**
 * Which sort controls to draw. Without its current value a control could only repeat the first option or the
 * same direction, so a control appears only with both its value and its handler.
 */
export function sortControls<T extends string>(props: ListHeaderProps<T>): { selector: boolean; direction: boolean } {
  return {
    selector: Boolean(props.sortOptions?.length) && props.sort !== undefined && typeof props.onSortChange === "function",
    direction: typeof props.descending === "boolean" && typeof props.onDescendingChange === "function",
  };
}

/**
 * Storage-style list header: label and count, a rule, a sort selector, and a sort-direction button (see
 * sortControls for when each appears). Activating the selector moves to the next option.
 */
export function ListHeader<T extends string = string>(props: ListHeaderProps<T>): React.ReactElement {
  const { label, count, sortOptions, sort, onSortChange, descending, onDescendingChange } = props;
  const show = sortControls(props);
  const { Focusable } = DeckyUI;
  const current = sortOptions?.length ? sortLabel(sortOptions, sort) : "";
  // Not Steam's context menu: from the Quick Access menu it opens in Steam's main window, which hides the Quick
  // Access menu and unmounts the plugin, so a choice made there is lost with the component's state.
  const cycle = () => {
    const next = sortOptions && nextSortValue(sortOptions, sort);
    if (next !== undefined) onSortChange?.(next);
  };
  const button = (extra: Record<string, unknown>, ...children: React.ReactNode[]) => h(Focusable, {
    role: "button", focusClassName: FOCUS_CLASS, ...extra,
    style: { display: "flex", alignItems: "center", height: 28, cursor: "pointer", flexShrink: 0, ...(extra.style as object) },
  }, ...children);
  return h(React.Fragment, null,
    h("style", null, FOCUS_CSS),
    h(Focusable, { style: { display: "flex", alignItems: "center", padding: "8px 8px 0" } },
      h("span", { style: { color: COLORS.textPrimary, fontSize: 16, fontWeight: 500, lineHeight: "20px", whiteSpace: "nowrap" } }, label),
      count === undefined ? null : h("span", { style: { color: COLORS.textSub, fontSize: 16, fontWeight: 500, lineHeight: "20px", marginLeft: 8 } }, count),
      h("div", { "aria-hidden": true, style: { flexGrow: 1, height: 2, margin: "0 10px", backgroundColor: COLORS.rule } }),
      show.selector
        ? button({ "aria-label": current, onActivate: cycle },
          h("span", { style: { marginRight: 8, display: "flex" } }, h(SteamIcon, { name: "SortByGeneric", size: 16 })),
          h("span", { style: { fontSize: 16, lineHeight: "20px", whiteSpace: "nowrap" } }, current))
        : null,
      show.direction && onDescendingChange
        ? button({
          "aria-label": descending ? props.ascendingLabel ?? "Sort ascending" : props.descendingLabel ?? "Sort descending",
          onActivate: () => onDescendingChange(!descending),
          style: { justifyContent: "center", width: 28, marginLeft: 13 },
        }, h("span", { style: { display: "flex", transform: descending ? undefined : "scaleY(-1)" } }, h(SteamIcon, { name: "SortDescending", size: 16 })))
        : null,
    ),
  );
}

export type DetailItem = { icon?: string; text: React.ReactNode };

export type DetailRowProps = {
  title: React.ReactNode;
  /** One line of small caps items, joined by " · "; each may have a Steam icon name. */
  details?: readonly DetailItem[];
  /** Right-aligned value, for example the field the list is sorted by. */
  value?: React.ReactNode;
  /** Buttons at the end of the row, for example icon-only `DialogButton`s. */
  actions?: React.ReactNode;
};

/** List row with a title, a details line, an optional value column and actions, as in Steam's storage lists. */
export function DetailRow({ title, details, value, actions }: DetailRowProps): React.ReactElement {
  const { Focusable } = DeckyUI;
  const maintainX = (DeckyUI as { NavEntryPositionPreferences?: { MAINTAIN_X?: number } }).NavEntryPositionPreferences?.MAINTAIN_X ?? 2;
  return h("div", { style: { display: "flex", alignItems: "center", minHeight: 58, padding: "6px 8px" } },
    h("div", { style: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 } },
      h("div", { style: { color: COLORS.textPrimary, fontSize: 16, fontWeight: 500, lineHeight: "20px", marginBottom: 4 } }, title),
      details?.length
        ? h("div", { style: { ...CAPS, color: COLORS.textSub } }, ...details.flatMap((item, index) => [
          index ? " · " : null,
          item.icon
            ? h("span", { key: `icon-${index}`, style: { display: "inline-flex", verticalAlign: -3, marginRight: 4, color: COLORS.textBody } },
              h(SteamIcon, { name: item.icon, size: 16 }))
            : null,
          h(React.Fragment, { key: `text-${index}` }, item.text),
        ]))
        : null,
    ),
    value === undefined || value === null
      ? null
      : h("span", { style: { ...CAPS, color: COLORS.textPrimary, whiteSpace: "nowrap", maxWidth: "35%", overflow: "hidden", textOverflow: "ellipsis", margin: "0 8px", flexShrink: 0 } }, value),
    actions ? h(Focusable, { style: { display: "flex", gap: 8, height: 40, flexShrink: 0 }, navEntryPreferPosition: maintainX }, actions) : null,
  );
}
