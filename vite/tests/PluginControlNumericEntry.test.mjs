import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript');
const text = readFileSync(new URL('../src/pipedal/PluginControl.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile('PluginControl.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// Execute the production editing methods, not a second validator/sync implementation.
function fixture() {
    const names = ['inputContextKey', 'componentDidUpdate', 'onInputFocus', 'onInputChange', 'onInputLostFocus', 'onInputKeyDown', 'validateInput'];
    const methods = new Map();
    const visit = node => {
        if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(source))) methods.set(node.name.getText(source), node.getText(source));
        ts.forEachChild(node, visit);
    };
    visit(source); assert.equal(methods.size, names.length);
    const context = { document: { activeElement: null } };
    vm.runInNewContext(ts.transpileModule('globalThis.Editor = class {' + [...methods.values()].join('\n') + '}',
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    const editor = new context.Editor();
    const commits = [], previews = [], selection = { bank: 6, preset: 26, snapshot: -1, state: 1 };
    const control = { symbol: 'gain', min_value: -24, max_value: 24,
        formatShortValue: v => String(v), valueToRange: v => Math.max(0, Math.min(1, (v + 24) / 48)), rangeToValue: r => r * 48 - 24 };
    editor.props = { instanceId: 1, value: 0, uiControl: control };
    editor.currentValue = 0;
    editor.state = { editFocused: false, error: false };
    editor.inputChanged = false;
    editor.setState = patch => Object.assign(editor.state, patch);
    editor.model = { banks: { get: () => ({ selectedBank: selection.bank }) }, presets: { get: () => ({ selectedInstanceId: selection.preset }) },
        pedalboard: { get: () => ({ selectedSnapshot: selection.snapshot }) }, state: { get: () => selection.state } };
    editor.previewInputValue = (v, committed) => (committed ? commits : previews).push(v);
    const input = { value: '0', selected: 0, blurred: 0,
        select() { ++this.selected; }, blur() { ++this.blurred; context.document.activeElement = null; editor.onInputLostFocus({ currentTarget: input }); } };
    editor.inputRef = { current: input };
    const focus = () => { context.document.activeElement = input; editor.onInputFocus({ currentTarget: input }); };
    const enter = composing => editor.onInputKeyDown({ key: 'Enter', nativeEvent: { isComposing: composing }, preventDefault() {} });
    const type = text => { input.value = text; editor.onInputChange({ currentTarget: input }); };
    return { editor, input, selection, context, commits, previews, control, focus, type, enter };
}

test('native focus selects text; incoming same-rig readbacks preserve the active draft', () => {
    const f = fixture(); f.focus(); f.type('-12.5');
    assert.equal(f.input.selected, 1);
    const before = f.editor.props; f.editor.props = { ...before, value: 4 };
    f.editor.componentDidUpdate(before);
    assert.equal(f.input.value, '-12.5'); assert.deepEqual(f.commits, []);
    // Browser focus is authoritative even before React's batched state catches up.
    f.editor.state.editFocused = false; f.editor.componentDidUpdate(f.editor.props);
    assert.equal(f.input.value, '-12.5');
});

test('Done commits a signed fraction exactly once and blur cannot repeat it', () => {
    const f = fixture(); f.focus(); f.type('-12.5'); f.enter(false);
    assert.deepEqual(f.commits, [-12.5]); assert.equal(f.input.blurred, 1);
    assert.equal(f.editor.state.editFocused, false);
});

test('locale decimal separator, finite range clamp and integer quantization use UiControl', () => {
    const f = fixture(); f.focus(); f.type('1,5'); f.enter(false);
    assert.deepEqual(f.commits, [1.5]);
    f.focus(); f.type('100'); f.enter(false); assert.equal(f.commits.at(-1), 24);
    f.control.rangeToValue = r => Math.round(r * 48 - 24);
    f.focus(); f.type('2.4'); f.enter(false); assert.equal(f.commits.at(-1), 2);
});

test('blank and nonfinite drafts restore current value without a committed write', () => {
    for (const text of ['', '   ', 'Infinity', '-Infinity', 'NaN', '1e999', '-', '1,2,3']) {
        const f = fixture(); f.focus(); f.type(text); f.enter(false);
        assert.equal(f.input.value, '0', text); assert.deepEqual(f.commits, [], text); assert.deepEqual(f.previews, [0], text);
    }
});

test('valid then invalid stock-port entry restores the live preview without saving', () => {
    const f = fixture(); f.focus(); f.type('12'); f.type('-'); f.enter(false);
    assert.deepEqual(f.previews, [12, 0]); assert.deepEqual(f.commits, []);
    assert.equal(f.input.value, '0');
});

test('composition Enter does not commit or dismiss the IME', () => {
    const f = fixture(); f.focus(); f.type('1.5'); f.enter(true);
    assert.deepEqual(f.commits, []); assert.equal(f.input.blurred, 0);
    f.enter(false); assert.deepEqual(f.commits, [1.5]);
});

test('same-instance preset, bank, snapshot and connection changes discard stale drafts', () => {
    for (const key of ['bank', 'preset', 'snapshot', 'state']) {
        const f = fixture(); f.focus(); f.type('12'); ++f.selection[key];
        f.editor.props.value = 3; f.editor.componentDidUpdate(f.editor.props);
        assert.equal(f.input.value, '3', key); assert.deepEqual(f.commits, [], key); assert.equal(f.input.blurred, 1, key);
        assert.equal(f.editor.inputChanged, false);
    }
    const f = fixture(); f.focus(); f.type('12'); ++f.selection.preset;
    f.enter(false); assert.deepEqual(f.commits, [], 'stale blur before render is also rejected');
});

test('external values synchronize while unfocused; changed control discards editing', () => {
    const f = fixture(); f.editor.props.value = 3; f.editor.componentDidUpdate(f.editor.props); assert.equal(f.input.value, '3');
    f.focus(); f.type('12'); const before = f.editor.props;
    f.editor.props = { ...before, instanceId: 2, value: 5 }; f.editor.componentDidUpdate(before);
    assert.equal(f.input.value, '5'); assert.deepEqual(f.commits, []); assert.equal(f.input.blurred, 1);
});

test('production input stays mounted and native tap routing/keyboard hints are explicit', () => {
    let numericInput;
    const visit = node => {
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Input') numericInput = node;
        ts.forEachChild(node, visit);
    };
    visit(source); assert.ok(numericInput);
    const attrs = numericInput.attributes.properties.map(p => p.name?.getText(source));
    assert.ok(!attrs.includes('key'), 'value changes must not remount the keyboard input');
    assert.ok(attrs.includes('onKeyDown'));
    assert.match(text, /pointerEvents: "none"/);
    assert.match(numericInput.getText(source), /control.min_value < 0 \? "text" : control.integer_property \? "numeric" : "decimal"/);
    assert.match(numericInput.getText(source), /step: control.integer_property \? 1 : "any"/);
    assert.match(numericInput.getText(source), /height: 44, boxSizing: "border-box", fontSize: 16/);
    assert.match(numericInput.getText(source), /enterKeyHint: "done"/);
});
