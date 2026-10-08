// Run: node --experimental-strip-types --test tests/Tone3000ControlLayout.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { tone3000ControlLayout, findTone3000Control } from "../src/pipedal/Tone3000ControlLayout.ts";

// Frozen parameter metadata for the reviewed TONE3000 v0.0.11 release.
const advertised = [
    "inputLevel", "toneBass", "toneMid", "toneTreble", "outputLevel", "gateThreshold",
    "targetLoudness", "calibrateInput", "inputCalibrationLevel", "gateEnabled", "toneEqEnabled",
    "outputBalance", "spreadEnabled", "spreadOffset", "spreadWobble", "spreadWobbleEnabled",
    "spreadCrossover", "spreadCrossoverEnabled", "spreadDiffuseEnabled", "alignEnabled",
    "alignOffset", "alignWobble", "alignWobbleEnabled", "alignCrossover", "alignCrossoverEnabled",
    "alignDiffuseEnabled", "chainPanLeft", "chainPanRight", "chainPanLinked", "chainSoloLeft",
    "chainSoloRight", "chainInvertLeft", "chainInvertRight", "osEnabled", "osFactor",
    "gateRelease", "gateHold", "gateRange", "pitchEnabled", "pitchSemitones", "pitchStep",
    "pitchTonality", "pitchWindow"
];

/**
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.10] [2.11]
 */
test("all 43 advertised properties have one readable presentation", () => {
    const controls = tone3000ControlLayout.flatMap(tab => tab.sections.flatMap(section => section.controls));
    assert.equal(controls.length, advertised.length);
    assert.equal(new Set(controls.map(control => control.id)).size, advertised.length);
    assert.deepEqual(controls.map(control => control.id).sort(), [...advertised].sort());
    assert.equal(tone3000ControlLayout[0].title, "Tone");
    assert.equal(tone3000ControlLayout[0].sections.flatMap(section => section.controls).length, 12);
    for (const control of controls) {
        // Preserve native wording instead of truncating the calibration field.
        const maxLength = control.id === "inputCalibrationLevel" ? "Calibration level".length : 12;
        assert.ok(control.label.length > 0 && control.label.length <= maxLength);
        assert.equal(findTone3000Control("https://www.tone3000.com/plugin:" + control.id)?.label, control.label);
    }
});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-FOLD-GEAR] [7.13] */
test("native wording and phone grouping separate stereo effects from gear categories", () => {
    assert.deepEqual(tone3000ControlLayout.map(tab => tab.title), ["Tone", "Stereo", "Pitch", "Settings"]);
    const presentation = id => findTone3000Control("https://www.tone3000.com/plugin:" + id);
    for (const [id, label] of [["toneMid", "Middle"], ["pitchWindow", "Buffer"],
        ["inputCalibrationLevel", "Calibration level"], ["osFactor", "Rate"]])
        assert.equal(presentation(id).label, label);
    for (const id of ["spreadEnabled", "alignEnabled", "outputBalance", "chainPanLinked", "chainSoloRight", "chainInvertLeft"])
        assert.equal(presentation(id).tab, "Stereo");
    assert.equal(presentation("alignOffset").section, "Align");
    for (const id of ["calibrateInput", "inputCalibrationLevel", "osEnabled", "osFactor"])
        assert.equal(presentation(id).tab, "Settings");
});

/**
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.10] [2.11]
 */
test("card ordering places power switches and main levels before advanced controls", () => {
    const presentation = id => findTone3000Control("https://www.tone3000.com/plugin:" + id);
    assert.deepEqual(["inputLevel", "outputLevel", "targetLoudness"].map(id => presentation(id).order), [0, 1, 2]);
    assert.deepEqual(["gateEnabled", "gateThreshold", "gateRelease", "gateHold", "gateRange"]
        .map(id => presentation(id).order), [0, 1, 2, 3, 4]);
    assert.equal(presentation("toneEqEnabled").order, 0);
    assert.equal(presentation("spreadEnabled").order, 0);
    assert.equal(presentation("alignEnabled").order, 0);
    assert.equal(presentation("pitchEnabled").order, 0);
});

/**
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.10] [2.11]
 */
test("future and unrelated property URIs remain eligible for the Other fallback", () => {
    assert.equal(findTone3000Control("https://www.tone3000.com/plugin:futureControl"), undefined);
    assert.equal(findTone3000Control("https://other.example/plugin:inputLevel"), undefined);
    assert.equal(findTone3000Control("inputLevel"), undefined);
});
