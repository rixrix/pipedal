import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { tone3000NumberPresentation, presentPatchNumber, rawPatchNumber } from "../src/pipedal/Tone3000ControlUnits.ts";

const uri = id => "https://www.tone3000.com/plugin:" + id;
const scale = id => tone3000NumberPresentation(uri(id), 0, 1);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ~= ${b}`);
function control() {
    return { min_value: 0, max_value: 1, default_value: .5, label: "stock",
        valueToRange(value) { return Math.max(0, Math.min(1, value)); },
        rangeToValue(value) { return Math.max(0, Math.min(1, value)); },
        formatDisplayValue: String, formatShortValue: String };
}

/** Pinned native values are physical outputs, not another normalized faceplate map.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-16] [DES-STAGE] [7.3]
 */
test("gain/balance/delay/frequency endpoints and centres match native units", () => {
    for (const id of ["inputLevel", "outputLevel", "spreadOffset", "alignOffset"]) {
        const p = scale(id);
        assert.deepEqual([0, .5, 1].map(p.toDisplay), [-24, 0, 24]);
    }
    assert.deepEqual([0, .5, 1].map(scale("outputBalance").toDisplay), [-12, 0, 12]);
    assert.deepEqual([0, .5, 1].map(scale("spreadCrossover").toDisplay), [32.5, 130, 520]);
    assert.equal(scale("alignOffset").format(-6), "6.0 ms L");
    assert.equal(scale("alignOffset").format(6), "6.0 ms R");
    assert.equal(scale("spreadOffset").format(0), "0 ms");
    assert.equal(scale("chainPanLeft").format(-100), "100% L");
    assert.equal(scale("chainPanRight").format(0), "C");
    assert.equal(scale("chainPanRight").format(100), "100% R");
});

test("every normalized physical mapping roundtrips without changing legal raw range", () => {
    for (const id of ["inputLevel", "outputLevel", "outputBalance", "spreadWobble", "alignWobble",
        "spreadOffset", "alignOffset", "spreadCrossover", "alignCrossover", "chainPanLeft", "chainPanRight"]) {
        const p = scale(id);
        for (const raw of [0, .001, .123456, .25, .5, .75, .999, 1]) close(p.fromDisplay(p.toDisplay(raw)), raw);
    }
});

test("stock knob geometry, defaults and text entry stay consistent with physical units", () => {
    const raw = control(), p = scale("inputLevel"), presented = presentPatchNumber(raw, p);
    assert.equal(presented.label, "stock");
    assert.deepEqual([presented.min_value, presented.max_value, presented.default_value], [-24, 24, 0]);
    assert.equal(presented.valueToRange(-6), .375);
    assert.equal(presented.rangeToValue(.375), -6);
    assert.equal(presented.formatDisplayValue(-6), "-6.0 dB");
    assert.equal(presented.formatShortValue(-6), "-6");
    assert.equal(rawPatchNumber(-6, raw, p), .375);
    assert.equal(raw.min_value, 0); assert.equal(raw.max_value, 1); assert.equal(raw.default_value, .5);
    assert.equal(raw.formatDisplayValue(.375), "0.375");
    const frequency = presentPatchNumber(raw, scale("alignCrossover"));
    close(frequency.valueToRange(130), .5); close(frequency.rangeToValue(.5), 130);
    assert.equal(frequency.valueToRange(-10), 0);
    assert.equal(frequency.rangeToValue(frequency.valueToRange(-10)), 32.5);
    assert.equal(frequency.valueToRange(10000), 1);
    assert.equal(rawPatchNumber(1000, raw, scale("alignCrossover")), 1);
    assert.throws(() => rawPatchNumber(NaN, raw, p), /finite/);
    assert.throws(() => rawPatchNumber(-1, raw, scale("alignCrossover")), /finite/);
});

test("real-unit fields are not converted twice; unfamiliar contracts keep stock rendering", () => {
    const p = tone3000NumberPresentation(uri("inputCalibrationLevel"), -60, 60);
    assert.equal(p.toDisplay(12), 12); assert.equal(p.fromDisplay(12), 12); assert.equal(p.format(12), "12.0 dBu");
    assert.equal(tone3000NumberPresentation(uri("pitchTonality"), 1000, 20000).format(20000), "Off");
    for (const args of [[uri("inputLevel"), -24, 24], [uri("gateThreshold"), 0, 1], ["https://other/plugin:inputLevel", 0, 1], [uri("osFactor"), 0, 2]])
        assert.equal(tone3000NumberPresentation(...args), undefined);
    const raw = control(); assert.equal(presentPatchNumber(raw), raw);
});

function patchHandlerFixture() {
    const require = createRequire(new URL("../package.json", import.meta.url)), ts = require("typescript");
    const source = ts.createSourceFile("PatchPropertyControl.tsx", readFileSync(new URL("../src/pipedal/PatchPropertyControl.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let handler;
    function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(source) === "setPatchValue") handler = node.initializer; ts.forEachChild(node, visit); }
    visit(source); assert.ok(handler);
    const sent = [], local = [], reads = [], errors = [], props = { instanceId: 42, property: { uri: uri("outputLevel"), readable: true }, numberPresentation: scale("outputLevel") };
    const context = { props, rawControl: control(), rawPatchNumber, setValue: value => local.push(value),
        lifetime: {current:0}, readOwner: {current:0}, writeGeneration: {current:0},
        model: { setPatchProperty: async (...args) => { sent.push(args); return true; },
            getPatchProperty: (...args) => { const pending=deferred(); reads.push({args,pending}); return pending.promise; } },
        console: {error: (...args) => errors.push(args)} };
    vm.runInNewContext(ts.transpileModule("globalThis.handler = " + handler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return {context,props,sent,local,reads,errors};
}
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush = async () => {for(let i=0;i<8;++i)await Promise.resolve();};
test("production patch handler sends raw LV2 values while displaying physical values", async () => {
    const {context,props,sent,local,reads}=patchHandlerFixture();
    context.handler(-6); await flush();
    assert.deepEqual(sent, [[42, uri("outputLevel"), .375]]); assert.deepEqual(local, [.375]);
    props.numberPresentation = undefined; context.handler(.123456); await flush();
    assert.equal(sent[1][2], .123456);
    assert.equal(reads.length,0,"ordinary successful patch writes keep stock behavior");
});

test("opted-in coupled writes receive raw values and authoritative readback; obsolete replies cannot overwrite a newer gesture", async () => {
    const {context,props,sent,local,reads}=patchHandlerFixture(), writes=[];
    props.onRawSet=value=>{const pending=deferred();writes.push({value,pending});return pending.promise;};
    context.handler(-6);assert.equal(writes[0].value,.375);assert.deepEqual(sent,[]);assert.deepEqual(local,[.375]);
    writes[0].pending.resolve(true);await flush();assert.deepEqual(reads[0].args,[42,uri("outputLevel")]);
    reads[0].pending.resolve(.31);await flush();assert.equal(local.at(-1),.31,"native coupled result replaces optimistic raw value");
    context.handler(-12);context.handler(0);writes[1].pending.resolve(true);await flush();assert.equal(reads.length,1,"obsolete coupled completion cannot trigger readback");
    writes[2].pending.resolve(true);await flush();assert.equal(reads.length,2);
    ++context.lifetime.current;reads[1].pending.resolve(.9);await flush();assert.equal(local.at(-1),.5,"old control lifetime cannot change newly selected view");
});

test("coupled failure refreshes actual state and logs only while its control lifetime is current", async () => {
    const {context,props,sent,local,reads,errors}=patchHandlerFixture(), writes=[];
    props.onRawSet=()=>{const pending=deferred();writes.push(pending);return pending.promise;};
    context.handler(-6);writes[0].reject(new Error("stale native revision"));await flush();assert.equal(errors.length,1);assert.equal(reads.length,1);assert.deepEqual(sent,[]);
    reads[0].pending.resolve(.4);await flush();assert.equal(local.at(-1),.4);
    context.handler(0);++context.lifetime.current;writes[1].reject(new Error("disconnected"));await flush();
    assert.equal(errors.length,1,"disposed failures stay handled without obsolete logging");assert.equal(reads.length,1,"disposed failure cannot issue another read");
});

test("production default reset uses the patch callback; ordinary ports keep their existing reset path", () => {
    const require = createRequire(new URL("../package.json", import.meta.url)), ts = require("typescript");
    const source = ts.createSourceFile("PluginControl.tsx", readFileSync(new URL("../src/pipedal/PluginControl.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let reset;
    function visit(node) { if (ts.isMethodDeclaration(node) && node.name.getText(source) === "resetToDefaultValue") reset = node; ts.forEachChild(node, visit); }
    visit(source); assert.ok(reset);
    const context = {};
    vm.runInNewContext(ts.transpileModule("class Control {" + reset.getText(source) + "}\nglobalThis.Control = Control;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    const component = new context.Control(), patchWrites = [], portWrites = [];
    const raw = control(), p = scale("outputLevel"), presented = presentPatchNumber(raw, p);
    component.props = { instanceId: 42, onResetToDefault: value => patchWrites.push(rawPatchNumber(value, raw, p)) };
    component.model = { setPedalboardControl: (...args) => portWrites.push(args) };
    component.resetToDefaultValue(presented);
    assert.deepEqual(patchWrites, [.5]); assert.equal(portWrites.length, 0);
    component.props.onResetToDefault = undefined; raw.symbol = "port";
    component.resetToDefaultValue(raw);
    assert.deepEqual(portWrites, [[42, "port", .5]]);
});
