import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript"), { build } = require("esbuild");
const path = name => fileURLToPath(new URL("../src/pipedal/" + name, import.meta.url));
const compiled = async name => (await build({ entryPoints: [path(name)], bundle: true, write: false,
    platform: "node", format: "cjs", logLevel: "silent" })).outputFiles[0].text;
const modules = await Promise.all(["ObservableProperty.tsx", "Tone3000Rig.ts", "Tone3000EditState.ts", "Tone3000BlockLiveEdit.ts"].map(compiled));
const ast = ts.createSourceFile("panel.tsx", readFileSync(path("Tone3000RigPanel.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const nodes = node => node && typeof node === "object" && "type" in node
    ? [node, ...(node.props.children ?? []).flat(Infinity).flatMap(nodes)] : [];

/** Execute the complete production panel and its real observable hook/handlers.
 * Deterministic hooks/RPCs exercise ownership and acknowledgements, not browser layout.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOUR-REFINEMENTS] [7.29]
 */
function fixture(section = "Blocks", share = null) {
    const slots = [], effects = [], pending = [], timers = new Map(), reads = [], saves = [], writes = [], getQueue = [];
    let cursor = 0, changed = false, tree, serial = 0, now = 0;
    let props = { instanceId: 1, section, active: true };
    const context = { module: { exports: {} }, exports: {}, State: { Ready: 1 }, DraftTouchContext: { Provider: "DraftProvider" },
        rowStyle: {}, fieldGridStyle: {}, blockGridStyle: {}, console,
        React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
        useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === "function" ? initial() : initial;
            return [slots[at], next => { const value = typeof next === "function" ? next(slots[at]) : next;
                if (!Object.is(slots[at], value)) { slots[at] = value; changed = true; } }]; },
        useRef(initial) { const at = cursor++; return slots[at] ??= { current: initial }; },
        useCallback(callback, deps) { const at = cursor++, before = slots[at];
            if (!before || deps.some((value, index) => !Object.is(value, before.deps[index]))) slots[at] = { deps, callback };
            return slots[at].callback; },
        useEffect(callback, deps) { const at = cursor++, before = effects[at];
            if (!before || deps.some((value, index) => !Object.is(value, before.deps[index])))
                pending.push(() => { before?.cleanup?.(); effects[at] = { deps }; effects[at].cleanup = callback(); }); }
    };
    context.window = {
        setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, when: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); }, setInterval(callback) { const id = ++serial; timers.set(id, { callback, interval: true }); return id; },
        clearInterval(id) { timers.delete(id); }
    };
    for (const code of modules) {
        context.module = { exports: {} }; context.exports = context.module.exports;
        vm.runInNewContext(code, context); Object.assign(context, context.module.exports);
    }
    const property = value => new context.ObservableProperty(value);
    const block = { blockId: "amp", lane: "left", index: 0, type: "nam", title: "Amp", gear: "amp", format: "nam",
        activeModelId: 7, enabled: true, normalize: true, capabilityUnknown: true, slimSize: 1, inputGain: .5, outputGain: .5, mix: 1,
        eq: { enabled: false, pre: false, bands: [{ type: "bell", freqHz: 1000, gainDb: 0, q: 1 }] } };
    const current = { revision: "original", instanceId: 1, followDefaults: false, hasSnapshotOverrides: false,
        summary: { activePresetId: "user:rig", activePresetName: "Rig", inputMode: "left", calibrateInput: false, inputCalibrationLevel: 0,
            osEnabled: false, osFactor: 0, stereoEnabled: false, branchSide: "left", branchAfterBlockId: "", blocks: [block] } };
    const defaults = { multiCore: false, namSlimSizeDefault: 1, calibrateInput: false, inputCalibrationLevel: 0, osEnabled: false, osFactor: 0 };
    const profile = { revision: "profile-original", activeProfile: "live", defaults,
        profiles: [{ id: "live", name: "Live", defaults }, { id: "home", name: "Home", defaults: { ...defaults } }], sourceStatus: "service-profile", warnings: [] };
    let currentValue = current;
    const model = share?.model ?? { state: property(1), banks: property({ selectedBank: 6 }), presets: property({ selectedInstanceId: 26, presetChanged: false }),
        selectedSnapshot: property(-1), pedalboard: property({ tryGetItem: () => ({ uri: "https://www.tone3000.com/plugin" }) }),
        getTone3000CurrentState: () => { reads.push(true); return getQueue.length ? getQueue.shift().promise : Promise.resolve(currentValue); },
        getTone3000Defaults: () => Promise.resolve(profile), getJackStatus: () => Promise.resolve({}),
        saveCurrentPreset: () => { saves.push(true); },
        setTone3000CurrentState: (...args) => { const pending = deferred(); writes.push({ args, pending }); return pending.promise; },
        setTone3000Defaults: (...args) => { const pending = deferred(); writes.push({ args, pending }); return pending.promise; }
    };
    if (share) context.tone3000EditDrafts = share.registryFactory;
    context.PiPedalModelFactory = { getInstance: () => model };
    for (const item of ast.statements.filter(ts.isImportDeclaration)) if (item.importClause?.name)
        context[item.importClause.name.text] ??= item.importClause.name.text;
    Object.assign(context, { BlockCard: "BlockCard", ProcessingFields: "ProcessingFields", SystemSettings: "SystemSettings" });
    vm.runInNewContext(ts.transpileModule(declaration("useHostValue") + "\n" + declaration("Tone3000RigPanel").replace(/^export default /, "")
        + "\nglobalThis.Panel = Tone3000RigPanel;", { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
    const render = () => {
        let rounds = 0;
        do { changed = false; cursor = 0; tree = context.Panel(props); pending.splice(0).forEach(callback => callback());
            assert.ok(++rounds < 30, "production hooks must settle"); } while (changed);
        return tree;
    };
    const flush = async () => { for (let i = 0; i < 12; ++i) { await Promise.resolve(); render(); } };
    render();
    return { model, current, block, profile, reads, saves, writes, flush, render, registryFactory: context.tone3000EditDrafts,
        all: () => nodes(tree), button: label => nodes(tree).find(node => node.type === "Button" && (node.props["aria-label"] === label || (node.props.children ?? []).flat(Infinity).includes(label))),
        field: label => nodes(tree).find(node => node.props.label === label),
        blockControl: () => nodes(tree).find(node => node.type === "BlockCard"),
        processing: () => nodes(tree).find(node => node.type === "ProcessingFields"),
        status: () => nodes(tree).find(node => node.props.role === "status").props.children.join(""),
        helper: context.tone3000DraftEqual,
        dirty(value = true) { model.presets.set({ ...model.presets.get(), presetChanged: value }); render(); },
        setCurrent(value) { currentValue = value; },
        holdRead() { const value = deferred(); getQueue.push(value); return value; },
        tick() { for (const value of [...timers.values()]) if (value.interval) value.callback(); },
        advance(ms) { now += ms; for (const [id, value] of [...timers]) if (!value.interval && value.when <= now) { timers.delete(id); value.callback(); } },
        unmount(assertClean = true) { effects.forEach(effect => effect?.cleanup?.());
            if (assertClean) for (const value of Object.values(model)) if (value?._on_changed_handlers) assert.equal(value._on_changed_handlers.length, 0);
            assert.equal(timers.size, 0); },
        update(next) { props = { ...props, ...next }; render(); }
    };
}

test("real draft comparison never erases NaN/infinity, including identical nested objects", async () => {
    const f = fixture(); await f.flush();
    for (const value of [NaN, Infinity, -Infinity]) { const same = { blocks: [{ gain: value }] }; assert.equal(f.helper(same, same), false); }
    assert.equal(f.helper({ x: .3 }, { x: .1 + .2 }), true); assert.equal(f.helper({ x: 1 }, { x: 1.01 }), false);
    f.unmount();
});

test("actual panel Restore of all block/EQ drafts clears unapplied status without Apply or Save", async () => {
    const f = fixture(); await f.flush(); assert.match(f.status(), /^Saved/);
    const edited = structuredClone(f.block); edited.mix = .8; edited.eq.bands[0].q = NaN;
    f.blockControl().props.onStaged(edited); f.render(); assert.match(f.status(), /Unapplied/);
    assert.equal(f.button("Apply block changes").props.disabled, true); assert.equal(f.button("Save preset").props.disabled, true);
    f.blockControl().props.onStaged(structuredClone(f.block)); f.render();
    assert.match(f.status(), /^Saved/); assert.equal(f.button("Apply block changes").props.disabled, true);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.saves, []); f.unmount();
});

test("actual settings and global profile drafts restore independently to accepted fields and profile identity", async () => {
    const f = fixture("Settings"); await f.flush();
    f.processing().props.onChange({ inputCalibrationLevel: NaN }); f.render(); assert.match(f.status(), /Unapplied/);
    f.processing().props.onChange({ inputCalibrationLevel: 0 }); f.render(); assert.match(f.status(), /^Saved/);
    f.field("Processing policy").props.onChange({ target: { value: "follow" } }); f.render(); assert.match(f.status(), /Unapplied/);
    f.field("Processing policy").props.onChange({ target: { value: "saved" } }); f.render(); assert.match(f.status(), /^Saved/);
    f.field("Processing profile").props.onChange({ target: { value: "home" } }); f.render(); assert.equal(f.button("Save defaults").props.disabled, false);
    f.field("Processing profile").props.onChange({ target: { value: "live" } }); f.render(); assert.equal(f.button("Save defaults").props.disabled, true);
    assert.deepEqual(f.saves, []); assert.deepEqual(f.writes, []); f.unmount();
});

test("actual Save waits for fresh capture and authoritative whole-preset dirty clearing, not optimistic success", async () => {
    const f = fixture(); await f.flush(); f.dirty(); assert.match(f.status(), /not saved/);
    const read = f.holdRead(); f.button("Save preset").props.onClick(); f.render(); assert.equal(f.saves.length, 0); assert.match(f.status(), /Saving preset/);
    read.resolve(f.current); await f.flush(); assert.equal(f.saves.length, 1); assert.match(f.status(), /Saving preset/);
    assert.equal(f.button("Save preset").props.disabled, true);
    f.dirty(false); await f.flush(); assert.match(f.status(), /^Saved/); assert.equal(f.button("Save preset").props.disabled, true);
    assert.equal(f.writes.length, 0); f.unmount();
});

test("actual Save failure/timeout retains unsaved state and never retries or invents Saved", async () => {
    const f = fixture(); await f.flush(); f.dirty();
    f.button("Save preset").props.onClick(); await f.flush(); f.advance(10000); await f.flush();
    assert.match(f.status(), /not saved/); assert.equal(f.saves.length, 1);
    assert.ok(f.all().some(node => node.type === "Alert" && String(node.props.children).includes("not been confirmed")));
    f.model.saveCurrentPreset = () => { throw Error("save failed"); };
    f.button("Save preset").props.onClick(); await f.flush(); assert.match(f.status(), /not saved/);
    assert.ok(f.all().some(node => node.type === "Alert" && String(node.props.children).includes("save failed"))); f.unmount();
});

test("actual same-owner graph replacement requires fresh capture and retained stale actions cannot Save another generation", async () => {
    const f = fixture(); await f.flush(); f.dirty(); const oldSave = f.button("Save preset").props.onClick;
    const read = f.holdRead(); f.model.pedalboard.set({ ...f.model.pedalboard.get() }); f.render();
    assert.equal(f.button("Save preset").props.disabled, true); oldSave(); assert.equal(f.saves.length, 0);
    read.resolve(f.current); await f.flush(); assert.equal(f.button("Save preset").props.disabled, false);
    assert.equal(f.saves.length, 0); f.unmount();
});

test("actual pending Save/capture cannot survive selection or connection A→B→A, including late replies", async () => {
    for (const type of ["bank", "preset", "snapshot", "connection"]) {
        const f = fixture(); await f.flush(); f.dirty(); const old = f.button("Save preset").props.onClick;
        const read = f.holdRead(); old();
        if (type === "bank") { f.model.banks.set({ selectedBank: 7 }); f.model.banks.set({ selectedBank: 6 }); }
        if (type === "preset") { f.model.presets.set({ selectedInstanceId: 27, presetChanged: true }); f.model.presets.set({ selectedInstanceId: 26, presetChanged: true }); }
        if (type === "snapshot") { f.model.selectedSnapshot.set(0); f.model.selectedSnapshot.set(-1); }
        if (type === "connection") { f.model.state.set(2); f.model.state.set(1); }
        read.resolve(f.current); await f.flush(); old(); await f.flush();
        assert.equal(f.saves.length, 0, type); f.unmount();
    }
});

test("actual accepted Apply reconciles a full-board event from observed state and leaves Save separate", async () => {
    const f = fixture(); await f.flush(); const edited = structuredClone(f.block); edited.mix = .8;
    f.blockControl().props.onStaged(edited); f.render(); f.button("Apply block changes").props.onClick();
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].args[2].blocks[0].mix, .8);
    const read = f.holdRead(); f.model.pedalboard.set({ ...f.model.pedalboard.get() });
    read.reject(Error("Apply accepted; plugin state has not reflected edit yet")); await f.flush(); assert.match(f.status(), /Wait before saving/);
    f.writes[0].pending.resolve(true); await f.flush(); assert.equal(f.saves.length, 0);
    const actual = structuredClone(f.current); actual.revision = "applied"; actual.summary.blocks[0].mix = Math.fround(.8);
    f.setCurrent(actual); f.dirty(); f.tick(); await f.flush();
    assert.match(f.status(), /not saved/); assert.equal(f.button("Apply block changes").props.disabled, true);
    assert.equal(f.button("Save preset").props.disabled, false); assert.equal(f.saves.length, 0); f.unmount();
});

test("native float32 readback reconciles exact control steps without accepting a different step or overflow", async () => {
    const f = fixture(); await f.flush();
    for (const value of [.99, .8, -.1, 0.1, 0.31234]) assert.equal(f.helper({ mix: value }, { mix: Math.fround(value) }, true), true);
    assert.equal(f.helper({ mix: .99 }, { mix: Math.fround(.98) }, true), false);
    assert.equal(f.helper({ activeModelId: 16777216 }, { activeModelId: 16777217 }, true), false);
    assert.equal(f.helper({ slimSize: .99 }, { slimSize: Math.fround(.99) }, true), false);
    assert.equal(f.helper({ inputCalibrationLevel: .99 }, { inputCalibrationLevel: Math.fround(.99) }), false);
    assert.equal(f.helper(1e40, 2e40), false);
    assert.equal(f.helper(Infinity, Infinity), false);
    const edited = structuredClone(f.block); edited.mix = .99;
    f.blockControl().props.onStaged(edited); f.render(); f.button("Apply block changes").props.onClick();
    const actual = structuredClone(f.current); actual.revision = "native-float"; actual.summary.blocks[0].mix = Math.fround(.99);
    f.setCurrent(actual); f.dirty(); f.model.pedalboard.set({ ...f.model.pedalboard.get() });
    f.writes[0].pending.resolve(true); await f.flush();
    assert.match(f.status(), /not saved/); assert.equal(f.button("Save preset").props.disabled, false);
    assert.equal(f.button("Apply block changes").props.disabled, true);
    assert.equal(f.all().some(node => node.type === "Alert" && String(node.props.children).includes("operation may have completed")), false);
    f.unmount();
});

test("matching rig capture cannot acknowledge an interrupted device-defaults Save", async () => {
    const f = fixture("Settings"); await f.flush();
    f.processing().props.onChange({ inputCalibrationLevel: 3 });
    f.field("Processing profile").props.onChange({ target: { value: "home" } }); f.render();
    f.button("Save defaults").props.onClick(); f.render();
    const actual = structuredClone(f.current); actual.revision = "external"; actual.summary.inputCalibrationLevel = 3;
    f.setCurrent(actual); f.model.pedalboard.set({ ...f.model.pedalboard.get() });
    f.writes[0].pending.resolve(f.profile); await f.flush();
    assert.equal(f.all().some(node => node.type === "Alert" && String(node.props.children).includes("operation may have completed")), true);
    assert.equal(f.saves.length, 0); f.unmount();
});

test("actual hidden Settings drafts synchronously block Blocks Save and restore/unmount removes only that token", async () => {
    const blocks = fixture(); await blocks.flush(); blocks.dirty();
    const settings = fixture("Settings", blocks); await settings.flush(); settings.update({ active: false });
    const oldSave = blocks.button("Save preset").props.onClick;
    settings.update({ active: true }); settings.processing().props.onChange({ inputCalibrationLevel: 3 }); settings.render();
    settings.update({ active: false }); blocks.render();
    assert.equal(blocks.button("Save preset").props.disabled, true); assert.match(blocks.status(), /Unapplied edits in Settings/);
    oldSave(); await blocks.flush(); assert.equal(blocks.saves.length, 0, "synchronous registry read protects already captured Save handler");
    settings.update({ active: true }); settings.processing().props.onChange({ inputCalibrationLevel: 0 }); settings.render(); blocks.render();
    assert.equal(blocks.button("Save preset").props.disabled, false, "exact hidden-draft Restore clears cross-tab pending flag");
    settings.processing().props.onChange({ inputCalibrationLevel: NaN }); settings.render(); blocks.render();
    assert.equal(blocks.button("Save preset").props.disabled, true);
    settings.unmount(false); blocks.render(); assert.equal(blocks.button("Save preset").props.disabled, false);
    assert.equal(blocks.registryFactory(blocks.model).sections(JSON.stringify([1, 6, 26, -1])).length, 0);
    blocks.unmount();
});

test("actual accepted-but-unobserved Settings Apply keeps hidden draft token until fresh capture confirms it", async () => {
    const blocks = fixture(); await blocks.flush(); blocks.dirty();
    const settings = fixture("Settings", blocks); await settings.flush();
    settings.processing().props.onChange({ inputCalibrationLevel: 3 }); settings.render();
    const read = blocks.holdRead(); settings.button("Apply rig settings").props.onClick();
    blocks.writes[0].pending.resolve(true); read.reject(Error("Apply accepted; plugin state has not reflected edit yet"));
    await settings.flush(); blocks.render(); assert.equal(blocks.button("Save preset").props.disabled, true);
    assert.match(blocks.status(), /Unapplied edits in Settings/);
    const actual = structuredClone(blocks.current); actual.revision = "applied"; actual.summary.inputCalibrationLevel = 3;
    blocks.setCurrent(actual); settings.tick(); await settings.flush(); blocks.render();
    assert.equal(blocks.button("Save preset").props.disabled, false); assert.equal(blocks.saves.length, 0);
    settings.unmount(false); blocks.unmount();
});
