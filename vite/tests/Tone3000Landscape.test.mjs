import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { tone3000ViewportStyles } from "../src/pipedal/Tone3000MobileLayout.ts";

const require = createRequire(new URL("../package.json", import.meta.url)), ts = require("typescript");
const parse = name => ts.createSourceFile(name, readFileSync(new URL("../src/pipedal/" + name, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const members = ast => {
    let result;
    const visit = node => { if (ts.isClassExpression(node)) result = node.members; else ts.forEachChild(node, visit); };
    visit(ast); return result;
};
const nodes = node => node && typeof node === "object" && "type" in node
    ? [node, ...(node.props.children ?? []).flat(Infinity).flatMap(nodes)] : [];
const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
const compile = (ast, names, context) => {
    const selected = members(ast).filter(node => names.includes(node.name?.getText(ast))).map(node => node.getText(ast)).join("\n");
    for (const item of ast.statements.filter(ts.isImportDeclaration)) if (item.importClause?.name)
        context[item.importClause.name.text] ??= item.importClause.name.text;
    vm.runInNewContext(ts.transpileModule("class Subject { " + selected + " }\nglobalThis.Subject = Subject;", {
        compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
    return new context.Subject();
};
const classes = new Proxy({}, { get: (_object, name) => String(name) });

/** Run actual host JSX/handlers; no model writer is supplied to the view toggle.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-LANDSCAPE] [7.38]
 */
function mainFixture(uri = "https://www.tone3000.com/plugin") {
    const editor = { type: "OwnerEditor", props: { children: [], draft: "kept" } };
    const item = { uri, instanceId: 10, isEnabled: true, isEmpty: () => false, isStart: () => false, isEnd: () => false, isSplit: () => false };
    const context = { React: react, withStyles: { getClasses: () => classes }, tone3000ViewportStyles,
        SPLIT_CONTROLBAR_THRESHHOLD: 750, isDarkMode: () => true, GetControlView: () => editor };
    const host = compile(parse("MainPage.tsx"), ["render"], context);
    host.props = { enableStructureEditing: true, hasTinyToolBar: false, theme: { palette: { text: { primary: "white" } } } };
    host.state = { tone3000ChainOnly: false, selectedPedal: 10, screenHeight: 344, horizontalScrollLayout: true, splitControlBar: false };
    host.windowSize = { width: 904, height: 344 };
    host.model = { pedalboard: { get: () => ({ canDeleteItem: () => true }) }, getUiPlugin: () => ({ uri }) };
    host.getSelectedPedalboardItem = () => item; host.canShowModUi = () => false;
    host.titleBar = () => null; host.snapshotIcon = () => null;
    host.setState = value => Object.assign(host.state, value);
    const render = () => nodes(host.render());
    const controls = tree => tree.find(node => node.props.id === "mainPageControls");
    const board = tree => tree.find(node => node.type === "PedalboardView");
    const toggle = tree => tree.find(node => node.type === "ButtonEx" && /Show (chain only|controls)/.test(node.props["aria-label"] ?? ""));
    const resize = (width, height) => { host.windowSize = { width, height }; host.state.screenHeight = height; host.state.horizontalScrollLayout = height < 500; };
    return { host, render, controls, board, toggle, editor, resize };
}

test("actual landscape toggle hides rather than removes editor and keeps read-only chain plus return action", () => {
    const f = mainFixture(); let tree = f.render();
    assert.equal(f.controls(tree).props.hidden, false); assert.equal(f.board(tree).props.readOnly, false);
    assert.equal(f.board(tree).props.selectedId, 10);
    f.toggle(tree).props.onClick(); tree = f.render();
    assert.equal(f.controls(tree).props.hidden, true); assert.ok(tree.includes(f.editor), "same editor remains in the host tree");
    assert.equal(f.board(tree).props.readOnly, true); assert.equal(f.board(tree).props.enableStructureEditing, false);
    assert.equal(f.board(tree).props.selectedId, undefined); assert.equal(f.toggle(tree).props["aria-label"], "Show controls");
    f.toggle(tree).props.onClick(); tree = f.render();
    assert.equal(f.controls(tree).props.hidden, false); assert.ok(tree.includes(f.editor)); assert.equal(f.editor.props.draft, "kept");
    assert.equal(f.host.state.selectedPedal, 10, "view toggle never changes selected instance");
});

test("actual chain preference survives portrait rotation and remains usable around a non-T3K host effect", () => {
    const f = mainFixture("urn:ordinary:delay"); f.toggle(f.render()).props.onClick();
    f.resize(344, 794); let tree = f.render();
    assert.equal(f.toggle(tree), undefined); assert.equal(f.controls(tree).props.hidden, false);
    assert.equal(f.board(tree).props.readOnly, false); assert.equal(f.host.state.tone3000ChainOnly, true);
    f.resize(829, 690); tree = f.render();
    assert.equal(f.controls(tree).props.hidden, true); assert.equal(f.board(tree).props.readOnly, true);
    assert.equal(f.toggle(tree).props["aria-label"], "Show controls"); assert.ok(tree.includes(f.editor));
});

/** Exercise production host rendering and event guards with captured embedded geometry.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-LANDSCAPE] [7.38]
 */
function boardFixture(readOnly) {
    const captures = { 10: { summary: { blocks: [], stereoEnabled: false, activePresetName: "Saved rig" } } }, observed = [], actions = [];
    const context = { React: react, withStyles: { getClasses: () => classes }, Tone3000ChainView: "Tone3000ChainView",
        PedalLayout: { Start: () => ({}), End: () => ({}) }, chainIterator: values => values[Symbol.iterator](),
        makeChain: (...args) => { observed.push(args); return []; } };
    const host = compile(parse("PedalboardView.tsx"), ["render", "renderChain", "isReadOnly", "setSelection", "onItemClick", "onItemDoubleClick", "onItemLongClick"], context);
    host.props = { readOnly, tone3000Chains: captures, selectedId: 10, enableStructureEditing: true,
        onSelectionChanged: id => actions.push(["select", id]), onDoubleClick: id => actions.push(["double", id]),
        onTone3000ParentClick: () => actions.push(["parent"]), onTone3000BlockClick: (id, block) => actions.push([id, block]) };
    host.state = { pedalboard: { items: [] } }; host.model = {};
    host.renderConnectorFrame = () => null; host.doLayout = () => ({ width: 800, height: 160 });
    const inline = { tone3000Inline: true, pedalItem: { instanceId: 10, isEnabled: true }, tone3000Chain: captures[10],
        bounds: { x: 0, y: 0, width: 800, height: 160 } };
    return { host, captures, observed, actions, inline };
}

test("actual live read-only renderer retains T3K captures, while synthetic previews stay isolated", () => {
    const f = boardFixture(true); f.host.render();
    assert.equal(f.observed[0][3], f.captures);
    f.host.props.displayBoard = { items: [] }; f.host.render(); assert.equal(f.observed[1][3], undefined);
});

test("actual read-only inline and host interaction paths cannot select or open controls; editing still works", () => {
    const f = boardFixture(true), event = { preventDefault() {}, stopPropagation() {} };
    const diagram = () => nodes({ type: "result", props: { children: f.host.renderChain([f.inline], {}) } })
        .find(node => node.type === "Tone3000ChainView");
    assert.equal(diagram().props.onBlockClick, undefined); diagram().props.parent.onClick();
    f.host.onItemClick(event, 10); f.host.onItemDoubleClick(event, 10); f.host.onItemLongClick(event, 10);
    assert.deepEqual(f.actions, []);
    f.host.props.readOnly = false; diagram().props.parent.onClick(); diagram().props.onBlockClick("amp");
    assert.deepEqual(f.actions, [["select", 10], ["parent"], ["select", 10], [10, "amp"]]);
});
