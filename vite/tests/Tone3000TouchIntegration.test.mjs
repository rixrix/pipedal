import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { tone3000TouchLive, tone3000TouchStep, tone3000PitchPlugin, tone3000TouchPlugin } from "../src/pipedal/Tone3000TouchSettings.ts";
import { presentPatchNumber, rawPatchNumber, tone3000NumberPresentation } from "../src/pipedal/Tone3000ControlUnits.ts";
import { tone3000DraftNumber, tone3000FormatNumber, tone3000SameDraftNumber } from "../src/pipedal/Tone3000MobileLayout.ts";

const ts = createRequire(new URL("../package.json", import.meta.url))("typescript");
const read = name => readFileSync(new URL("../src/pipedal/" + name, import.meta.url), "utf8");
const parse = name => ts.createSourceFile(name, read(name), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const prefix = "https://www.tone3000.com/plugin:";

/** Execute the production lifecycle methods and real immediate-callback observable.
 * This fixture records setter dispatch; it cannot qualify an atomic daemon/MIDI race.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TOUCH-EDITOR] [7.27]
 */
function ownerFixture(uri = "https://www.tone3000.com/plugin") {
    const ast = parse("PluginControl.tsx");
    const names = ["inputContextKey", "touchCurrent", "removeTouchListeners", "closeTouchEditor", "openTouchEditor", "touchChange", "componentWillUnmount"];
    const methods = new Map();
    const visit = node => {
        if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(ast))) methods.set(node.name.getText(ast), node.getText(ast));
        ts.forEachChild(node, visit);
    };
    visit(ast); assert.equal(methods.size, names.length);
    const observableAst = parse("ObservableProperty.tsx");
    const observable = observableAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ObservableProperty");
    const context = { State: { Ready: 1 }, tone3000PitchPlugin, tone3000TouchPlugin };
    vm.runInNewContext(compile(observable.getText(observableAst).replace(/^export /, "")
        + "\nglobalThis.Property = ObservableProperty;\nglobalThis.Editor = class {" + [...methods.values()].join("\n") + "}"), context);
    const property = value => new context.Property(value), writes = [];
    const board = { selectedSnapshot: -1, tryGetItem: () => ({ uri }) };
    const model = { state: property(1), banks: property({ selectedBank: 6 }), presets: property({ selectedInstanceId: 26, presetChanged: false }),
        selectedSnapshot: property(-1), pedalboard: property(board) };
    const editor = new context.Editor();
    editor.props = { instanceId: 1, uiControl: { symbol: prefix + "inputLevel", min_value: -24, max_value: 24 },
        touchEdit: { ready: true, live: true, step: .1 }, onChange: value => writes.push(value) };
    editor.model = model; editor.state = { touchEditorOpen: false }; editor.touchSubscriptions = [];
    editor.setState = patch => Object.assign(editor.state, patch); editor.hideZoomedControl = () => {};
    const subscriptions = () => Object.values(model).reduce((count, value) => count + (value._on_changed_handlers?.length ?? 0), 0);
    return { editor, model, board, writes, subscriptions };
}

test("production Patch touch dispatch is live only when opted in; release-only, unavailable and invalid values obey guards", () => {
    const f = ownerFixture(); f.editor.openTouchEditor();
    assert.equal(f.editor.state.touchEditorOpen, true); assert.equal(f.subscriptions(), 5); assert.deepEqual(f.writes, []);
    f.editor.touchChange(-12.5, false); assert.deepEqual(f.writes, [-12.5]);
    f.editor.props.touchEdit.live = false; f.editor.touchChange(2, false); assert.deepEqual(f.writes, [-12.5]);
    f.editor.touchChange(2, true); assert.deepEqual(f.writes, [-12.5, 2]);
    for (const value of [NaN, Infinity, -Infinity, -25, 25]) f.editor.touchChange(value, true);
    f.editor.props.touchEdit.ready = false; f.editor.touchChange(3, true); assert.deepEqual(f.writes, [-12.5, 2]);
    f.editor.closeTouchEditor(); assert.equal(f.subscriptions(), 0); f.editor.touchChange(4, true); assert.equal(f.writes.length, 2);
});

/** Use real board cloning, ordinary-port setter and its synchronous publication.
 * Only network delivery and unrelated enabled-item UI listeners are sinks.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-27] [DES-PITCH-LV2] [7.36]
 */
function pitchOwnerFixture(uri) {
    const f = ownerFixture(uri), context = {};
    const stripped = name => parse(name).statements.filter(node => !ts.isImportDeclaration(node))
        .map(node => node.getText().replace(/^export default /, "").replace(/^export /, "")).join("\n");
    const ast = parse("PiPedalModel.tsx"), names = ["_setPedalboardControlValue", "setPedalboardControl", "setModelPedalboard", "removeInvalidSidechains", "previewPedalboardValue", "_setServerControl"];
    const methods = new Map();
    const visit = node => {
        if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(ast))) methods.set(node.name.getText(ast), node.getText(ast));
        ts.forEachChild(node, visit);
    };
    visit(ast); assert.equal(methods.size, names.length);
    vm.runInNewContext(compile(["PiPedalError.tsx", "MidiBinding.tsx", "MidiChannelBinding.tsx", "Pedalboard.tsx"].map(stripped).join("\n")
        + "\nglobalThis.Board = Pedalboard; globalThis.Item = PedalboardItem; globalThis.Control = ControlValue;"
        + "\nglobalThis.Model = class {" + [...methods.values()].join("\n") + "}"), context);
    const board = new context.Board(), item = new context.Item();
    item.instanceId = 1; item.uri = uri; item.controlValues = [new context.Control("semitones", 0), new context.Control("step", 1)];
    board.items = [item]; board.selectedSnapshot = -1; board.name = "Owner";
    f.model.pedalboard.set(board);
    for (const name of names) f.model[name] = context.Model.prototype[name];
    const messages = [];
    f.model.clientId = 12; f.model.webSocket = { send: (message, body) => messages.push({ message, ...body }) };
    f.model._controlValueChangeItems = []; f.model.updateEnabledItems = () => {};
    f.model.getUiPlugin = () => ({ getControl: () => ({ is_expensive: false }) });
    f.editor.props.uiControl = { symbol: "semitones", min_value: -24, max_value: 24 };
    f.editor.props.onPreviewChange = value => f.model.previewPedalboardValue(1, "semitones", value);
    f.editor.props.onChange = value => f.model.setPedalboardControl(1, "semitones", value);
    return { ...f, messages };
}

test("production original URI and exact mono/stereo pitch URIs are the only touch owners", () => {
    for (const uri of ["https://www.tone3000.com/plugin", "https://github.com/rixrix/pipedal/plugins/t3k-pitch#mono", "https://github.com/rixrix/pipedal/plugins/t3k-pitch#stereo"]) {
        const f = ownerFixture(uri); f.editor.openTouchEditor();
        assert.equal(f.editor.state.touchEditorOpen, true); assert.equal(f.subscriptions(), 5); f.editor.componentWillUnmount();
    }
    for (const uri of [undefined, "other-plugin", "https://github.com/rixrix/pipedal/plugins/t3k-pitch#unknown", "https://github.com/rixrix/pipedal/plugins/t3k-pitch#mono-extra"]) {
        const f = ownerFixture(uri); f.board.tryGetItem = () => ({ uri }); f.editor.openTouchEditor();
        assert.equal(f.editor.state.touchEditorOpen, false); assert.equal(f.subscriptions(), 0);
    }
});

test("actual ordinary pitch preview leaves the saved board intact; exact commit publication keeps editor open", () => {
    for (const uri of ["https://github.com/rixrix/pipedal/plugins/t3k-pitch#mono", "https://github.com/rixrix/pipedal/plugins/t3k-pitch#stereo"]) {
        const f = pitchOwnerFixture(uri); f.editor.openTouchEditor();
        const original = f.model.pedalboard.get();
        f.editor.touchChange(-7, false); f.editor.touchChange(-8, false);
        assert.equal(f.editor.state.touchEditorOpen, true); assert.equal(f.model.pedalboard.get(), original);
        assert.deepEqual(f.messages.map(message => [message.message, message.value]), [["previewControl", -7], ["previewControl", -8]]);
        f.editor.touchChange(-8, true);
        assert.equal(f.editor.state.touchEditorOpen, true); assert.equal(f.subscriptions(), 5);
        assert.equal(f.model.pedalboard.get().getItem(1).getControlValue("semitones"), -8);
        assert.equal(original.getItem(1).getControlValue("semitones"), 0, "commit clones rather than mutates the prior owner");
        assert.equal(f.messages.at(-1).message, "setControl"); assert.equal(f.messages.length, 3);
        assert.equal(f.editor.touchExpectedBoard, undefined, "owned publication allowance is consumed synchronously");
        f.model.pedalboard.set(f.model.pedalboard.get().clone());
        assert.equal(f.editor.state.touchEditorOpen, false, "even equal external board replacement retires the gesture outside commit");
        f.editor.touchChange(1, true); assert.equal(f.messages.length, 3); assert.equal(f.subscriptions(), 0);
    }
});

test("ordinary pitch commit cannot ignore foreign board, preset or duplicate publication inside its callback", () => {
    for (const mutation of ["board", "preset", "duplicate"]) {
        const f = pitchOwnerFixture("https://github.com/rixrix/pipedal/plugins/t3k-pitch#stereo"); f.editor.openTouchEditor();
        f.editor.props.onChange = value => {
            f.model.setPedalboardControl(1, "semitones", value);
            if (mutation === "preset") f.model.presets.set({ selectedInstanceId: 27, presetChanged: false });
            else {
                const board = f.model.pedalboard.get().clone();
                if (mutation === "board") board.output_volume_db = 3;
                f.model.pedalboard.set(board);
            }
        };
        f.editor.touchChange(-7, true);
        assert.equal(f.editor.state.touchEditorOpen, false, mutation); assert.equal(f.subscriptions(), 0);
        f.editor.touchChange(2, true); assert.equal(f.messages.length, 1);
    }
});

test("production immediate subscriptions retain dirty-only events and synchronously reject bank/preset/snapshot/connection A→B→A gestures", () => {
    const dirty = ownerFixture(); dirty.editor.openTouchEditor();
    dirty.model.presets.set({ selectedInstanceId: 26, presetChanged: true });
    assert.equal(dirty.editor.state.touchEditorOpen, true); dirty.editor.touchChange(1, false); assert.deepEqual(dirty.writes, [1]);
    dirty.editor.componentWillUnmount(); assert.equal(dirty.subscriptions(), 0);
    for (const type of ["bank", "preset", "snapshot", "connection"]) {
        const f = ownerFixture(); f.editor.openTouchEditor(); const oldGesture = value => f.editor.touchChange(value, true);
        if (type === "bank") { f.model.banks.set({ selectedBank: 7 }); f.model.banks.set({ selectedBank: 6 }); }
        if (type === "preset") { f.model.presets.set({ selectedInstanceId: 27 }); f.model.presets.set({ selectedInstanceId: 26 }); }
        if (type === "snapshot") {
            f.board.selectedSnapshot = 0; f.model.selectedSnapshot.set(0); f.board.selectedSnapshot = -1; f.model.selectedSnapshot.set(-1);
        }
        if (type === "connection") { f.model.state.set(0); f.model.state.set(1); }
        assert.equal(f.editor.touchContext, undefined, type); assert.equal(f.editor.state.touchEditorOpen, false, type);
        oldGesture(8); assert.deepEqual(f.writes, [], type); assert.equal(f.subscriptions(), 0, type);
    }
});

test("production full graph replacement invalidates same-ID edit and cleanup prevents later observable callbacks", () => {
    const f = ownerFixture(); f.editor.openTouchEditor();
    f.model.pedalboard.set({ ...f.board }); assert.equal(f.editor.state.touchEditorOpen, false); assert.equal(f.subscriptions(), 0);
    f.editor.touchChange(5, true); assert.deepEqual(f.writes, []);
    f.editor.openTouchEditor(); assert.equal(f.subscriptions(), 5); f.editor.componentWillUnmount();
    f.model.pedalboard.set({ ...f.board }); f.model.presets.set({ selectedInstanceId: 27 });
    f.editor.touchChange(5, true); assert.deepEqual(f.writes, []); assert.equal(f.subscriptions(), 0);
    const stopped = ownerFixture(); stopped.model.state.set(0); stopped.editor.openTouchEditor();
    assert.equal(stopped.subscriptions(), 0); assert.equal(stopped.editor.state.touchEditorOpen, false);
});

test("production stale DOM opening after plugin replacement neither opens nor retains immediate-callback subscriptions", () => {
    for (const item of [undefined, { uri: "other-plugin" }]) {
        const f = ownerFixture(); f.board.tryGetItem = () => item;
        f.editor.openTouchEditor(); assert.equal(f.editor.state.touchEditorOpen, false);
        assert.equal(f.editor.touchContext, undefined); assert.equal(f.subscriptions(), 0);
        f.editor.touchChange(4, true); assert.deepEqual(f.writes, []);
    }
});

test("production touch steps use dynamic pitch mode and release-only processing/coupled controls", () => {
    assert.equal(tone3000TouchStep(prefix + "pitchSemitones", -24, 24, false, true), 1);
    assert.equal(tone3000TouchStep(prefix + "pitchSemitones", -24, 24, false, false), .1);
    assert.equal(tone3000TouchStep(prefix + "unknown", 0, 10, true), 1);
    assert.equal(tone3000TouchStep(prefix + "inputLevel", -24, 24, false), .1);
    for (const name of ["calibrateInput", "inputCalibrationLevel", "osEnabled", "osFactor"]) assert.equal(tone3000TouchLive(prefix + name, false), false);
    assert.equal(tone3000TouchLive(prefix + "chainPanLeft", true), false);
    assert.equal(tone3000TouchLive(prefix + "inputLevel", false), true);
});

test("production physical slider adapters preserve native geometry and convert saved values only once", () => {
    const raw = { min_value: 0, max_value: 1, default_value: .5, valueToRange: value => Math.max(0, Math.min(1, value)),
        rangeToValue: range => range, formatDisplayValue: String, formatShortValue: String };
    const db = tone3000NumberPresentation(prefix + "inputLevel", 0, 1), shown = presentPatchNumber(raw, db);
    assert.equal(shown.min_value, -24); assert.equal(shown.max_value, 24); assert.equal(shown.rangeToValue(.5), 0);
    assert.equal(rawPatchNumber(-12, raw, db), .25); assert.equal(raw.default_value, .5); assert.equal(raw.min_value, 0);
    const hz = tone3000NumberPresentation(prefix + "spreadCrossover", 0, 1), frequency = presentPatchNumber(raw, hz);
    assert.equal(frequency.rangeToValue(.5), 130); assert.equal(frequency.valueToRange(130), .5);
    assert.equal(rawPatchNumber(130, raw, hz), .5);
    assert.throws(() => rawPatchNumber(NaN, raw, db), /finite/);
});

/** Execute actual NumberField JSX/hooks; the callback is only a local draft sink.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TOUCH-EDITOR] [7.27]
 */
function draftFixture() {
    const owner = ownerFixture(), ast = parse("Tone3000RigPanel.tsx");
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "NumberField");
    const slots = [], effects = [], pending = [], writes = []; let cursor = 0, tree, value = 0;
    let draftOwner = { enabled: true, scopeKey: "rig/revision/block" };
    const context = { State: { Ready: 1 }, DraftTouchContext: {}, PiPedalModelFactory: { getInstance: () => owner.model },
        tone3000DraftNumber, tone3000FormatNumber, tone3000SameDraftNumber,
        React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
        useMediaQuery: () => true, useContext: () => draftOwner,
        useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === "function" ? initial() : initial;
            return [slots[at], next => { slots[at] = typeof next === "function" ? next(slots[at]) : next; }]; },
        useRef(initial) { const at = cursor++; return slots[at] ??= { current: initial }; },
        useEffect(callback, deps) { const at = cursor++, before = effects[at];
            if (!before || deps.some((item, index) => !Object.is(item, before.deps[index])))
                pending.push(() => { before?.cleanup?.(); effects[at] = { deps, cleanup: callback() }; }); }
    };
    for (const declaration of ast.statements.filter(ts.isImportDeclaration)) if (declaration.importClause?.name)
        context[declaration.importClause.name.text] ??= declaration.importClause.name.text;
    vm.runInNewContext(compile(node.getText(ast) + "\nglobalThis.Field = NumberField;"), context);
    const render = () => { cursor = 0; tree = context.Field({ label: "Block gain", value, min: -24, max: 24, step: .1,
        onChange: next => { value = next; writes.push(next); } }); pending.splice(0).forEach(callback => callback()); return tree; };
    const nodes = node => node && typeof node === "object" && "type" in node
        ? [node, ...(node.props.children ?? []).flat(Infinity).flatMap(nodes)] : [];
    const find = type => nodes(tree).find(node => node.type === type);
    render(); render();
    return { writes, model: owner.model, render, find, subscriptions: owner.subscriptions,
        open() { find("Button").props.onClick(); render(); render(); return find("Tone3000TouchEditor").props; },
        owner(next) { draftOwner = next; render(); render(); },
        unmount() { effects.forEach(effect => effect?.cleanup?.()); } };
}

test("actual block NumberField touch writes local drafts only; disable, replacement and ownership changes reject retained callbacks", () => {
    const f = draftFixture(), dialog = f.open();
    assert.deepEqual(f.writes, []); assert.equal(f.subscriptions(), 5);
    dialog.onChange(-12); f.render(); assert.deepEqual(f.writes, [-12]);
    dialog.onCommit(-10); f.render(); assert.deepEqual(f.writes, [-12, -10]);
    f.owner({ enabled: false, scopeKey: "rig/revision/block" }); dialog.onChange(3); assert.deepEqual(f.writes, [-12, -10]);
    assert.equal(f.find("Button").props.disabled, true); f.unmount(); assert.equal(f.subscriptions(), 0);
    for (const type of ["preset", "board", "revision", "disconnect"]) {
        const other = draftFixture(), old = other.open();
        if (type === "preset") { other.model.presets.set({ selectedInstanceId: 27 }); other.model.presets.set({ selectedInstanceId: 26 }); }
        if (type === "board") other.model.pedalboard.set({ ...other.model.pedalboard.get() });
        if (type === "revision") other.owner({ enabled: true, scopeKey: "rig/new-revision/block" });
        if (type === "disconnect") { other.model.state.set(0); other.model.state.set(1); }
        old.onChange(4); old.onCommit(5); assert.deepEqual(other.writes, [], type);
        other.render(); other.unmount(); assert.equal(other.subscriptions(), 0, type);
    }
});

/** Read the actual adapter through deterministic hooks and delayed RPC replies.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TOUCH-EDITOR] [7.27]
 */
function patchFixture(id = "inputLevel", presentation = tone3000NumberPresentation(prefix + "inputLevel", 0, 1)) {
    const owner = ownerFixture(), ast = parse("PatchPropertyControl.tsx");
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "PatchPropertyControl");
    const slots = [], effects = [], pending = [], requests = [], writes = [], alerts = [], monitors = new Map();
    let cursor = 0, serial = 0, tree;
    const raw = { min_value: id === "pitchSemitones" ? -24 : 0, max_value: id === "pitchSemitones" ? 24 : 1,
        default_value: 0, integer_property: false, is_expensive: false, symbol: prefix + id,
        valueToRange(value) { return Math.max(0, Math.min(1, (value - this.min_value) / (this.max_value - this.min_value))); },
        rangeToValue(range) { return this.min_value + range * (this.max_value - this.min_value); },
        formatDisplayValue: String, formatShortValue: String };
    owner.model.getPatchProperty = (_instanceId, uri) => new Promise(resolve => requests.push({ uri, resolve }));
    owner.model.monitorPatchProperty = (_instanceId, uri, callback) => { const handle = ++serial; monitors.set(handle, { uri, callback }); return handle; };
    owner.model.cancelMonitorPatchProperty = handle => monitors.delete(handle);
    owner.model.setPatchProperty = (_instanceId, uri, value) => { writes.push({ uri, value }); return Promise.resolve(true); };
    owner.model.showAlert = message => alerts.push(message);
    const context = { State: { Ready: 1 }, PluginControl: "PluginControl", PiPedalModelFactory: { getInstance: () => owner.model },
        presentPatchNumber, rawPatchNumber, tone3000TouchLive, tone3000TouchStep, console: { error() {} },
        React: { createElement: (type, props) => ({ type, props }) },
        useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = initial;
            return [slots[at], next => { slots[at] = typeof next === "function" ? next(slots[at]) : next; }]; },
        useRef(initial) { const at = cursor++; return slots[at] ??= { current: initial }; },
        useMemo(callback, deps) { const at = cursor++, prior = slots[at];
            if (!prior || deps.some((item, index) => !Object.is(item, prior.deps[index]))) slots[at] = { deps, value: callback() };
            return slots[at].value; },
        useEffect(callback, deps) { const at = cursor++, before = effects[at];
            if (!before || deps.some((item, index) => !Object.is(item, before.deps[index])))
                pending.push(() => { before?.cleanup?.(); effects[at] = { deps, cleanup: callback() }; }); }
    };
    vm.runInNewContext(compile(node.getText(ast).replace(/^export default /, "") + "\nglobalThis.Adapter = PatchPropertyControl;"), context);
    const props = { instanceId: 1, uniformLayout: true, numberPresentation: presentation,
        property: { uri: prefix + id, readable: true, writable: true, toUiControl: () => raw } };
    const render = () => { cursor = 0; tree = context.Adapter(props); pending.splice(0).forEach(callback => callback()); return tree.props; };
    render(); render();
    return { model: owner.model, requests, writes, alerts, props, render,
        monitor(uri, value) { for (const entry of [...monitors.values()]) if (entry.uri === prefix + uri) entry.callback(1, entry.uri, value); },
        unmount() { effects.forEach(effect => effect?.cleanup?.()); assert.equal(monitors.size, 0); assert.equal(owner.subscriptions(), 0); } };
}

test("actual Patch adapter waits for finite authoritative readback and discards old selection/reconnect replies", async () => {
    const f = patchFixture(); assert.equal(f.render().touchEdit.ready, false, "default is not an observed plugin value");
    assert.deepEqual(f.writes, []); const stale = f.requests[0];
    f.monitor("inputLevel", NaN); assert.equal(f.render().touchEdit.ready, false);
    f.monitor("inputLevel", .25); assert.equal(f.render().touchEdit.ready, true); assert.equal(f.render().value, -12);
    f.render().onChange(-6); await Promise.resolve(); assert.deepEqual(f.writes, [{ uri: prefix + "inputLevel", value: .375 }]);
    f.model.state.set(0); f.render(); f.render(); assert.equal(f.render().touchEdit.ready, false);
    f.model.state.set(1); f.render(); f.render();
    stale.resolve(.9); await Promise.resolve(); assert.equal(f.render().touchEdit.ready, false, "old reply cannot authorize new connection");
    const latest = f.requests.at(-1); latest.resolve(.5); await Promise.resolve();
    assert.equal(f.render().touchEdit.ready, true); assert.equal(f.render().value, 0);
    f.model.presets.set({ selectedInstanceId: 27 }); f.model.presets.set({ selectedInstanceId: 26 });
    f.render(); f.render(); assert.equal(f.render().touchEdit.ready, false, "A→B→A still requires fresh readback");
    f.unmount();
});

test("actual Patch adapter requires authoritative pitchStep and follows mode changes without writing a snap", async () => {
    const f = patchFixture("pitchSemitones", null);
    f.monitor("pitchSemitones", -1.25); assert.equal(f.render().touchEdit.ready, false);
    f.monitor("pitchStep", 1); assert.equal(f.render().touchEdit.ready, true); assert.equal(f.render().touchEdit.step, 1);
    f.monitor("pitchStep", 0); assert.equal(f.render().touchEdit.step, .1); assert.deepEqual(f.writes, []);
    const oldPitch = f.requests.find(request => request.uri === prefix + "pitchStep");
    f.model.pedalboard.set({ ...f.model.pedalboard.get() }); f.render(); f.render();
    oldPitch.resolve(1); await Promise.resolve(); assert.equal(f.render().touchEdit.ready, false);
    f.monitor("pitchSemitones", 25); f.monitor("pitchStep", 1); assert.equal(f.render().touchEdit.ready, false, "out-of-contract numeric readback does not authorize editing");
    f.monitor("pitchSemitones", 2); assert.equal(f.render().touchEdit.ready, true); assert.deepEqual(f.writes, []);
    f.unmount();
});

test("actual Patch write failure alerts and refreshes only its owner without duplicating coupled alerts", async () => {
    const settled = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
    const f = patchFixture(); f.monitor("inputLevel", .5); f.render();
    f.model.setPatchProperty = () => Promise.reject(Error("rejected"));
    const before = f.requests.length; f.render().onChange(-12); await settled();
    assert.equal(f.alerts.length, 1); assert.match(f.alerts[0], /could not be applied/);
    assert.equal(f.requests.length, before + 1, "same-owner failure refreshes the authoritative value");
    f.requests.at(-1).resolve(.5); await settled(); assert.equal(f.render().value, 0);
    let reject;
    f.model.setPatchProperty = () => new Promise((_resolve, fail) => { reject = fail; });
    f.render().onChange(-6); const count = f.requests.length;
    f.model.presets.set({ selectedInstanceId: 27 }); reject(Error("old owner rejected")); await settled();
    assert.equal(f.alerts.length, 1); assert.equal(f.requests.length, count, "obsolete rejection neither alerts nor reads another rig");
    f.render(); f.render(); f.unmount();
    const coupled = patchFixture(); coupled.monitor("inputLevel", .5);
    coupled.props.onRawSet = () => Promise.reject(Error("coupled wrapper already reports this"));
    coupled.render().onChange(-12); await settled(); assert.deepEqual(coupled.alerts, []);
    coupled.unmount();
});
