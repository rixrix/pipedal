// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT

/** Processing defaults are distinct from the rig's saved tone and blocks.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [DES-OPERATE] [3.13]
 */
export interface Tone3000Defaults {
    multiCore: boolean;
    namSlimSizeDefault: number;
    calibrateInput: boolean;
    inputCalibrationLevel: number;
    osEnabled: boolean;
    osFactor: number;
}
/** Named device profiles, staged independently of the playing rig.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [DES-OPERATE] [3.13]
 */
export interface Tone3000DefaultsResult {
    revision: string;
    activeProfile: string;
    defaults: Tone3000Defaults;
    profiles: { id: string; name: string; defaults: Tone3000Defaults }[];
    appDefaults?: Tone3000Defaults | null;
    sourceStatus: string;
    warnings: string[];
}
/** Source-defined six-band EQ in real units.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.13]
 */
export interface Tone3000EqBand { type: string; freqHz: number; gainDb: number; q: number; }
/** Compact block projection; model data remains on the server.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.13]
 */
export interface Tone3000Block {
    blockId: string; lane: string; index: number; type: string;
    title: string; gear: string; format: string; activeModelId: number | null;
    enabled: boolean; normalize: boolean; capabilityUnknown: boolean;
    slimSize: number; inputGain: number; outputGain: number; mix: number;
    eq: { enabled: boolean; pre: boolean; bands: Tone3000EqBand[] };
}
/** Current captured plugin state, not an engine readiness assertion.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [DES-OPERATE] [3.13]
 */
export interface Tone3000Summary {
    activePresetId: string; activePresetName: string; inputMode: string;
    calibrateInput: boolean; inputCalibrationLevel: number; osEnabled: boolean; osFactor: number;
    stereoEnabled: boolean; branchSide: string; branchAfterBlockId: string;
    blocks: Tone3000Block[];
}
/** Optimistic revision covers the current rig and its saved processing policy.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [DES-OPERATE] [3.13]
 */
export interface Tone3000CurrentState {
    revision: string; instanceId: number; followDefaults: boolean;
    summary: Tone3000Summary; hasSnapshotOverrides: boolean;
}
/** Sparse changes preserve all untouched block/state data.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.13]
 */
export interface Tone3000BlockPatch {
    blockId: string; enabled?: boolean; normalize?: boolean; inputGain?: number;
    outputGain?: number; mix?: number; slimSize?: number; eqEnabled?: boolean; eqPre?: boolean;
    eqBands?: ({ index: number } & Partial<Tone3000EqBand>)[];
}
/** Session edits and block changes use the existing safe state-reload path.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [DES-OPERATE] [3.13]
 */
export interface Tone3000StatePatch {
    inputMode?: string; calibrateInput?: boolean; inputCalibrationLevel?: number;
    osEnabled?: boolean; osFactor?: number; blocks?: Tone3000BlockPatch[];
}

/** Produce only changed fields, including individual EQ bands.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [FR-14] [DES-OPERATE] [3.13]
 */
export function tone3000BlockChanges(original: Tone3000Block[], draft: Tone3000Block[]): Tone3000BlockPatch[] {
    return draft.flatMap(block => {
        const old = original.find(candidate => candidate.blockId === block.blockId);
        if (!old) throw new Error("The rig's blocks changed. Refresh before applying edits.");
        const result: Tone3000BlockPatch = { blockId: block.blockId };
        for (const field of ["enabled", "normalize", "inputGain", "outputGain", "mix", "slimSize"] as const) {
            if (old[field] !== block[field]) Object.assign(result, { [field]: block[field] });
        }
        if (old.eq.enabled !== block.eq.enabled) result.eqEnabled = block.eq.enabled;
        if (old.eq.pre !== block.eq.pre) result.eqPre = block.eq.pre;
        const bands = block.eq.bands.flatMap((band, index) => {
            const before = old.eq.bands[index];
            if (!before) throw new Error("The rig's EQ changed. Refresh before applying edits.");
            const patch: { index: number } & Partial<Tone3000EqBand> = { index };
            for (const field of ["type", "freqHz", "gainDb", "q"] as const) {
                if (before[field] !== band[field]) Object.assign(patch, { [field]: band[field] });
            }
            return Object.keys(patch).length > 1 ? [patch] : [];
        });
        if (bands.length) result.eqBands = bands;
        return Object.keys(result).length > 1 ? [result] : [];
    });
}

/** Validate draft numbers before JSON can turn NaN into null.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.13]
 */
export function tone3000ValidBlocks(blocks: Tone3000Block[]): boolean {
    const range = (value: number, low: number, high: number) => Number.isFinite(value) && value >= low && value <= high;
    return blocks.every(block => [block.inputGain, block.outputGain, block.mix, block.slimSize].every(value => range(value, 0, 1))
        && block.eq.bands.every(band => range(band.freqHz, 20, 20000) && range(band.gainDb, -15, 15) && range(band.q, .1, 10)));
}
