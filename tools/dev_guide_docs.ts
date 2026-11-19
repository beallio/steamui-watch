/**
 * Plain-English descriptions ("what it does") and Steam Deck Gaming Mode UI placement zones
 * ("where it lives on screen") for verified @decky/ui, decky-loader, @beallio/decky-extras,
 * and inferred SteamUI components, stores, and CSS modules.
 */
import extrasData from "../packages/decky-extras/extras.json";
import type { ExportKind, PlacementZone, SourcePackage } from "./dev_guide_schema";

export const PLACEMENT_LABELS: Record<PlacementZone, string> = {
  "top-bar": "Top Header Bar (clock, status, search)",
  "left-sidebar": "Left Navigation Sidebar (Steam Menu / Settings Nav)",
  "main-content": "Main Viewport (Library, App Details, Store, Settings Content)",
  "qam-drawer": "Right Quick Access Menu (QAM ·••• Drawer)",
  "settings-panel": "Settings & Plugin Configuration Panels",
  "footer-bar": "Bottom Footer Bar (Gamepad button prompts)",
  "modal-overlay": "Center Modal / Confirm Dialog Overlay",
  "context-menu": "Floating Context / Dropdown Menu",
  "virtual-keyboard": "Bottom Virtual Keyboard Overlay",
  "toast-overlay": "Top-Right / Corner Notification Toast",
  "background-store": "Background Runtime Store (SharedJSContext state)",
};

interface CuratedDoc {
  description: string;
  placements: PlacementZone[];
}

const CURATED_EXPORTS: Record<string, CuratedDoc> = {
  // Panel & Layout
  PanelSection: {
    description: "Titled container grouping related controls inside a Quick Access Menu tab or plugin panel.",
    placements: ["qam-drawer", "settings-panel"],
  },
  PanelSectionRow: {
    description: "Single padded row wrapper inside a PanelSection; ensures proper gamepad focus spacing between controls.",
    placements: ["qam-drawer", "settings-panel"],
  },
  Field: {
    description: "Core two-column Steam settings row with a label, optional description, icon, bottom separator, and right-aligned control slot.",
    placements: ["qam-drawer", "settings-panel", "modal-overlay"],
  },
  ControlsList: {
    description: "Vertical stack container that applies consistent Steam Deck spacing between child buttons or form controls.",
    placements: ["qam-drawer", "settings-panel", "modal-overlay"],
  },
  ScrollPanel: {
    description: "Gamepad-aware scrollable container that automatically scrolls focused elements into view.",
    placements: ["qam-drawer", "main-content", "settings-panel"],
  },
  ScrollPanelGroup: {
    description: "Coordinates scroll-into-view focus behavior across nested ScrollPanels inside a page or drawer.",
    placements: ["qam-drawer", "main-content", "settings-panel"],
  },
  Focusable: {
    description: "Base gamepad navigation node; makes any subtree focusable by D-pad/stick and supports directional focus callbacks.",
    placements: ["main-content", "qam-drawer", "settings-panel", "modal-overlay"],
  },
  FocusRing: {
    description: "Visual focus highlight wrapper that renders Steam's animated selection outline around the active gamepad target.",
    placements: ["main-content", "qam-drawer", "modal-overlay"],
  },
  ErrorBoundary: {
    description: "React error boundary that catches render exceptions and displays Steam's fallback crash panel instead of blanking the UI.",
    placements: ["main-content", "qam-drawer"],
  },

  // Buttons
  ButtonItem: {
    description: "Full-width interactive button row with optional label, description, and below/inline layout. The standard clickable action control in QAM and Settings.",
    placements: ["qam-drawer", "settings-panel"],
  },
  DialogButton: {
    description: "Standard secondary pill/rectangle button used inside dialogs, footers, and forms (alias of DialogButtonSecondary).",
    placements: ["modal-overlay", "settings-panel", "qam-drawer"],
  },
  DialogButtonSecondary: {
    description: "Secondary Steam dialog button (identical runtime component to DialogButton).",
    placements: ["modal-overlay", "settings-panel", "qam-drawer"],
  },
  DialogButtonPrimary: {
    description: "High-emphasis Steam Blue primary action button for confirming dialogs or key actions.",
    placements: ["modal-overlay", "settings-panel"],
  },
  Button: {
    description: "Lightweight HTML button wrapper created by @decky/ui (not a native Steam component).",
    placements: ["qam-drawer", "settings-panel"],
  },

  // Form Controls
  ToggleField: {
    description: "Complete settings row pairing a Field label/description with Steam's animated on/off Toggle switch.",
    placements: ["qam-drawer", "settings-panel"],
  },
  Toggle: {
    description: "Standalone Steam Deck on/off pill toggle switch without a surrounding Field label.",
    placements: ["qam-drawer", "settings-panel", "modal-overlay"],
  },
  DialogCheckbox: {
    description: "Labeled checkbox control used in dialogs and multi-option forms.",
    placements: ["modal-overlay", "settings-panel"],
  },
  SliderField: {
    description: "Gamepad-friendly range slider row supporting min/max/step, live value readout, tick notches, and notch labels.",
    placements: ["qam-drawer", "settings-panel"],
  },
  TextField: {
    description: "Single-line text input row that opens Steam's virtual keyboard on focus and supports clear button and validation.",
    placements: ["settings-panel", "modal-overlay", "qam-drawer"],
  },
  Dropdown: {
    description: "Compact dropdown button that opens a gamepad-navigable option menu on press.",
    placements: ["qam-drawer", "settings-panel", "context-menu"],
  },
  DropdownItem: {
    description: "Full Field row combining a label/description with Steam's Dropdown selector (built around DropdownItemInternal).",
    placements: ["qam-drawer", "settings-panel"],
  },
  DropdownItemInternal: {
    description: "Native Steam dropdown Field component used internally by Settings and wrapped by @decky/ui's DropdownItem.",
    placements: ["qam-drawer", "settings-panel"],
  },

  // Progress & Loading
  ProgressBar: {
    description: "Horizontal Steam progress bar displaying completion percentage (nProgress 0–100).",
    placements: ["qam-drawer", "main-content", "modal-overlay"],
  },
  ProgressBarWithInfo: {
    description: "Progress bar paired with a label, operation status text, and optional description (e.g. downloads, installs).",
    placements: ["qam-drawer", "main-content", "settings-panel"],
  },
  ProgressBarItem: {
    description: "Field-wrapped progress bar row (points to the same Steam component as ProgressBarWithInfo).",
    placements: ["qam-drawer", "settings-panel"],
  },
  Spinner: {
    description: "Compact rotating loading ring icon from IconsModule for inline busy states.",
    placements: ["qam-drawer", "main-content", "modal-overlay"],
  },
  SteamSpinner: {
    description: "Full-size animated Steam loading emblem used while pages, dialogs, or data queries initialize.",
    placements: ["main-content", "modal-overlay"],
  },
  Marquee: {
    description: "Auto-scrolling horizontal text ticker for overflowing titles and labels on narrow Steam Deck screens.",
    placements: ["main-content", "qam-drawer", "top-bar"],
  },

  // Dialog Parts & Modals
  DialogHeader: {
    description: "Primary bold heading at the top of a Steam modal or settings page.",
    placements: ["modal-overlay", "settings-panel"],
  },
  DialogSubHeader: {
    description: "Secondary uppercase/accent subheading inside dialogs and settings sections.",
    placements: ["modal-overlay", "settings-panel"],
  },
  DialogLabel: {
    description: "Form field label text styled for Steam dialogs.",
    placements: ["modal-overlay", "settings-panel"],
  },
  DialogBody: {
    description: "Scrollable main content body container inside a modal dialog.",
    placements: ["modal-overlay"],
  },
  DialogBodyText: {
    description: "Standard body copy paragraph styled for modal descriptions and prompts.",
    placements: ["modal-overlay"],
  },
  DialogControlsSection: {
    description: "Grouped settings/controls block inside a dialog or Settings page.",
    placements: ["settings-panel", "modal-overlay"],
  },
  DialogControlsSectionHeader: {
    description: "Section title divider rendered above a DialogControlsSection.",
    placements: ["settings-panel", "modal-overlay"],
  },
  DialogFooter: {
    description: "Bottom action bar inside a modal holding Confirm/Cancel buttons.",
    placements: ["modal-overlay"],
  },
  ConfirmModal: {
    description: "Ready-to-use Yes/No confirmation popup displayed via showModal() with title, description, and OK/Cancel callbacks.",
    placements: ["modal-overlay"],
  },
  ModalRoot: {
    description: "Base modal frame wrapper for building custom modal dialogs shown via showModal().",
    placements: ["modal-overlay"],
  },
  SimpleModal: {
    description: "Fixed-position modal backdrop overlay managing background dismissal and focus trapping.",
    placements: ["modal-overlay"],
  },
  ModalPosition: {
    description: "Centering layout container that positions a modal dialog inside the Gaming Mode viewport.",
    placements: ["modal-overlay"],
  },
  showModalRaw: {
    description: "Internal Steam function that mounts a modal element onto the Gaming Mode portal stack.",
    placements: ["modal-overlay"],
  },

  // Menus & Navigation
  Menu: {
    description: "Floating context menu container opened via showContextMenu() anchored to a target element.",
    placements: ["context-menu"],
  },
  MenuGroup: {
    description: "Labeled submenu or grouped section inside a context Menu.",
    placements: ["context-menu"],
  },
  MenuItem: {
    description: "Individual selectable option inside a context Menu (supports normal and destructive tones).",
    placements: ["context-menu"],
  },
  MenuSeparator: {
    description: "Horizontal divider line separating groups of items in a context Menu.",
    placements: ["context-menu"],
  },
  Tabs: {
    description: "Top horizontal tab bar with gamepad L1/R1 switching (used in Library shelves, Game Properties, etc.).",
    placements: ["top-bar", "main-content"],
  },
  SidebarNavigation: {
    description: "Two-pane Settings-style layout with a left category sidebar and right scrollable page content.",
    placements: ["left-sidebar", "settings-panel", "main-content"],
  },
  Carousel: {
    description: "Horizontal gamepad-scrollable card strip (used for Recent Games, Library shelves, and Store capsules).",
    placements: ["main-content"],
  },
  ReorderableList: {
    description: "Library helper component from @decky/ui for gamepad-accessible drag/reorder lists.",
    placements: ["qam-drawer", "settings-panel"],
  },
  SuspensefulImage: {
    description: "Helper image component from @decky/ui with placeholder sizing while loading.",
    placements: ["main-content", "qam-drawer"],
  },
  ColorPickerModal: {
    description: "HSL color picker modal provided by @decky/ui for plugin/theme customization.",
    placements: ["modal-overlay"],
  },

  // Stores & Loader Internals
  Router: {
    description: "Steam's central navigation and UI store (BasicUIStore): controls route navigation, running apps, window management, and gamepad focus.",
    placements: ["background-store", "main-content"],
  },
  CommonUIModule: {
    description: "Steam's shared UI component registry exporting core controls (Field, ButtonItem, SliderField, ToggleField, Dialog parts, and Gaming Mode overrides).",
    placements: ["qam-drawer", "settings-panel", "modal-overlay"],
  },
  IconsModule: {
    description: "Steam's ~490 built-in vector SVG UI icons (controller glyphs, system status, library, settings, arrows, and brand marks).",
    placements: ["top-bar", "left-sidebar", "qam-drawer", "footer-bar", "main-content"],
  },
  ReactRouter: {
    description: "Internal React Router module powering Steam Gaming Mode's client-side route transitions.",
    placements: ["background-store"],
  },
  HistoryStore: {
    description: "Internal Steam routing history store holding m_history, m_navigator, and m_locationPathname for programmatic navigation.",
    placements: ["background-store"],
  },
  QuickAccessMenuRenderer: {
    description: "Root component rendering the right-hand Quick Access Menu (•••) drawer and its tabs.",
    placements: ["qam-drawer"],
  },
  ToastRenderer: {
    description: "Valve's notification toast overlay renderer displaying achievements, friend alerts, and plugin toasts.",
    placements: ["toast-overlay"],
  },
  ErrorReportingStore: {
    description: "Internal store that captures and reports frontend errors from Steam's ErrorBoundary.",
    placements: ["background-store"],
  },
  RouterRoute: {
    description: "Internal Route wrapper component used by Decky Loader to inject custom plugin pages into Steam's router.",
    placements: ["main-content"],
  },
};

const EXTRA_PLACEMENTS: Record<string, PlacementZone[]> = {
  RadioGroup: ["settings-panel", "qam-drawer", "modal-overlay"],
  RadioButton: ["settings-panel", "qam-drawer", "modal-overlay"],
  TextButton: ["qam-drawer", "settings-panel", "modal-overlay"],
  DialogSettingsSection: ["settings-panel", "modal-overlay"],
  DialogRoundCheckboxField: ["settings-panel", "modal-overlay"],
  ToggleRow: ["qam-drawer", "settings-panel"],
  DiscreteSlider: ["qam-drawer", "settings-panel"],
  PinInput: ["modal-overlay", "settings-panel"],
  PasswordInput: ["modal-overlay", "settings-panel"],
  TextArea: ["modal-overlay", "settings-panel"],
  DialogHBar: ["modal-overlay", "settings-panel"],
  BottomButtons: ["modal-overlay", "footer-bar"],
  StackedConfirmButtons: ["modal-overlay"],
  FieldDescription: ["qam-drawer", "settings-panel"],
  LabelValueField: ["qam-drawer", "settings-panel"],
  FieldSeparator: ["qam-drawer", "settings-panel"],
  LoadingThrobber: ["main-content", "qam-drawer", "modal-overlay"],
  WarningBox: ["settings-panel", "modal-overlay", "qam-drawer"],
  SectionHeader: ["settings-panel", "qam-drawer"],
  SegmentedCharacterInput: ["modal-overlay", "settings-panel"],
  CalloutMessage: ["settings-panel", "qam-drawer", "modal-overlay"],
  CompoundSlider: ["qam-drawer", "settings-panel"],
  DialogTwoButton: ["modal-overlay", "footer-bar"],
  DialogThreeButton: ["modal-overlay", "footer-bar"],
  DropDownControlButton: ["qam-drawer", "settings-panel", "context-menu"],
  DropDownLabelDescription: ["context-menu", "settings-panel", "qam-drawer"],
  DialogReorderableList: ["settings-panel", "qam-drawer", "modal-overlay"],
  PagedSettings: ["left-sidebar", "settings-panel", "main-content"],
  GamepadPage: ["main-content", "top-bar", "footer-bar"],
  CollapsibleContent: ["main-content", "qam-drawer", "settings-panel"],
  ExpandableOverflow: ["main-content", "qam-drawer", "modal-overlay"],
  SquareActionButton: ["main-content", "qam-drawer", "modal-overlay"],
  SteamAvatar: ["top-bar", "qam-drawer", "main-content"],
};

const AREA_TO_PLACEMENTS: Record<string, PlacementZone[]> = {
  Keyboard: ["virtual-keyboard"],
  Settings: ["settings-panel", "left-sidebar"],
  "Overlay & Menus": ["qam-drawer", "context-menu", "modal-overlay", "toast-overlay"],
  Broadcast: ["main-content"],
  Store: ["main-content"],
  "Friends & Chat": ["qam-drawer", "modal-overlay", "toast-overlay"],
  "Media & Recording": ["main-content", "modal-overlay"],
  "Gamepad & Input": ["settings-panel", "footer-bar", "modal-overlay"],
  Library: ["main-content", "top-bar"],
  CommonUI: ["qam-drawer", "settings-panel", "modal-overlay"],
  "System & Misc": ["main-content"],
  Unmatched: ["main-content"],
};

function inferPlacementsFromHints(area: string, hints: string[], kind: ExportKind): PlacementZone[] {
  const joined = hints.join(" ").toLowerCase();
  const zones = new Set<PlacementZone>();
  if (kind === "store") zones.add("background-store");
  if (/keyboard|keyrow|numpad|emoji/.test(joined)) zones.add("virtual-keyboard");
  if (/quickaccess|qam/.test(joined)) zones.add("qam-drawer");
  if (/toast|notification/.test(joined)) zones.add("toast-overlay");
  if (/footer|actionbutton|glyph/.test(joined)) zones.add("footer-bar");
  if (/headerbar|topbar|status|battery|clock/.test(joined)) zones.add("top-bar");
  if (/sidebar|mainmenu|leftpanel/.test(joined)) zones.add("left-sidebar");
  if (/modal|dialog|popup|confirm/.test(joined)) zones.add("modal-overlay");
  if (/contextmenu|dropdown|popover|tooltip/.test(joined)) zones.add("context-menu");
  if (/settings|preferences/.test(joined)) zones.add("settings-panel");

  if (zones.size === 0 || (zones.size === 1 && zones.has("background-store") && kind !== "store")) {
    for (const z of AREA_TO_PLACEMENTS[area] ?? ["main-content"]) zones.add(z);
  }
  return [...zones];
}

export function describeExport(info: {
  name: string;
  kind: ExportKind;
  sourcePackage: SourcePackage;
  featureArea: string;
  props: string[];
  storeFields: string[];
  steamClientApis: string[];
  cssModuleNames: string[];
}): { description: string; placements: PlacementZone[] } {
  const curated = CURATED_EXPORTS[info.name];
  if (curated) return curated;

  const extraDef = (extrasData.components as Record<string, { title: string; description: string }>)[info.name];
  if (extraDef) {
    return {
      description: `${extraDef.description} (Available via @beallio/decky-extras without modifying DFL.)`,
      placements: EXTRA_PLACEMENTS[info.name] ?? ["qam-drawer", "settings-panel"],
    };
  }

  const placements = inferPlacementsFromHints(
    info.featureArea,
    [info.name, ...info.cssModuleNames, ...info.steamClientApis],
    info.kind,
  );

  if (info.kind === "store") {
    const fieldNote = info.storeFields.length
      ? ` Tracks state fields including ${info.storeFields.slice(0, 4).join(", ")}${info.storeFields.length > 4 ? ` (+${info.storeFields.length - 4} more)` : ""}.`
      : "";
    const apiNote = info.steamClientApis.length
      ? ` Talks to ${info.steamClientApis.slice(0, 2).join(", ")}.`
      : "";
    return {
      description: `Internal SteamUI ${info.featureArea} state store.${fieldNote}${apiNote}`,
      placements,
    };
  }

  if (info.kind === "component") {
    const modNote = info.cssModuleNames.length
      ? ` Styled with ${info.cssModuleNames.slice(0, 3).join(", ")} CSS.`
      : "";
    const propNote = info.props.length
      ? ` Accepts props such as ${info.props.slice(0, 5).join(", ")}${info.props.length > 5 ? ` (+${info.props.length - 5} more)` : ""}.`
      : "";
    const apiNote = info.steamClientApis.length
      ? ` Calls ${info.steamClientApis.slice(0, 2).join(", ")}.`
      : "";
    return {
      description: `SteamUI ${info.featureArea} React component.${modNote}${propNote}${apiNote}`,
      placements,
    };
  }

  const modNote = info.cssModuleNames.length ? ` References ${info.cssModuleNames.slice(0, 2).join(", ")} styles.` : "";
  return {
    description: `SteamUI ${info.featureArea} runtime helper/export.${modNote}`,
    placements,
  };
}

export function describeCssModule(
  moduleName: string,
  featureArea: string,
  sampleClasses: string[],
): { description: string; placements: PlacementZone[] } {
  const placements = inferPlacementsFromHints(featureArea, [moduleName, ...sampleClasses.slice(0, 10)], "component");
  const sample = sampleClasses.slice(0, 5).join(", ");
  const description = sample
    ? `CSS module for Steam's ${featureArea} (${moduleName}) UI, styling elements including ${sample}${sampleClasses.length > 5 ? `, and ${sampleClasses.length - 5} more` : ""}.`
    : `CSS module for Steam's ${featureArea} (${moduleName}) UI.`;
  return { description, placements };
}
