import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { tone3000TouchValue, tone3000TouchRange, tone3000TouchDrag, tone3000TouchSameValue } from "../src/pipedal/Tone3000TouchMath.ts";
import { tone3000DraftNumber } from "../src/pipedal/Tone3000MobileLayout.ts";

const ts = createRequire(new URL("../package.json", import.meta.url))("typescript");
const children = node => node?.props?.children?.flat(Infinity) ?? [];
const nodes = node => node && typeof node === "object" && "type" in node ? [node, ...children(node).flatMap(nodes)] : [];

/** Run actual editor handlers/effects with deterministic clocks and capture target.
 * Transport callbacks are recorded; the numeric/gesture/lifecycle implementation
 * is extracted directly from production, never mirrored in this harness.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-13] [FR-16] [DES-TOUCH-EDITOR] [7.27]
 */
function fixture(overrides = {}) {
    const raw = readFileSync(new URL("../src/pipedal/Tone3000TouchEditor.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("Editor.tsx", raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "Tone3000TouchEditor");
    let cursor = 0, tree, now = 0, serial = 0, closes = 0;
    const slots = [], effects = [], pending = [], timers = new Map(), previews = [], commits = [];
    let props = { open: true, value: .25, min: 0, max: 1, step: .01, label: "Level", scopeKey: "bank/preset/control",
        onChange: value => previews.push(value), onCommit: value => commits.push(value), onClose: () => ++closes, ...overrides };
    const context = { tone3000TouchValue, tone3000TouchRange, tone3000TouchDrag, tone3000TouchSameValue, tone3000DraftNumber,
        Date: { now: () => now },
        setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, when: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
        useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = initial;
            return [slots[at], value => { slots[at] = value; }]; },
        useRef(initial) { const at = cursor++; return slots[at] ??= { current: initial }; },
        useEffect(callback, deps) {
            const at = cursor++, prior = effects[at];
            if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i])))
                pending.push(() => { prior?.cleanup?.(); effects[at] = { deps, cleanup: callback() }; });
        }
    };
    for (const item of ast.statements.filter(ts.isImportDeclaration)) if (item.importClause?.name)
        context[item.importClause.name.text] = item.importClause.name.text;
    vm.runInNewContext(ts.transpileModule(component.getText(ast).replace(/^export default /, "")
        + "\nglobalThis.component = Tone3000TouchEditor;", { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
    const render = () => { cursor = 0; tree = context.component(props); pending.splice(0).forEach(callback => callback()); return tree; };
    const capture = new Set(), element = { setPointerCapture: id => capture.add(id), releasePointerCapture: id => capture.delete(id),
        hasPointerCapture: id => capture.has(id), getBoundingClientRect: () => ({ width: 232 }) };
    const event = x => ({ clientX: x, pointerId: 1, button: 0, currentTarget: element, preventDefault() {}, stopPropagation() {} });
    render(); render();
    return { previews, commits, render, timers,
        all: () => nodes(tree), slider: () => nodes(tree).find(node => node.props.role === "slider"),
        button: label => nodes(tree).find(node => node.type === "Button" && children(node).includes(label)),
        closes: () => closes, event,
        update(value) { props = { ...props, ...value }; render(); render(); },
        advance(ms) { now += ms; for (const [id, value] of [...timers]) if (value.when <= now) { timers.delete(id); value.callback(); } },
        unmount() { effects.forEach(effect => effect?.cleanup?.()); }
    };
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-16] [DES-TOUCH-EDITOR] [7.27] */
test("actual math preserves endpoints, native logarithmic midpoint and fine steps; invalid geometry refuses writes", () => {
    const scale = { min: 20, max: 20000, step: 1, valueToRange: value => Math.log(value / 20) / Math.log(1000),
        rangeToValue: range => 20 * 1000 ** range };
    assert.equal(tone3000TouchDrag(20, 0, 200, scale), 20);
    assert.equal(tone3000TouchDrag(20, 100, 200, scale), 632);
    assert.equal(tone3000TouchDrag(20, 200, 200, scale), 20000);
    assert.equal(tone3000TouchValue(-1.25, { min: -24, max: 24, step: .01 }), -1.25);
    assert.equal(tone3000TouchValue(.1 + .2, { min: 0, max: 1, step: .01 }), .3);
    for (const value of [NaN, Infinity]) assert.ok(Number.isNaN(tone3000TouchValue(value, scale)));
    assert.ok(Number.isNaN(tone3000TouchDrag(20, 1, 0, scale)));
    assert.ok(Number.isNaN(tone3000TouchRange(20, { ...scale, valueToRange: () => Infinity })));
    assert.ok(Number.isNaN(tone3000TouchDrag(20, 1, 100, { ...scale, rangeToValue: () => { throw Error("bad converter"); } })));
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-16] [DES-TOUCH-EDITOR] [7.27] */
test("production track tap never jumps; drag coalesces previews and commits the exact final value once", () => {
    const f = fixture(), slider = f.slider();
    assert.equal(f.all().some(node => node.type === "TextField"), false, "keyboard input is absent until explicitly requested");
    assert.equal(f.button("Done").props.autoFocus, true, "initial modal focus targets a non-text action, never the background input");
    assert.equal(f.all().find(node => node.type === "DialogEx").props.disableAutoFocus, undefined);
    const title = f.all().find(node => node.type === "DialogTitle");
    assert.equal(nodes(title).filter(node => node.props.component === "output").length, 1, "value shares the compact title row");
    slider.props.onPointerDown(f.event(180)); slider.props.onPointerUp(f.event(180));
    assert.deepEqual(f.previews, []); assert.deepEqual(f.commits, []);
    slider.props.onPointerDown(f.event(50));
    for (const x of [70, 90, 110]) slider.props.onPointerMove(f.event(x));
    assert.deepEqual(f.previews, [.35]); assert.equal(f.timers.size, 1);
    f.advance(34); assert.deepEqual(f.previews, [.35, .55]);
    slider.props.onPointerMove(f.event(130)); slider.props.onPointerUp(f.event(140));
    assert.deepEqual(f.commits, [.7]); assert.equal(f.timers.size, 0);
    f.advance(1000); assert.deepEqual(f.previews, [.35, .55]);
    slider.props.onPointerUp(f.event(140)); assert.equal(f.commits.length, 1);
    f.unmount();
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-TOUCH-EDITOR] [7.27] */
test("production pointer cancel restores preview without a commit; close/unmount discard scheduled values", () => {
    const f = fixture(), slider = f.slider();
    slider.props.onPointerDown(f.event(50)); slider.props.onPointerMove(f.event(90)); slider.props.onPointerMove(f.event(110));
    slider.props.onPointerCancel(f.event(110));
    assert.deepEqual(f.previews, [.45, .25]); assert.deepEqual(f.commits, []);
    slider.props.onPointerUp(f.event(110)); f.advance(1000); assert.deepEqual(f.previews, [.45, .25]);
    slider.props.onPointerDown(f.event(50)); slider.props.onPointerMove(f.event(70)); slider.props.onPointerMove(f.event(100));
    f.update({ open: false }); const count = f.previews.length;
    f.advance(1000); slider.props.onPointerUp(f.event(100)); assert.equal(f.previews.length, count); assert.deepEqual(f.commits, []);
    f.unmount();
    const other = fixture(); other.slider().props.onPointerDown(other.event(50));
    other.slider().props.onPointerMove(other.event(70)); other.slider().props.onPointerMove(other.event(90));
    other.unmount(); const emitted = other.previews.length; other.advance(1000); assert.equal(other.previews.length, emitted);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-TOUCH-EDITOR] [7.27] */
test("production idle readbacks preserve owned Restore baseline and external MIDI replaces it; scope change rejects old drag", () => {
    const f = fixture(); f.button("+").props.onClick(); assert.deepEqual(f.commits, [.26]);
    f.update({ value: .25999999046325684 }); f.button("Restore starting value").props.onClick();
    assert.equal(f.commits.at(-1), .25, "own float32 echo does not redefine the opening baseline");
    f.update({ value: .6 }); f.button("+").props.onClick(); f.button("Restore starting value").props.onClick();
    assert.equal(f.commits.at(-1), .6, "new external authoritative value owns Restore");
    const slider = f.slider(); slider.props.onPointerDown(f.event(50)); slider.props.onPointerMove(f.event(70));
    f.update({ scopeKey: "other preset", value: .1 }); const before = f.commits.length, previews = f.previews.length;
    slider.props.onPointerUp(f.event(150)); f.advance(1000);
    assert.equal(f.commits.length, before); assert.equal(f.previews.length, previews);
    f.unmount();
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-13] [DES-TOUCH-EDITOR] [7.27] */
test("production keyboard entry is explicit and validates complete bounded text before commit", () => {
    const f = fixture(); f.button("Enter value").props.onClick(); f.render();
    const field = () => f.all().find(node => node.type === "TextField");
    assert.equal(field().props.autoFocus, true);
    for (const value of ["", "-", "Infinity", "2"]) {
        field().props.onChange({ target: { value } }); f.render();
        assert.equal(field().props.error, true); assert.equal(f.button("Set value").props.disabled, true);
    }
    field().props.onChange({ target: { value: "0,75" } }); f.render();
    assert.equal(field().props.error, false); f.button("Set value").props.onClick(); assert.deepEqual(f.commits, [.75]);
    f.render(); f.button("Done").props.onClick(); assert.equal(f.closes(), 1); assert.equal(f.commits.length, 1); f.unmount();
    const releaseOnly = fixture({ onChange: undefined }); const slider = releaseOnly.slider();
    slider.props.onPointerDown(releaseOnly.event(50)); slider.props.onPointerMove(releaseOnly.event(100));
    assert.equal(releaseOnly.timers.size, 0); slider.props.onPointerUp(releaseOnly.event(100));
    assert.deepEqual(releaseOnly.previews, []); assert.deepEqual(releaseOnly.commits, [.5]); releaseOnly.unmount();
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [FR-16] [DES-TOUCH-EDITOR] [7.27] */
test("production Restore preserves exact off-grid opening values; explicit entry keeps fractions and bipolar zero is marked", () => {
    const f = fixture({ value: 11.999998, min: -24, max: 24, step: .1 });
    assert.ok(f.all().some(node => node.props.title === "Zero"));
    f.button("+").props.onClick(); assert.deepEqual(f.commits, [12.1]);
    f.button("Restore starting value").props.onClick(); assert.equal(f.commits.at(-1), 11.999998);
    assert.equal(f.button("Restore starting value").props.fullWidth, true);
    f.button("Enter value").props.onClick(); f.render();
    assert.equal(f.all().find(node => node.type === "TextField").props.inputProps.inputMode, "text", "signed entry can expose a minus on Android");
    f.all().find(node => node.type === "TextField").props.onChange({ target: { value: "6.143" } }); f.render();
    f.button("Set value").props.onClick(); assert.equal(f.commits.at(-1), 6.143, "fine step applies to dragging, not an exact typed continuous value");
    f.update({ disabled: true }); f.update({ disabled: false });
    f.button("Restore starting value").props.onClick(); assert.equal(f.commits.at(-1), 11.999998, "temporary disabling never takes baseline ownership");
    f.unmount();
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-TOUCH-EDITOR] [7.27] */
test("production old button, entry and pointer callbacks cannot alter or close a newer editor session", () => {
    const f = fixture(), oldIncrease = f.button("+"), oldDone = f.button("Done"), oldSlider = f.slider();
    f.button("Enter value").props.onClick(); f.render();
    const oldField = f.all().find(node => node.type === "TextField"), oldSet = f.button("Set value");
    f.update({ open: false }); f.update({ open: true, value: .6 });
    const slider = f.slider(); slider.props.onPointerDown(f.event(50)); slider.props.onPointerMove(f.event(70)); slider.props.onPointerMove(f.event(90));
    const before = f.previews.length;
    oldIncrease.props.onClick(); oldDone.props.onClick(); oldSet.props.onClick();
    oldField.props.onChange({ target: { value: ".9" } }); oldSlider.props.onPointerUp(f.event(150));
    assert.deepEqual(f.commits, []); assert.equal(f.closes(), 0);
    assert.equal(f.timers.size, 1, "obsolete callbacks must not cancel a newer gesture's pending preview");
    f.advance(34); assert.equal(f.previews.length, before + 1); assert.equal(f.previews.at(-1), .8);
    slider.props.onPointerUp(f.event(90)); assert.deepEqual(f.commits, [.8]); f.unmount();
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-16] [DES-FOUR-REFINEMENTS] [7.28] */
test("Fine mode latches ten times slower drag, keeps step/Restore, and resets for the next owner", () => {
    const f = fixture({ value: 0, min: -24, max: 24, step: .1 });
    assert.equal(f.button("Fine").props["aria-pressed"], false);
    f.button("Fine").props.onClick(); f.render();
    assert.equal(f.button("Fine").props["aria-pressed"], true);
    let slider = f.slider(); slider.props.onPointerDown(f.event(50));
    slider.props.onPointerMove(f.event(100)); assert.deepEqual(f.previews, [1.2]);
    f.button("Fine").props.onClick(); f.render();
    slider = f.slider(); slider.props.onPointerUp(f.event(150));
    assert.deepEqual(f.commits, [2.4], "mid-gesture toggle never changes latched sensitivity");
    f.render(); f.button("+").props.onClick(); assert.equal(f.commits.at(-1), 2.5);
    f.button("Restore starting value").props.onClick(); assert.equal(f.commits.at(-1), 0);
    f.render(); slider = f.slider(); slider.props.onPointerDown(f.event(50)); slider.props.onPointerUp(f.event(150));
    assert.equal(f.commits.at(-1), 24, "next ordinary drag spans the original full range");
    f.button("Fine").props.onClick(); f.render(); const oldFine = f.button("Fine");
    f.update({ scopeKey: "new owner", value: 0 });
    assert.equal(f.button("Fine").props["aria-pressed"], false);
    oldFine.props.onClick(); f.render(); assert.equal(f.button("Fine").props["aria-pressed"], false);
    f.unmount();
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-16] [DES-FOUR-REFINEMENTS] [7.28] */
test("Fine drag keeps logarithmic native geometry and release-only dispatch", () => {
    const f = fixture({ value: 20, min: 20, max: 20000, step: 1, onChange: undefined,
        valueToRange: value => Math.log(value / 20) / Math.log(1000), rangeToValue: range => 20 * 1000 ** range });
    f.button("Fine").props.onClick(); f.render(); const slider = f.slider();
    slider.props.onPointerDown(f.event(50)); slider.props.onPointerMove(f.event(150)); slider.props.onPointerUp(f.event(250));
    assert.deepEqual(f.previews, []); assert.deepEqual(f.commits, [40]); assert.equal(f.timers.size, 0);
    f.unmount();
});
