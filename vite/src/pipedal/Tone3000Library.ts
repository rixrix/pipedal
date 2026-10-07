// Copyright (c) 2026 Thomas Rapolani
// SPDX-License-Identifier: MIT

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
