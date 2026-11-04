// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT

/** Browser filter categories from pinned TONE3000 v0.0.12 Labels.cpp.
 * These describe metadata, never host plugin types or editable topology.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-FOLD-GEAR] [7.13]
 */
export const tone3000GearCategories = [
    { id: "amp-cab", label: "Amp + Cab" }, { id: "amp", label: "Amp Head" },
    { id: "cab", label: "Cabinet" }, { id: "pedal", label: "Pedal" },
    { id: "outboard", label: "Outboard" }, { id: "space", label: "Spaces" },
    { id: "experimental", label: "Experimental" }
] as const;

/** Noninteractive, locally bundled mask; native geometry and MIT notice retained.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-FOLD-GEAR] [7.13]
 */
export interface Tone3000GearIcon { url: string; label: string; }

/** Owner-linked coloured logo, isolated to the parent marker and bundled offline.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-T3K-LOGO] [7.17]
 */
export const tone3000LogoIcon = {
    url: new URL("./svg/tone3000/t3k-avatar.png", import.meta.url).href,
    label: "TONE3000 logo", width: 32, height: 32, preserveColors: true
} as const;

// Literal URLs let Vite include all native assets without dynamic/private paths.
const glyphs: Readonly<Record<string, string>> = {
    "amp-cab": new URL("./svg/tone3000/amp-cab.svg", import.meta.url).href,
    amp: new URL("./svg/tone3000/amp.svg", import.meta.url).href,
    cab: new URL("./svg/tone3000/cab.svg", import.meta.url).href,
    pedal: new URL("./svg/tone3000/pedal.svg", import.meta.url).href,
    outboard: new URL("./svg/tone3000/outboard.svg", import.meta.url).href,
    space: new URL("./svg/tone3000/space.svg", import.meta.url).href,
    experimental: new URL("./svg/tone3000/experimental.svg", import.meta.url).href,
    ir: new URL("./svg/tone3000/ir.svg", import.meta.url).href,
    file: new URL("./svg/tone3000/file.svg", import.meta.url).href
};

/** Native compact label, or browser filter label when explicitly requested.
 * Unknown metadata survives verbatim; missing gear falls back to format only.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-FOLD-GEAR] [7.13]
 */
export function tone3000GearLabel(gear: string, format = "", filter = false): string {
    const id = gear.toLowerCase() === "full-rig" ? "amp-cab" : gear.toLowerCase();
    const category = tone3000GearCategories.find(value => value.id === id);
    if (category) return category.id === "space" && !filter ? "Space" : category.label;
    if (id === "ir") return "IR";
    return gear || format.toUpperCase();
}

/** Gear identity stays independent of NAM/IR format; unknown gear is neutral.
 * Unlike native's generic amp fallback, missing metadata never implies an amp.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-FOLD-GEAR] [7.13]
 */
export function tone3000GearIcon(gear: string, format = ""): Tone3000GearIcon {
    const id = gear.toLowerCase() === "full-rig" ? "amp-cab" : gear.toLowerCase();
    const category = tone3000GearCategories.find(value => value.id === id);
    const fallback = format.toLowerCase() === "ir" ? "ir" : "file";
    return { url: glyphs[category?.id ?? (id === "ir" ? "ir" : fallback)],
        label: tone3000GearLabel(gear, format) || "Unknown gear" };
}
