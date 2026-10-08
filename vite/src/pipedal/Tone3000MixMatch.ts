// SPDX-License-Identifier: MIT
import type { Tone3000Summary } from "./Tone3000Rig";

/** Exact saved identities; source bytes remain on the server.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-26] [FR-27] [DES-PITCH-LV2] [7.36] */
export interface Tone3000MixMatchRequest {
    bankId: number; presetId: number; instanceId: number; expectedRevision: string;
    ampBlockId: string; cabBlockId: string; name: string; includePitch: boolean;
    confirmAmpHead: boolean; creationId?: string;
}
export interface Tone3000MixMatchPreview {
    sourceRevision: string; sourceName: string; name: string;
    ampBlockId: string; cabBlockId: string; ampSummary: Tone3000Summary; cabSummary: Tone3000Summary;
    includePitch: boolean; pitchControls: { key: string; value: number }[];
    items: { instanceId: number; uri: string; name: string; role: string }[];
    warnings: string[]; qualified: boolean; requiresAmpHeadConfirmation: boolean;
}
export interface Tone3000MixMatchResult {
    bankId: number; presetId: number; name: string; sourceRevision: string;
    ampInstanceId: number; cabInstanceId: number; pitchInstanceId: number; qualified: boolean;
}
export interface Tone3000DerivedSource {
    bankId: number; presetId: number; instanceId: number; revision: string;
    ampBlockId: string; cabBlockId: string; stage: "amp" | "cab" | "pitch";
    creationId: string; requestHash: string;
}

/** getRandomValues works on local HTTP too; randomUUID requires a secure context.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [7.36] */
export function tone3000CreationId(fill: (bytes: Uint8Array) => Uint8Array = bytes => crypto.getRandomValues(bytes)): string {
    const bytes = fill(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export interface Tone3000MixMatchRead {
    loading: boolean; creating: boolean; preview: Tone3000MixMatchPreview | null;
    receipt: Tone3000MixMatchResult | null; error: string; uncertain: boolean;
}

/** Generation-bound previews and one explicit creation; never retries a mutation.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [DES-SEC] [7.36] */
export class Tone3000MixMatchSession {
    state: Tone3000MixMatchRead = { loading: false, creating: false, preview: null, receipt: null, error: "", uncertain: false };
    private generation = 0;
    private request: Tone3000MixMatchRequest | null = null;
    private publish: (state: Tone3000MixMatchRead) => void;
    private makeId: () => string;
    constructor(publish: (state: Tone3000MixMatchRead) => void, makeId = tone3000CreationId) { this.publish = publish; this.makeId = makeId; }
    private update(value: Partial<Tone3000MixMatchRead>) { this.state = { ...this.state, ...value }; this.publish(this.state); }
    invalidate(): boolean {
        const uncertain = this.state.creating || this.state.uncertain;
        ++this.generation; this.request = null;
        this.update({ loading: false, creating: false, preview: null, uncertain });
        return uncertain;
    }
    async read(load: () => Promise<{ request: Tone3000MixMatchRequest; preview: Tone3000MixMatchPreview }>): Promise<void> {
        if (this.state.creating || this.state.uncertain || this.state.receipt) return;
        const generation = ++this.generation;
        this.request = null; this.update({ loading: true, preview: null, error: "" });
        try {
            const { request, preview } = await load();
            if (generation !== this.generation) return;
            if (preview.sourceRevision !== request.expectedRevision || preview.ampBlockId !== request.ampBlockId
                || preview.cabBlockId !== request.cabBlockId || preview.includePitch !== request.includePitch
                || preview.name !== request.name || preview.qualified !== false)
                throw new Error("Saved source or preview changed. Read it again.");
            this.request = { ...request, confirmAmpHead: false, creationId: this.makeId() };
            this.update({ loading: false, preview });
        } catch (error) {
            if (generation === this.generation) this.update({ loading: false, preview: null, error: String(error) });
        }
    }
    async create(confirmed: boolean, save: (request: Tone3000MixMatchRequest) => Promise<Tone3000MixMatchResult>): Promise<void> {
        if (!confirmed || !this.request || !this.state.preview || this.state.loading || this.state.creating
            || this.state.uncertain || this.state.receipt) return;
        const request = { ...this.request, confirmAmpHead: true }, generation = this.generation;
        this.update({ creating: true, error: "" });
        try {
            const receipt = await save(request);
            if (generation !== this.generation) return;
            if (!Number.isSafeInteger(receipt.bankId) || receipt.bankId < 0 || !Number.isSafeInteger(receipt.presetId)
                || receipt.presetId < 0 || receipt.sourceRevision !== request.expectedRevision
                || ![receipt.ampInstanceId, receipt.cabInstanceId, ...(request.includePitch ? [receipt.pitchInstanceId] : [])].every(id => Number.isSafeInteger(id) && id >= 0)
                || new Set([receipt.ampInstanceId, receipt.cabInstanceId, ...(request.includePitch ? [receipt.pitchInstanceId] : [])]).size !== (request.includePitch ? 3 : 2)
                || (!request.includePitch && receipt.pitchInstanceId !== -1) || receipt.name !== request.name || receipt.qualified !== false)
                throw new Error("Creation receipt could not be verified. Inspect the experimental banks.");
            this.update({ creating: false, receipt });
        } catch (error) {
            if (generation === this.generation) this.update({ creating: false, uncertain: true,
                error: String(error) + " Inspect TONE3000 Experiments banks before creating another copy." });
        }
    }
}
