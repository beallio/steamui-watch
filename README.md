# steamui-watch

Keeps CSS Loader themes working after Steam updates on the Steam Deck.

Steam gives the parts of its interface random class names, and the names can change with each Steam update. CSS Loader themes depend on these names. The DeckThemes team publishes a translation list ("mappings") that lets old themes work on new Steam versions. This tool gets the newest Steam Deck interface files directly from Valve and adds them to that translation list, so you do not need a Steam Deck to do it.

## What you need

- Python 3.10 or newer. You do not need extra packages.
- A copy of the DeckThemes mappings repository:

  ```sh
  git clone https://github.com/DeckThemes/CSSLoader-Mappings.git
  ```

## Everyday use

```sh
python3 css_mappings.py path/to/CSSLoader-Mappings
```

The tool does these steps:

1. It reads the current Steam Deck **stable** and **beta** versions from Valve.
2. It skips a version that already has a file in `webpack/`.
3. It downloads the interface files for a new version and makes sure the download is not damaged.
4. It writes `webpack/<version>.stable.json` or `webpack/<version>.beta.json`.
5. It runs the three DeckThemes scripts, which make the new `beta.json` and `stable.json`.

Useful options:

| Option | What it does |
|---|---|
| `--branch stable` or `--branch publicbeta` | Do only one branch. |
| `--force` | Make the file again, even if it exists. |
| `--no-pipeline` | Write the new file, but do not run the DeckThemes scripts. |

The second step (the `classname_mappings.py` script) can take a few minutes.

## Troubleshooting

- **"is not a CSSLoader-Mappings checkout"**: Give the path to the folder that contains `webpack/` and `classname_mappings.py`.
- **"SHA-256 does not match the manifest"**: The download is damaged or incomplete. Run the tool again.
- **"only N class modules found"**: Steam changed how it packs its interface files. The tool needs an update. Do not use the output.
- **HTTP 403 errors**: Some networks block downloads from Valve's servers. Try a different network.

## Running the tests

```sh
python3 -m unittest
```
