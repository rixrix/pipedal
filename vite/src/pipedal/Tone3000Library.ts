// Copyright (c) 2026 Thomas Rapolani
// SPDX-License-Identifier: MIT

import type { Tone3000Summary } from "./Tone3000Rig";

/** Saved rig versions found by the server-owned local library.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [3.10]
 */
export interface Tone3000Import {
    bankId: number;
    presetId: number;
    instanceId: number;
    name: string;
    sha256: string;
    active: boolean;
    hasSnapshotOverrides: boolean;
}

/** Source metadata only; embedded model bytes remain on the server.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [3.10]
 */
export interface Tone3000LibraryEntry {
    key: string;
    name: string;
    source: string;
    sha256: string;
    imports: Tone3000Import[];
}

/** Discovery can return valid rigs alongside actionable source warnings.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]
 */
export interface Tone3000LibraryResult {
    entries: Tone3000LibraryEntry[];
    warnings: string[];
}

/** The saved target returned after Add or Update; neither action is a program slot.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]
 */
export interface Tone3000ImportResult {
    bankId: number;
    presetId: number;
    instanceId: number;
}

/** Whitelisted stored observations; counts include disabled/cached variants.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [7.1]
 */
export interface Tone3000PreviewState {
    summary: Tone3000Summary;
    namCount: number; irCount: number; embeddedBytes: number;
}
/** No raw assets, paths, live capture or exhaustive opaque diff.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [7.1]
 */
export interface Tone3000PreviewResult {
    key: string; sha256: string; name: string; source: string; targetName: string;
    sourceState: Tone3000PreviewState; targetState: Tone3000PreviewState | null;
    active: boolean; hasUnsavedChanges: boolean; hasSnapshotOverrides: boolean;
    replaces: string[]; preserves: string[];
}
export interface Tone3000PreviewSelection {
    entry: Tone3000LibraryEntry; target?: Tone3000Import;
    action: "preview" | "add" | "addNew" | "update";
}

/** Client filtering uses existing source/import metadata and the real bank index.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-FOUR-REFINEMENTS] [7.30]
 */
export type Tone3000LibraryFilter = "all" | "saved" | "new" | "updates";

/** Structural bank index view, keeping names separate from native import identities.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-FOUR-REFINEMENTS] [7.30]
 */
export interface Tone3000LibraryBanks { entries?: readonly { instanceId: number; name: string }[]; }

/** Missing names remain explicitly unknown; never substitute the selected bank.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-FOUR-REFINEMENTS] [7.30]
 */
export function tone3000BankLocation(bankId: number, banks: Tone3000LibraryBanks): string {
    const name = banks.entries?.find(bank => bank.instanceId === bankId)?.name;
    return name?.trim() ? name : `Bank ${bankId} (name unavailable)`;
}

/** A real linked saved copy, never a source inferred from a similar preset name.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-PITCH-LV2] [7.30] [7.36]
 */
export interface Tone3000SavedCopy { entry: Tone3000LibraryEntry; target: Tone3000Import; }

/** Search each saved rig independently and retain the server's exact identities.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-11] [DES-PITCH-LV2] [7.30] [7.36]
 */
export function tone3000SavedCopies(entries: readonly Tone3000LibraryEntry[], search: string,
    banks: Tone3000LibraryBanks): Tone3000SavedCopy[] {
    const needle = search.trim().toLocaleLowerCase();
    return entries.flatMap(entry => entry.imports.map(target => ({ entry, target })))
        .filter(({ entry, target }) => [target.name, entry.name, tone3000BankLocation(target.bankId, banks)]
            .join(" ").toLocaleLowerCase().includes(needle))
        .sort((left, right) => Number(right.target.active) - Number(left.target.active));
}

/** Preserve source/target objects and server order, except current-first in Saved.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-11] [DES-FOUR-REFINEMENTS] [7.30]
 */
export function tone3000FilterLibrary(entries: readonly Tone3000LibraryEntry[], filter: Tone3000LibraryFilter,
    search: string, banks: Tone3000LibraryBanks): Tone3000LibraryEntry[] {
    const needle = search.trim().toLocaleLowerCase();
    const result = entries.filter(entry => {
        if (filter === "saved" && !entry.imports.length || filter === "new" && entry.imports.length
            || filter === "updates" && !entry.imports.some(target => target.sha256 !== entry.sha256)) return false;
        return [entry.name, entry.source, ...entry.imports.flatMap(target => [target.name, tone3000BankLocation(target.bankId, banks)])]
            .join(" ").toLocaleLowerCase().includes(needle);
    });
    if (filter === "saved") result.sort((left, right) => Number(right.imports.some(target => target.active)) - Number(left.imports.some(target => target.active)));
    return result;
}
