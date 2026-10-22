#!/usr/bin/env bun
/**
 * Read @decky/ui's compiled dist/ and print the @decky/ui half of decky_watch.py's finder table as JSON.
 *
 *   bun tools/finder_table.ts [DECKY_UI_PACKAGE] > table.json
 *
 * Every top-level declaration whose value comes from a Steam search (findModule*, findClassModule,
 * `.find`/`.filter` over modules) becomes one entry. Its predicate becomes clauses that must all
 * match; each clause lists alternatives: `.includes()` text, regex literals, `createPropListRegex`
 * prop lists, and property names the predicate tests (`m.X`, `"X" in m`). Negated tests and generic
 * names (`toString`, `render`, ...) say nothing about the bundle and are dropped. Class finders list
 * the class names a module must have and must lack.
 * Exit status 1 when a predicate uses a form this reader does not know, so the table cannot miss it silently.
 */
import { parse } from "acorn";
import { join, relative, resolve } from "node:path";

/** An acorn (ESTree) node. */
type Node = any;
export type Atom = { text: string } | { regex: string } | { name: string } | { props: string[]; from_start: boolean };
/** Clauses that must all match; each clause lists alternatives. [] means "no constraint". */
type Cnf = Atom[][];
export type Entry = { name: string; code: Cnf } | { name: string; classes: { has: string[]; lacks: string[] } };

const SEARCH_HELPERS = new Set(["findModule", "findModuleExport", "findModuleByExport", "findModuleDetailsByExport", "findModuleChild"]);
const CLASS_HELPERS = new Set(["findClassModule", "findClass", "findClassByName"]);
// Names every object or function has: a test for them finds nothing in the bundle.
const GENERIC = new Set(["toString", "render", "type", "prototype", "length", "call", "apply"]);

const key = (a: Atom) => JSON.stringify(a);
const and = (...xs: Cnf[]): Cnf => xs.flat();
function or(a: Cnf, b: Cnf): Cnf {
  if (!a.length || !b.length) return [];
  return a.flatMap((x) => b.map((y) => [...new Map([...x, ...y].map((atom) => [key(atom), atom])).values()]));
}

const isFunction = (n: Node) => n?.type === "ArrowFunctionExpression" || n?.type === "FunctionExpression";
const propName = (n: Node): string | undefined =>
  !n.computed && n.property.type === "Identifier" ? n.property.name
    : n.computed && typeof n.property.value === "string" ? n.property.value : undefined;
const literalText = (n: Node): string | undefined =>
  n?.type === "Literal" && typeof n.value === "string" ? n.value
    : n?.type === "TemplateLiteral" && !n.expressions.length ? n.quasis[0].value.cooked : undefined;

/** Reads one file's predicates. `where` names the entry for error messages. */
class Reader {
  propRegexes = new Map<string, Atom>();
  unread: string[] = [];
  searched = false;
  /** The current predicate's parameters: only names tested on them are Steam names (not `window.SP_REACT`). */
  params = new Set<string>();
  where = "";

  fail(why: string, n: Node) {
    this.unread.push(`${this.where}: ${why} at offset ${n.start}`);
    return [] as Cnf;
  }

  /** What must be true for the expression to be truthy. */
  cnf(n: Node): Cnf {
    switch (n.type) {
      case "ChainExpression": return this.cnf(n.expression);
      case "LogicalExpression":
        return n.operator === "&&" ? and(this.cnf(n.left), this.cnf(n.right)) : or(this.cnf(n.left), this.cnf(n.right));
      case "UnaryExpression": return []; // `!x`, `typeof x`: no needle
      case "BinaryExpression": {
        const text = literalText(n.left);
        return n.operator === "in" && text !== undefined ? [[{ name: text }]] : this.within(n);
      }
      case "MemberExpression": {
        const names: Cnf = [];
        let m = n;
        for (; m.type === "MemberExpression"; m = m.object) {
          const p = propName(m);
          if (p !== undefined && !GENERIC.has(p)) names.unshift([{ name: p }]);
        }
        return and(m.type === "Identifier" && this.params.has(m.name) ? names : [], this.cnf(m));
      }
      case "CallExpression": return this.call(n);
      default: return this.within(n);
    }
  }

  call(n: Node): Cnf {
    const callee = n.callee.type === "ChainExpression" ? n.callee.expression : n.callee;
    if (callee.type === "Identifier" && SEARCH_HELPERS.has(callee.name)) {
      this.searched = true;
      return this.predicate(n.arguments[0]);
    }
    if (callee.type === "Identifier" && CLASS_HELPERS.has(callee.name)) return this.fail(`${callee.name} outside a declaration`, n);
    if (callee.type !== "MemberExpression") return this.within(n);
    const method = propName(callee);
    if (method === "includes") {
      const text = literalText(n.arguments[0]);
      return text === undefined ? this.fail("`.includes()` with a non-literal argument", n) : [[{ text }]];
    }
    if (method === "test") {
      const re = callee.object;
      if (re.type === "Literal" && re.regex) return re.regex.flags ? this.fail(`regex flags /${re.regex.flags}`, n) : [[{ regex: re.regex.pattern }]];
      if (re.type === "Identifier" && this.propRegexes.has(re.name)) return [[this.propRegexes.get(re.name)!]];
      return this.fail("`.test()` on an unknown regex", n);
    }
    if ((method === "find" || method === "filter") && isFunction(n.arguments[0])) {
      this.searched = true;
      return and(this.within(callee.object), this.predicate(n.arguments[0]));
    }
    return this.within(n);
  }

  /** The searches nested in a value (arguments, receivers); nested functions run later and are skipped. */
  within(n: Node): Cnf {
    const out: Cnf[] = [];
    for (const [k, v] of Object.entries(n)) {
      if (k === "type" || !v || typeof v !== "object") continue;
      for (const child of Array.isArray(v) ? v : [v]) {
        if (child && typeof child.type === "string" && !isFunction(child)) out.push(child.type === "CallExpression" ? this.call(child) : this.within(child));
      }
    }
    return and(...out);
  }

  /** A finder's predicate: truthy when any truthy `return` is reached. */
  predicate(fn: Node): Cnf {
    if (!isFunction(fn)) return this.fail("search without a predicate function", fn ?? { start: -1 });
    const outer = this.params;
    this.params = new Set(fn.params.filter((p: Node) => p.type === "Identifier").map((p: Node) => p.name));
    try {
      return this.body(fn);
    } finally {
      this.params = outer;
    }
  }

  body(fn: Node): Cnf {
    if (fn.body.type !== "BlockStatement") return this.cnf(fn.body);
    const paths: Cnf[] = [];
    const walk = (s: Node, conds: Node[]) => {
      if (!s) return;
      switch (s.type) {
        case "BlockStatement": for (const t of s.body) walk(t, conds); break;
        case "IfStatement": walk(s.consequent, [...conds, s.test]); walk(s.alternate, conds); break;
        case "ForStatement": case "ForInStatement": case "ForOfStatement": case "WhileStatement": walk(s.body, conds); break;
        case "TryStatement": walk(s.block, conds); break;
        case "ReturnStatement": {
          const a = s.argument;
          if (!a || (a.type === "Literal" && !a.value)) break;
          paths.push(and(...conds.map((c) => this.cnf(c)), a.type === "Literal" ? [] : this.cnf(a)));
        }
      }
    };
    walk(fn.body, []);
    if (!paths.length) return this.fail("predicate has no truthy return", fn);
    return paths.reduce(or);
  }

  /** `findClassModule((m) => m.A && !m.B)`: names the module must have and must lack. */
  classes(fn: Node) {
    const has: string[] = [], lacks: string[] = [];
    const terms = (e: Node): Node[] => (e.type === "LogicalExpression" && e.operator === "&&" ? [...terms(e.left), ...terms(e.right)] : [e]);
    if (!isFunction(fn) || fn.body.type === "BlockStatement") return this.fail("class finder without an expression predicate", fn ?? { start: -1 }), undefined;
    for (const t of terms(fn.body)) {
      const negated = t.type === "UnaryExpression" && t.operator === "!";
      const m = negated ? t.argument : t;
      const p = m.type === "MemberExpression" && m.object.type === "Identifier" ? propName(m) : undefined;
      if (p === undefined) return this.fail("class finder term is not `m.Name` or `!m.Name`", t), undefined;
      (negated ? lacks : has).push(p);
    }
    return { has, lacks };
  }
}

/** The entries of one dist file. Unknown predicate forms are listed in `unread`. */
export function readSource(source: string, file: string) {
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const reader = new Reader();
  const entries: Entry[] = [];
  for (const statement of program.body) {
    const decl = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (decl?.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      const init = d.init;
      if (!init || isFunction(init)) continue;
      const id = d.id.type === "Identifier" ? d.id.name : d.id.elements?.map((e: Node) => e?.name).filter(Boolean).join(", ");
      reader.where = `${file}: ${id}`;
      if (init.type === "CallExpression" && init.callee.type === "Identifier" && init.callee.name === "createPropListRegex") {
        const [list, fromStart] = init.arguments;
        const props = list?.type === "ArrayExpression" ? list.elements.map(literalText) : [];
        if (!props.length || props.includes(undefined) || (fromStart && fromStart.type !== "Literal")) reader.fail("createPropListRegex arguments are not literals", init);
        else reader.propRegexes.set(id, { props: props as string[], from_start: fromStart ? Boolean(fromStart.value) : true });
        continue;
      }
      if (init.type === "CallExpression" && init.callee.type === "Identifier" && CLASS_HELPERS.has(init.callee.name)) {
        const classes = init.callee.name === "findClassModule" ? reader.classes(init.arguments[0]) : reader.fail(`${init.callee.name} is not supported`, init);
        if (classes && !Array.isArray(classes)) entries.push({ name: reader.where, classes });
        continue;
      }
      reader.searched = false;
      const code = reader.cnf(init);
      if (reader.searched && code.length) entries.push({ name: reader.where, code });
    }
  }
  return { entries, unread: reader.unread };
}

if (import.meta.main) {
  const pkg = resolve(Bun.argv[2] ?? join(import.meta.dir, "../../decky-loader/frontend/node_modules/@decky/ui"));
  const dist = join(pkg, "dist");
  const finders: Entry[] = [], unread: string[] = [];
  for (const file of [...new Bun.Glob("**/*.js").scanSync(dist)].sort()) {
    const r = readSource(await Bun.file(join(dist, file)).text(), relative(dist, join(dist, file)));
    finders.push(...r.entries);
    unread.push(...r.unread);
  }
  if (unread.length) {
    console.error(`Cannot read ${unread.length} predicate part(s); teach tools/finder_table.ts the form:\n  ${unread.join("\n  ")}`);
    process.exit(1);
  }
  const { version } = await Bun.file(join(pkg, "package.json")).json();
  console.log(JSON.stringify({ ui: version, finders }, null, 1));
}
