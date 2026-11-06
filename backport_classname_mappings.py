import os, json

with open("./classname_mappings.json", 'r') as fp:
    data = json.load(fp)

def load_json(path : str, default):
    if not os.path.exists(path):
        return default
    with open(path, 'r') as fp:
        return json.load(fp)

def generate(data : dict, version : int, branch : str):
    print(f"Generating for version {version}")
    final = {}
    dump = load_json(f"./webpack/{version}.{branch}.json", {})
    # Class names Steam's own CSS uses as plain classes; translating them would move a theme's rule off them.
    literal = set(load_json(f"./webpack-literals/{version}.{branch}.json", []))

    for module_id in data["module_mappings"]:
        module = data["module_mappings"][module_id]
        current = dump.get(module["ids"].get(str(version)), {})

        for classname_id in module["classname_mappings"]:
            key = f"{module_id}_{classname_id}"
            if key not in final:
                final[key] = []

            items = sorted(module["classname_mappings"][classname_id].items(), key=lambda x: int(x[0]))

            module_name = module["name"] if module["name"] is not None else f"_{module_id}"

            stable_ids = [
                f"_{module_id}_{classname_id}",
                f"{module_name}_{classname_id}"
            ]

            for stable_id in stable_ids:
                if stable_id not in final[key]:
                    final[key].append(stable_id)

            for i, (k, v) in enumerate(items):
                if v not in final[key] and int(k) <= version:
                    final[key].append(v)

            for i, (k, v) in enumerate(items):
                if v not in final[key]:
                    final[key].insert(len(final[key]) - 1, v)

            # A beta build can have a lower number than the stable build without being part of it,
            # so the number order above can end on the other branch's class. This branch's dump is the truth.
            value = current.get(classname_id)
            if value in final[key]:
                final[key].remove(value)
                final[key].append(value)

            final[key] = [x for x in final[key][:-1] if x not in literal] + final[key][-1:]

    return final

last_beta = sorted([int(x[0]) for x in data["versions"].items() if x[1] == "beta"])[-1]
last_stable = sorted([int(x[0]) for x in data["versions"].items() if x[1] == "stable"])[-1]

beta = generate(data, last_beta, "beta")
stable = generate(data, last_stable, "stable")

with open("./beta.json", 'w') as fp:
    json.dump(beta, fp)

with open("./stable.json", 'w') as fp:
    json.dump(stable, fp)
