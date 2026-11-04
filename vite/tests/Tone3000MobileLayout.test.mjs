import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { tone3000DraftNumber, tone3000FormatNumber, tone3000SameDraftNumber, tone3000ViewportStyles } from "../src/pipedal/Tone3000MobileLayout.ts";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const source = name => readFileSync(new URL("../src/pipedal/" + name, import.meta.url), "utf8");
const rigSource = source("Tone3000RigPanel.tsx");
const rigAst = ts.createSourceFile("panel.tsx", rigSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = name => rigAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(rigAst);

/** Exercise production field JSX handlers and hooks without claiming browser/IME coverage.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOLD-GEAR] [7.14]
 */
function fieldFixture(min = -24, step = .1, parentConvert = value => value) {
    const slots = [], effects = [];
    let cursor = 0, value = 0;
    const writes = [];
    const context = { TextField: "TextField", DraftTouchContext: {},
        useMediaQuery: () => false, useContext: () => ({ enabled: false, scopeKey: "" }),
        PiPedalModelFactory: { getInstance: () => ({}) }, tone3000DraftNumber, tone3000FormatNumber, tone3000SameDraftNumber,
        React: { createElement: (type, props, ...children) => ({ type, props, children }) },
        useState(initial) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
            return [slots[i], next => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }];
        },
        useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
        useEffect(callback, deps) {
            const i = cursor++, before = effects[i];
            if (!before || deps.some((item, index) => !Object.is(item, before[index]))) callback();
            effects[i] = deps;
        }
    };
    vm.createContext(context);
    vm.runInContext(ts.transpileModule(declaration("NumberField"), { compilerOptions: {
        target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
    const render = () => { cursor = 0; return context.NumberField({ label: "Gain", value, min, max: 24, step,
        onChange: next => { value = parentConvert(next); writes.push(next); } }).props; };
    return { render, writes, replace(next) { value = next; render(); } };
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-FOLD-GEAR] [7.14] */
test("local numeric drafts reject blank, incomplete and nonfinite entries without coercion", () => {
    for (const text of ["", " ", "-", "+", ".", "-.", "NaN", "Infinity", "1,2,3", "1e1000", "--1"])
        assert.ok(Number.isNaN(tone3000DraftNumber(text)), text);
    assert.equal(tone3000DraftNumber("-0,25"), -.25);
    assert.equal(tone3000DraftNumber(" 12.5 "), 12.5);
    assert.equal(tone3000DraftNumber(".5"), .5);
    assert.equal(tone3000FormatNumber(-1.234, .1), "-1.2");
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-FOLD-GEAR] [7.14] */
test("production field retains partial signed and decimal text through rerenders; Done only blurs", () => {
    const field = fieldFixture(); field.render().onFocus();
    for (const text of ["-", "-.", "-0.", "-0.25"]) {
        field.render().onChange({ target: { value: text } });
        assert.equal(field.render().value, text);
    }
    assert.equal(field.writes.at(-1), -.25);
    let blurred = 0, prevented = 0;
    const before = field.writes.length;
    field.render().onKeyDown({ key: "Enter", nativeEvent: { isComposing: false },
        target: { blur() { ++blurred; } }, preventDefault() { ++prevented; } });
    assert.equal(blurred, 1); assert.equal(prevented, 1); assert.equal(field.writes.length, before);
    field.render().onBlur();
    assert.equal(field.render().value, "-0.25");
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-FOLD-GEAR] [7.14] */
test("invalid draft stays invalid after blur and authoritative replacement discards it", () => {
    const field = fieldFixture(); field.render().onFocus();
    field.render().onChange({ target: { value: "-" } });
    field.render().onBlur();
    assert.equal(field.render().value, "-"); assert.equal(field.render().error, true);
    field.replace(3);
    assert.equal(field.render().value, "3"); assert.equal(field.render().error, false);
    field.render().onFocus(); field.render().onChange({ target: { value: "-" } });
    field.replace(5); assert.equal(field.render().value, "5");
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-FOLD-GEAR] [7.14] */
test("range errors, composition and signed/mobile keyboard hints use production handlers", () => {
    const field = fieldFixture(); field.render().onFocus();
    field.render().onChange({ target: { value: "25" } });
    assert.equal(field.render().error, true);
    assert.equal(field.render().inputProps.inputMode, "text");
    assert.equal(field.render().inputProps.enterKeyHint, "done");
    assert.equal(field.render().sx["& .MuiInputBase-root"].minHeight, 44);
    field.render().onKeyDown({ key: "Enter", nativeEvent: { isComposing: true },
        target: { blur() { assert.fail("composing Enter must not blur"); } }, preventDefault() { assert.fail(); } });
    assert.equal(fieldFixture(0, 1).render().inputProps.inputMode, "numeric");
    assert.equal(fieldFixture(0, .01).render().inputProps.inputMode, "decimal");
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOLD-GEAR] [7.14] */
test("T3K viewport reserves remaining height on short, cover and unfolded screens", () => {
    for (const [height, short] of [[320, true], [440, true], [760, false], [840, false]]) {
        const layout = tone3000ViewportStyles(height, short);
        assert.ok(layout.chain.maxHeight > 0 && layout.chain.maxHeight < height / 2);
        assert.equal(layout.controls.flex, "1 1 0"); assert.equal(layout.controls.minHeight, 0);
    }
    const main = source("MainPage.tsx");
    assert.match(main, /tone3000Panel = pluginUri === "https:\/\/www.tone3000.com\/plugin"/);
    assert.match(main, /style=\{tone3000Panel \? t3kViewport.controls : undefined\}/);
    assert.match(main, /className=\{horizontalScrollLayout \? classes.controlContentSmall : classes.controlContent\}/);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-FOLD-GEAR] [7.14] */
test("collapse remains presentation-only with mounted children; graph focus expands first", () => {
    const block = declaration("BlockCard");
    assert.match(block, /unmountOnExit: false/);
    assert.match(block, /onChange=\{\(_event, open\) => onToggle\(open\)\}/);
    assert.doesNotMatch(block, /setTone3000CurrentState|setTone3000Defaults|\.apply\(/);
    assert.match(rigSource, /expandedBlock !== focusedBlock.blockId[\s\S]*setExpandedBlock\(focusedBlock.blockId\);[\s\S]*return;[\s\S]*scrollIntoView/);
    const view = source("Tone3000View.tsx");
    assert.match(view, /hidden=\{active !== title\}/);
    assert.match(view, /title === "Blocks" \|\| title === "Settings"/);
    assert.match(view, /tone3000ControlLayout.find\(tab => tab.title === title\)/);
    assert.match(view, /@container \(max-width: 440px\)/);
    assert.doesNotMatch(rigSource, /minWidth: 260/);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-20] [DES-STAGE-BRIDGE] [7.5] */
test("Soundcheck initializes from an already-connected host and cancels on disconnect", () => {
    const code = source("Tone3000SoundcheckPanel.tsx");
    const ast = ts.createSourceFile("soundcheck.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect;
    const visit = node => {
        if (!effect && ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect") effect = node.arguments[0];
        ts.forEachChild(node, visit);
    };
    visit(ast);
    const handlers = new Map(), stops = [];
    const property = initial => ({ get: () => initial, addOnChangedHandler(fn) { handlers.set(this, fn); }, removeOnChangedHandler(fn) { if (handlers.get(this) === fn) handlers.delete(this); } });
    const state = property(1), presets = property({ selectedInstanceId: 7, presetChanged: false }), banks = property({ selectedBank: 6 });
    const values = {};
    const context = { model: { state, presets, banks }, State: { Ready: 1 },
        working: { current: false }, generation: { current: 0 }, runner: { current: { stop() { stops.push(true); } } } };
    for (const name of ["Busy", "Result", "Blocks", "Ready", "Notice", "Dirty"]) context["set" + name] = value => { values[name] = value; };
    vm.createContext(context);
    const compiled = ts.transpileModule("const mount = " + effect.getText(ast) + "; mount();", {
        compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const cleanup = vm.runInContext(compiled, context);
    assert.equal(values.Ready, true, "already Ready must enable Soundcheck without reconnect");
    context.working.current = true; handlers.get(state)(0);
    assert.equal(values.Ready, false); assert.equal(values.Busy, false);
    assert.match(values.Notice, /Connection lost/); assert.equal(stops.length, 1);
    cleanup(); assert.equal(handlers.size, 0);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-FOLD-GEAR] [7.14] */
test("focused gain drafts survive the actual dB-to-normalized-to-dB parent conversion", () => {
    const field = fieldFixture(-24, .1, db => ((db / 48 + .5) - .5) * 48);
    field.render().onFocus();
    for (const text of ["1.", "-0.12", "-0.", "0,25"]) {
        field.render().onChange({ target: { value: text } });
        assert.equal(field.render().value, text);
    }
    field.replace(4); assert.equal(field.render().value, "4");
});
