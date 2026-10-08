import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const { build } = require("esbuild");
const path = name => fileURLToPath(new URL("../src/pipedal/" + name, import.meta.url));
const compiled = async name => (await build({ entryPoints: [path(name)], bundle: true, write: false,
    platform: "node", format: "cjs", logLevel: "silent" })).outputFiles[0].text;
const observableCode = await compiled("ObservableProperty.tsx"), rigCode = await compiled("Tone3000Rig.ts");
const editStateCode = await compiled("Tone3000EditState.ts");
const flush = async () => { for (let i = 0; i < 10; ++i) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

/** Run exact production handlers/effects with controlled RPCs and observable state.
 * AST extraction avoids a new DOM/mock React dependency or duplicated recovery logic.
 * These are handler/effect regressions, not mounted-browser layout tests.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
 */
function fixture(kind, section = "Blocks") {
    const context = { module: { exports: {} }, exports: {}, console, State: { Ready: 1, Reconnecting: 2 },
        alive: { current: true }, working: { current: false }, generation: { current: 0 }, operationGeneration: { current: 0 },
        rigDirty: { current: false }, profileDirty: { current: false }, waitingRef: { current: false }, rigRef: { current: null },
        draftRef: { current: null }, followRef: { current: false }, defaultsRef: { current: null },
        profileDraftRef: { current: null }, profileIdRef: { current: "" }, staleRef: { current: false },
        activeRef: { current: true }, captureReadyRef: { current: false }, captureOwner: { current: null },
        ownership: { current: { key: "", epoch: 0 } }, saveCancellation: { current: null },
        operationLabel: { current: "" }, rigRecovery: { current: false },
        draftToken: { current: Symbol("test panel") },
        active: true, open: true, section, instanceId: 1, busy: false, refreshing: false,
        error: "", notice: "", recoveryNotice: "", stale: false, waiting: false, connected: true,
        window: { setInterval: () => 1, clearInterval() {} } };
    const runModule = code => {
        context.module = { exports: {} }; context.exports = context.module.exports;
        vm.runInNewContext(code, context); return context.module.exports;
    };
    const { ObservableProperty } = runModule(observableCode);
    Object.assign(context, runModule(rigCode));
    Object.assign(context, runModule(editStateCode));
    context.registry = context.tone3000EditDrafts(context);
    for (const name of ["Busy", "Refreshing", "Connected", "PendingLoad", "Preview", "PerformanceOpen", "BundleOpen", "RecoveryNotice", "Notice", "Error", "Library",
        "Rig", "Draft", "Follow", "Defaults", "ProfileId", "ProfileDraft", "Status", "Stale", "Waiting", "CaptureReady", "BusyLabel"]) {
        const key = name[0].toLowerCase() + name.slice(1);
        context["set" + name] = value => {
            context[key] = typeof value === "function" ? value(context[key]) : value;
            if (key === "rig") context.rigRef.current = context.rig;
            if (key === "waiting") context.waitingRef.current = context.waiting;
            if (context[key + "Ref"]) context[key + "Ref"].current = context[key];
        };
    }
    const block = { blockId: "amp", lane: "left", index: 0, type: "nam", title: "Amp", gear: "amp", format: "nam",
        activeModelId: 7, enabled: true, normalize: true, capabilityUnknown: true, slimSize: 1, inputGain: .5,
        outputGain: .5, mix: 1, eq: { enabled: false, pre: false, bands: [] } };
    const current = { revision: "original", instanceId: 1, followDefaults: false, hasSnapshotOverrides: false,
        summary: { activePresetId: "user:rig", activePresetName: "Rig", inputMode: "left", calibrateInput: false,
            inputCalibrationLevel: 0, osEnabled: false, osFactor: 0, stereoEnabled: false,
            branchSide: "left", branchAfterBlockId: "", blocks: [block] } };
    const profile = { revision: "profile-original", activeProfile: "live", defaults: { multiCore: false,
        namSlimSizeDefault: 1, calibrateInput: false, inputCalibrationLevel: 0, osEnabled: false, osFactor: 0 }, profiles: [] };
    const reads = [], writes = [], uploads = [], alerts = [];
    let currentValue = current, libraryValue = { entries: [], warnings: [] }, profileValue = profile;
    const model = context.model = {
        state: new ObservableProperty(context.State.Ready),
        banks: new ObservableProperty({ selectedBank: 6 }), presets: new ObservableProperty({ selectedInstanceId: 26, presetChanged: false }),
        selectedSnapshot: new ObservableProperty(-1),
        pedalboard: new ObservableProperty({ tryGetItem: () => ({ uri: "https://www.tone3000.com/plugin" }) }),
        showAlert: message => alerts.push(message),
        getTone3000CurrentState: async () => { reads.push("current"); return currentValue; },
        getTone3000Library: async () => { reads.push("library"); return libraryValue; },
        getTone3000Defaults: async () => { reads.push("defaults"); return profileValue; },
        getJackStatus: async () => ({}),
        importTone3000Preset: (...args) => { const pending = deferred(); writes.push({ args, pending }); return pending.promise; },
        setTone3000CurrentState: (...args) => { const pending = deferred(); writes.push({ args, pending }); return pending.promise; },
        setTone3000Defaults: (...args) => { const pending = deferred(); writes.push({ args, pending }); return pending.promise; },
        uploadTone3000Preset: file => { const pending = deferred(); uploads.push({ file, pending }); return pending.promise; }
    };
    const filename = path(kind === "library" ? "Tone3000LibraryDialog.tsx" : "Tone3000RigPanel.tsx");
    const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const variables = new Map(), effects = [];
    const visit = node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node.initializer);
        if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") effects.push(node.arguments[0]);
        ts.forEachChild(node, visit);
    };
    visit(source);
    const install = (name, expression) => {
        assert.ok(expression, "production callback missing: " + name);
        if (ts.isCallExpression(expression) && expression.expression.getText(source) === "useCallback") expression = expression.arguments[0];
        const js = ts.transpileModule("globalThis." + name + " = " + expression.getText(source) + ";", {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
        }).outputText;
        vm.runInNewContext(js, context, { filename });
    };
    for (const name of kind === "library" ? ["refresh", "run", "add", "upload"]
        : ["ownerKey", "ownerCurrent", "invalidateCapture", "publishDraft", "acceptRig", "acceptDefaults", "refresh", "run", "edit", "apply", "saveDefaults"]) install(name, variables.get(name));
    if (kind === "rig") {
        context.ownership.current.key = context.ownerKey();
        context.renderedOwner = { ...context.ownership.current };
    }
    install("mount", effects.find(effect => effect.getText(source).includes("const connectionChanged")));
    if (kind === "rig") install("mountDisposal", effects.find(effect => effect.getText(source).includes("() => { ++operationGeneration.current")));
    let cleanup = context.mount(), dispose = context.mountDisposal?.();
    return { context, model, reads, writes, uploads, alerts, current, profile,
        setCurrent: value => { currentValue = value; }, setLibrary: value => { libraryValue = value; },
        lose: () => model.state.set(context.State.Reconnecting), ready: () => {
            model.state.set(context.State.Ready);
            if (kind === "rig") context.renderedOwner = { ...context.ownership.current };
        },
        reopen: () => { cleanup?.(); context.open = false; context.mount(); context.open = true; cleanup = context.mount(); },
        remountInactive: () => { cleanup(); context.active = false; cleanup = context.mount(); },
        cleanup: () => { cleanup?.(); dispose?.(); } };
}

test("Library interruption reconciles metadata, retains uncertain outcome and ignores late replies without replay", async () => {
    const f = fixture("library"); await flush();
    const entry = { key: "user:x", name: "Rig", imports: [] };
    const old = f.context.add(entry, true);
    assert.equal(f.context.busy, true);
    f.lose(); assert.equal(f.context.busy, false); assert.equal(f.context.working.current, false);
    assert.match(f.context.recoveryNotice, /may have completed/);
    f.setLibrary({ entries: [entry], warnings: [] }); f.ready(); await flush();
    assert.equal(f.context.library.entries.length, 1); assert.equal(f.writes.length, 1);
    const next = f.context.add(entry, true);
    f.writes[0].pending.resolve({ presetId: 3 }); await old;
    assert.equal(f.context.busy, true, "old completion cannot release a newer operation");
    assert.equal(f.context.notice, "");
    f.writes[1].pending.resolve({ presetId: 4 }); await next;
    assert.equal(f.context.busy, false); assert.match(f.context.notice, /saved in PiPedal/);
    assert.match(f.context.recoveryNotice, /may have completed/);
    f.cleanup(); assert.equal(f.model.state._on_changed_handlers.length, 0);
});

test("interrupted upload batch and unmounted Library stop before additional files", async () => {
    const f = fixture("library"); await flush();
    const operation = f.context.upload(["first.t3kpreset", "second.t3kpreset"]);
    f.lose(); f.ready(); await flush(); f.cleanup();
    const reads = f.reads.length;
    f.uploads[0].pending.resolve({}); await operation;
    assert.equal(f.uploads.length, 1); assert.equal(f.reads.length, reads);
    assert.equal(f.context.notice, ""); assert.equal(f.model.state._on_changed_handlers.length, 0);
});

test("externally closing/reopening Library clears obsolete busy guards and ignores the original completion", async () => {
    const f = fixture("library"); await flush();
    const operation = f.context.add({ key: "user:x", name: "Rig", imports: [] }, true);
    assert.equal(f.context.busy, true);
    f.reopen(); await flush();
    assert.equal(f.context.busy, false); assert.equal(f.context.refreshing, false);
    assert.equal(f.context.working.current, false); assert.equal(f.writes.length, 1);
    assert.match(f.context.recoveryNotice, /may have completed/);
    assert.equal(f.alerts.length, 1, "forced closure retains uncertainty outside the destroyed dialog");
    f.writes[0].pending.resolve({}); await operation;
    assert.equal(f.context.notice, ""); assert.equal(f.context.busy, false);
    assert.equal(f.model.state._on_changed_handlers.length, 1); f.cleanup();
});

test("Rig Apply interruption preserves draft/revision conflict and refresh confirms actual state without replay", async () => {
    const f = fixture("rig"); await flush();
    const edited = structuredClone(f.current.summary.blocks); edited[0].mix = .9;
    f.context.edit({ blocks: edited });
    const operation = f.context.apply();
    assert.equal(f.context.busy, true); assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].args[2].blocks[0].mix, .9);
    f.lose(); assert.equal(f.context.busy, false); assert.equal(f.context.waiting, false);
    assert.equal(f.context.rigDirty.current, true); assert.equal(f.context.draft.blocks[0].mix, .9);
    // A different observed edit remains a conflict; exact draft matches are
    // reconciled by the full production-component tests in Tone3000EditState.
    const actual = structuredClone(f.current); actual.revision = "applied"; actual.summary.blocks[0].mix = .85;
    f.setCurrent(actual); f.ready(); await flush();
    assert.equal(f.context.stale, true); assert.equal(f.context.rig.revision, "original");
    assert.equal(f.writes.length, 1, "reconcile never reapplies the patch");
    const reads = f.reads.length;
    f.writes[0].pending.resolve(true); await operation;
    assert.equal(f.reads.length, reads, "late mutation completion cannot trigger follow-up state reads");
    assert.equal(f.context.notice, "");
    await f.context.refresh(true);
    assert.equal(f.context.rig.revision, "applied"); assert.equal(f.context.stale, false);
    assert.equal(f.context.rigDirty.current, false); assert.match(f.context.recoveryNotice, /may have completed/);
    f.cleanup();
});

test("old defaults save cannot overwrite a new operation; disposal removes listeners and stale results", async () => {
    const f = fixture("rig", "Settings"); await flush(); f.context.profileDirty.current = true;
    const old = f.context.saveDefaults(); f.lose(); f.ready(); await flush();
    const next = f.context.saveDefaults();
    f.writes[0].pending.resolve({ ...f.profile, revision: "old-reply" }); await old;
    assert.equal(f.context.busy, true); assert.equal(f.context.defaults.revision, "profile-original");
    f.cleanup(); f.writes[1].pending.resolve({ ...f.profile, revision: "new-after-dispose" }); await next;
    assert.equal(f.context.defaults.revision, "profile-original"); assert.equal(f.context.notice, "");
    assert.equal(f.model.state._on_changed_handlers.length, 0); assert.equal(f.context.working.current, false);
});

test("changing tabs does not strand an accepted operation or replay it", async () => {
    const f = fixture("rig"); await flush();
    const edited = structuredClone(f.current.summary.blocks); edited[0].mix = .8;
    f.context.edit({ blocks: edited }); const operation = f.context.apply();
    const actual = structuredClone(f.current); actual.revision = "accepted"; actual.summary.blocks[0].mix = .8;
    f.setCurrent(actual); f.remountInactive();
    f.writes[0].pending.resolve(true); await operation;
    assert.equal(f.context.busy, false); assert.equal(f.context.rig.revision, "accepted");
    assert.equal(f.writes.length, 1); f.cleanup();
});
