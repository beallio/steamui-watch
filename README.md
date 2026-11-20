# steamui-watch

An automated service and toolkit that keeps Steam Deck themes and Decky plugins working when Valve updates Steam — and gives theme and plugin authors a plain-English map of Steam's interface.

## What this project does

When Valve updates the Steam Deck interface, it often scrambles the internal names that themes and plugins rely on. Recent Steam Deck beta updates went even further, removing most human-readable names from Steam's files altogether. This repository watches every Steam Deck update and publishes five things to keep customizations working:

- **Theme translation lists (CSS Loader):** Automatically maps old Steam screen names to the newest ones every 6 hours, for both Steam Deck Stable and Beta. It remembers past versions so older themes keep working, even across Steam's newer beta format where readable names are no longer stored in code.
- **Public Steam Deck interface guide:** Publishes a searchable [online guide](https://beallio.github.io/steamui-watch/guide/) that turns Steam's scrambled internal names back into readable names. Theme and plugin authors can look up any part of the Steam Deck screen, see what it does and where it appears on the Deck, or paste in an existing theme snippet to translate it to the latest beta names.
- **Early warnings for Decky Loader:** Runs daily checks against Steam Deck Stable and Beta in a headless browser to catch changes that could break Decky Loader or its plugin library before they reach everyone. When something breaks, it opens a GitHub issue (and suggests a replacement search when it can find a clear match) and closes the issue automatically once fixed.
- **33 extra built-in Steam controls for plugins:** Ships an add-on package ([Decky extras](packages/decky-extras/README.md)) giving plugin authors 33 native Steam controls — such as segmented radio buttons, multi-handle sliders, PIN inputs, warning boxes, reorderable lists, and paged settings — that Decky's standard plugin library does not expose by name. Plugins bundle it themselves, so Steam Deck users do not need a custom Decky Loader.
- **Local visual previews and control catalog:** Includes local tools you can run on your own computer to see how Steam's controls and ~490 built-in icons actually look and behave using Steam's own styles. Because these previews include Valve's icons and styling, they stay on your computer and are never published to the public website.

## Do I need to do anything?

**If you just use themes or plugins on your Steam Deck:**

- If you use a current version of [beallio's CSS Loader](https://github.com/beallio/SDH-CssLoader), it downloads updated translation lists from here automatically every hour. (The standard CSS Loader uses the DeckThemes team's lists instead.)
- If a plugin uses **Decky extras**, it works on standard Decky Loader with nothing extra for you to install.
- You do not need to run anything in this repository yourself.

**If you build themes or Decky plugins:**

- Browse the [Steam Deck Interface Guide](https://beallio.github.io/steamui-watch/guide/) to search controls, screen areas, and theme names, or use its built-in paste translator to update a theme for the beta. (The raw [guide data](https://beallio.github.io/steamui-watch/guide/data.json) is also public.)
- Read [Decky extras](packages/decky-extras/README.md) to add the 33 extra Steam controls to a plugin.
- Download the live theme translation lists directly if you need them:
  - [Stable theme list](https://beallio.github.io/steamui-watch/stable.json) (normal Steam Deck release)
  - [Beta theme list](https://beallio.github.io/steamui-watch/beta.json) (Steam Deck beta)
  - [Decky extras search list](https://beallio.github.io/steamui-watch/decky-extras.json)

## What happens automatically

- **Every 6 hours — publish theme lists and the public guide:** Checks Valve's current Steam Deck Stable and Beta releases, updates both theme translation lists (keeping full history for older themes), verifies all 33 Decky extras work on both releases, and rebuilds the public online guide. Each piece is isolated: if the guide or extras check fails, the last working version stays online and fresh theme lists still publish.
- **When a new Steam version appears:** Opens a **"New CSS mappings"** issue summarizing whether screen names actually changed (with links to the full list of changes) or if only Steam's version number changed.
- **Every 6 hours — freshness check:** Verifies that theme lists have published within the past 24 hours, opens a **"CSS mappings are overdue"** issue if not, and closes it automatically once publishing recovers.
- **Once a day — sync upstream theme history:** Checks the DeckThemes team's mapping repository and merges safe data updates automatically, or opens a **"DeckThemes mappings changed"** issue when human review is needed.
- **Once a day — Decky compatibility and control checks:**
  - Tests Decky Loader and its plugin library against both Stable and Beta (plus upcoming library updates), opening and auto-closing warning issues with suggested repairs when possible.
  - Tracks upstream Decky UI library compatibility with Steam's new beta format in a rolling issue.
  - Checks whether this repository's local copies of Decky Loader's own searches need updating.
  - Records the settings each of the 33 extra controls accepts and opens a **"Decky extra props changed"** issue if Steam adds or removes any.

GitHub can occasionally run scheduled jobs a little late.

## Limits

- Automated checks catch many breakages early, but they cannot guarantee that every theme or plugin works flawlessly on a real Steam Deck.
- Some parts of Steam only exist inside a live Gaming Mode session (such as controller navigation, sound effects, and live window overlays), so final confirmation still belongs on a Steam Deck or SteamOS test machine.
- Suggested repairs are review aids for maintainers — this service never pushes or installs code changes onto your Deck automatically.

## For the owner

- **"New CSS mappings":** A **"version only"** notice is informational and can be closed. For **"class changes"**, review the summary and diffs, confirm deployment succeeded, test a few themes, and close the issue.
- **"CSS mappings are overdue":** Open [Publish CSS mappings](https://github.com/beallio/steamui-watch/actions/workflows/publish-mappings.yml) to inspect the latest run or re-enable Actions if paused.
- **"DeckThemes mappings changed":** Review the linked changes and follow the [maintenance steps](DEVELOPER.md#reviewing-deckthemes-changes).
- **"Decky finders missing"**, **"Decky runtime finders failing"**, or **"Decky finder copies out of date":** Confirm on a Deck or SteamOS VM and follow the [Decky maintenance steps](DEVELOPER.md#keeping-the-decky-checks-current).
- **"Decky extra props changed":** Review the added/removed setting names and test affected controls in Gaming Mode before closing.

To run a publish manually, open [Publish CSS mappings](https://github.com/beallio/steamui-watch/actions/workflows/publish-mappings.yml), click **Run workflow**, and select `main`.

## Development and local tools

See [DEVELOPER.md](DEVELOPER.md) for local setup, running the local visual guide (`--with-previews`) and control catalog, tests, troubleshooting, and maintenance. See [docs/background.md](docs/background.md) for research notes, experiments, and validation history.

## Credits and license

The theme translation lists build on the DeckThemes team's scripts and historical Steam data under the [MIT license](https://beallio.github.io/steamui-watch/LICENSE.txt).
