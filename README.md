# CSSLoader-Mappings
Internal css mappings to translate css from older Steam clients to new ones

This is the retained data branch for [steamui-watch](https://github.com/beallio/steamui-watch).
It keeps older Steam class names and reviewed corrections so themes can still use them after updates.
Use the normal Steam Deck tools in that repository to update the lists; do not replace this branch with a fresh upstream copy.

The pipeline keeps continuing modules separate from new modules that look similar.
When an old module moves and Steam reuses its number, both modules keep separate histories.
Older generated class names remain valid through the seed data.
See the [developer guide](https://github.com/beallio/steamui-watch/blob/main/DEVELOPER.md#generate-css-mappings-locally) for maintenance and test commands.



### Format:

```json
{
    "id": [
        "1",
        "2",
        "3"
    ]
}
```

- id: A randomly generated uuid. Currently serves no use.
- 1,2,3: The Steam classnames to map. All previous entries in the list will be mapped to the latest entry in the list.

### Updating translations (Webpack)

```js
// There are three localization classes, ranging from 1000-8000 keys of UI strings
const withoutLocalizationClasses = DFL.classMap.filter((module) => Object.keys(module).length < 1000)

const allClasses = withoutLocalizationClasses.map((module) => {
    let filteredModule = {}
    Object.entries(module).forEach(([propertyName, value]) => {
      // Filter out things that start with a number (eg: Breakpoints like 800px)
      // I have confirmed the new classes don't start with numbers
      if (isNaN(value.charAt(0))) {
        filteredModule[propertyName] = value;
      }
    })
    return filteredModule;
}).filter((module) => {
    // Some modules will be empty after the filtering, remove those
    return Object.keys(module).length > 0;
});

const mappings = allClasses.reduce((acc, cur) => {
    Object.entries(cur).forEach(([property, value]) => {
        if (acc[property]) {
            acc[property].push(value)
        } else {
            acc[property] = [value]   
        }
    })
    return acc
}, {})
```

+ webpack_mappings.py