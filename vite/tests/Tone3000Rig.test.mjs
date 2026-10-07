// Run: node --experimental-strip-types --test tests/Tone3000Rig.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { tone3000BlockChanges, tone3000ValidBlocks } from "../src/pipedal/Tone3000Rig.ts";

const block = () => ({ blockId: "amp", lane: "left", index: 0, type: "nam", title: "Amp",
    gear: "amp", format: "nam", activeModelId: 42, enabled: true, normalize: true,
    capabilityUnknown: true, slimSize: 1, inputGain: .5, outputGain: .5, mix: 1,
    eq: { enabled: true, pre: false, bands: Array.from({ length: 6 }, () => ({ type: "bell", freqHz: 1000, gainDb: 0, q: 1 })) } });

/** A band tweak must not resend defaults for unrelated controls or other bands.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [FR-14] [DES-OPERATE] [3.13]
 */
test("sparse block changes preserve untouched values and identities", () => {
    const original = [block()];
    const draft = structuredClone(original);
    draft[0].eq.bands[2].gainDb = 2.5;
    draft[0].enabled = false;
    assert.deepEqual(tone3000BlockChanges(original, draft), [{ blockId: "amp", enabled: false,
        eqBands: [{ index: 2, gainDb: 2.5 }] }]);
    assert.equal(original[0].enabled, true);
    assert.equal(original[0].eq.bands[2].gainDb, 0);
    assert.deepEqual(tone3000BlockChanges(original, original), []);
});

/** A stale local draft may not become a patch against a different block list.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.13]
 */
test("missing original identities refuse draft generation", () => {
    assert.throws(() => tone3000BlockChanges([], [block()]), /blocks changed/);
});

/** JSON turns NaN into null, which means unchanged in a sparse native patch.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.13]
 */
test("incomplete or out-of-range drafts cannot silently become unchanged patches", () => {
    const draft = [block()];
    assert.equal(tone3000ValidBlocks(draft), true);
    for (const invalid of [NaN, Infinity, -1, 1.01]) {
        draft[0].mix = invalid;
        assert.equal(tone3000ValidBlocks(draft), false);
    }
    draft[0].mix = 1;
    draft[0].eq.bands[0].q = .09;
    assert.equal(tone3000ValidBlocks(draft), false);
    draft[0].eq.bands[0].q = .1;
    assert.equal(tone3000ValidBlocks(draft), true);
});
