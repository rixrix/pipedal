// Run: node --experimental-strip-types --test tests/Tone3000ChainProjection.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { projectTone3000Chain, tone3000ChainFootprint } from "../src/pipedal/Tone3000ChainProjection.ts";

const block = (blockId, lane, index, type = "nam", enabled = true) => ({ blockId, lane, index, type, enabled, title: blockId });
const summary = (blocks, overrides = {}) => ({ blocks, inputMode: "left", stereoEnabled: false,
    branchSide: "left", branchAfterBlockId: "", ...overrides });
const ids = entries => entries.flatMap(entry => entry.kind === "block" ? [entry.block.blockId]
    : entry.kind === "split" ? [...ids(entry.left), ...ids(entry.right)] : []);

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15] */
test("mono retains source order and bypassed blocks, excluding inactive right and insert slots", () => {
    const source = summary([block("cab", "left", 2, "ir", false), block("empty", "left", 1, "insert"),
        block("amp", "left", 0), block("right", "right", 0)]);
    const original = structuredClone(source);
    const result = projectTone3000Chain(source);
    assert.deepEqual(ids(result.entries), ["amp", "cab"]);
    assert.equal(result.entries[1].block.enabled, false);
    assert.equal(result.emptySlots, 1); assert.equal(result.inactiveRightBlocks, 1);
    assert.deepEqual(source, original);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15] */
test("independent stereo keeps separate ordered lanes and explicit empty pass-through", () => {
    const result = projectTone3000Chain(summary([block("amp", "left", 0)], { stereoEnabled: true, inputMode: "stereo" }));
    assert.equal(result.entries[0].kind, "split");
    assert.deepEqual(ids(result.entries[0].left), ["amp"]);
    assert.deepEqual(result.entries[0].right, [{ kind: "direct", lane: "right" }]);
    assert.equal(result.stereo, true);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15] */
test("left tap draws shared prefix once, then left tail and complete right lane", () => {
    const result = projectTone3000Chain(summary([block("pedal", "left", 0), block("amp", "left", 1),
        block("cab", "left", 2, "ir"), block("rightCab", "right", 0, "ir")],
        { stereoEnabled: true, branchAfterBlockId: "amp" }));
    assert.deepEqual(ids(result.entries.slice(0, 2)), ["pedal", "amp"]);
    const fork = result.entries[2]; assert.equal(fork.kind, "split");
    assert.deepEqual(ids(fork.left), ["cab"]); assert.deepEqual(ids(fork.right), ["rightCab"]);
    assert.deepEqual(ids(result.entries), ["pedal", "amp", "cab", "rightCab"]);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15] */
test("right tap preserves shared right prefix and left/right output assignment", () => {
    const result = projectTone3000Chain(summary([block("leftCab", "left", 0, "ir"),
        block("rightAmp", "right", 0), block("rightCab", "right", 1, "ir")],
        { stereoEnabled: true, branchSide: "right", branchAfterBlockId: "rightAmp" }));
    assert.equal(result.entries[0].block.blockId, "rightAmp");
    const fork = result.entries[1];
    assert.deepEqual(ids(fork.left), ["leftCab"]); assert.deepEqual(ids(fork.right), ["rightCab"]);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15] */
test("stale and insert taps match native independent routing; dormant mono branches stay dormant", () => {
    for (const tap of ["missing", "slot"])
        assert.equal(projectTone3000Chain(summary([block("slot", "left", 0, "insert")],
            { stereoEnabled: true, branchAfterBlockId: tap })).entries[0].kind, "split");
    const result = projectTone3000Chain(summary([block("amp", "left", 0), block("cab", "right", 0, "ir")],
        { branchAfterBlockId: "amp" }));
    assert.deepEqual(ids(result.entries), ["amp"]); assert.equal(result.inactiveRightBlocks, 1);
    assert.deepEqual(projectTone3000Chain(summary([])).entries, [{ kind: "direct", lane: "left" }]);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15] */
test("ambiguous identities, lanes, positions and unsupported shapes refuse a guessed diagram", () => {
    for (const blocks of [[block("same", "left", 0), block("same", "right", 0)],
        [block("a", "left", 0), block("b", "left", 0)], [block("a", "middle", 0)],
        [block("a", "left", 0.5)], [block("a", "left", 0, "unknown")],
        Array.from({ length: 257 }, (_, i) => block(String(i), "left", i))])
        assert.throws(() => projectTone3000Chain(summary(blocks)), /cannot be represented/);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15] */
test("measured group aligns its terminals with the real prefix and suffix signal line", () => {
    const result = tone3000ChainFootprint(192, 128, { width: 768, height: 142, inputY: 48, outputY: 48 }, 96);
    assert.deepEqual(result, { x: 192, y: 80, width: 768, height: 128,
        inputX: 240, inputY: 128, outputX: 912, outputY: 128 });
    assert.equal(result.inputX, 144 + 96); // Previous real host's outgoing connector.
    assert.equal(result.outputX + 96, result.x + result.width + 48); // Next real host's input.
    const shifted = tone3000ChainFootprint(192, 328, { width: 768, height: 142, inputY: 48, outputY: 48 }, 96);
    assert.equal(shifted.y - result.y, 200); assert.equal(shifted.outputY - result.outputY, 200);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15] */
test("invalid measurements cannot collapse or overflow the surrounding host layout", () => {
    for (const measured of [{ width: 0, height: 80, inputY: 32, outputY: 32 },
        { width: 288, height: 80, inputY: -1, outputY: 32 },
        { width: 288, height: 80, inputY: 32, outputY: 81 },
        { width: Infinity, height: 80, inputY: 32, outputY: 32 }])
        assert.throws(() => tone3000ChainFootprint(0, 32, measured, 96), /dimensions/);
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15] */
test("plain mono expansion adds only stock block cells, with zero header or terminal padding", () => {
    const result = tone3000ChainFootprint(96, 32, { width: 288, height: 78, inputY: 32, outputY: 32 }, 96);
    assert.equal(result.x, 96); assert.equal(result.y, 0); assert.equal(result.width, 3 * 96);
    assert.equal(result.height, 64); assert.equal(result.inputX, 144); assert.equal(result.outputX, 336);
});
