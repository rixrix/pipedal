// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT

/** Only shipped pitch descriptors opt into ordinary-port touch editing.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-27] [DES-PITCH-LV2] [7.36]
 */
export function tone3000PitchPlugin(uri: string | undefined): boolean {
    return uri === "https://github.com/rixrix/pipedal/plugins/t3k-pitch#mono"
        || uri === "https://github.com/rixrix/pipedal/plugins/t3k-pitch#stereo";
}

/** Patch T3K and the two ordinary-port pitch descriptors share owner guards.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TOUCH-EDITOR] [DES-PITCH-LV2] [7.36]
 */
export function tone3000TouchPlugin(uri: string | undefined): boolean {
    return uri === "https://www.tone3000.com/plugin" || tone3000PitchPlugin(uri);
}

/** Fine steps are in displayed units, never normalized saved LV2 values.
 * Unknown controls use their discovered span and integer contract.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-16] [DES-TOUCH-EDITOR] [7.27]
 */
export function tone3000TouchStep(uri: string, min: number, max: number, integer: boolean, pitchStep?: boolean): number {
    if (integer) return 1;
    const id = uri.replace("https://www.tone3000.com/plugin:", "");
    if (id === "pitchSemitones") return pitchStep ? 1 : .1;
    if (["inputLevel", "outputLevel", "outputBalance", "targetLoudness", "inputCalibrationLevel", "spreadOffset", "alignOffset",
        "toneBass", "toneMid", "toneTreble"].includes(id)) return .1;
    if (["spreadWobble", "alignWobble", "chainPanLeft", "chainPanRight", "gateThreshold", "gateRelease", "gateHold", "gateRange",
        "spreadCrossover", "alignCrossover", "pitchTonality"].includes(id)) return 1;
    return (max - min) / 1000;
}

/** Native processing capture and coupled gestures require release-only writes.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TOUCH-EDITOR] [7.27]
 */
export function tone3000TouchLive(uri: string, coupled: boolean): boolean {
    return !coupled && !["calibrateInput", "inputCalibrationLevel", "osEnabled", "osFactor"]
        .some(id => uri === "https://www.tone3000.com/plugin:" + id);
}
