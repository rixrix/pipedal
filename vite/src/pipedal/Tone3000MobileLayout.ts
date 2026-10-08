// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT

/** Parse only complete, finite local field drafts; blank input is never zero.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-13] [DES-FOLD-GEAR] [7.14]
 */
export function tone3000DraftNumber(text: string): number {
    const trimmed = text.trim();
    if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(trimmed)) return NaN;
    const value = Number(trimmed.replace(",", "."));
    return Number.isFinite(value) ? value : NaN;
}

/** Format an unfocused field; focused draft text is retained by its component.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-FOLD-GEAR] [7.14]
 */
export function tone3000FormatNumber(value: number, step: number): string {
    return Number.isFinite(value) ? String(Number(value.toFixed(Math.max(0, Math.ceil(-Math.log10(step)))))) : "";
}

/** Recognize the same local draft after normalized gain conversion round-off.
 * Real replacements and invalid-to-finite Refresh values still reset the field.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-FOLD-GEAR] [7.14]
 */
export function tone3000SameDraftNumber(value: number, emitted: number): boolean {
    return Object.is(value, emitted) || (Number.isFinite(value) && Number.isFinite(emitted)
        && Math.abs(value - emitted) <= Number.EPSILON * 64 * Math.max(1, Math.abs(value), Math.abs(emitted)));
}

/** Reserve scrolling chain space and give the tabbed editor remaining height.
 * Applied only to T3K; ordinary plugins retain PiPedal's stock layout.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [NFR-4] [DES-FOLD-GEAR] [7.14]
 */
export function tone3000ViewportStyles(height: number, short: boolean) {
    return {
        chain: { flex: "0 0 auto", maxHeight: Math.max(0, height) * (short ? 0.28 : 0.35) },
        controls: { flex: "1 1 0", height: "auto", minHeight: 0 }
    };
}
