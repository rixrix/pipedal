import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { projectTone3000Chain } from "../src/pipedal/Tone3000ChainProjection.ts";
import { tone3000GearIcon, tone3000GearLabel, tone3000LogoIcon } from "../src/pipedal/Tone3000Gear.ts";
import { tone3000NumberPresentation } from "../src/pipedal/Tone3000ControlUnits.ts";
import { Tone3000PreviewReader } from "../src/pipedal/Tone3000PreviewReader.ts";

const require = createRequire(new URL("../package.json", import.meta.url)), ts = require("typescript");
const { build } = require("esbuild");
const read = name => readFileSync(new URL("../src/pipedal/" + name, import.meta.url), "utf8");
const children = node => node?.props?.children?.flat(Infinity) ?? [];
const nodes = node => node && typeof node === "object" && "type" in node ? [node, ...children(node).flatMap(nodes)] : [];
const actualModule = async name => {
    const result = await build({ entryPoints: [fileURLToPath(new URL("../src/pipedal/" + name, import.meta.url))],
        bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent" });
    const context = { module: { exports: {} } }; vm.runInNewContext(result.outputFiles[0].text, context); return context.module.exports;
};
const board = await actualModule("Pedalboard.tsx"), metadata = await actualModule("Lv2Plugin.tsx");

/** Actual production components/board classes and projection; only DOM is replaced.
 * No fake host plugins, model methods, state parsers or alternate routing logic.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [FR-17] [DES-FOUR-REFINEMENTS] [7.31]
 */
function renderer() {
    const context = { React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
        ...board, ...metadata, projectTone3000Chain, tone3000GearIcon, tone3000GearLabel, tone3000LogoIcon,
        tone3000NumberPresentation, Tone3000PreviewReader, State: { Ready: 1 },
        Box: "Box", Typography: "Typography", Paper: "Paper", Stack: "Stack", Alert: "Alert", PedalboardView: "PedalboardView",
        DialogEx: "DialogEx", DialogTitle: "DialogTitle", DialogContent: "DialogContent", DialogActions: "DialogActions", Button: "Button" };
    const compile = code => vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
    const chain = ts.createSourceFile("Chain.tsx", read("Tone3000ChainView.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const chainFunction = chain.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "Tone3000ChainView");
    compile(chainFunction.getText(chain).replace(/^export default /, "") + "\nglobalThis.Tone3000ChainView = Tone3000ChainView;");
    const preview = ts.createSourceFile("Preview.tsx", read("Tone3000PresetPreviewDialog.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const gain = preview.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(node => node.name.getText(preview) === "blockGain"));
    const stored = preview.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "StoredChain");
    compile(gain.getText(preview) + "\n" + stored.getText(preview) + "\nglobalThis.StoredChain = StoredChain;");
    const dialog = preview.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "Tone3000PresetPreviewDialog");
    compile(dialog.getText(preview).replace(/^export default /, "") + "\nglobalThis.Dialog = Tone3000PresetPreviewDialog;");
    return {
        stored: (summary, title = "Source") => context.StoredChain({ title, state: { summary, namCount: 1, irCount: 1, embeddedBytes: 20 } }),
        chain: props => context.Tone3000ChainView(props),
        dialog(selection, result) {
            const model = { state: { get: () => 1 } }; context.PiPedalModelFactory = { getInstance: () => model };
            const states = [{ loading: false, error: "", result }, selection, true]; let cursor = 0;
            context.useState = () => [states[cursor++], () => {}]; context.useRef = value => ({ current: value }); context.useEffect = () => {};
            return context.Dialog({ selection, onClose() {}, onConfirm() {} });
        }
    };
}
const block = (blockId, lane, index, type = "nam") => ({ blockId, lane, index, type, enabled: true, title: blockId,
    gear: type === "ir" ? "cab" : "amp", format: type, inputGain: .5, outputGain: .5, mix: 1, normalize: false,
    slimSize: 1, activeModelId: null, capabilityUnknown: true, eq: { enabled: false, pre: false, bands: [] } });
const summary = (blocks, patch = {}) => ({ activePresetName: "Saved", blocks, inputMode: "left", stereoEnabled: false,
    branchSide: "left", branchAfterBlockId: "", ...patch });

/** Ordinary host cloning must retain split-source provenance without aliasing it.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [7.36] */
test("actual Pedalboard clone and wire deserialize retain independent derived-stage metadata", () => {
    const item = new board.PedalboardItem();
    item.instanceId = 7; item.uri = "https://www.tone3000.com/plugin";
    item.tone3000DerivedSource = { bankId: 6, presetId: 24, instanceId: 1, revision: "saved", ampBlockId: "amp", cabBlockId: "cab", stage: "amp", creationId: "creation", requestHash: "request" };
    item.tone3000FollowDefaults = false;
    const copy = item.clone(), wire = new board.PedalboardItem().deserialize(JSON.parse(JSON.stringify(item)));
    assert.equal(JSON.stringify(copy.tone3000DerivedSource), JSON.stringify(item.tone3000DerivedSource));
    assert.equal(JSON.stringify(wire.tone3000DerivedSource), JSON.stringify(item.tone3000DerivedSource));
    copy.tone3000DerivedSource.stage = "cab"; assert.equal(item.tone3000DerivedSource.stage, "amp");
    assert.equal(new board.PedalboardItem().tone3000DerivedSource, null, "ordinary rigs remain ordinary");
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [FR-17] [DES-FOUR-REFINEMENTS] [7.31] */
test("production saved preview routes mono/stereo/shared summaries through isolated noninteractive stock boards", () => {
    const render = renderer();
    const cases = [summary([block("amp", "left", 0), block("cab", "left", 1, "ir")]),
        summary([block("L", "left", 0), block("R", "right", 0, "ir")], { stereoEnabled: true, inputMode: "stereo" }),
        summary([block("shared", "left", 0), block("L", "left", 1), block("R", "right", 0, "ir")], { stereoEnabled: true, branchAfterBlockId: "shared" })];
    for (const [index, state] of cases.entries()) {
        const before = structuredClone(state), stored = render.stored(state, "Saved target: Rx");
        const details = nodes(stored).find(node => node.props.component === "details");
        assert.ok(details); assert.equal(details.props.open, undefined, "native details starts collapsed");
        const chain = nodes(details).find(node => typeof node.type === "function");
        assert.equal(chain.props.summary, state); assert.equal(chain.props.parent, undefined); assert.equal(chain.props.onBlockClick, undefined);
        const result = render.chain(chain.props), view = nodes(result).find(node => node.type === "PedalboardView");
        assert.ok(view); assert.equal(view.props.readOnly, true); assert.equal(view.props.enableStructureEditing, false);
        assert.equal(view.props.omitDisplayTerminals, false); assert.equal(view.props.onDisplayNodeClick, undefined);
        assert.equal(view.props.selectedId, undefined); assert.ok(Object.values(view.props.displayNodes).every(node => !node.clickable));
        assert.ok(nodes(result).some(node => node.props["aria-label"] === "Saved target: Rx routing diagram"));
        const items = view.props.displayBoard.items;
        if (index === 0) { assert.equal(items.length, 2); assert.equal(items[0].uri, ""); }
        if (index === 1) { assert.equal(items.length, 1); assert.equal(items[0].topChain.length, 1); assert.equal(items[0].bottomChain.length, 1); }
        if (index === 2) { assert.equal(items.length, 2); assert.equal(items[0].uri, ""); assert.equal(items[1].topChain.length, 1); assert.equal(items[1].bottomChain.length, 1); }
        assert.deepEqual(state, before);
    }
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [FR-17] [DES-FOUR-REFINEMENTS] [7.31] */
test("production preview unsupported routing falls back truthfully and default current heading remains intact", () => {
    const render = renderer(), invalid = summary([block("duplicate", "left", 0), block("duplicate", "right", 0)]);
    const chain = nodes(render.stored(invalid)).find(node => typeof node.type === "function");
    const result = render.chain(chain.props);
    assert.equal(result.type, "Alert"); assert.match(children(result).join(""), /Embedded chain unavailable/);
    assert.equal(nodes(result).some(node => node.type === "PedalboardView"), false);
    const ordinary = render.chain({ summary: summary([]) });
    assert.ok(nodes(ordinary).some(node => children(node).includes("Current embedded chain · Read only")));
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-FOUR-REFINEMENTS] [7.31] */
test("production Preview source/target disclosure keys are distinct and reset for another source or saved target", () => {
    const render = renderer(), state = { summary: summary([]), namCount: 0, irCount: 0, embeddedBytes: 0 };
    const entry = { key: "user:a", sha256: "a", name: "A" }, target = { bankId: 6, presetId: 26, instanceId: 1, sha256: "old" };
    const result = { ...entry, targetName: "Rx", sourceState: state, targetState: state, active: false, hasUnsavedChanges: false };
    const keys = (entryValue = entry, targetValue = target) => nodes(render.dialog({ entry: entryValue, target: targetValue, action: "preview" },
        { ...result, ...entryValue })).filter(node => typeof node.type === "function").map(node => node.props.key);
    const first = keys(); assert.notEqual(first[0], first[1]);
    assert.notDeepEqual(first, keys({ ...entry, sha256: "new" }));
    const otherTarget = keys(entry, { ...target, presetId: 25 });
    assert.equal(first[0], otherTarget[0]); assert.notEqual(first[1], otherTarget[1]);
});
