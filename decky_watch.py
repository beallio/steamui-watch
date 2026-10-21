"""Warn when a Steam Deck client bundle no longer has what Decky's finders search for.

Decky Loader and @decky/ui find Steam components at runtime by text in their minified source
(`toString().includes(...)`) and by the property names of CSS class modules. This reads the
same minified bundle from Valve's CDN and checks that each finder's text and class module
still exist. Writes OUTDIR/<branch>-<version>.md for each branch with missing finders.

The check is static: a hit proves the text is somewhere in the bundle, not that it is in the
function the finder tests. Property and prototype names are only checked as names.
"""

import argparse
import re
from pathlib import Path
from typing import NamedTuple

from css_mappings import BRANCHES, download_sources, extract_class_modules, fetch_manifest

UI = "@decky/ui 4.15.1"
LOADER = "decky-loader fee3a65"

type Text = str | re.Pattern[str]


class Classes(NamedTuple):
    has: frozenset[str]
    lacks: frozenset[str]
    module: str | None


class Finder(NamedTuple):
    owner: str
    name: str
    code: tuple[tuple[Text, ...], ...]  # every clause must match; a clause is a set of alternatives
    classes: Classes | None


def code(owner, name, *clauses):
    return Finder(owner, name, tuple(c if isinstance(c, tuple) else (c,) for c in clauses), None)


def classes(owner, name, *has, lacks=(), module=None):
    return Finder(owner, name, (), Classes(frozenset(has), frozenset(lacks), module))


def props(*names, from_start=True):
    """`createPropListRegex` from @decky/ui `utils/react/react.js`."""
    body = ",".join(f'"?{re.escape(n)}"?:[a-zA-Z_$]{{1,2}}' for n in names)
    return re.compile(("const\\{" if from_start else "") + body)


def name(word):
    """A property or method name the finder tests on a live object; the name is all a static check sees."""
    return re.compile(rf"(?<![\w$]){re.escape(word)}(?![\w$])")


FINDERS = (
    # @decky/ui dist/webpack.js and dist/components/*.js
    code(UI, "IconsModule/Spinner", (re.compile(r'Spinner\),children:\[\(0,\w+\.jsx\)\("path",\{d:"M18 '),
                                     re.compile(r'Spinner\)}\)?,.\.createElement\("path",{d:"M18 '))),
    code(UI, "ReactRouter", name("computeRootMatch")),
    code(UI, "ButtonItem", (props("highlightOnFocus", "childrenContainerWidth", from_start=False),
                            'childrenContainerWidth:"min"')),
    code(UI, "Carousel", "setFocusedColumn:"),
    code(UI, "ControlsList", "().ControlsListChild", "().ControlsListOuterPanel"),
    code(UI, "Dialog components", ('jsx)("div",{...', 'jsx)("div",Object.assign({},',
                                   'createElement("div",{...', 'createElement("div",Object.assign({},')),
    code(UI, "DialogButtonPrimary", '"DialogButton","_DialogLayout","Primary"'),
    code(UI, "DialogButton", '"DialogButton","_DialogLayout","Secondary"'),
    code(UI, "DialogCheckbox", name("GetPanelElementProps"), name("SetChecked"), ('="DialogCheckbox"', "fallback:")),
    code(UI, "Dropdown", name("SetSelectedOption"), name("BuildMenu")),
    code(UI, "DropdownItem", props("dropDownControlRef", "description", from_start=False)),
    code(UI, "ErrorBoundary", name("componentDidCatch"), "lastErrorKey"),
    code(UI, "Field", '"shift-children-below"'),
    code(UI, "FocusRing", ".GetShowDebugFocusRing())"),
    code(UI, "Focusable", props("flow-children", "onActivate", "onCancel", "focusClassName", "focusWithinClassName")),
    code(UI, "Marquee", ".Marquee", "--fade-length"),
    code(UI, "showContextMenu", "GetContextMenuManagerFromWindow(", ".CreateContextMenuInstance("),
    code(UI, "MenuItem", ("bPlayAudio:", name("OnMouseEnter"))),
    code(UI, "Menu", (name("HideIfSubmenu"), "labelId")),
    code(UI, "MenuGroup", name("OnOKButton"), ('this.props.tone=="emphasis"', '"emphasis"==this.props.tone'),
         "bInGamepadUI:"),
    # shortcut: `.+?` is bounded, or it would match across functions in a one-line bundle.
    code(UI, "MenuSeparator", re.compile(r"className:.{0,300}?\.ContextMenuSeparator")),
    code(UI, "showModal", "props.bDisableBackgroundDismiss"),
    code(UI, "ConfirmModal", "bUpdateDisabled", "closeModal", "onGamepadCancel"),
    code(UI, "ModalRoot", ("Either closeModal or onCancel should be passed to GenericDialog. Classes: ",
                           name("m_mapModalManager"))),
    code(UI, "ModalPosition", ".ModalPosition"),
    code(UI, "SimpleModal", ".ShowPortalModal()", ".OnElementReadyCallbacks.Register("),
    code(UI, "PanelSection", ".PanelSection"),
    code(UI, "ProgressBar", re.compile(r'\.ProgressBar,(?:\w*==)?"standard"(?:==)?')),
    code(UI, "ProgressBarWithInfo", (".ProgressBarFieldStatus,children", ".ProgressBarFieldStatus},")),
    code(UI, "ProgressBarItem", props("indeterminate", "nTransitionSec", "nProgress")),
    code(UI, "ScrollPanel", '{case"x":'),
    code(UI, "ScrollPanelGroup", (".FocusVisibleChild(),[])", ".FocusVisibleChild()),[])")),
    code(UI, "SidebarNavigation", props("pages", "fnSetNavigateToPage", "disableRouteReporting")),
    code(UI, "SliderField", ("SliderField,fallback", 'SliderField",')),
    code(UI, "SteamSpinner", "Steam Spinner"),
    code(UI, "Tabs", ".TabRowTabs", "activeTab:", "(function()"),
    code(UI, "TextField", name("validateUrl"), name("validateEmail")),
    code(UI, "Toggle", ".ToggleOff)"),
    code(UI, "ToggleField", ("ToggleField,fallback", 'ToggleField",')),
    code(UI, "Router", name("NavigationManager")),
    code(UI, "useParams", re.compile(r"return (\w*)\?\1\.params:{}")),
    # @decky/ui dist/utils/static-classes.js
    classes(UI, "quickAccessMenuClasses", "Title", "QuickAccessMenu"),
    classes(UI, "scrollPanelClasses", "ScrollPanel"),
    classes(UI, "gamepadDialogClasses", "GamepadDialogContent", lacks=("BindingButtons",)),
    classes(UI, "quickAccessControlsClasses", "BatteryPercentageLabel", "PanelSection",
            lacks=("vr-dashboard-bar-height", "QuickAccessMenu", "QuickAccess", "PerfProfileInfo")),
    classes(UI, "updaterFieldClasses", "OOBEUpdateStatusContainer"),
    classes(UI, "playSectionClasses", "PlayBarDetailLabel"),
    classes(UI, "gamepadSliderClasses", "SliderControlPanelGroup"),
    classes(UI, "appDetailsHeaderClasses", "TopCapsule"),
    classes(UI, "appDetailsClasses", "HeaderLoaded"),
    classes(UI, "gamepadUIClasses", "BasicUiRoot"),
    classes(UI, "gamepadTabbedPageClasses", "GamepadTabbedPage"),
    classes(UI, "gamepadContextMenuClasses", "BasicContextMenuModal"),
    classes(UI, "achievementListClasses", "AchievementListItemBase", lacks=("Page",)),
    classes(UI, "achievementPageClasses", "AchievementListItemBase", "Page"),
    classes(UI, "mainMenuAppRunningClasses", "AppRunningControls", "OverlayAchievements"),
    classes(UI, "basicAppDetailsSectionStylerClasses", "AppDetailsRoot"),
    classes(UI, "steamSpinnerClasses", "SpinnerLoaderContainer"),
    classes(UI, "footerClasses", "QuickAccessFooter"),
    classes(UI, "appActionButtonClasses", "PlayButtonContainer"),
    classes(UI, "libraryAssetImageClasses", "LongTitles", "GreyBackground"),
    classes(UI, "gamepadLibraryClasses", "GamepadLibrary"),
    classes(UI, "focusRingClasses", "FocusRingRoot"),
    classes(UI, "searchBarClasses", "SearchAndTitleContainer"),
    classes(UI, "mainBrowserClasses", "MainBrowserContainer"),
    # decky-loader frontend/src
    # errorboundary-hook.tsx anchors this to the whole function; a bundle search cannot.
    code(LOADER, "errorboundary-hook: error reporting store",
         re.compile(r"\(\)=>\([\w$]+\|\|(?:[\w$]+\(|\([\w$]+=)new [\w$]+\),[\w$]+\)"), name("BIsBlacklisted")),
    code(LOADER, "router-hook: Route", '"router-backstack"',
         (re.compile(r"routePath:[\w$]+\.match\?\.path."), re.compile(r"routePath:null===\(.=.\.match\)"))),
    code(LOADER, "router-hook: router node", "bShowDesktopUIContent:"),
    code(LOADER, "router-hook: settings node", "Settings.Root()"),
    # tabs-hook.tsx also patches QuickAccessMenuEmbedded, but only when it exists.
    code(LOADER, "tabs-hook: QAM renderer", "QuickAccessMenuBrowserView"),
    code(LOADER, "toaster: Valve toast renderer", 'controller:"notification",method:'),
    # library.ts finds the routing store by a set m_history. Steam sets it only in
    # UpdateRoutingInfo, which a router component calls from a useEffect.
    code(LOADER, "filepicker: history", re.compile(r"UpdateRoutingInfo\([\w$]+,[\w$]+\)\{this\.m_history=[\w$]+"),
         ".UpdateRoutingInfo("),
    classes(LOADER, "Markdown: EventDetailsBody", "EventDetailsBody"),
    classes(LOADER, "Markdown: event link", "Link", module="43088"),
    classes(LOADER, "Toast: templateClasses", "ShortTemplate"),
    classes(LOADER, "DropdownMultiselect: classes", "DropDownControlButton", "duration-app-launch"),
    classes(LOADER, "Store: TabCount", "TabCount", "TabTitle"),
)


def _describe(text):
    return f"`{text.pattern}` (regex)" if isinstance(text, re.Pattern) else f"`{text}`"


def missing(sources, class_modules, finders=FINDERS):
    """Return (finder, reason) for every finder the bundle no longer satisfies."""
    bundle = "\n".join(sources)
    found = {}

    def hit(text):
        if text not in found:
            found[text] = text in bundle if isinstance(text, str) else text.search(bundle) is not None
        return found[text]

    result = []
    for finder in finders:
        if rule := finder.classes:
            candidates = [class_modules.get(rule.module, {})] if rule.module else class_modules.values()
            if not any(rule.has <= m.keys() and not rule.lacks & m.keys() for m in candidates):
                where = f"module {rule.module}" if rule.module else "class module"
                lacks = f" without {', '.join(sorted(rule.lacks))}" if rule.lacks else ""
                result.append((finder, f"no {where} with {', '.join(sorted(rule.has))}{lacks}"))
            continue
        for clause in finder.code:
            if not any(hit(text) for text in clause):
                result.append((finder, "none of " + " / ".join(map(_describe, clause))))
                break
    return result


def report(branch, version, misses):
    lines = [f"Static check of the Steam Deck {branch} client `{version}` against Decky's finders.", ""]
    for owner in dict.fromkeys(finder.owner for finder, _ in misses):
        lines += [f"### {owner}", ""]
        lines += [f"- **{finder.name}**: {reason}" for finder, reason in misses if finder.owner == owner]
        lines.append("")
    lines.append("A miss means the finder will probably fail on this version. Confirm on the SteamOS VM, "
                 "then update the finder or `decky_watch.py`. Close this issue when done.")
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("outdir", type=Path, help="directory for the <branch>-<version>.md reports")
    parser.add_argument("--branch", choices=BRANCHES, action="append", help="Valve branch (default: both)")
    args = parser.parse_args(argv)
    args.outdir.mkdir(parents=True, exist_ok=True)
    for branch in args.branch or BRANCHES:
        version, fields = fetch_manifest(branch)
        sources = download_sources(fields)
        misses = missing(sources, extract_class_modules(sources))
        print(f"{branch} {version}: {len(misses)} of {len(FINDERS)} finders missing")
        for finder, reason in misses:
            print(f"  {finder.owner} {finder.name}: {reason}")
        if misses:
            (args.outdir / f"{BRANCHES[branch]}-{version}.md").write_text(
                report(BRANCHES[branch], version, misses), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
