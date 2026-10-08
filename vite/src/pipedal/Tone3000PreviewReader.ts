// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
import type { Tone3000PreviewResult } from "./Tone3000Library";

export interface Tone3000PreviewRead {
    loading: boolean;
    result: Tone3000PreviewResult | null;
    error: string;
}

/** Reads belong to one source/target and connection generation. Never replay writes.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [DES-RECOVERY] [7.1]
 */
export class Tone3000PreviewReader {
    private generation = 0;
    invalidate(): void { ++this.generation; }
    async read(load: () => Promise<Tone3000PreviewResult>, receive: (read: Tone3000PreviewRead) => void): Promise<void> {
        const generation = ++this.generation;
        receive({ loading: true, result: null, error: "" });
        try {
            const result = await load();
            if (generation === this.generation) receive({ loading: false, result, error: "" });
        } catch (error) {
            if (generation === this.generation) receive({ loading: false, result: null, error: String(error) });
        }
    }
}
