import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { tone3000BankLocation, tone3000FilterLibrary } from "../src/pipedal/Tone3000Library.ts";

const ts = createRequire(new URL("../package.json", import.meta.url))("typescript");
const read = name => readFileSync(new URL("../src/pipedal/" + name, import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 10; ++i) await Promise.resolve(); };
const children = node => node?.props?.children?.flat(Infinity) ?? [];
const nodes = node => node && typeof node === "object" && "type" in node ? [node, ...children(node).flatMap(nodes)] : [];
const target = (bankId, presetId, active = false, sha256 = "source") => ({ bankId, presetId, instanceId: 3,
    active, sha256, name: "Saved " + presetId, hasSnapshotOverrides: false });
const source = (key, imports = []) => ({ key, name: key, source: "Pi app", sha256: "source", imports });
const entries = [source("changed", [target(6, 20, false, "old"), target(8, 90)]), source("new"),
    source("current", [target(6, 21, true)]), source("other", [target(99, 22)])];
const banks = { selectedBank: 6, entries: [{ instanceId: 6, name: "TONE3000 Rx" }, { instanceId: 8, name: "Spare rigs" }] };

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-11] [DES-FOUR-REFINEMENTS] [7.30] */
test("actual filter helper combines saved/new/update status and bank search without mutating target identities", () => {
    const before = structuredClone(entries);
    assert.deepEqual(tone3000FilterLibrary(entries, "all", "", banks).map(entry => entry.key), ["changed", "new", "current", "other"]);
    assert.deepEqual(tone3000FilterLibrary(entries, "saved", "", banks).map(entry => entry.key), ["current", "changed", "other"]);
    assert.deepEqual(tone3000FilterLibrary(entries, "new", "", banks).map(entry => entry.key), ["new"]);
    assert.deepEqual(tone3000FilterLibrary(entries, "updates", "", banks).map(entry => entry.key), ["changed"]);
    assert.deepEqual(tone3000FilterLibrary(entries, "saved", " spare RIGS ", banks).map(entry => entry.key), ["changed"]);
    assert.deepEqual(tone3000FilterLibrary(entries, "updates", "Saved 90", banks).map(entry => entry.key), ["changed"]);
    assert.deepEqual(tone3000FilterLibrary(entries, "new", "TONE3000 Rx", banks), []);
    assert.equal(tone3000BankLocation(99, banks), "Bank 99 (name unavailable)");
    assert.equal(tone3000BankLocation(6, { entries: [] }), "Bank 6 (name unavailable)");
    assert.equal(tone3000FilterLibrary(entries, "saved", "", banks)[1], entries[0]);
    assert.equal(tone3000FilterLibrary(entries, "saved", "", banks)[1].imports[1], entries[0].imports[1]);
    assert.deepEqual(entries, before);
});

/** Run production dialog/observable code; only service replies and DOM are controlled.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-11] [DES-FOUR-REFINEMENTS] [7.30]
 */
function fixture() {
    const slots = [], effects = [], pending = [], writes = []; let cursor = 0, tree, value = { entries, warnings: [] };
    const context = { tone3000BankLocation, tone3000FilterLibrary, console, State: { Ready: 1, Reconnecting: 2 },
        window: { setInterval: () => 1, clearInterval() {} }, React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
        useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = initial;
            return [slots[at], value => { slots[at] = typeof value === "function" ? value(slots[at]) : value; }]; },
        useRef(initial) { const at = cursor++; return slots[at] ??= { current: initial }; },
        useCallback(callback, deps) { const at = cursor++; const prior = slots[at];
            if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) slots[at] = { callback, deps }; return slots[at].callback; },
        useEffect(callback, deps) { const at = cursor++, prior = effects[at];
            if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) pending.push(() => { prior?.cleanup?.(); effects[at] = { deps, cleanup: callback() }; }); }
    };
    const observable = ts.createSourceFile("Observable.tsx", read("ObservableProperty.tsx"), ts.ScriptTarget.Latest, true);
    const compile = code => vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
    const observableClass = observable.statements.find(ts.isClassDeclaration);
    compile(observableClass.getText(observable).replace(/^export /, "") + "\nglobalThis.ObservableProperty = ObservableProperty;");
    const model = { banks: new context.ObservableProperty(banks), state: new context.ObservableProperty(1),
        presets: new context.ObservableProperty({ presetChanged: false }), getTone3000Library: async () => value,
        importTone3000Preset: async (...args) => writes.push(args), loadTone3000Preset: async (...args) => writes.push(args), showAlert() {} };
    context.PiPedalModelFactory = { getInstance: () => model };
    const ast = ts.createSourceFile("Library.tsx", read("Tone3000LibraryDialog.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const item of ast.statements.filter(ts.isImportDeclaration)) if (item.importClause?.name) context[item.importClause.name.text] = item.importClause.name.text;
    const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "Tone3000LibraryDialog");
    compile(component.getText(ast).replace(/^export default /, "") + "\nglobalThis.render = Tone3000LibraryDialog;");
    const render = () => { cursor = 0; tree = context.render({ open: true, onClose() {} }); pending.splice(0).forEach(callback => callback()); return tree; };
    render();
    return { model, writes, render, all: () => nodes(tree),
        cards: () => nodes(tree).filter(node => node.type === "Paper").map(node => node.props.key),
        button: label => nodes(tree).find(node => node.type === "Button" && children(node).includes(label)),
        setLibrary(next) { value = next; }, cleanup() { effects.forEach(effect => effect?.cleanup?.()); } };
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-11] [DES-FOUR-REFINEMENTS] [7.30] */
test("production Library filters observe bank renames, preserve refresh selection and exact compare/update/load targets", async () => {
    const f = fixture(); await flush(); f.render();
    f.button("Saved").props.onClick(); f.render(); assert.deepEqual(f.cards(), ["current", "changed", "other"]);
    const field = () => f.all().find(node => node.type === "TextField");
    field().props.onChange({ target: { value: "Rx" } }); f.render(); assert.deepEqual(f.cards(), ["current", "changed"]);
    f.model.banks.set({ ...banks, entries: [{ instanceId: 6, name: "Stage set" }, ...banks.entries.slice(1)] }); f.render();
    assert.deepEqual(f.cards(), []); assert.equal(field().props.value, "Rx");
    field().props.onChange({ target: { value: "Stage" } }); f.render();
    assert.deepEqual(f.cards(), ["current", "changed"]);
    assert.ok(f.all().some(node => node.type === "Typography" && children(node).includes("Stage set")));
    f.setLibrary({ entries: [...entries].reverse(), warnings: [] }); f.button("Refresh").props.onClick(); await flush(); f.render();
    assert.equal(f.button("Saved").props["aria-pressed"], true); assert.equal(field().props.value, "Stage");
    assert.deepEqual(f.cards(), ["current", "changed"]); assert.deepEqual(f.writes, []);
    f.button("Compare with source").props.onClick(); f.render();
    const preview = () => f.all().find(node => node.type === "Tone3000PresetPreviewDialog");
    assert.equal(preview().props.selection.entry, entries[2]); assert.equal(preview().props.selection.target, entries[2].imports[0]);
    f.button("Load").props.onClick(); await flush(); f.render(); assert.deepEqual(f.writes[0], [6, 21]);
    f.button("Updates").props.onClick(); field().props.onChange({ target: { value: "" } }); f.render();
    f.button("Update").props.onClick(); f.render();
    assert.equal(preview().props.selection.target, entries[0].imports[0]); assert.equal(preview().props.selection.action, "update");
    preview().props.onConfirm(preview().props.selection); await flush(); f.render();
    assert.equal(f.writes[1][0], entries[0]); assert.equal(f.writes[1][1], entries[0].imports[0]);
    f.cleanup();
    const before = f.cards(); f.model.banks.set({ selectedBank: -1, entries: [] }); f.render(); assert.deepEqual(f.cards(), before, "unmounted bank subscription has been removed");
});
