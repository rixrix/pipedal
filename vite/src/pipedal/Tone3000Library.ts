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
