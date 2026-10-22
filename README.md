# steamui-watch

Tools to help Steam Deck themes and Decky plugins keep working after Steam updates, and to explore the screen controls that Steam provides.

## What it does

- **Theme updates:** publishes translation lists for CSS Loader. Themes use Steam's internal names to change how the screen looks. Steam updates can change those names; the lists connect older names to newer ones.
- **Decky warnings:** checks for changes that could break Decky Loader or its plugin library. A warning from a beta version can give maintainers time to fix a problem before it reaches the normal Steam version.
- **Steam control catalog:** lets plugin authors look at and try Steam's buttons, sliders, menus, icons, and other screen parts on their own computer. It also includes some controls that Decky's plugin library does not offer by name.
- **Extra controls for plugins:** a separate package gives plugin authors 21 more Steam controls. Plugins carry this package themselves, so users can use standard Decky Loader. It downloads updated search data and keeps a working local copy if the download fails.

The theme lists and Decky checks run automatically. The catalog is a local tool, not a public website or a plugin to install on a Deck.

## Do I need to do anything?

If you use a current version of [beallio's CSS Loader](https://github.com/beallio/SDH-CssLoader), it downloads the newest translation list every hour. Older builds may need an update to use these lists.

The standard CSS Loader uses the DeckThemes team's lists instead, not these.

The lists are public:

- [Stable list](https://beallio.github.io/steamui-watch/stable.json), for the normal Steam Deck version
- [Beta list](https://beallio.github.io/steamui-watch/beta.json), for the Steam Deck beta

You do not need to run this tool to use the lists. Decky warnings are for maintainers; they do not install fixes on your Deck.

Plugin authors can install [Decky extras](packages/decky-extras/README.md) to use the extra controls. Plugin users do not need to install this package separately or switch to our loader fork.

## What happens automatically

- Every 6 hours, the service checks Valve's current stable and beta versions and publishes both theme lists. It keeps the older names it has collected, so it can still translate older themes.
- If publication fails, the last good lists stay online.
- When the service finds a new Steam version, it opens a **"New CSS mappings"** issue. The notice says whether CSS class data changed or only the Steam version changed. If class data changed, it highlights added and removed names and links to the full differences.
- Every 6 hours, a separate check looks for lists that have not been published for at least 24 hours. It opens a **"CSS mappings are overdue"** issue if needed, and closes it when a later check finds that publication has recovered.
- Once a day, the service checks for changes to the DeckThemes team's translation data. It adopts changes that pass its safety checks. Other changes open a **"DeckThemes mappings changed"** issue for review.
- Once a day, it checks the current stable and beta versions for parts of Steam that Decky needs. It reads Steam's files and runs Decky's searches in a browser without Steam. Missing parts open a **"Decky finders missing"** or **"Decky runtime finders failing"** issue.
- It also checks whether its copies of Decky Loader's own searches need review. Changes open a **"Decky finder copies out of date"** issue. The searches of Decky's UI library are read from the library itself each day, so they need no copy.
- Before publishing extra-control search updates, the service checks that every extra has exactly one match on both Steam stable and beta. A failed check leaves the previous published data in place.

GitHub can run scheduled checks late.

## Limits

These checks help find problems; they do not prove that every theme or plugin works. The service checks the stable and beta versions available at each run, not every version released between runs.

Some Decky checks still need a real Steam Deck or a SteamOS test machine. The catalog cannot preview every control, and it cannot test controller navigation, sounds, or features that need a running Steam client.

Research into suggesting repairs for broken Decky searches is separate from the daily checks. The service does not repair them automatically.

## For the owner

- **"New CSS mappings":** a **"version only"** notice is informational: no tracked CSS class data changed, so you can close it. For **"class changes"**, read the highlights and linked differences. Check that publication succeeded before you try a few themes on the new Steam version, then close the issue. A **"comparison unavailable"** notice needs review because there is no earlier version to compare. Keep the version numbers in the title.
- **"CSS mappings are overdue":** open [Publish CSS mappings](https://github.com/beallio/steamui-watch/actions/workflows/publish-mappings.yml) and check the newest run. Enable it if it is disabled. If it failed, its log gives the error.
- **"DeckThemes mappings changed":** review the reason in the issue, then use the [maintenance steps](DEVELOPER.md#reviewing-deckthemes-changes) to accept or skip the changes.
- **"Decky finders missing" or "Decky runtime finders failing":** confirm the problem on a Deck or SteamOS test machine with that Steam version. Use the [Decky maintenance steps](DEVELOPER.md#keeping-the-decky-checks-current) to correct the check or the Decky search, then close the issue.
- **"Decky finder copies out of date":** review what changed in Decky and update the checks if needed. Follow the [same maintenance steps](DEVELOPER.md#keeping-the-decky-checks-current) before closing the issue.

To publish now, open [Publish CSS mappings](https://github.com/beallio/steamui-watch/actions/workflows/publish-mappings.yml), select **Run workflow**, and choose the `main` branch.

If no checks have run for a long time, check that they are enabled on the [Actions page](https://github.com/beallio/steamui-watch/actions). The service adds activity during quiet periods to help keep GitHub's scheduled checks enabled, but it cannot run if Actions is disabled.

## Development and local tools

See [DEVELOPER.md](DEVELOPER.md) for setup, commands, the local catalog, troubleshooting, and maintenance. [Background and research notes](docs/background.md) record the experiments and their limits.

## Credits and license

The translation lists use the DeckThemes team's scripts and earlier Steam history under the [MIT license](https://beallio.github.io/steamui-watch/LICENSE.txt).
