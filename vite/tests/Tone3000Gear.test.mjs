// Run: node --experimental-strip-types --test tests/Tone3000Gear.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import vm from "node:vm";
import { tone3000GearCategories, tone3000GearLabel, tone3000GearIcon, tone3000LogoIcon } from "../src/pipedal/Tone3000Gear.ts";
import { projectTone3000Chain } from "../src/pipedal/Tone3000ChainProjection.ts";

const categories = [["amp-cab", "Amp + Cab"], ["amp", "Amp Head"], ["cab", "Cabinet"],
    ["pedal", "Pedal"], ["outboard", "Outboard"], ["space", "Spaces"], ["experimental", "Experimental"]];

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-FOLD-GEAR] [7.13] */
test("all native gear categories and deprecated alias preserve identity independently of format", () => {
    assert.deepEqual(tone3000GearCategories.map(value => [value.id, value.label]), categories);
    for (const [id, label] of categories) {
        assert.equal(tone3000GearLabel(id, "nam", true), label);
        assert.equal(tone3000GearLabel(id.toUpperCase(), "ir", true), label);
        assert.equal(new URL(tone3000GearIcon(id, "ir").url).pathname.split("/").at(-1), id + ".svg");
    }
    assert.equal(tone3000GearLabel("space"), "Space");
    assert.equal(tone3000GearLabel("full-rig"), "Amp + Cab");
    assert.deepEqual(tone3000GearIcon("full-rig"), tone3000GearIcon("amp-cab"));
    assert.equal(tone3000GearLabel("Future Gear", "nam"), "Future Gear");
    assert.equal(tone3000GearLabel("", "nam"), "NAM");
    assert.equal(tone3000GearLabel("", "ir"), "IR");
    assert.equal(tone3000GearIcon("Future Gear", "nam").label, "Future Gear");
    assert.ok(tone3000GearIcon("amp-like unknown", "nam").url.endsWith("/file.svg"));
    assert.ok(tone3000GearIcon("", "ir").url.endsWith("/ir.svg"));
    assert.ok(tone3000GearIcon("", "").url.endsWith("/file.svg"));
    assert.equal(tone3000GearIcon("", "").label, "Unknown gear");
});

// Frozen unmodified SVG geometry hashes from v0.0.12 plugin/ui/core/GearGlyphs.h.
const geometry = {
    "amp-cab": "b144679e445e6b09e48df21a96756fa38a8fef9f2e864d1043a125a502a73022",
    amp: "b97d302364c482839e12175d6810d5017d7629da12da7fef7ebf2da59b330cca",
    cab: "407479463b9cc09d1b7cbb8e4ded093a932d96ccd66276afab31c0e0b431aa6c",
    pedal: "7ce54d0810aa65ffdd6b5d37abe6358600bfc596d30070f252e6b5db209cd408",
    outboard: "39e888e05d2c0247e5f5eae7f774c3ff1ac1c6f2ae0d84b0a79628a6ef04f612",
    space: "dd2a9cf32ceb06cc3d9639ca9d76f966f191a3b71b5b5875e511953e0e6f581c",
    experimental: "c9280f65d2c1624c83cbaf6f02098f2dabe7282745e26b1557bfdd72fde5ff80",
    file: "69496941d45a4fc5f4239b8a8c6fc491c693abdba8004f39aeb64d183f40dcdd",
    ir: "0dd513e22e6230653fa53bdc924554e9e0e01b9b2d51d2381e23ff7775644985"
};

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-FOLD-GEAR] [7.13] */
test("each bundled glyph has exact native geometry and retained MIT attribution", () => {
    const hashes = new Set();
    for (const [id, hash] of Object.entries(geometry)) {
        const raw = fs.readFileSync(new URL("../src/pipedal/svg/tone3000/" + id + ".svg", import.meta.url), "utf8");
        assert.match(raw, /Copyright \(c\) 2026 TONE3000/);
        assert.match(raw, /SPDX-License-Identifier: MIT/);
        const svg = raw.slice(raw.indexOf("<svg")).trim();
        assert.equal(createHash("sha256").update(svg).digest("hex"), hash);
        assert.doesNotMatch(svg, /<script|on\w+=|<foreignObject|href=/i);
        hashes.add(hash);
    }
    assert.equal(hashes.size, 9);
    assert.match(fs.readFileSync(new URL("../src/pipedal/svg/tone3000/LICENSE", import.meta.url), "utf8"),
        /Permission is hereby granted, free of charge/);
});

const ts = createRequire(new URL("../package.json", import.meta.url))("typescript");
const element = (type, props, ...children) => ({ type, props: { ...props, children } });
const walk = value => value && typeof value === "object" && "type" in value
    ? [value, ...value.props.children.flat(Infinity).flatMap(walk)] : [];
const compile = (source, context) => vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
}).outputText, context);

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-FOLD-GEAR] [7.13] */
test("production chain descriptors use metadata glyphs and retain actual block click IDs without mutating input", () => {
    const raw = fs.readFileSync(new URL("../src/pipedal/Tone3000ChainView.tsx", import.meta.url), "utf8");
    const source = ts.createSourceFile("Chain.tsx", raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const render = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "Tone3000ChainView");
    assert.ok(render);
    class Item { isEnabled = true; instanceId = 0; uri = ""; }
    const context = { React: { createElement: element }, Box: "Box", Typography: "Typography", Alert: "Alert",
        PedalboardView: "PedalboardView", Pedalboard: class { items = []; }, PedalboardItem: Item,
        PedalboardSplitItem: class extends Item {}, ControlValue: class {}, SplitType: { Lr: 2 },
        PluginType: { UtilityPlugin: "utility", SimulatorPlugin: "simulator", AmplifierPlugin: "amp", NamPlugin: "nam" },
        projectTone3000Chain, tone3000GearIcon, tone3000LogoIcon };
    compile(render.getText(source).replace(/^export default /, "") + "\nglobalThis.render = Tone3000ChainView;", context);
    const summary = { blocks: categories.map(([gear], index) => ({ blockId: "real-" + index, lane: "left", index,
        type: index === 2 ? "ir" : "nam", format: index === 2 ? "ir" : "nam", title: gear, gear, enabled: index !== 3 })),
        inputMode: "left", stereoEnabled: false, branchSide: "left", branchAfterBlockId: "" };
    const before = structuredClone(summary), clicks = [];
    const result = context.render({ summary, embedded: true, onBlockClick: id => clicks.push(id) });
    const view = walk(result).find(node => node.type === "PedalboardView");
    assert.ok(view); assert.equal(view.props.readOnly, true); assert.equal(view.props.enableStructureEditing, false);
    for (const [index, item] of view.props.displayBoard.items.entries()) {
        assert.equal(item.uri, "");
        assert.equal(view.props.displayNodes[item.instanceId].icon.url, tone3000GearIcon(categories[index][0]).url);
        view.props.onDisplayNodeClick(item.instanceId);
    }
    assert.deepEqual(clicks, categories.map((_, index) => "real-" + index));
    assert.equal(view.props.displayBoard.items[3].isEnabled, false);
    assert.deepEqual(summary, before);
    let parentClicks = 0;
    const branded = context.render({ summary, embedded: true, onBlockClick: id => clicks.push(id),
        parent: { pluginType: "utility", selected: true, onClick: () => ++parentClicks } });
    const parentView = walk(branded).find(node => node.type === "PedalboardView");
    const marker = parentView.props.displayBoard.items[0];
    assert.equal(parentView.props.displayNodes[marker.instanceId].icon, tone3000LogoIcon);
    assert.equal(parentView.props.selectedId, marker.instanceId);
    parentView.props.onDisplayNodeClick(marker.instanceId);
    assert.equal(parentClicks, 1);
    assert.deepEqual(summary, before);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-FOLD-GEAR] [7.13] */
test("production renderer masks only isolated display nodes and keeps stock plugin icon path", () => {
    const raw = fs.readFileSync(new URL("../src/pipedal/PedalboardView.tsx", import.meta.url), "utf8");
    const source = ts.createSourceFile("Board.tsx", raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let method;
    const find = node => { if (ts.isMethodDeclaration(node) && node.name.getText(source) === "pedalButton") method = node;
        ts.forEachChild(node, find); };
    find(source); assert.ok(method);
    const context = { React: { createElement: element }, withStyles: { getClasses: () => ({}) },
        PluginIcon: "PluginIcon", ButtonBase: "ButtonBase", SelectHoverBackground: "Hover", Draggable: "Draggable",
        iconColors: { custom: "#abc" } };
    // Execute the production resolver: default/unrecognized keys return undefined.
    const colorRaw = fs.readFileSync(new URL("../src/pipedal/PluginIcon.tsx", import.meta.url), "utf8");
    const colorSource = ts.createSourceFile("Icon.tsx", colorRaw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let color;
    const findColor = node => { if (ts.isVariableDeclaration(node) && node.name.getText(colorSource) === "getIconColor") color = node.initializer;
        ts.forEachChild(node, findColor); };
    findColor(colorSource); assert.ok(color);
    compile("globalThis.getIconColor = " + color.getText(colorSource), context);
    compile("globalThis.Renderer = class {" + method.getText(source) + "};", context);
    const renderer = new context.Renderer(), icon = tone3000GearIcon("experimental", "nam");
    renderer.props = { displayBoard: {}, displayNodes: { 1: { name: "Example", clickable: true, icon } },
        onDisplayNodeClick: () => {}, enableStructureEditing: true, theme: { palette: { text: { primary: "#ddd" } } } };
    renderer.isReadOnly = () => true;
    const call = (color = "default") => renderer.pedalButton(1, "stock", color, true, true, true, false, false);
    const custom = walk(call());
    const glyph = custom.find(node => node.type === "span" && node.props.role === "img");
    assert.equal(glyph.props["aria-label"], "Experimental");
    assert.equal(glyph.props.title, "Experimental"); assert.match(glyph.props.style.mask, /experimental/);
    assert.equal(glyph.props.style.pointerEvents, "none");
    assert.equal(glyph.props.style.backgroundColor, "#ddd", "default-colored masks need explicit theme paint");
    const customColor = walk(call("custom")).find(node => node.type === "span" && node.props.role === "img");
    assert.equal(customColor.props.style.backgroundColor, "#abc");
    renderer.props.theme.palette.text.primary = "#222";
    assert.equal(walk(call()).find(node => node.type === "span" && node.props.role === "img").props.style.backgroundColor, "#222");
    assert.equal(custom.some(node => node.type === "Draggable" || node.type === "PluginIcon"), false);
    renderer.props.displayNodes[1].icon = tone3000LogoIcon;
    const logo = walk(call()).find(node => node.type === "img");
    assert.equal(logo.props.src, tone3000LogoIcon.url);
    assert.equal(logo.props.alt, "TONE3000 logo");
    assert.equal(logo.props.draggable, false);
    assert.equal(logo.props.style.width, 32);
    assert.equal(logo.props.style.pointerEvents, "none");
    assert.equal(logo.props.style.mask, undefined);
    renderer.props.displayBoard = undefined;
    assert.equal(walk(call()).some(node => node.type === "PluginIcon"), true);
    renderer.props.displayBoard = {}; renderer.isReadOnly = () => false;
    const ordinary = walk(call());
    assert.equal(ordinary.some(node => node.type === "PluginIcon"), true);
    assert.equal(ordinary.some(node => node.type === "span" && node.props.role === "img"), false);
});
