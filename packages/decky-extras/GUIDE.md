# Build with `@beallio/decky-extras`

This guide shows how to add `@beallio/decky-extras` to a Decky plugin and gives examples of what you can build with it. For the API reference, update rules and limits, see the [package README](README.md).

The package gives your plugin two things that the public `@decky/ui` API does not export:

- **Steam components** (`extras.<Name>`, `findExtra`): native controls such as a segmented radio group, a toggle row, a slider with fixed values, PIN and password inputs, dialog button rows and a warning box.
- **Steam values** (`findSteamValue`): Steam functions and objects, for example the router history store.

Your plugin bundles the package. It works with the standard Decky Loader and official `@decky/ui`; it does not need a custom loader.

## 1. Add the package

Start from a normal Decky plugin (for example the [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template)) that builds with `@decky/rollup`. Then add the package:

```sh
npm install https://github.com/beallio/steamui-watch/releases/download/decky-extras-v0.5.0/beallio-decky-extras-0.5.0.tgz
```

Do not change the Rollup setup. `@decky/rollup` already maps `react` to Steam's React and `@decky/ui` to the loader's library, and it bundles this package into your `dist/index.js`.

## 2. A first panel

```tsx
import { definePlugin } from "@decky/api";
import { PanelSection, PanelSectionRow, staticClasses } from "@decky/ui";
import { useState } from "react";
import { extras, stopExtrasUpdates } from "@beallio/decky-extras";

const { RadioGroup, RadioButton, ToggleRow } = extras;

function Content() {
  const [quality, setQuality] = useState("mid");
  const [enabled, setEnabled] = useState(true);
  return (
    <PanelSection title="Settings">
      <PanelSectionRow>
        <RadioGroup value={quality} onChange={setQuality}>
          <RadioButton value="low">Low</RadioButton>
          <RadioButton value="mid">Mid</RadioButton>
          <RadioButton value="high">High</RadioButton>
        </RadioGroup>
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleRow label="Enabled" value={enabled} onChange={setEnabled} />
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => ({
  name: "My Plugin",
  titleView: <div className={staticClasses.Title}>My Plugin</div>,
  content: <Content />,
  icon: <span>MP</span>,
  onDismount() {
    stopExtrasUpdates();
  },
}));
```

Each wrapper renders nothing when its component is not found in the running Steam build, and it writes one warning to the console. Always call `stopExtrasUpdates()` when the plugin unloads.

## 3. Examples of what to build

The props below are the ones the package's checks render with. Steam does not document these components: test your controls in Gaming Mode, and read the [observed props reference](https://github.com/beallio/steamui-watch/tree/finder-data/props) for more names.

### Steam icons

`SteamIcon` renders a named icon from the running Steam client. Set `size` in pixels and pass `direction` for a directional icon.

```tsx
import { IconBrowser, SteamIcon } from "@beallio/decky-extras";

function SteamIconExample() {
  return (
    <div>
      <SteamIcon name="Arrow" direction="right" size={24} />
      <IconBrowser />
    </div>
  );
}
```

`IconBrowser` searches the available names and shows a snippet when you select a cell. It does not copy the snippet. It is not yet tested in Gaming Mode.

### Settings panel with native controls

Use Steam's own controls instead of drawing your own, so your panel looks and moves like the rest of the Quick Access menu.

```tsx
const { DiscreteSlider, LabelValueField, WarningBox, LoadingThrobber } = extras;

<DiscreteSlider label="Frame limit" rValues={[15, 30, 40, 60]} value={fps} onChange={setFps} showValue />
<LabelValueField label="Status">{connected ? "Connected" : "Offline"}</LabelValueField>
{error && <WarningBox type="Warning" body={error} />}
{loading && <LoadingThrobber size="medium" />}
```

`DiscreteSlider` only stops on the values in `rValues`, which suits presets such as frame limits, power levels or refresh intervals.

### Sign-in and pairing forms

```tsx
const { PinInput, SegmentedCharacterInput, PasswordInput, TextArea } = extras;

<PinInput digits={4} value={pin} onChange={setPin} />                    // device pairing code
<SegmentedCharacterInput length={5} value={code} onChange={setCode} />   // one box per character
<PasswordInput value={apiKey} onChange={setApiKey} />                     // API key with show/hide
<TextArea value={notes} onChange={setNotes} />                            // notes that grow
```

### Dialogs and confirmations

Inside a modal (for example one opened with `showModal` from `@decky/ui`), use Steam's button rows so the buttons match Steam's dialogs:

```tsx
const { DialogTwoButton, StackedConfirmButtons } = extras;

<DialogTwoButton strOKText="Delete" strCancelText="Keep" onOK={remove} onCancel={closeModal} />
<StackedConfirmButtons strPrimaryButtonText="Continue" strCancelButtonText="Cancel" onPrimary={next} onCancel={closeModal} />
```

### Panels that follow the current Steam page

`RouterHistoryStore` is Steam's routing store. Its `m_history` object is the history that Steam's router uses, so a plugin can react when the user opens another page, for example to show options for the game page that is open:

```tsx
import { useEffect, useState } from "react";
import { findSteamValue } from "@beallio/decky-extras";

type Location = { pathname?: string };
type History = { location?: Location; listen?: (cb: (location: Location) => void) => () => void };

function useSteamPath() {
  const history = (findSteamValue("RouterHistoryStore") as { m_history?: History } | null)?.m_history;
  const [path, setPath] = useState(history?.location?.pathname ?? "");
  useEffect(() => history?.listen?.((location) => setPath(location.pathname ?? "")), [history]);
  return path;
}

function GameOptions() {
  const appId = useSteamPath().match(/^\/library\/app\/(\d+)/)?.[1];
  return appId ? <div>Options for app {appId}</div> : <div>Open a game page to see its options.</div>;
}
```

`listen` returns a function that stops listening; returning it from `useEffect` removes the listener when the panel closes. Steam can call the listener more than once for one page change.

### Fallbacks for missing controls

A Steam update can remove or change a component. Use `findExtra` when you want your own fallback instead of an empty space:

```tsx
import { findExtra } from "@beallio/decky-extras";
import { ToggleField } from "@decky/ui";

function EnabledToggle(props: { value: boolean; onChange: (value: boolean) => void }) {
  // Look it up on each render: a later definitions update can then supply a control that was missing.
  const ToggleRow = findExtra("ToggleRow");
  return ToggleRow
    ? <ToggleRow label="Enabled" value={props.value} onChange={props.onChange} />
    : <ToggleField label="Enabled" checked={props.value} onChange={props.onChange} />;
}
```

Call `findExtra` inside the component, not once at module level: a value stored when the plugin loads never changes. `findExtra` is a quick lookup, so calling it on each render costs little.

`findSteamValue` returns `null` in the same cases. Check the result and its fields before you use them.

### Low-level: Steam's toast component

`findSteamValue("ValveToastRenderer")` returns the function component that draws a group of Steam notification toasts (props `group` and `location`). Decky Loader already patches it to draw Decky toasts. To show a toast, use `toaster` from `@decky/api`. Use this value only to read or render Steam's toast drawing; do not patch it again.

## 4. Test in Gaming Mode

1. Build the plugin (`npm run build`) and make a ZIP that contains one folder named after the plugin, with `plugin.json`, `package.json` and `dist/index.js`.
2. Install it with Decky's **Settings → Developer → Install Plugin from ZIP File**.
3. Open the plugin in the Quick Access menu. Check that each control draws, takes controller focus and changes state, and that no "unavailable or ambiguous" warnings appear in the console.
4. Test on both Steam Stable and Steam Beta if you can. Some components are found on only one of them. For example, `CalloutMessage` is not found on Beta clients that use ES modules.

## Verified example

On 2026-11-23 a test plugin built this way with package 0.4.0 ran in Gaming Mode on a SteamOS VM (Steam Beta 1795048523, ES modules, Decky Loader with `@decky/ui` 5). Results:

- 35 of 36 extras were found; `CalloutMessage` was missing, as expected on Beta.
- `RadioGroup`, `ToggleRow`, `TextButton`, `DiscreteSlider`, `LabelValueField`, `WarningBox`, `LoadingThrobber` and `DialogHBar` drew in the Quick Access menu. Clicks changed the radio choice, the toggle and a click counter.
- `RouterHistoryStore.m_history.listen` reported each page change while the panel was open.
- The package downloaded `decky-extras-v2.json` (HTTP 200), and unloading the plugin ran `stopExtrasUpdates`.

That test did not cover Steam Stable, a physical Deck, controller navigation inside the controls, or a visual check of the drawing.
