import { Tone3000MixMatchSession } from "../src/pipedal/Tone3000MixMatch.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { Tone3000ProgramEvidence } from "../src/pipedal/Tone3000Performance.ts";
import { Tone3000BundleReader, tone3000BundleImportAllowed, tone3000BundleMaxBytes } from "../src/pipedal/Tone3000Bundle.ts";
import { Tone3000StageRunner, Tone3000MeasurementSession, tone3000ValidMeasurement, tone3000QuietestTarget,
    tone3000LevelProposalAllowed, tone3000StageBlockName, tone3000StageRequestedSize, tone3000StageCalibration } from "../src/pipedal/Tone3000Stage.ts";
import { tone3000DraftNumber } from "../src/pipedal/Tone3000MobileLayout.ts";
import { tone3000GearLabel } from "../src/pipedal/Tone3000Gear.ts";
import { tone3000NumberPresentation } from "../src/pipedal/Tone3000ControlUnits.ts";
import { tone3000BankLocation, tone3000FilterLibrary, tone3000SavedCopies } from "../src/pipedal/Tone3000Library.ts";

const ts = createRequire(new URL("../package.json", import.meta.url))("typescript");
const source = name => readFileSync(new URL("../src/pipedal/" + name, import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 12; ++i) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const children = node => node?.props?.children.flat(Infinity) ?? [];
const nodes = node => node && typeof node === "object" && "type" in node
    ? [node, ...children(node).flatMap(nodes)] : [];

/** Execute production component hooks and JSX handlers, replacing only transport
 * promises and DOM rendering. No rewritten close/recovery implementation.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-STABILITY-REVIEW] [7.22]
 */
function fixture(kind) {
    const name = "Tone3000" + kind + (kind === "Soundcheck" ? "Panel" : "Dialog"), raw = source(name + ".tsx");
    const ast = ts.createSourceFile(name + ".tsx", raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const slots = [], effects = [], pendingEffects = [];
    let cursor = 0, tree, open = true, closes = 0, midi;
    const alerts = [], writes = [], reads = [];
    const measurements = new Tone3000MeasurementSession();
    measurements.add({ state: "done", token: 7, valid: true, receiptValid: true, finite: true, clipped: false,
        silent: false, rmsDb: -24, peakDb: -12, seconds: 3, samples: 144000, savedRevision: "a".repeat(64),
        bankId: 6, presetId: 20, instanceId: 1 }, "Measured rig");
    const context = { console, Tone3000MixMatchSession, State: { Ready: 1, Reconnecting: 2 }, Tone3000ProgramEvidence,
        Tone3000BundleReader, tone3000BundleImportAllowed, tone3000BundleMaxBytes,
        Tone3000StageRunner, tone3000ValidMeasurement, tone3000QuietestTarget, tone3000LevelProposalAllowed,
        tone3000StageBlockName, tone3000StageRequestedSize, tone3000StageCalibration, tone3000DraftNumber, tone3000BankLocation, tone3000FilterLibrary, tone3000SavedCopies,
        useSyncExternalStore: (_subscribe, get) => get(),
        window: { setInterval: () => 1, clearInterval() {} },
        React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
        useState(initial) {
            const at = cursor++;
            if (!(at in slots)) slots[at] = typeof initial === "function" ? initial() : initial;
            return [slots[at], value => { slots[at] = typeof value === "function" ? value(slots[at]) : value; }];
        },
        useRef(initial) { const at = cursor++; return slots[at] ??= { current: initial }; },
        useCallback(callback, deps) {
            const at = cursor++, prior = slots[at];
            if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) slots[at] = { callback, deps };
            return slots[at].callback;
        },
        useEffect(callback, deps) {
            const at = cursor++, prior = effects[at];
            if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i])))
                pendingEffects.push(() => { prior?.cleanup?.(); effects[at] = { deps, cleanup: callback() }; });
        }
    };
    const observableAst = ts.createSourceFile("Observable.tsx", source("ObservableProperty.tsx"), ts.ScriptTarget.Latest, true);
    const observable = observableAst.statements.find(node => ts.isClassDeclaration(node));
    const compile = code => vm.runInNewContext(ts.transpileModule(code, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
    compile(observable.getText(observableAst).replace(/^export /, "") + "\nglobalThis.ObservableProperty = ObservableProperty;");
    const sources = Array.from({ length: 4 }, (_, i) => ({ bankId: 6, presetId: i + 20, name: "Rig " + i, bankName: "TONE3000 Rx", revision: "saved" }));
    const model = {
        pedalboard: new context.ObservableProperty({ tryGetItem: () => ({}) }),
        selectedSnapshot: new context.ObservableProperty(-1),
        state: new context.ObservableProperty(context.State.Ready),
        presets: new context.ObservableProperty({ presetChanged: false, selectedInstanceId: 20, presets: [] }),
        banks: new context.ObservableProperty({ selectedBank: 6 }),
        alsaSequencerConfiguration: new context.ObservableProperty({ midiChannel: 0 }),
        showAlert: message => alerts.push(message),
        getTone3000PerformanceSources: async () => { reads.push("sources"); return sources; },
        getTone3000PresetPreview: async () => ({ targetState: { summary: { blocks: [{ type: "nam", blockId: "amp" }, { type: "ir", blockId: "cab" }] } } }),
        getTone3000MixMatchPreview: async request => ({ sourceRevision: request.expectedRevision, name: request.name, sourceName: "Rig 0", ampBlockId: "amp", cabBlockId: "cab", includePitch: request.includePitch, qualified: false, warnings: [], items: [] }),
        createTone3000MixMatch: (...args) => { const pending = deferred(); writes.push({ args, pending }); return pending.promise; },
        getTone3000Library: async () => { reads.push("library"); return { entries: [], warnings: [] }; },
        createTone3000PerformanceBank: (...args) => { const pending = deferred(); writes.push({ args, pending }); return pending.promise; },
        loadTone3000Preset: (...args) => { const pending = deferred(); writes.push({ args, pending }); return pending.promise; },
        importTone3000Preset: (...args) => { const pending = deferred(); writes.push({ args, pending }); return pending.promise; },
        uploadBank: (...args) => { const pending = deferred(); writes.push({ args, pending }); return pending.promise; },
        applyTone3000Level: (...args) => { const pending = deferred(); writes.push({ args, pending }); return pending.promise; },
        getTone3000MeasurementSession: () => measurements,
        getTone3000PerformanceBank: async () => created,
        listenForMidiProgramEvent: async callback => { midi = callback; return { id: 1 }; },
        cancelListenForMidiEvent() {},
        maxPresetUploadSize: 1024, varServerUrl: "http://test/var/"
    };
    context.fetch = async () => {
        reads.push("bundle");
        return { ok: true, json: async () => ({ name: "Checked", completenessKnown: true,
            plugins: [], missingMedia: [], warnings: [], embeddedBytes: 0, presetCount: 1, namCount: 0, irCount: 0 }) };
    };
    context.PiPedalModelFactory = { getInstance: () => model };
    for (const item of ast.statements.filter(ts.isImportDeclaration)) {
        const clause = item.importClause;
        if (clause?.name && !(clause.name.text in context)) context[clause.name.text] = clause.name.text;
    }
    const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    compile(component.getText(ast).replace(/^export default /, "") + "\nglobalThis.renderComponent = " + name + ";");
    const selection = { entry: { key: "user:source", sha256: "sourcehash" }, target: { bankId: 6, presetId: 20, instanceId: 1, name: "Rig 0" } };
    const render = () => {
        cursor = 0; tree = context.renderComponent({ selection: open ? selection : null, open, active: open, instanceId: 1, onClose: () => { ++closes; } });
        pendingEffects.splice(0).forEach(commit => commit()); return tree;
    };
    const button = label => nodes(tree).find(node => node.type === "Button" && (node.props["aria-label"] === label || children(node).includes(label)));
    const dialog = () => nodes(tree).find(node => node.type === "DialogEx" && node.props.tag === "tone3000" + kind);
    const unmount = () => { for (const effect of effects) { effect?.cleanup?.(); if (effect) effect.cleanup = undefined; } };
    render();
    return { model, writes, reads, alerts, sources, button, dialog, render,
        all: () => nodes(tree), closes: () => closes,
        midi(status, program) { assert.ok(midi); midi({ cc0: status, cc1: program }); },
        setOpen(value) { open = value; render(); }, unmount,
        async prepareCreate() {
            await flush(); render();
            for (let i = 0; i < 4; ++i) {
                const field = nodes(tree).find(node => node.type === "TextField" && String(node.props.label).startsWith("ABCD"[i] + " · PC"));
                field.props.onChange({ target: { value: sources[i].bankId + "/" + sources[i].presetId } }); render();
            }
        }
    };
}

/** Actual authoring dialog handlers/effects, including separate Load ownership.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [7.36] */
test("Mix & match creates only the reviewed saved copy and never auto-loads; dirty current rig blocks Load", async () => {
    const f = fixture("MixMatch"); f.render();
    f.button("Review saved rig").props.onClick(); await flush(); f.render();
    const confirmation = f.all().find(node => node.type === "FormControlLabel" && node.props.label === "I confirm this NAM is an amp head without a baked cabinet.");
    assert.ok(confirmation); assert.equal(f.button("Create separate copy").props.disabled, true);
    confirmation.props.control.props.onChange({ target: { checked: true } }); f.render();
    f.model.presets.set({ ...f.model.presets.get(), presetChanged: true });
    f.button("Create separate copy").props.onClick(); f.render(); assert.equal(f.writes.length, 1);
    const request = f.writes[0].args[0]; assert.equal(request.expectedRevision, "saved"); assert.equal(request.instanceId, 1);
    assert.equal(request.confirmAmpHead, true); assert.equal(request.includePitch, true);
    f.writes[0].pending.resolve({ bankId: 42, presetId: 1, ampInstanceId: 8, cabInstanceId: 9, pitchInstanceId: 7, name: request.name, sourceRevision: "saved", qualified: false });
    await flush(); f.render(); assert.equal(f.writes.length, 1, "Creation does not load");
    assert.equal(f.button("Load experimental copy").props.disabled, true);
    f.button("Load experimental copy").props.onClick(); await flush(); assert.equal(f.writes.length, 1, "Handler enforces dirty ownership too"); f.unmount();
});
test("Mix & match dismiss/disconnect during Create retains uncertainty and ignores obsolete receipt", async () => {
    const f = fixture("MixMatch"); f.render(); f.button("Review saved rig").props.onClick(); await flush(); f.render();
    const checkbox = f.all().find(node => node.type === "FormControlLabel" && node.props.label.startsWith("I confirm"));
    checkbox.props.control.props.onChange({ target: { checked: true } }); f.render();
    f.button("Create separate copy").props.onClick(); const request = f.writes[0].args[0];
    f.setOpen(false); assert.ok(f.alerts.some(message => message.includes("may have completed")));
    f.writes[0].pending.resolve({ bankId: 42, presetId: 1, ampInstanceId: 8, cabInstanceId: 9, pitchInstanceId: 7, name: request.name, sourceRevision: "saved", qualified: false });
    await flush(); f.setOpen(true); assert.equal(f.writes.length, 1); assert.equal(f.button("Create separate copy").props.disabled, true); f.unmount();
});

const created = { bankId: 9, revision: "copied", name: "Stage", slots: [0, 1, 2, 3].map(program => ({ program, label: "ABCD"[program], name: "Copy", presetId: 50 + program })) };

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-18] [DES-STABILITY-REVIEW] [7.22] */
test("production performance close handlers refuse a pending create before rerender and allow settled close", async () => {
    const f = fixture("Performance"); await f.prepareCreate();
    const closeButton = f.button("Close"), dialog = f.dialog();
    f.button("Create four saved copies").props.onClick();
    assert.equal(f.writes.length, 1);
    dialog.props.onClose({}, "escapeKeyDown"); dialog.props.onClose({}, "backdropClick"); closeButton.props.onClick();
    assert.equal(f.closes(), 0, "ref guards all close paths even before busy state renders");
    f.writes[0].pending.resolve(created); await flush(); f.render();
    assert.equal(f.button("Load performance bank").props.disabled, false);
    assert.equal(f.writes.length, 1, "create never automatically loads");
    f.button("Close").props.onClick(); assert.equal(f.closes(), 1);
    f.unmount(); assert.equal(f.alerts.length, 0, "settled/no-work cleanup is silent");
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-18] [DES-STABILITY-REVIEW] [7.24] */
test("production performance observation labels legitimate A to B to A as a repeat, not a duplicate fault", async () => {
    const f = fixture("Performance"); await f.prepareCreate();
    f.button("Create four saved copies").props.onClick(); f.writes[0].pending.resolve(created); await flush(); f.render();
    f.model.banks.set({ selectedBank: 9 });
    const preset = selectedInstanceId => ({ presetChanged: false, selectedInstanceId,
        presets: created.slots.map(slot => ({ instanceId: slot.presetId })) });
    f.model.presets.set(preset(50));
    f.button("Observe Program Changes").props.onClick(); f.render(); await flush();
    for (const program of [0, 1, 0]) {
        f.model.presets.set(preset(50 + program)); f.midi(0xc0, program); f.render();
    }
    const text = f.all().filter(node => node.type === "Typography").flatMap(children).filter(value => typeof value === "string").join("");
    assert.match(text, /1 repeat\(s\)/); assert.doesNotMatch(text, /duplicate/);
    f.button("Close").props.onClick(); assert.equal(f.closes(), 1, "read-only MIDI observation is still closable");
    f.unmount(); assert.equal(f.alerts.length, 0);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-21] [DES-STABILITY-REVIEW] [7.24] */
test("production comparison field retains text; invalid proposals cannot apply and valid decimal uses exact receipt", async () => {
    const f = fixture("Soundcheck"); f.render();
    const field = () => f.all().find(node => node.type === "TextField" && node.props.label === "Extra volume (dB)");
    for (const text of ["", " ", "-", "Infinity", "7", "-1", "1,2,3"]) {
        field().props.onChange({ target: { value: text } }); f.render();
        assert.equal(field().props.value, text); assert.equal(field().props.error, true);
        assert.match(field().props.helperText, /0 to 6/);
        const apply = f.button("Save matched volume"); assert.equal(apply.props.disabled, true);
        apply.props.onClick(); await flush(); assert.equal(f.writes.length, 0);
    }
    field().props.onChange({ target: { value: "1,5" } }); f.render();
    assert.equal(field().props.value, "1,5"); assert.equal(field().props.error, false);
    assert.equal(f.button("Save matched volume").props.disabled, false);
    f.button("Save matched volume").props.onClick();
    assert.deepEqual(f.writes[0].args, [7, "a".repeat(64), -22.5]);
    f.writes[0].pending.resolve({ trimDb: 1.5 }); await flush(); f.render();
    assert.equal(f.button("Save matched volume").props.disabled, true, "receipt applied once");
    f.unmount();
});

function storedPreview() {
    const raw = source("Tone3000PresetPreviewDialog.tsx");
    const ast = ts.createSourceFile("Preview.tsx", raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "StoredChain");
    let gain;
    ts.forEachChild(ast, node => { if (ts.isVariableStatement(node))
        for (const declaration of node.declarationList.declarations) if (declaration.name.getText(ast) === "blockGain") gain = declaration; });
    assert.ok(gain);
    const context = { React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
        Paper: "Paper", Typography: "Typography", Stack: "Stack", Box: "Box", Tone3000ChainView: "Tone3000ChainView", tone3000GearLabel, tone3000NumberPresentation };
    vm.runInNewContext(ts.transpileModule("const " + gain.getText(ast) + ";\n" + component.getText(ast)
        + "\nglobalThis.render = StoredChain;", { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
    return state => nodes(context.render({ title: "Source", state }));
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STABILITY-REVIEW] [7.24] */
test("production stored preview uses native category labels and shared physical gain scale without changing saved values", () => {
    const render = storedPreview();
    const state = { namCount: 1, irCount: 1, embeddedBytes: 20, summary: { activePresetName: "Rig", stereoEnabled: false,
        blocks: ["full-rig", "space", "Unknown category"].map((gear, index) => ({ blockId: String(index), lane: "left", index,
            type: "nam", title: "Model", gear, format: "nam", enabled: true, activeModelId: null,
            inputGain: .5, outputGain: .75, mix: .25, normalize: true, slimSize: 1,
            eq: { enabled: false, pre: false, bands: [] } })) } };
    const before = structuredClone(state);
    const text = render(state).flatMap(children).filter(value => typeof value === "string").join("");
    assert.match(text, /Amp \+ Cab/); assert.match(text, /Space/); assert.match(text, /Unknown category/);
    assert.match(text, /Input 0\.0 dB/); assert.match(text, /Output 12\.0 dB/); assert.match(text, /Mix 25\.0%/);
    assert.doesNotMatch(text, /stored 0–1|full-rig/); assert.deepEqual(state, before);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STABILITY-REVIEW] [7.24] */
test("production stored preview bounds EQ display precision and only describes NAM size capability", () => {
    const render = storedPreview();
    const block = { blockId: "one", lane: "left", index: 0, title: "Saved block", gear: "cab", format: "ir",
        enabled: true, activeModelId: null, inputGain: .5, outputGain: .5, mix: 1, normalize: false,
        slimSize: 1, capabilityUnknown: true, eq: { enabled: true, pre: false, bands: [
            { type: "peak", freqHz: 799.9999389648438, gainDb: -2.299999952316284, q: .7099999785423279 },
            { type: "highShelf", freqHz: 3500.000244140625, gainDb: 1.399999976158142, q: 1.399999976158142 }
        ] } };
    const state = { namCount: 0, irCount: 1, embeddedBytes: 20, summary: { activePresetName: "Saved", stereoEnabled: false,
        blocks: [{ ...block, type: "ir" }] } };
    const before = structuredClone(state);
    const text = value => render(value).flatMap(children).filter(value => typeof value === "string").join("");
    const ir = text(state);
    assert.match(ir, /800 Hz \/ -2\.3 dB \/ Q 0\.71/);
    assert.match(ir, /3500 Hz \/ 1\.4 dB \/ Q 1\.4/);
    assert.doesNotMatch(ir, /709999|399999|size is a saved request/);
    assert.deepEqual(state, before, "display rounding must not quantize saved EQ values");
    const nam = text({ ...state, summary: { ...state.summary, blocks: [{ ...block, type: "nam", format: "nam" }] } });
    assert.match(nam, /Model capability is unverified; size is a saved request/);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-18] [DES-STABILITY-REVIEW] [7.22] */
test("forced performance close retains uncertainty once; reopening ignores old result and only refreshes sources", async () => {
    const f = fixture("Performance"); await f.prepareCreate();
    f.button("Create four saved copies").props.onClick();
    f.setOpen(false); assert.equal(f.alerts.length, 1); assert.match(f.alerts[0], /may have completed/);
    f.setOpen(true); await flush(); f.render();
    assert.equal(f.button("Create four saved copies").props.disabled, false);
    f.writes[0].pending.resolve(created); await flush(); f.render();
    assert.equal(f.button("Load performance bank"), undefined, "late reply cannot attach the old created bank to the reopened dialog");
    assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 2);
    f.unmount(); assert.equal(f.alerts.length, 1);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-18] [DES-STABILITY-REVIEW] [7.22] */
test("performance disconnect clears busy, preserves notice, reconciles sources and never replays a load", async () => {
    const f = fixture("Performance"); await f.prepareCreate();
    f.button("Create four saved copies").props.onClick(); f.writes[0].pending.resolve(created); await flush(); f.render();
    f.button("Load performance bank").props.onClick(); assert.equal(f.writes.length, 2);
    f.model.state.set(2); f.render();
    assert.equal(f.button("Close").props.disabled, false);
    assert.ok(f.all().some(node => node.type === "Alert" && children(node).some(value => typeof value === "string" && value.includes("may have completed"))));
    f.model.state.set(1); await flush(); f.render();
    f.writes[1].pending.reject(new Error("old transport")); await flush(); f.render();
    assert.equal(f.writes.length, 2); assert.equal(f.reads.length, 2);
    f.unmount(); assert.equal(f.alerts.length, 0, "disconnect already released ownership; teardown must not repeat its warning");
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-STABILITY-REVIEW] [7.22] */
test("Library footer guards immediate pending Add and true unmount retains uncertainty", async () => {
    const f = fixture("Library"); await flush(); f.render();
    const dialog = f.dialog(), close = f.button("Close");
    const preview = f.all().find(node => node.type === "Tone3000PresetPreviewDialog");
    preview.props.onConfirm({ action: "add", entry: { key: "user:test", name: "Test", sha256: "source" } });
    assert.equal(f.writes.length, 1);
    dialog.props.onClose(); close.props.onClick(); assert.equal(f.closes(), 0);
    f.unmount(); assert.equal(f.alerts.length, 1); assert.match(f.alerts[0], /may have completed/);
    f.writes[0].pending.resolve({ presetId: 91 }); await flush();
    assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 1);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-STABILITY-REVIEW] [7.22] */
test("Bundle footer and ordinary closes guard a durable import; forced destruction retains its unknown outcome", async () => {
    const f = fixture("Bundle"); f.render();
    const input = f.all().find(node => node.type === "input");
    input.props.onChange({ currentTarget: { files: [{ name: "Checked.piBank", size: 10 }], value: "chosen" } });
    await flush(); f.render();
    const close = f.button("Close"), dialog = f.dialog();
    f.button("Import as new bank").props.onClick(); assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].args[0].name, "Checked.piBank"); assert.equal(f.writes[0].args[1], 6);
    dialog.props.onClose(); close.props.onClick(); assert.equal(f.closes(), 0);
    f.unmount(); assert.equal(f.alerts.length, 1); assert.match(f.alerts[0], /may have completed/);
    f.writes[0].pending.resolve(42); await flush(); assert.equal(f.writes.length, 1);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-22] [DES-STABILITY-REVIEW] [7.22] */
test("Bundle import ownership blocks two clicks before rerender and releases only after settlement", async () => {
    const f = fixture("Bundle"); f.render();
    const input = f.all().find(node => node.type === "input");
    input.props.onChange({ currentTarget: { files: [{ name: "Checked.piBank", size: 10 }], value: "chosen" } });
    await flush(); f.render();
    const importButton = f.button("Import as new bank");
    importButton.props.onClick(); importButton.props.onClick();
    assert.equal(f.writes.length, 1, "the second same-render callback cannot issue another durable upload");
    f.writes[0].pending.resolve(42); await flush(); f.render();
    assert.equal(f.button("Import as new bank").props.disabled, false);
    assert.ok(f.all().some(node => node.type === "Alert" && children(node).some(value => typeof value === "string" && value.includes("New bank 42 imported"))));
    f.unmount(); assert.equal(f.alerts.length, 0);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-22] [DES-STABILITY-REVIEW] [7.22] */
test("Bundle import stale callback reads live connection state before any durable upload", async () => {
    const f = fixture("Bundle"); f.render();
    const input = f.all().find(node => node.type === "input");
    input.props.onChange({ currentTarget: { files: [{ name: "Checked.piBank", size: 10 }], value: "chosen" } });
    await flush(); f.render();
    const importButton = f.button("Import as new bank");
    assert.equal(importButton.props.disabled, false);
    f.model.state.set(2); // Invoke the previously rendered handler before React rerenders.
    importButton.props.onClick(); await flush();
    assert.equal(f.writes.length, 0, "rendered ready=true cannot authorize a disconnected mutation");
    f.render(); f.model.state.set(1); f.render();
    assert.equal(f.button("Import as new bank"), undefined, "reconnect requires a new explicit bundle check");
    assert.equal(f.writes.length, 0); f.unmount(); assert.equal(f.alerts.length, 0);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-PLAIN-TOOLS] [7.25] */
test("Library search finds renamed saved copies and Load retains the selected saved identity", async () => {
    const f = fixture("Library"); await flush(); f.render();
    const target = { bankId: 6, presetId: 26, instanceId: 1, name: "Rx Clean", sha256: "same", active: false };
    f.model.getTone3000Library = async () => ({ warnings: [], entries: [
        { key: "factory:marshall", name: "Marshall Bluesbreaker", source: "Pi app factory", sha256: "same", imports: [target] },
        { key: "factory:other", name: "Other", source: "Pi app factory", sha256: "same", imports: [] }
    ] });
    f.button("Refresh").props.onClick(); await flush(); f.render();
    f.all().find(node => node.type === "TextField" && node.props.label === "Find a rig or bank").props.onChange({ target: { value: "RX CLEAN" } }); f.render();
    assert.deepEqual(f.all().filter(node => node.type === "Paper").map(node => node.props.key), ["factory:marshall"]);
    assert.equal(f.writes.length, 0, "search and refresh never load or import");
    f.button("Load").props.onClick(); assert.deepEqual(f.writes[0].args, [6, 26]);
    f.writes[0].pending.resolve(); await flush(); f.unmount();
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [7.36] */
async function prepareMixMatchLoad() {
    const f = fixture("MixMatch"); f.render(); f.button("Review saved rig").props.onClick(); await flush(); f.render();
    f.all().find(node => node.type === "FormControlLabel" && node.props.label.startsWith("I confirm")).props.control.props.onChange({ target: { checked: true } }); f.render();
    f.button("Create separate copy").props.onClick(); const request = f.writes[0].args[0];
    f.writes[0].pending.resolve({ bankId: 42, presetId: 1, ampInstanceId: 8, cabInstanceId: 9, pitchInstanceId: 7,
        name: request.name, sourceRevision: "saved", qualified: false });
    await flush(); f.render(); return f;
}
test("Mix & match Load has synchronous ownership and close guards; obsolete Create cannot replace owner", async () => {
    const f = await prepareMixMatchLoad();
    const button = f.button("Load experimental copy"), close = f.button("Close"), dialog = f.dialog();
    button.props.onClick(); button.props.onClick(); assert.equal(f.writes.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(f.writes[1].args)), [42, 1, { requireClean: true, expectedBankId: 6, expectedPresetId: 20 }]);
    close.props.onClick(); dialog.props.onClose(); assert.equal(f.closes(), 0);
    f.writes[1].pending.resolve(); await flush(); f.render();
    assert.equal(f.button("Load experimental copy").props.disabled, true);
    f.button("Close").props.onClick(); assert.equal(f.closes(), 1); f.unmount(); assert.equal(f.alerts.length, 0);
});
test("Mix & match forced unmount or disconnect during Load retains uncertainty and ignores late result", async () => {
    for (const disconnect of [false, true]) {
        const f = await prepareMixMatchLoad(); f.button("Load experimental copy").props.onClick();
        if (disconnect) { f.model.state.set(2); f.render(); f.model.state.set(1); f.render(); }
        else { f.setOpen(false); f.setOpen(true); f.render(); }
        assert.equal(f.alerts.length, 1); assert.match(f.alerts[0], /Loading may have completed/);
        f.writes[1].pending.resolve(); await flush(); f.render();
        assert.ok(!f.all().some(node => node.type === "Alert" && children(node).some(value => value === "Experimental copy loaded. Test at your usual sample rate and buffers before taking it to a gig.")));
        assert.equal(f.writes.length, 2); f.unmount(); assert.equal(f.alerts.length, 1);
    }
});
test("Mix & match stale Load callback cannot authorize a disconnected load", async () => {
    const f = await prepareMixMatchLoad(), load = f.button("Load experimental copy");
    f.model.state.set(2); load.props.onClick(); await flush(); assert.equal(f.writes.length, 1);
    f.render(); f.unmount(); assert.equal(f.alerts.length, 0);
});
