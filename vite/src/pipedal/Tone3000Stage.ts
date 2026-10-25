// SPDX-License-Identifier: MIT
import type { Tone3000Block } from "./Tone3000Rig";
export type Tone3000StageCommand = "runtime" | "balance" | "align" | "level" | "pan" | "solo" | "block";
export interface Tone3000StageRuntimeBlock {
    blockId: string; lane: string; enabled: boolean; loaded?: boolean; modelLoading?: boolean; loadFailed?: boolean;
    requestedSlimSize?: number; a2Known: boolean; a2Supported?: boolean; effectiveSlimKnown: boolean;
    slimSizeCountKnown?: boolean; slimSizeCount?: number | null; slimBreakpoints?: number[];
    inputLevelDbu?: number | null; outputLevelDbu?: number | null;
}
export interface Tone3000StageRuntime {
    unknown?: boolean; truncated?: boolean; stereoEnabled?: boolean; audioActive?: boolean; stereoInput?: boolean; stereoOutput?: boolean;
    blocks?: Tone3000StageRuntimeBlock[]; capabilities?: string[];
}
export interface Tone3000StageResult {
    state: "queued" | "listening" | "done" | "timeout" | "cancelled" | "notApplicable" | "failed" | "stale";
    token: number; runtime?: Tone3000StageRuntime; revision?: string; bankId?: number; presetId?: number; instanceId?: number; savedRevision?: string;
    valid?: boolean; receiptValid?: boolean; finite?: boolean; clipped?: boolean; silent?: boolean; rmsDb?: number | null; peakDb?: number | null;
    seconds?: number; samples?: number; channels?: number; progress?: number; matchedDb?: number; matchedMs?: number; polarityFlipped?: boolean;
}
export interface Tone3000StageMeasurement { result: Tone3000StageResult; name: string; applied: boolean; }
/** Labels describe captured metadata and requested endpoints, never effective DSP tiers.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.5]
 */
export function tone3000StageBlockName(blockId: string, blocks: Pick<Tone3000Block, "blockId" | "title" | "type" | "gear">[]): string {
    const block = blocks.find(item => item.blockId === blockId);
    return block?.title || block?.gear || (block ? block.type.toUpperCase() : "Unknown block");
}
export function tone3000StageRequestedSize(size: number | undefined): string {
    if (size === 0) return "A2-Lite";
    if (size === 1) return "A2-Full";
    return typeof size === "number" && Number.isFinite(size) && size > 0 && size < 1 ? "intermediate request (" + Math.round(size * 100) + "%)" : "unknown";
}
export function tone3000StageCalibration(block: Tone3000StageRuntimeBlock): string {
    const fields: string[] = [];
    if (typeof block.inputLevelDbu === "number" && Number.isFinite(block.inputLevelDbu)) fields.push("input " + block.inputLevelDbu.toFixed(1) + " dBu");
    if (typeof block.outputLevelDbu === "number" && Number.isFinite(block.outputLevelDbu)) fields.push("output " + block.outputLevelDbu.toFixed(1) + " dBu");
    return fields.length ? "calibration metadata: " + fields.join(" · ") : "calibration metadata unknown";
}
/** Bounded model-session observations survive rig-view remounts, never reconnect.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [DES-RECOVERY] [7.6]
 */
export class Tone3000MeasurementSession {
    private rows: Tone3000StageMeasurement[] = [];
    private listeners = new Set<() => void>();
    get = (): Tone3000StageMeasurement[] => this.rows;
    subscribe = (callback: () => void): (() => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
    private changed(): void { this.listeners.forEach(listener => listener()); }
    add(result: Tone3000StageResult, name: string): void {
        if (!tone3000ValidMeasurement(result)) return;
        this.rows = [...this.rows.filter(row => row.result.bankId !== result.bankId || row.result.presetId !== result.presetId || row.result.instanceId !== result.instanceId), { result, name, applied: false }].slice(-32);
        this.changed();
    }
    applied(token: number): void { this.rows = this.rows.map(row => row.result.token === token ? { ...row, applied: true } : row); this.changed(); }
    clear(): void { this.rows = []; this.changed(); }
}
/** Invalid/silent/nonfinite observations never become level receipts or targets.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-21] [DES-STAGE-BRIDGE] [7.6]
 */
export function tone3000ValidMeasurement(result: Tone3000StageResult): boolean {
    return result.state === "done" && result.valid === true && result.receiptValid === true && result.finite === true && result.clipped === false && result.silent === false
        && typeof result.rmsDb === "number" && Number.isFinite(result.rmsDb) && result.rmsDb >= -60
        && typeof result.peakDb === "number" && Number.isFinite(result.peakDb) && result.peakDb >= result.rmsDb
        && typeof result.seconds === "number" && Number.isFinite(result.seconds) && result.seconds >= 1
        && typeof result.samples === "number" && Number.isFinite(result.samples) && result.samples > 0
        && typeof result.savedRevision === "string" && /^[0-9a-f]{64}$/.test(result.savedRevision)
        && Number.isSafeInteger(result.token) && result.token > 0;
}
export function tone3000QuietestTarget(rows: Tone3000StageMeasurement[]): number | null {
    const valid = rows.filter(row => tone3000ValidMeasurement(row.result));
    return valid.length ? Math.min(...valid.map(row => row.result.rmsDb as number)) : null;
}
/** Client proposal only; native receipt and saved-state guards remain authoritative.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.6]
 */
export function tone3000LevelProposalAllowed(row: Tone3000StageMeasurement, target: number): boolean {
    return !row.applied && tone3000ValidMeasurement(row.result) && Number.isFinite(target) && target >= -60 && target <= -3
        && Math.abs(target - (row.result.rmsDb as number)) <= 12 && (row.result.peakDb as number) + target - (row.result.rmsDb as number) <= -1;
}
/** One native request generation; cancellation handles late acknowledgements too.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [DES-RECOVERY] [7.5] [7.6]
 */
export class Tone3000StageRunner {
    private generation = 0;
    private token: number | null = null;
    private cancel: ((token: number) => Promise<unknown>) | null = null;
    private wake: (() => void) | null = null;
    get running(): boolean { return this.cancel !== null; }
    stop(): void {
        ++this.generation; this.wake?.(); this.wake = null;
        if (this.token !== null && this.cancel) void this.cancel(this.token).catch(() => {});
        this.token = null; this.cancel = null;
    }
    async run(start: () => Promise<Tone3000StageResult>, poll: (token: number) => Promise<Tone3000StageResult>,
        cancel: (token: number) => Promise<unknown>, receive: (result: Tone3000StageResult) => void,
        fail: (error: string) => void): Promise<void> {
        this.stop(); const generation = this.generation; this.cancel = cancel;
        try {
            let result = await start();
            if (generation !== this.generation) { void cancel(result.token).catch(() => {}); return; }
            if (!Number.isSafeInteger(result.token) || result.token <= 0) throw new Error("Invalid soundcheck token.");
            const activeToken = result.token; this.token = activeToken; const deadline = Date.now() + 30000;
            for (;;) {
                if (generation !== this.generation) return;
                receive(result);
                if (result.state !== "queued" && result.state !== "listening") { this.token = null; this.cancel = null; return; }
                if (Date.now() > deadline) throw new Error("Soundcheck did not finish; cancel and retry after checking the rig.");
                await new Promise<void>(resolve => { const timer = setTimeout(() => { this.wake = null; resolve(); }, 200); this.wake = () => { clearTimeout(timer); resolve(); }; });
                if (generation !== this.generation) return;
                result = await poll(activeToken);
            }
        } catch (failure) { if (generation === this.generation) { this.stop(); fail(String(failure)); } }
    }
}
