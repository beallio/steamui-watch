import { expect, test } from "bun:test";
import { analyzeProps } from "./prop_surface";

const factory = (body: string) => `function(module,exports,__webpack_require__){${body}}`;

test("resolves webpack re-exports and wrappers before following createElement props", () => {
  const factories = {
    "1": factory(`
      var childModule=__webpack_require__(2), React=__webpack_require__(4);
      __webpack_require__.d(exports,{x:()=>Root});
      const Root=React.forwardRef((props,ref)=>{
        const {omitted,...rest}=props, alias=rest;
        return React.createElement(childModule.Child,{...alias,forced:false},"child");
      });`),
    "2": factory(`var React=__webpack_require__(4); __webpack_require__.d(exports,{Child:()=>MemoChild}); function Child(p){return p.accepted&&p.label&&p.forced&&p.children} const MemoChild=React.memo(Child);`),
    "3": factory(`var rootModule=__webpack_require__(1); __webpack_require__.d(exports,{Main:()=>rootModule.x});`),
    "4": factory(""),
  };

  expect(analyzeProps(factories, { RadioGroup: ["3:Main"] })).toEqual({
    RadioGroup: { props: ["accepted", "label", "omitted"], notes: [] },
  });
});

test("unions sibling forwarding branches without leaking nested option keys", () => {
  const factories = {
    "10": factory(`
      __webpack_require__.d(exports,{Parent:()=>Parent});
      function Child({options:{nested},checked,title}){return nested&&checked&&title}
      function Parent(props){
        const local=props;
        return [jsxs(Child,{...local,checked:false}),jsx(Child,{...local})];
      }`),
  };

  const result = analyzeProps(factories, { ToggleField: ["10:Parent"] });
  expect(result.ToggleField).toEqual({ props: ["checked", "options", "title"], notes: [] });
  expect(analyzeProps(factories, { ToggleField: ["10:Parent"] })).toEqual(result);
});

test("keeps cycles branch-local and ignores shadowed function parameters", () => {
  const factories = {
    "20": factory(`
      __webpack_require__.d(exports,{Root:()=>Root});
      function Root(props){
        function shadow(props){return props.ghost;}
        const local=props;
        return props.root&&[jsx(Child,{...local,child:false}),jsx(Child,{...local})];
      }
      function Child(p){return p.child&&jsx(Root,{...p})}`),
  };

  const result = analyzeProps(factories, { SliderField: ["20:Root"] }).SliderField;
  expect(result.props).toEqual(["child", "root"]);
  expect(result.props).not.toContain("ghost");
  expect(result.notes.some((note) => note.startsWith("component forwarding cycle at 20:"))).toBe(true);
});

test("reads class props, lifecycle instance props and local base classes, not prevProps", () => {
  const factories = {
    "30": factory(`
      var bases=__webpack_require__(31);
      __webpack_require__.d(exports,{Panel:()=>Panel});
      class Panel extends bases.Base {
        constructor(props){super(props);if(props.constructed){}}
        render(){return this.props.visible&&this.props.title}
        componentDidUpdate(prevProps){if(prevProps.oldValue)this.props.updated}
      }`),
    "31": factory(`__webpack_require__.d(exports,{Base:()=>Base}); class Base {render(){return this.props.baseValue}}`),
  };

  expect(analyzeProps(factories, { Panel: ["30:Panel"] }).Panel).toEqual({
    props: ["baseValue", "constructed", "title", "updated", "visible"],
    notes: [],
  });
});

test("follows a unique Gaming Mode provider instead of the default component", () => {
  const factories = {
    "40": factory(`
      var hooks=__webpack_require__(41), jsx=__webpack_require__(42);
      __webpack_require__.d(exports,{Screen:()=>Screen});
      const Default=p=>p.defaultOnly;
      function Screen(props){const target=(0,hooks.useComponent)("Field",Default);return jsx.jsx(target,{...props})}`),
    "41": factory(""),
    "42": factory(""),
    "43": factory(`
      var jsx=__webpack_require__(42);
      function Game(p){return p.gameOnly}
      function Wrong(p){return p.wrongOnly}
      function Provider(){return jsx.jsx(context.Provider,{value:{Field:Game}})}
      function NotAProvider(){return jsx.jsx(Other,{value:{Field:Wrong}})}`),
  };

  expect(analyzeProps(factories, { SliderField: ["40:Screen"] }).SliderField).toEqual({
    props: ["gameOnly"],
    notes: [],
  });
});

test("reports ambiguous providers and does not merge candidate prop names", () => {
  const factories = {
    "50": factory(`
      var hooks=__webpack_require__(51), jsx=__webpack_require__(52);
      __webpack_require__.d(exports,{Screen:()=>Screen});
      const Default=p=>p.fallbackOnly;
      function Screen(props){const target=hooks.useComponent("Field",Default);return jsx.jsx(target,{...props})}`),
    "51": factory(""),
    "52": factory(""),
    "53": factory(`var jsx=__webpack_require__(52); function First(p){return p.firstOnly} function Provider(){return jsx.jsx(context.Provider,{value:{Field:First}})}`),
    "54": factory(`var jsx=__webpack_require__(52); function Second(p){return p.secondOnly} function Provider(){return jsx.jsx(context.Provider,{value:{Field:Second}})}`),
  };

  const surface = analyzeProps(factories, { SliderField: ["50:Screen"] }).SliderField;
  expect(surface.props).toEqual(["fallbackOnly"]);
  expect(surface.notes).toContain("ambiguous override providers for Field; followed fallback");
});

test("surfaces unsupported dynamic reads, helper use and unresolved render targets", () => {
  const factories = {
    "60": factory(`
      __webpack_require__.d(exports,{Root:()=>Root});
      function Root(props){const value=props[key];helper(props);return jsx(Missing,{...props,value})}`),
  };

  const surface = analyzeProps(factories, { DialogButton: ["60:Root"] }).DialogButton;
  expect(surface.props).toEqual([]);
  expect(surface.notes).toContain("dynamic prop access in module 60");
  expect(surface.notes).toContain("props passed to helper helper in module 60");
  expect(surface.notes.some((note) => note.includes("unresolved component target"))).toBe(true);
});

test("follows imported memo targets in their own module scope", () => {
  const factories = {
    "1": factory(`var React=__webpack_require__(4), child=__webpack_require__(2); __webpack_require__.d(exports,{Root:()=>Root}); const Root=React.memo(child.Child);`),
    "2": factory(`var leaf=__webpack_require__(3); __webpack_require__.d(exports,{Child:()=>Child}); function Child(props){return jsx(leaf.Leaf,{...props})}`),
    "3": factory(`__webpack_require__.d(exports,{Leaf:()=>Leaf}); function Leaf(props){helper(props.value);return props.forwarded}`),
    "4": factory(""),
  };
  expect(analyzeProps(factories, { Root: ["1:Root"] }).Root).toEqual({
    props: ["forwarded", "value"], notes: [],
  });
});
