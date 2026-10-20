# steamui-watch

Keeps CSS Loader themes working on the Steam Deck after Steam updates.

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

GitHub can run the checks a little late.

## For the owner

**When a "New CSS mappings" issue opens:** try a few themes on the new Steam version, then close the issue. Keep the version numbers in the title, because the service uses them to know which versions it has announced.

**When a "CSS mappings are overdue" issue opens:** open the [Publish CSS mappings](https://github.com/beallio/steamui-watch/actions/workflows/publish-mappings.yml) page and look at the newest run. If GitHub shows that the workflow is disabled, enable it.

GitHub disables all scheduled checks after 60 days without activity in the repository. When that happens, the overdue issue cannot open either. If you see no issue and no new run for a long time, check that page.

**To publish now:** open the [Publish CSS mappings](https://github.com/beallio/steamui-watch/actions/workflows/publish-mappings.yml) page, select **Run workflow**, and choose the `main` branch.

## Run it on your own computer (advanced)

You do not need this to use the lists. It is for testing or for checking a Steam update by hand. A run on your computer does not publish anything.

You need Python 3.10 or newer and `git`. No other software is needed.

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

## Troubleshooting

- **"is not a CSSLoader-Mappings checkout"**: give the path to the folder you downloaded in step 2.
- **"SHA-256 does not match the manifest"**: the download is damaged or incomplete. Run the tool again.
- **"only N class modules found"**: Steam changed how it stores its screen files, and the tool needs an update. Do not use the result.
- **"has its own history"** or **"is used twice"**: a hand-made fix in `webpack-mappings/` is wrong. Remove that fix.
- **HTTP 403 errors**: your network blocks downloads from Valve. Try a different network.

## Credits and license

The translation lists are built with the DeckThemes team's scripts and their earlier Steam history, used under the [MIT license](https://beallio.github.io/steamui-watch/LICENSE.txt).

## For developers: running the tests

```sh
python3 -m unittest
```

Some tests also need `jq`. They are skipped if `git` or `jq` is missing.
