// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT

/** Validated numeric geometry; converters use the existing UiControl 0..1 range.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-16] [DES-TOUCH-EDITOR] [7.27]
 */
export interface Tone3000TouchScale {
    min: number; max: number; step: number;
    valueToRange?: (value: number) => number;
    rangeToValue?: (range: number) => number;
}

/** Refuse unusable bounds rather than inventing a numeric setting.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-TOUCH-EDITOR] [7.27]
 */
export function tone3000TouchValue(value: number, scale: Tone3000TouchScale): number {
    const { min, max, step } = scale;
    if (![value, min, max, step, max - min].every(Number.isFinite) || max <= min || step <= 0) return NaN;
    const bounded = Math.max(min, Math.min(max, value));
    if (bounded === min || bounded === max) return bounded;
    return Math.max(min, Math.min(max, Number((min + Math.round((bounded - min) / step) * step).toPrecision(15))));
}

/** Native nonlinear geometry is used directly, with finite conversion guards.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-16] [DES-TOUCH-EDITOR] [7.27]
 */
export function tone3000TouchRange(value: number, scale: Tone3000TouchScale): number {
    if (!Number.isFinite(tone3000TouchValue(value, scale))) return NaN;
    try {
        const range = scale.valueToRange ? scale.valueToRange(value) : (value - scale.min) / (scale.max - scale.min);
        return Number.isFinite(range) ? Math.max(0, Math.min(1, range)) : NaN;
    } catch { return NaN; }
}

/** Relative movement never maps a track tap to an absolute value.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-16] [DES-TOUCH-EDITOR] [7.27]
 */
export function tone3000TouchDrag(start: number, delta: number, width: number, scale: Tone3000TouchScale): number {
    if (!Number.isFinite(delta) || !Number.isFinite(width) || width <= 0) return NaN;
    const range = tone3000TouchRange(start, scale);
    if (!Number.isFinite(range)) return NaN;
    try {
        const next = Math.max(0, Math.min(1, range + delta / width));
        return tone3000TouchValue(scale.rangeToValue ? scale.rangeToValue(next) : scale.min + next * (scale.max - scale.min), scale);
    } catch { return NaN; }
}

/** Float LV2 readbacks can differ slightly from the displayed physical value.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-TOUCH-EDITOR] [7.27]
 */
export function tone3000TouchSameValue(a: number, b: number): boolean {
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}
