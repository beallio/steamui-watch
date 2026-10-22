import { parse } from "acorn";

export type PropSurface = { props: string[]; notes: string[] };

type Ast = any;
type Alias = { omitted: Set<string>; unknown: boolean };
const EMPTY_ALIAS: Alias = { omitted: new Set(), unknown: false };
type Module = {
  id: string;
  factory: Ast;
  parents: WeakMap<object, Ast>;
  locals: Map<string, Ast>;
  requires: Map<string, string>;
  imports: Map<string, { id: string; key: string }>;
  exports: Map<string, Ast>;
  moduleName?: string;
  exportsName?: string;
  requireName?: string;
};
type Resolved = { module: Module; node: Ast } | { dom: string } | { unresolved: string };
type Forward = {
  target: Ast;
  omitted: Alias;
  overridden: Set<string>;
  unknownOverrides: boolean;
  override?: { name: string; fallback: Ast };
};
type ScanResult = { props: Set<string>; notes: string[] };

const isNode = (value: unknown): value is Ast => !!value && typeof value === "object" && typeof (value as Ast).type === "string";
const isFunction = (node: Ast) => node && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type);
const isClass = (node: Ast) => node && ["ClassDeclaration", "ClassExpression"].includes(node.type);
const isIdentifier = (node: Ast) => node?.type === "Identifier";

function children(node: Ast): Ast[] {
  const out: Ast[] = [];
  for (const [key, value] of Object.entries(node ?? {})) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (isNode(value)) out.push(value);
    else if (Array.isArray(value)) for (const item of value) if (isNode(item)) out.push(item);
  }
  return out;
}

function walk(node: Ast, visit: (node: Ast) => void): void {
  if (!isNode(node)) return;
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

function parentMap(root: Ast): WeakMap<object, Ast> {
  const parents = new WeakMap<object, Ast>();
  const visit = (node: Ast) => {
    for (const child of children(node)) {
      parents.set(child, node);
      visit(child);
    }
  };
  visit(root);
  return parents;
}

function strip(node: Ast): Ast {
  while (node) {
    if (node.type === "ChainExpression" || node.type === "ParenthesizedExpression") node = node.expression;
    else if (node.type === "SequenceExpression" && node.expressions.length) node = node.expressions.at(-1);
    else break;
  }
  return node;
}

function staticKey(node: Ast, computed = false): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier" && !computed) return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) return String(node.value);
  return undefined;
}

function memberKey(node: Ast): string | undefined {
  node = strip(node);
  return node?.type === "MemberExpression" ? staticKey(node.property, node.computed) : undefined;
}

function callName(node: Ast): string {
  const callee = strip(node?.callee);
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression") return memberKey(callee) ?? "";
  return "";
}

const JSX_CALLS = new Set(["jsx", "jsxs", "jsxDEV", "createElement"]);
const isElementCall = (node: Ast) => node?.type === "CallExpression" && JSX_CALLS.has(callName(node));

function bindingNames(pattern: Ast, out = new Set<string>()): Set<string> {
  if (!pattern) return out;
  if (pattern.type === "Identifier") out.add(pattern.name);
  else if (pattern.type === "RestElement") bindingNames(pattern.argument, out);
  else if (pattern.type === "AssignmentPattern") bindingNames(pattern.left, out);
  else if (pattern.type === "ArrayPattern") for (const element of pattern.elements) bindingNames(element, out);
  else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) bindingNames(property.type === "RestElement" ? property.argument : property.value, out);
  }
  return out;
}

function moduleId(node: Ast): string | undefined {
  node = strip(node);
  if (node?.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) return String(node.value);
  return undefined;
}

function requireCall(node: Ast, requireName?: string): string | undefined {
  node = strip(node);
  if (node?.type !== "CallExpression" || !isIdentifier(strip(node.callee)) || strip(node.callee).name !== requireName) return undefined;
  return moduleId(node.arguments[0]);
}

function requireExport(node: Ast, requireName?: string): { id: string; key: string } | undefined {
  node = strip(node);
  if (node?.type !== "MemberExpression") return undefined;
  const key = staticKey(node.property, node.computed);
  const id = requireCall(node.object, requireName);
  return id !== undefined && key !== undefined ? { id, key } : undefined;
}

function objectProperty(object: Ast, key: string): Ast | undefined {
  if (object?.type !== "ObjectExpression") return undefined;
  return object.properties.find((property: Ast) => property.type === "Property" && staticKey(property.key, property.computed) === key);
}

function propertyValue(property: Ast): Ast | undefined {
  return property?.type === "Property" && property.kind !== "get" && property.kind !== "set" ? property.value : undefined;
}

function getterValue(node: Ast): Ast {
  if (!isFunction(node)) return node;
  if (node.body?.type !== "BlockStatement") return node.body;
  const returned = node.body.body.find((statement: Ast) => statement.type === "ReturnStatement");
  return returned?.argument;
}

export function analyzeProps(factories: Record<string, string>, entries: Record<string, string[]>): Record<string, PropSurface> {
  const modules = new Map<string, Module | null>();
  const providerCache = new Map<string, Resolved[]>();

  const parseModule = (id: string): Module | null => {
    if (modules.has(id)) return modules.get(id)!;
    const source = factories[id];
    if (typeof source !== "string") {
      modules.set(id, null);
      return null;
    }
    let factory: Ast;
    try {
      const program = parse(`(${source})`, { ecmaVersion: "latest" }) as unknown as Ast;
      factory = strip(program.body?.[0]?.expression);
      if (!isFunction(factory)) throw new Error("factory is not a function");
    } catch {
      modules.set(id, null);
      return null;
    }

    const module: Module = {
      id,
      factory,
      parents: parentMap(factory),
      locals: new Map(),
      requires: new Map(),
      imports: new Map(),
      exports: new Map(),
      moduleName: isIdentifier(factory.params?.[0]) ? factory.params[0].name : undefined,
      exportsName: isIdentifier(factory.params?.[1]) ? factory.params[1].name : undefined,
      requireName: isIdentifier(factory.params?.[2]) ? factory.params[2].name : undefined,
    };
    modules.set(id, module);

    const collectTopLevel = (node: Ast) => {
      if (!isNode(node)) return;
      if (node.type === "FunctionDeclaration" && node.id) {
        module.locals.set(node.id.name, node);
        return;
      }
      if (node.type === "ClassDeclaration" && node.id) {
        module.locals.set(node.id.name, node);
        return;
      }
      if (node !== factory && (isFunction(node) || isClass(node))) return;
      if (node.type === "VariableDeclarator") {
        if (node.id.type === "Identifier") {
          module.locals.set(node.id.name, node);
          const req = requireCall(node.init, module.requireName);
          if (req !== undefined) module.requires.set(node.id.name, req);
          const imported = requireExport(node.init, module.requireName);
          if (imported) module.imports.set(node.id.name, imported);
          const staticMember = strip(node.init);
          if (staticMember?.type === "MemberExpression" && isIdentifier(staticMember.object)) {
            const targetModule = module.requires.get(staticMember.object.name);
            const key = staticKey(staticMember.property, staticMember.computed);
            if (targetModule !== undefined && key !== undefined) module.imports.set(node.id.name, { id: targetModule, key });
          }
        } else if (node.id.type === "ObjectPattern") {
          const req = requireCall(node.init, module.requireName);
          if (req !== undefined) {
            for (const property of node.id.properties) {
              if (property.type !== "Property") continue;
              const key = staticKey(property.key, property.computed);
              if (key !== undefined) for (const name of bindingNames(property.value)) module.imports.set(name, { id: req, key });
            }
          }
        }
      }
      for (const child of children(node)) collectTopLevel(child);
    };
    collectTopLevel(factory.body);

    const exportObject = (node: Ast) => {
      node = strip(node);
      if (isIdentifier(node) && node.name === module.exportsName) return true;
      return node?.type === "MemberExpression" && isIdentifier(node.object) && node.object.name === module.moduleName
        && staticKey(node.property, node.computed) === "exports";
    };
    const setExport = (key: string | undefined, value: Ast | undefined) => {
      if (key !== undefined && value) module.exports.set(key, value);
    };
    const collectExports = (node: Ast) => {
      if (!isNode(node)) return;
      if (node.type === "CallExpression") {
        const callee = strip(node.callee);
        if (callee?.type === "MemberExpression" && isIdentifier(callee.object) && callee.object.name === module.requireName
          && staticKey(callee.property, callee.computed) === "d" && exportObject(node.arguments[0])) {
          const getters = node.arguments[1];
          if (getters?.type === "ObjectExpression") {
            for (const property of getters.properties) {
              if (property.type === "Property") setExport(staticKey(property.key, property.computed), getterValue(property.value));
            }
          }
        }
        if (callee?.type === "MemberExpression" && isIdentifier(callee.object) && callee.object.name === "Object") {
          const method = staticKey(callee.property, callee.computed);
          if (method === "defineProperty" && exportObject(node.arguments[0])) {
            const key = staticKey(node.arguments[1], true);
            const getter = propertyValue(objectProperty(node.arguments[2], "get"));
            setExport(key, getter && getterValue(getter));
          } else if (method === "defineProperties" && exportObject(node.arguments[0]) && node.arguments[1]?.type === "ObjectExpression") {
            for (const property of node.arguments[1].properties) {
              const key = staticKey(property.key, property.computed);
              const getter = propertyValue(objectProperty(property.value, "get"));
              setExport(key, getter && getterValue(getter));
            }
          }
        }
      }
      if (node.type === "AssignmentExpression") {
        const left = strip(node.left);
        if (left?.type === "MemberExpression" && exportObject(left.object)) {
          setExport(staticKey(left.property, left.computed), node.right);
        } else if (left?.type === "MemberExpression" && isIdentifier(left.object) && left.object.name === module.moduleName
          && staticKey(left.property, left.computed) === "exports" && node.right?.type === "ObjectExpression") {
          for (const property of node.right.properties) {
            if (property.type === "Property") setExport(staticKey(property.key, property.computed), propertyValue(property));
          }
        }
      }
      for (const child of children(node)) collectExports(child);
    };
    collectExports(factory.body);

    const collectAssignments = (node: Ast) => {
      if (!isNode(node)) return;
      if (node !== factory && (isFunction(node) || isClass(node))) return;
      if (node.type === "AssignmentExpression" && node.operator === "=" && isIdentifier(node.left) && module.locals.has(node.left.name)) {
        const previous = module.locals.get(node.left.name);
        if (previous?.type === "VariableDeclarator" && !previous.init) {
          previous.init = node.right;
          const req = requireCall(node.right, module.requireName);
          if (req !== undefined) module.requires.set(node.left.name, req);
          const imported = requireExport(node.right, module.requireName);
          if (imported) module.imports.set(node.left.name, imported);
        }
      }
      for (const child of children(node)) collectAssignments(child);
    };
    collectAssignments(factory.body);
    return module;
  };

  const resolveExpr = (module: Module, expression: Ast, seen = new Set<string>()): Resolved => {
    const node = strip(expression);
    if (!node) return { unresolved: `${module.id}: missing expression` };
    if (node.type === "Literal" && typeof node.value === "string") return { dom: node.value };
    if (node.type === "Identifier") {
      const localKey = `${module.id}:local:${node.name}`;
      if (seen.has(localKey)) return { unresolved: `cyclic local alias ${module.id}:${node.name}` };
      const nextSeen = new Set(seen).add(localKey);
      const imported = module.imports.get(node.name);
      if (imported) return resolveExport(imported.id, imported.key, nextSeen);
      if (module.requires.has(node.name)) return { unresolved: `module namespace ${module.requires.get(node.name)}` };
      const declaration = module.locals.get(node.name);
      if (declaration?.type === "VariableDeclarator") {
        if (!declaration.init) return { unresolved: `uninitialized local ${module.id}:${node.name}` };
        return resolveExpr(module, declaration.init, nextSeen);
      }
      if (declaration) return { module, node: declaration };
      return { unresolved: `unresolved local ${module.id}:${node.name}` };
    }
    if (node.type === "MemberExpression") {
      const key = staticKey(node.property, node.computed);
      if (key === undefined) return { unresolved: `dynamic member in ${module.id}` };
      const object = strip(node.object);
      const required = isIdentifier(object) ? module.requires.get(object.name) : requireCall(object, module.requireName);
      if (required !== undefined) return resolveExport(required, key, new Set(seen));
      if (isIdentifier(object)) {
        const imported = module.imports.get(object.name);
        if (imported) {
          const resolved = resolveExport(imported.id, imported.key, new Set(seen));
          if ("module" in resolved && resolved.node?.type === "ObjectExpression") {
            const value = propertyValue(objectProperty(resolved.node, key));
            if (value) return resolveExpr(resolved.module, value, new Set(seen));
          }
          return { unresolved: `unresolved member ${object.name}.${key} in ${module.id}` };
        }
      }
      const resolvedObject = resolveExpr(module, object, new Set(seen));
      if ("module" in resolvedObject && resolvedObject.node?.type === "ObjectExpression") {
        const value = propertyValue(objectProperty(resolvedObject.node, key));
        if (value) return resolveExpr(resolvedObject.module, value, new Set(seen));
      }
      return { unresolved: `unresolved member ${node.start ?? ""} in ${module.id}` };
    }
    if (node.type === "CallExpression" && requireCall(node, module.requireName) !== undefined) return { unresolved: `module namespace call in ${module.id}` };
    return { module, node };
  };

  function resolveExport(id: string, key: string, seen: Set<string>): Resolved {
    const exportKey = `${id}:export:${key}`;
    if (seen.has(exportKey)) return { unresolved: `cyclic export ${id}:${key}` };
    const module = parseModule(id);
    if (!module) return { unresolved: `missing or unparsable module ${id}` };
    const value = module.exports.get(key);
    if (!value) return { unresolved: `missing export ${id}:${key}` };
    return resolveExpr(module, value, new Set(seen).add(exportKey));
  }

  const providerResults = (name: string): Resolved[] => {
    if (providerCache.has(name)) return providerCache.get(name)!;
    const providers: Resolved[] = [];
    const identities = new Set<string>();
    for (const id of Object.keys(factories).sort()) {
      if (!factories[id]?.includes(name) || !factories[id]?.includes(".Provider")) continue;
      const module = parseModule(id);
      if (!module) continue;
      walk(module.factory.body, (node) => {
        if (!isElementCall(node)) return;
        const target = strip(node.arguments?.[0]);
        if (target?.type !== "MemberExpression" || memberKey(target) !== "Provider") return;
        const props = node.arguments?.[1];
        const valueProperty = objectProperty(props, "value");
        const valueExpression = propertyValue(valueProperty);
        if (!valueExpression) return;
        let valueObject = strip(valueExpression);
        if (valueObject?.type === "Identifier") {
          const resolved = resolveExpr(module, valueObject);
          if ("module" in resolved) valueObject = strip(resolved.node);
        }
        if (valueObject?.type !== "ObjectExpression") return;
        for (const property of valueObject.properties) {
          if (property.type !== "Property" || staticKey(property.key, property.computed) !== name) continue;
          const result = resolveExpr(module, propertyValue(property));
          const identity = "module" in result ? `${result.module.id}:${result.node.start}` : "unresolved" in result ? result.unresolved : `dom:${result.dom}`;
          if (identities.has(identity)) continue;
          identities.add(identity);
          providers.push(result);
        }
      });
    }
    providerCache.set(name, providers);
    return providers;
  };

  const isScope = (node: Ast) => isFunction(node) || ["BlockStatement", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement", "CatchClause"].includes(node?.type);
  const nearestScope = (module: Module, node: Ast, variableKind?: string): Ast | undefined => {
    let parent = module.parents.get(node);
    while (parent) {
      if (isFunction(parent)) {
        if (variableKind !== "var" || !isFunction(node)) return parent;
      }
      if (isScope(parent) && (variableKind === "var" ? isFunction(parent) : true)) return parent;
      parent = module.parents.get(parent);
    }
    return undefined;
  };

  const localBinding = (module: Module, root: Ast, reference: Ast, name: string): { found: boolean; value?: Ast } => {
    const scopes: Ast[] = [];
    let current: Ast | undefined = reference;
    while (current) {
      if (isScope(current)) scopes.push(current);
      if (current === root) break;
      current = module.parents.get(current);
    }
    if (!scopes.includes(root)) scopes.push(root);
    const candidates: { scope: Ast; value?: Ast; start: number }[] = [];
    walk(root, (node) => {
      if (node.type === "VariableDeclarator") {
        const names = bindingNames(node.id);
        if (!names.has(name)) return;
        const declaration = module.parents.get(node);
        const kind = declaration?.type === "VariableDeclaration" ? declaration.kind : undefined;
        const scope = nearestScope(module, node, kind);
        if (scope && scopes.includes(scope)) candidates.push({ scope, value: node.id.type === "Identifier" ? node.init : undefined, start: node.start ?? 0 });
      } else if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id?.name === name) {
        const scope = module.parents.get(node);
        if (scope && scopes.includes(scope)) candidates.push({ scope, value: node, start: node.start ?? 0 });
      } else if (isFunction(node)) {
        if (node.id?.name === name && scopes.includes(node)) candidates.push({ scope: node, value: node, start: node.start ?? 0 });
        for (const parameter of node.params ?? []) {
          if (bindingNames(parameter).has(name) && scopes.includes(node)) candidates.push({ scope: node, value: undefined, start: node.start ?? 0 });
        }
      }
    });
    for (const scope of scopes) {
      const matches = candidates.filter((candidate) => candidate.scope === scope).sort((a, b) => b.start - a.start);
      if (matches.length) return { found: true, value: matches[0].value };
    }
    return { found: false };
  };

  const cloneAliases = (aliases: Map<string, Alias>) => new Map([...aliases].map(([name, alias]) => [name, { omitted: new Set(alias.omitted), unknown: alias.unknown }]));
  const isPropsAlias = (expression: Ast, aliases: Map<string, Alias>, allowThis: boolean): Alias | undefined => {
    const node = strip(expression);
    if (node?.type === "Identifier") return aliases.get(node.name);
    if (allowThis && node?.type === "MemberExpression" && node.object?.type === "ThisExpression" && memberKey(node) === "props") return EMPTY_ALIAS;
    return undefined;
  };
  const setAlias = (name: string, alias: Alias, aliases: Map<string, Alias>) => aliases.set(name, { omitted: new Set(alias.omitted), unknown: alias.unknown });
  const addRead = (name: string | undefined, alias: Alias, props: Set<string>, notes: string[], module: Module) => {
    if (name === undefined) {
      notes.push(`dynamic prop access in module ${module.id}`);
      return;
    }
    if (alias.unknown) {
      notes.push(`prop read ${name} through a dynamically omitted rest object in module ${module.id}`);
      return;
    }
    if (!alias.omitted.has(name)) props.add(name);
  };

  const objectPatternKeys = (pattern: Ast, notes: string[], module: Module): { keys: Set<string>; dynamic: boolean } => {
    const keys = new Set<string>();
    let dynamic = false;
    for (const property of pattern.properties ?? []) {
      if (property.type === "RestElement") continue;
      const key = staticKey(property.key, property.computed);
      if (key === undefined) {
        dynamic = true;
        notes.push(`dynamic prop destructuring in module ${module.id}`);
      } else keys.add(key);
    }
    return { keys, dynamic };
  };

  const bindPropPattern = (pattern: Ast, source: Alias, aliases: Map<string, Alias>, props: Set<string>, notes: string[], module: Module) => {
    if (pattern?.type !== "ObjectPattern") {
      if (pattern?.type === "ArrayPattern") notes.push(`array destructuring of props in module ${module.id}`);
      return;
    }
    const { keys, dynamic } = objectPatternKeys(pattern, notes, module);
    for (const property of pattern.properties) {
      if (property.type === "RestElement") {
        for (const name of bindingNames(property.argument)) {
          setAlias(name, { omitted: new Set([...source.omitted, ...keys]), unknown: source.unknown || dynamic }, aliases);
        }
        continue;
      }
      const key = staticKey(property.key, property.computed);
      if (source.unknown) notes.push(`prop destructuring through a dynamically omitted rest object in module ${module.id}`);
      else if (key !== undefined && !source.omitted.has(key)) props.add(key);
    }
  };

  const scopeLexicalNames = (scope: Ast): Set<string> => {
    const names = new Set<string>();
    if (isFunction(scope)) {
      const functionName = scope.id?.name;
      if (functionName) names.add(functionName);
      for (const parameter of scope.params ?? []) for (const name of bindingNames(parameter)) names.add(name);
      const body = scope.body;
      if (body?.type === "BlockStatement") {
        for (const statement of body.body) {
          if (statement.type === "VariableDeclaration" && statement.kind !== "var") for (const declaration of statement.declarations) bindingNames(declaration.id, names);
          else if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id) names.add(statement.id.name);
        }
        const collectVar = (node: Ast) => {
          if (!isNode(node)) return;
          if (node !== body && (isFunction(node) || isClass(node))) return;
          if (node.type === "VariableDeclaration" && node.kind === "var") for (const declaration of node.declarations) bindingNames(declaration.id, names);
          for (const child of children(node)) collectVar(child);
        };
        collectVar(body);
      }
      return names;
    }
    if (scope.type === "BlockStatement") {
      for (const statement of scope.body) {
        if (statement.type === "VariableDeclaration" && statement.kind !== "var") for (const declaration of statement.declarations) bindingNames(declaration.id, names);
        else if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id) names.add(statement.id.name);
      }
    } else if (scope.type === "CatchClause") {
      for (const name of bindingNames(scope.param)) names.add(name);
    } else if (["ForStatement", "ForInStatement", "ForOfStatement"].includes(scope.type)) {
      if (scope.init?.type === "VariableDeclaration" && scope.init.kind !== "var") for (const declaration of scope.init.declarations) bindingNames(declaration.id, names);
      if (scope.left?.type === "VariableDeclaration" && scope.left.kind !== "var") for (const declaration of scope.left.declarations) bindingNames(declaration.id, names);
    } else if (scope.type === "SwitchStatement") {
      for (const branch of scope.cases) for (const statement of branch.consequent) {
        if (statement.type === "VariableDeclaration" && statement.kind !== "var") for (const declaration of statement.declarations) bindingNames(declaration.id, names);
      }
    }
    return names;
  };

  const resolveTarget = (module: Module, component: Ast, target: Ast): { result: Resolved; notes: string[] }[] => {
    const expression = strip(target);
    let foundLocal = false;
    let localValue: Ast | undefined;
    if (expression?.type === "Identifier") {
      const local = localBinding(module, component, expression, expression.name);
      foundLocal = local.found;
      localValue = local.value;
    }
    const candidate = foundLocal ? localValue : expression;
    const hook = (node: Ast): { name: string; fallback: Ast } | undefined => {
      node = strip(node);
      if (node?.type !== "CallExpression") return undefined;
      const nameArg = node.arguments.find((argument: Ast) => argument.type === "Literal" && typeof argument.value === "string");
      const fallback = [...node.arguments].reverse().find((argument: Ast) => !(argument.type === "Literal" && typeof argument.value === "string"));
      return nameArg && fallback ? { name: nameArg.value, fallback } : undefined;
    };
    const spec = hook(candidate);
    if (spec) {
      const overrides = providerResults(spec.name);
      if (overrides.length === 1) return [{ result: overrides[0], notes: [] }];
      if (overrides.length > 1) return [{ result: resolveExpr(module, spec.fallback), notes: [`ambiguous override providers for ${spec.name}; followed fallback`] }];
    }
    if (foundLocal) {
      if (!localValue) return [{ result: { unresolved: `uninitialized local ${expression.name}` }, notes: [`uninitialized render target ${expression.name}`] }];
      const missingHook = localValue.type === "CallExpression" ? hook(localValue) : undefined;
      if (missingHook) return [{ result: { unresolved: `override provider not found for ${missingHook.name}` }, notes: [`override provider not found for ${missingHook.name}`] }];
      return [{ result: resolveExpr(module, localValue), notes: [] }];
    }
    return [{ result: resolveExpr(module, expression), notes: [] }];
  };

  const analyzeComponent = (resolved: Resolved, ancestry: Set<string>, depth: number): ScanResult => {
    if ("dom" in resolved) return { props: new Set(), notes: [`props forwarded to native ${resolved.dom}; native attributes are not enumerated`] };
    if (!("module" in resolved)) return { props: new Set(), notes: [`unresolved component target: ${resolved.unresolved}`] };
    let module = resolved.module;
    let node = strip(resolved.node);
    let wrapperDepth = 0;
    while (node?.type === "CallExpression") {
      const name = callName(node);
      if (name !== "memo" && name !== "forwardRef") {
        return { props: new Set(), notes: [`unsupported component wrapper ${name || "<anonymous>"} in module ${module.id}`] };
      }
      const argument = node.arguments?.[0];
      if (!argument) return { props: new Set(), notes: [`empty ${name} wrapper in module ${module.id}`] };
      const inner = resolveExpr(module, argument);
      if (!("module" in inner)) return { props: new Set(), notes: [`unresolved ${name} target in module ${module.id}: ${"unresolved" in inner ? inner.unresolved : inner.dom}`] };
      node = strip(inner.node);
      module = inner.module;
      wrapperDepth++;
      if (wrapperDepth > 8) return { props: new Set(), notes: [`wrapper nesting limit in module ${module.id}`] };
    }
    if (!isFunction(node) && !isClass(node)) return { props: new Set(), notes: [`unsupported component value ${node?.type ?? "missing"} in module ${module.id}`] };
    const identity = `${module.id}:${node.start}`;
    if (ancestry.has(identity)) return { props: new Set(), notes: [`component forwarding cycle at ${identity}`] };
    if (depth > 24) return { props: new Set(), notes: [`component forwarding depth limit at ${identity}`] };
    const nextAncestry = new Set(ancestry).add(identity);
    const props = new Set<string>();
    const notes: string[] = [];
    const forwards: Forward[] = [];

    const recordForward = (target: Ast, alias: Alias, overridden: Set<string>, unknownOverrides: boolean, override?: Forward["override"]) => {
      forwards.push({ target, omitted: { omitted: new Set(alias.omitted), unknown: alias.unknown }, overridden, unknownOverrides, override });
    };

    const scanFunction = (fn: Ast, inherited: Map<string, Alias>, root = false, classThis = false, propsParameter = true) => {
      const aliases = cloneAliases(inherited);
      const params = fn.params ?? [];
      if (root && propsParameter) {
        for (let index = 1; index < params.length; index++) for (const name of bindingNames(params[index])) aliases.delete(name);
        const first = params[0];
        if (first?.type === "Identifier") aliases.set(first.name, EMPTY_ALIAS);
        else if (first?.type === "AssignmentPattern" && first.left?.type === "Identifier") aliases.set(first.left.name, EMPTY_ALIAS);
        else if (first?.type === "ObjectPattern" || first?.type === "AssignmentPattern" && first.left?.type === "ObjectPattern") {
          bindPropPattern(first.type === "AssignmentPattern" ? first.left : first, EMPTY_ALIAS, aliases, props, notes, module);
        } else if (first) notes.push(`unsupported props parameter pattern in module ${module.id}`);
      } else if (!root) {
        for (const name of scopeLexicalNames(fn)) aliases.delete(name);
      }
      for (const parameter of params) scanNode(parameter, aliases, classThis);
      const body = fn.body;
      if (body?.type === "BlockStatement") scanNode(body, aliases, classThis, true);
      else scanNode(body, aliases, classThis, false);
    };


    const elementForwards = (call: Ast, aliases: Map<string, Alias>, classThis: boolean) => {
      const target = call.arguments?.[0];
      const propsArgument = call.arguments?.[1];
      if (!target || !propsArgument) return;
      const direct = isPropsAlias(propsArgument, aliases, classThis);
      if (direct) {
        const overridden = new Set<string>();
        const childArg = callName(call) === "createElement" && call.arguments.length > 2;
        if (childArg) overridden.add("children");
        recordForward(target, direct, overridden, false);
        return;
      }
      if (propsArgument.type !== "ObjectExpression") {
        const stripped = strip(propsArgument);
        if (stripped?.type !== "Literal" || stripped.value !== null) notes.push(`dynamic rendered props in module ${module.id}`);
        return;
      }
      const properties = propsArgument.properties;
      const componentProperty = objectProperty(propsArgument, "component");
      const fallbackProperty = objectProperty(propsArgument, "fallback");
      const overrideMember = strip(propertyValue(componentProperty));
      const fallback = propertyValue(fallbackProperty);
      const overrideSpec = overrideMember?.type === "MemberExpression" ? memberKey(overrideMember) : undefined;
      const override = overrideSpec && fallback ? { name: overrideSpec, fallback } : undefined;
      for (let index = 0; index < properties.length; index++) {
        const property = properties[index];
        if (property.type !== "SpreadElement") {
          if (property.type === "Property" && property.computed && staticKey(property.key, true) === undefined) notes.push(`dynamic rendered prop key in module ${module.id}`);
          continue;
        }
        const alias = isPropsAlias(property.argument, aliases, classThis);
        if (!alias) {
          notes.push(`unresolved spread in rendered props in module ${module.id}`);
          continue;
        }
        const overridden = new Set<string>();
        let unknownOverrides = false;
        for (const later of properties.slice(index + 1)) {
          if (later.type === "SpreadElement") {
            const laterAlias = isPropsAlias(later.argument, aliases, classThis);
            if (laterAlias) {
              if (laterAlias.unknown) unknownOverrides = true;
            } else if (later.argument?.type === "ObjectExpression") {
              for (const field of later.argument.properties) {
                if (field.type === "SpreadElement") unknownOverrides = true;
                else if (field.type === "Property") {
                  const key = staticKey(field.key, field.computed);
                  if (key === undefined) unknownOverrides = true;
                  else overridden.add(key);
                }
              }
            } else unknownOverrides = true;
            continue;
          }
          const key = later.type === "Property" ? staticKey(later.key, later.computed) : undefined;
          if (key === undefined && later.type === "Property" && later.computed) unknownOverrides = true;
          else if (key !== undefined) overridden.add(key);
        }
        if (callName(call) === "createElement" && call.arguments.length > 2) overridden.add("children");
        if (unknownOverrides) notes.push(`dynamic prop key may override forwarded props in module ${module.id}`);
        recordForward(target, alias, overridden, unknownOverrides, override);
      }
    };

    const scanNode = (node: Ast, aliases: Map<string, Alias>, classThis: boolean, rootBlock = false): void => {
      if (!isNode(node)) return;
      if (isFunction(node)) {
        scanFunction(node, aliases, false, classThis && node.type === "ArrowFunctionExpression");
        return;
      }
      if (isClass(node)) return;
      if (node.type === "BlockStatement" && !rootBlock) {
        const scoped = cloneAliases(aliases);
        for (const name of scopeLexicalNames(node)) scoped.delete(name);
        for (const child of node.body) scanNode(child, scoped, classThis);
        return;
      }
      if (node.type === "CatchClause") {
        const scoped = cloneAliases(aliases);
        for (const name of scopeLexicalNames(node)) scoped.delete(name);
        scanNode(node.body, scoped, classThis);
        return;
      }
      if (["ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement"].includes(node.type)) {
        const scoped = cloneAliases(aliases);
        for (const name of scopeLexicalNames(node)) scoped.delete(name);
        for (const child of children(node)) scanNode(child, scoped, classThis);
        return;
      }
      if (node.type === "VariableDeclarator") {
        const alias = isPropsAlias(node.init, aliases, classThis);
        if (node.id.type === "Identifier") {
          if (alias) setAlias(node.id.name, alias, aliases);
          else aliases.delete(node.id.name);
        } else if (alias && node.id.type === "ObjectPattern") bindPropPattern(node.id, alias, aliases, props, notes, module);
        else if (alias && node.id.type === "ArrayPattern") notes.push(`array destructuring of props in module ${module.id}`);
        scanNode(node.id, aliases, classThis);
        if (node.init) scanNode(node.init, aliases, classThis);
        return;
      }
      if (node.type === "AssignmentExpression") {
        const alias = isPropsAlias(node.right, aliases, classThis);
        if (node.left.type === "Identifier") {
          if (alias) setAlias(node.left.name, alias, aliases);
          else if (aliases.has(node.left.name)) {
            aliases.delete(node.left.name);
            notes.push(`props alias reassigned in module ${module.id}`);
          }
        } else if (alias && node.left.type === "ObjectPattern") bindPropPattern(node.left, alias, aliases, props, notes, module);
        if (node.left.type === "ObjectPattern" || node.left.type === "ArrayPattern") scanNode(node.left, aliases, classThis);
        scanNode(node.right, aliases, classThis);
        return;
      }
      if (node.type === "MemberExpression") {
        const alias = isPropsAlias(node.object, aliases, classThis);
        if (alias) addRead(staticKey(node.property, node.computed), alias, props, notes, module);
      }
      if (node.type === "CallExpression" || node.type === "NewExpression") {
        if (node.type === "CallExpression" && isElementCall(node)) elementForwards(node, aliases, classThis);
        else if (node.callee?.type !== "Super" && (node.arguments ?? []).some((argument: Ast) => isPropsAlias(argument.type === "SpreadElement" ? argument.argument : argument, aliases, classThis))) {
          notes.push(`props passed to helper ${callName(node) || "<anonymous>"} in module ${module.id}`);
        }
      }
      if (node.type === "SpreadElement") {
        const alias = isPropsAlias(node.argument, aliases, classThis);
        if (alias) {
          const object = module.parents.get(node);
          const call = object && module.parents.get(object);
          const isRenderedProps = object?.type === "ObjectExpression" && call?.type === "CallExpression" && isElementCall(call) && call.arguments?.[1] === object;
          if (!isRenderedProps) notes.push(`props copied into object in module ${module.id}`);
        }
      }
      for (const child of children(node)) scanNode(child, aliases, classThis);
    };

    if (isFunction(node)) {
      scanFunction(node, new Map(), true, false);
    } else {
      const classBody = node.body;
      for (const member of classBody?.body ?? []) {
        if (member.type === "MethodDefinition" && isFunction(member.value)) {
          const constructor = member.kind === "constructor" && !member.static;
          scanFunction(member.value, new Map(), constructor, !member.static, constructor);
        } else if (member.type === "PropertyDefinition" && member.value) scanNode(member.value, new Map(), !member.static);
        else if (member.type === "StaticBlock") scanNode(member, new Map(), false);
      }
    }

    for (const forward of forwards) {
      let targets: { result: Resolved; notes: string[] }[];
      if (forward.override) {
        const candidates = providerResults(forward.override.name);
        if (candidates.length === 1) targets = [{ result: candidates[0], notes: [] }];
        else if (candidates.length > 1) targets = [{ result: resolveExpr(module, forward.override.fallback), notes: [`ambiguous override providers for ${forward.override.name}; followed fallback`] }];
        else targets = [{ result: resolveExpr(module, forward.override.fallback), notes: [`override provider not found for ${forward.override.name}; followed fallback`] }];
      } else targets = resolveTarget(module, node, forward.target);
      for (const target of targets) {
        notes.push(...target.notes);
        const child = analyzeComponent(target.result, nextAncestry, depth + 1);
        notes.push(...child.notes);
        if (forward.omitted.unknown) notes.push(`forwarded props have dynamic omissions in module ${module.id}`);
        else if (!forward.unknownOverrides) {
          for (const name of child.props) if (!forward.omitted.omitted.has(name) && !forward.overridden.has(name)) props.add(name);
        }
      }
    }

    if (isClass(node)) {
      const base = node.superClass;
      if (base) {
        const parent = resolveExpr(module, base);
        if ("module" in parent) {
          const inherited = analyzeComponent(parent, nextAncestry, depth + 1);
          for (const name of inherited.props) props.add(name);
          notes.push(...inherited.notes);
        } else {
          notes.push(`unresolved base class in module ${module.id}: ${"unresolved" in parent ? parent.unresolved : parent.dom}`);
        }
      }
    }
    return { props, notes };
  };

  const result: Record<string, PropSurface> = {};
  for (const name of Object.keys(entries).sort()) {
    const props = new Set<string>();
    const notes = new Set<string>();
    const locations = [...new Set(entries[name] ?? [])].sort();
    for (const location of locations) {
      const separator = location.lastIndexOf(":");
      if (separator <= 0 || separator === location.length - 1) {
        notes.add(`invalid export location ${location}`);
        continue;
      }
      const id = location.slice(0, separator);
      const key = location.slice(separator + 1);
      const module = parseModule(id);
      if (!module) {
        notes.add(`missing or unparsable module ${id}`);
        continue;
      }
      const value = module.exports.get(key);
      if (!value) {
        notes.add(`missing export ${id}:${key}`);
        continue;
      }
      const resolved = resolveExport(id, key, new Set());
      const surface = analyzeComponent(resolved, new Set(), 0);
      for (const prop of surface.props) props.add(prop);
      for (const note of surface.notes) notes.add(note);
    }
    result[name] = { props: [...props].sort(), notes: [...notes].sort() };
  }
  return result;
}
