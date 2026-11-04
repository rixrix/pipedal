/**
 * Presentation metadata only; numeric ranges and choices come from LV2 discovery.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.10]
 */
export interface Tone3000ControlSection {
    title: string;
    controls: readonly { id: string; label: string }[];
}

/**
 * All 43 pinned parameter IDs, grouped without translating their units.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.10]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-FOLD-GEAR] [7.13]
 */
export const tone3000ControlLayout: readonly {
    title: string;
    sections: readonly Tone3000ControlSection[];
}[] = [
    {
        title: "Tone", sections: [
            { title: "Levels", controls: [
                { id: "inputLevel", label: "Input" },
                { id: "outputLevel", label: "Output" },
                { id: "targetLoudness", label: "Loudness" }
            ] },
            { title: "Tone stack", controls: [
                { id: "toneEqEnabled", label: "Tone on" },
                { id: "toneBass", label: "Bass" },
                { id: "toneMid", label: "Middle" },
                { id: "toneTreble", label: "Treble" }
            ] },
            { title: "Noise gate", controls: [
                { id: "gateEnabled", label: "Gate on" },
                { id: "gateThreshold", label: "Threshold" },
                { id: "gateRelease", label: "Release" },
                { id: "gateHold", label: "Hold" },
                { id: "gateRange", label: "Range" }
            ] }
        ]
    },
    {
        title: "Stereo", sections: [
            { title: "Spread", controls: [
                { id: "spreadEnabled", label: "Spread on" },
                { id: "spreadOffset", label: "Offset" },
                { id: "spreadWobble", label: "Wobble" },
                { id: "spreadWobbleEnabled", label: "Wobble on" },
                { id: "spreadCrossover", label: "Crossover" },
                { id: "spreadCrossoverEnabled", label: "Cross on" },
                { id: "spreadDiffuseEnabled", label: "Diffuse on" }
            ] },
            { title: "Align", controls: [
                { id: "alignEnabled", label: "Align on" },
                { id: "alignOffset", label: "Offset" },
                { id: "alignWobble", label: "Wobble" },
                { id: "alignWobbleEnabled", label: "Wobble on" },
                { id: "alignCrossover", label: "Crossover" },
                { id: "alignCrossoverEnabled", label: "Cross on" },
                { id: "alignDiffuseEnabled", label: "Diffuse on" }
            ] },
            { title: "Stereo routing", controls: [
                { id: "outputBalance", label: "Balance" },
                { id: "chainPanLeft", label: "Left pan" },
                { id: "chainPanRight", label: "Right pan" },
                { id: "chainPanLinked", label: "Link pans" },
                { id: "chainSoloLeft", label: "Solo left" },
                { id: "chainSoloRight", label: "Solo right" },
                { id: "chainInvertLeft", label: "Invert left" },
                { id: "chainInvertRight", label: "Invert right" }
            ] }
        ]
    },
    {
        title: "Pitch", sections: [
            { title: "Pitch shift", controls: [
                { id: "pitchEnabled", label: "Pitch on" },
                { id: "pitchSemitones", label: "Semitones" },
                { id: "pitchStep", label: "Step" },
                { id: "pitchTonality", label: "Tonality" },
                { id: "pitchWindow", label: "Buffer" }
            ] }
        ]
    },
    {
        title: "Settings", sections: [
            { title: "Calibration", controls: [
                { id: "calibrateInput", label: "Calibration" },
                { id: "inputCalibrationLevel", label: "Calibration level" }
            ] },
            { title: "Oversampling", controls: [
                { id: "osEnabled", label: "Enabled" },
                { id: "osFactor", label: "Rate" }
            ] }
        ]
    }
];

/**
 * Match the full reviewed URI; unfamiliar properties remain in the Other tab.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.10]
 */
export function findTone3000Control(uri: string) {
    for (const tab of tone3000ControlLayout) {
        for (const section of tab.sections) {
            const control = section.controls.find(item => uri === "https://www.tone3000.com/plugin:" + item.id);
            if (control) return { tab: tab.title, section: section.title, label: control.label,
                order: section.controls.indexOf(control) };
        }
    }
    return undefined;
}
