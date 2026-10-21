# steamui-watch

Keeps CSS Loader themes working on the Steam Deck after Steam updates, and warns early when a Steam update will probably break Decky Loader.

## What it does

CSS Loader themes change how the Steam screen looks. To do that, a theme points at parts of the screen by their internal names. Steam gives these parts random names, and an update can change them. When the names change, themes stop working.

This service follows every Steam Deck update. It reads the new screen files directly from Valve and publishes a translation list from the old names to the new names. CSS Loader uses the list to make old themes work on the new Steam version.

## Do I need to do anything?

No, if you use [beallio's CSS Loader](https://github.com/beallio/SDH-CssLoader). It downloads the newest list every hour.

The standard CSS Loader uses the list from the DeckThemes team instead, not this one.

The lists are public:

- [Stable list](https://beallio.github.io/steamui-watch/stable.json), for the normal Steam Deck version
- [Beta list](https://beallio.github.io/steamui-watch/beta.json), for the Steam Deck beta

## What happens automatically

- Every 6 hours, the service checks Valve for new stable and beta versions and publishes both lists.
- If a check fails, the last good lists stay online.
- Each list keeps the names from all earlier Steam versions, so old themes can still be translated.
- When a new Steam version arrives, the service opens an issue named **"New CSS mappings"** in this repository and assigns it to the owner. GitHub sends its normal issue notification.
- If no new list was published for 24 hours, the service opens an issue named **"CSS mappings are overdue"**. That issue closes by itself after the next successful publication.
- Once a day, the service checks whether the DeckThemes team changed their own translation data. If they only added newer Steam versions or corrected translations, the service merges the change by itself, and the next publication uses it. If the change needs a person (for example, changed scripts, an older Steam version, or a conflict with our own corrections), it opens an issue named **"DeckThemes mappings changed"** that gives the reason.
- Once a day, the service checks the newest stable and beta Steam versions for the parts of Steam that Decky Loader and its plugin library look for. If a part is missing, it opens an issue named **"Decky finders missing in beta 1234567890"** (or `stable`). A beta warning comes before the same change reaches the normal Steam version.
- GitHub stops scheduled checks in a repository with no activity for 60 days. To prevent that, the service adds an empty commit when the repository has had no commits for 45 days.

GitHub can run the checks a little late.

## For the owner

**When a "New CSS mappings" issue opens:** try a few themes on the new Steam version, then close the issue. Keep the version numbers in the title, because the service uses them to know which versions it has announced.

**When a "CSS mappings are overdue" issue opens:** open the [Publish CSS mappings](https://github.com/beallio/steamui-watch/actions/workflows/publish-mappings.yml) page and look at the newest run. If GitHub shows that the workflow is disabled, enable it.

**When a "DeckThemes mappings changed" issue opens:** the issue gives the reason it was not merged automatically and lists the new DeckThemes commits and files. Files marked "also in mapping-data" exist in both places, so merge them carefully. To use the changes, merge the commits into the `mapping-data` branch without replacing its history. Then put the newest DeckThemes commit in `.github/upstream-baseline` and close the issue. To skip the changes, just close the issue.

**When a "Decky finders missing" issue opens:** the issue lists the Decky parts that the service could not find. This check only reads Steam's files, so confirm the problem on a Steam Deck or the SteamOS test machine with that Steam version. Then fix the finder in Decky Loader, or correct the list in `decky_watch.py` if the check was wrong, and close the issue. A closed issue is not opened again for the same Steam version.

If you see no issue and no new run for a long time, check that the workflows on the [Actions page](https://github.com/beallio/steamui-watch/actions) are enabled.

**To publish now:** open the [Publish CSS mappings](https://github.com/beallio/steamui-watch/actions/workflows/publish-mappings.yml) page, select **Run workflow**, and choose the `main` branch.

## Run it on your own computer (advanced)

You do not need this to use the lists. It is for testing or for checking a Steam update by hand. A run on your computer does not publish anything.

You need Python 3.14 or newer and `git`. No other software is needed.

1. Download this tool and open its folder:

   ```sh
   git clone https://github.com/beallio/steamui-watch.git
   cd steamui-watch
   ```

2. Download the saved Steam history from the `mapping-data` branch into a folder next to the tool:

   ```sh
   git clone --branch mapping-data https://github.com/beallio/steamui-watch.git ../mapping-data
   ```

   Use this branch, not the DeckThemes repository. It holds every Steam version this service has seen and the hand-made fixes. A copy from DeckThemes does not have them, so its lists would be incomplete.

3. Run the tool:

   ```sh
   python3 css_mappings.py ../mapping-data
   ```

The tool gets the current Steam Deck versions from Valve and downloads the screen files of any version it has not seen yet. It checks that the download is not damaged. Then it runs the DeckThemes scripts that make `stable.json` and `beta.json`. It checks that both files are complete. This takes a few minutes.

| Option | What it does |
|---|---|
| `--branch stable` or `--branch publicbeta` | Check only the stable or only the beta version. |
| `--force` | Download and read a version again, even if the tool has seen it. |
| `--no-pipeline` | Save the new Steam data, but do not make the lists. |

To check the current Steam versions for Decky Loader by hand, run `python3 decky_watch.py reports`. It prints how many Decky parts are missing for each version and writes a report for each version with misses into the `reports` folder. It needs no `mapping-data` folder and takes about a minute. It also accepts `--branch`.

## Troubleshooting

- **"is not a CSSLoader-Mappings checkout"**: give the path to the folder you downloaded in step 2.
- **"SHA-256 does not match the manifest"**: the download is damaged or incomplete. Run the tool again.
- **"only N class modules found"**: Steam changed how it stores its screen files, and the tool needs an update. Do not use the result.
- **"has its own history"** or **"is used twice"**: a hand-made fix in `webpack-mappings/` is wrong. Remove that fix.
- **HTTP 403 errors**: your network blocks downloads from Valve. Try a different network.

## Credits and license

The translation lists are built with the DeckThemes team's scripts and their earlier Steam history, used under the [MIT license](https://beallio.github.io/steamui-watch/LICENSE.txt).

## For developers

The project uses [uv](https://docs.astral.sh/uv/) to pick the Python version (3.14, set in `.python-version`) and the type checker [ty](https://docs.astral.sh/ty/):

```sh
uv run python -m unittest
uv run ty check
```

`python3 -m unittest` also works without uv. Some tests also need `jq`; they are skipped if `git` or `jq` is missing. GitHub runs both checks on every push.

`tools/runtime_probe.ts` runs the real Decky finders against the current Steam versions in headless Chrome, without a Steam Deck. It needs [Bun](https://bun.sh), `unzip`, Chrome, and a checkout of Decky Loader with its frontend packages installed next to this folder (`../decky-loader/frontend/node_modules`). GitHub does not run it.

```sh
CHROME=/path/to/chrome bun tools/runtime_probe.ts            # stable and beta
bun tools/runtime_probe.ts --branch publicbeta --decky-ui /path/to/@decky/ui
```

It prints one line per Steam version and lists every finder that failed. It exits with status 1 if any finder failed. Finders that need the drawn Gaming Mode screen cannot run there; check those on a Steam Deck.
