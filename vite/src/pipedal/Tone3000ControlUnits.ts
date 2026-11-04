// Copyright (c) 2026 Thomas Rapolani
// SPDX-License-Identifier: MIT

/** Physical text-entry/readout mapping; saved LV2 values keep their original units.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-16] [DES-STAGE] [7.3]
 */
export interface PatchNumberPresentation {
    toDisplay: (raw: number) => number;
    fromDisplay: (display: number) => number;
    format: (display: number) => string;
    editText: (display: number) => string;
}

const prefix = "https://www.tone3000.com/plugin:";
const numberText = (value: number) => Number(value.toFixed(6)).toString();
const fixed = (value: number, digits: number) => (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toFixed(digits);

function linear(low: number, high: number, unit: string, digits = 1): PatchNumberPresentation {
    return { toDisplay: value => low + value * (high - low),
        fromDisplay: value => (value - low) / (high - low),
        format: value => fixed(value, digits) + " " + unit, editText: numberText };
}

/** Exact v0.0.11/v0.0.12 ranges prevent accidental double conversion in future metadata.
 * Native formula references: plugin/ui/core/KnobScale.h and plugin/include/ImageDeck.h.
 * Pan retains the complete legal stored range; linked/half-range gestures are separate work.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-16] [DES-STAGE] [7.3]
 */
export function tone3000NumberPresentation(uri: string, minimum: number, maximum: number): PatchNumberPresentation | undefined {
    if (!uri.startsWith(prefix)) return undefined;
    const id = uri.slice(prefix.length);
    if (minimum === 0 && maximum === 1) {
        switch (id) {
            case "inputLevel": case "outputLevel": return linear(-24, 24, "dB");
            case "outputBalance": return linear(-12, 12, "dB");
            case "spreadWobble": case "alignWobble": return linear(0, 100, "%", 0);
            case "spreadOffset": case "alignOffset": return { ...linear(-24, 24, "ms"),
                format: value => Math.abs(value) < .05 ? "0 ms" : fixed(Math.abs(value), 1) + " ms " + (value < 0 ? "L" : "R") };
            case "spreadCrossover": case "alignCrossover": return {
                toDisplay: value => 32.5 * 16 ** value,
                fromDisplay: value => Math.log(value / 32.5) / Math.log(16),
                format: value => Math.round(value) + " Hz", editText: numberText };
            case "chainPanLeft": case "chainPanRight": return { ...linear(-100, 100, "%"),
                format: value => Math.abs(value) < .5 ? "C" : Math.round(Math.abs(value)) + "% " + (value < 0 ? "L" : "R") };
        }
    }
    const physical: Record<string, [number, number, string, number]> = {
        gateThreshold: [-100, 0, "dB", 0], targetLoudness: [-60, 0, "dB", 1],
        inputCalibrationLevel: [-60, 60, "dBu", 1], gateRelease: [5, 500, "ms", 0],
        gateHold: [0, 200, "ms", 0], gateRange: [20, 80, "dB", 0],
        pitchSemitones: [-24, 24, "st", 1], pitchTonality: [1000, 20000, "Hz", 0]
    };
    const contract = physical[id];
    if (!contract || minimum !== contract[0] || maximum !== contract[1]) return undefined;
    return { toDisplay: value => value, fromDisplay: value => value,
        format: value => id === "pitchTonality" && value >= 20000 ? "Off" : fixed(value, contract[3]) + " " + contract[2],
        editText: numberText };
}

interface NumericControl {
    min_value: number; max_value: number; default_value: number;
    valueToRange(value: number): number;
    rangeToValue(range: number): number;
    formatDisplayValue(value: number): string;
    formatShortValue(value: number): string;
}

/** Keep stock knob geometry/quantization while making numeric entry use physical units.
 * This wraps a newly discovered control; neither it nor the saved raw value is mutated.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-16] [DES-STAGE] [7.3]
 */
export function presentPatchNumber<T extends NumericControl>(raw: T, presentation?: PatchNumberPresentation): T {
    if (!presentation) return raw;
    const result: T = Object.create(raw);
    result.min_value = presentation.toDisplay(raw.min_value);
    result.max_value = presentation.toDisplay(raw.max_value);
    result.default_value = presentation.toDisplay(raw.default_value);
    // Clamp physical entry before nonlinear conversion (e.g. negative Hz).
    result.valueToRange = value => raw.valueToRange(presentation.fromDisplay(
        Math.max(result.min_value, Math.min(result.max_value, value))));
    result.rangeToValue = range => presentation.toDisplay(raw.rangeToValue(range));
    result.formatDisplayValue = presentation.format;
    result.formatShortValue = presentation.editText;
    return result;
}

/** Preserve the discovered raw range/quantization and refuse invalid numeric writes.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-16] [DES-STAGE] [7.3]
 */
export function rawPatchNumber(display: number, control: NumericControl, presentation?: PatchNumberPresentation): number {
    const value = presentation ? presentation.fromDisplay(display) : display;
    if (!Number.isFinite(value)) throw new Error("Enter a finite control value.");
    return control.rangeToValue(control.valueToRange(value));
}
