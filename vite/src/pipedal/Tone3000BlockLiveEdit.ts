// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
import type { Tone3000EqBand } from "./Tone3000Rig";
import type { Tone3000StageResult } from "./Tone3000Stage";

export type Tone3000BlockEditPayload =
    | { blockId: string; kind: "param"; param: "enabled" | "normalize" | "inputGain" | "outputGain" | "mix"; value: number }
    | { blockId: string; kind: "eqEnabled" | "eqPre"; value: boolean }
    | { blockId: string; kind: "eqBand"; index: number; band: Tone3000EqBand };

export interface Tone3000BlockEditApi {
    revision: () => string;
    start: (revision: string, payload: object) => Promise<Tone3000StageResult>;
    update: (token: number, payload: object) => Promise<Tone3000StageResult>;
    poll: (token: number) => Promise<Tone3000StageResult>;
    cancel: (token: number) => Promise<Tone3000StageResult>;
    current: () => boolean;
    done: (result: Tone3000StageResult) => void;
    fail: (message: string) => void;
    pause?: () => Promise<void>;
}

type Queued = { payload: Tone3000BlockEditPayload; commit: boolean };

/** One owned native edit gesture. Preview values coalesce while transport is
 * busy; release always sends one final commit before PiPedal captures state.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIVE-BLOCK] [7.39]
 */
export class Tone3000BlockLiveEdit {
    private generation = 0;
    private identity = "";
    private token: number | null = null;
    private queued: Queued | null = null;
    private pumping = false;
    private api: Tone3000BlockEditApi | null = null;

    get active(): boolean { return this.pumping || this.token !== null || this.queued !== null; }

    dispatch(identity: string, payload: Tone3000BlockEditPayload, commit: boolean, api: Tone3000BlockEditApi): boolean {
        if (!identity || !api.current()) return false;
        if (this.identity && this.identity !== identity) {
            return false;
        }
        if (!this.identity) { this.identity = identity; this.api = api; }
        if (this.queued?.commit && !commit) return false;
        this.queued = { payload, commit: commit || !!this.queued?.commit };
        if (!this.pumping) void this.pump(++this.generation);
        return true;
    }

    stop(): void {
        ++this.generation;
        const token = this.token, api = this.api;
        this.reset();
        if (token !== null && api?.current()) void api.cancel(token).catch(() => {});
    }

    private reset(): void {
        this.identity = ""; this.token = null; this.queued = null; this.pumping = false; this.api = null;
    }

    private async pump(generation: number): Promise<void> {
        this.pumping = true;
        const api = this.api;
        if (!api) { this.reset(); return; }
        const alive = () => generation === this.generation && this.api === api && api.current();
        const check = () => { if (!alive()) throw new Error("The rig or connection changed; block edit cancelled."); };
        try {
            while (alive() && this.queued) {
                const next = this.queued; this.queued = null;
                const body = { ...next.payload, phase: next.commit ? "commit" : "preview" };
                if (this.token === null) {
                    const started = await api.start(api.revision(), body);
                    if (!Number.isSafeInteger(started.token) || started.token <= 0) throw new Error("Invalid block edit token.");
                    this.token = started.token; check();
                } else {
                    await api.update(this.token, body); check();
                }
                if (!next.commit) continue;
                const token = this.token; if (token === null) throw new Error("Block edit token expired.");
                let result: Tone3000StageResult = { state: "queued", token };
                const deadline = Date.now() + 10000;
                while (result.state === "queued" || result.state === "listening") {
                    if (Date.now() > deadline) throw new Error("Block edit did not finish. Refresh before retrying.");
                    await (api.pause?.() ?? new Promise<void>(resolve => setTimeout(resolve, 25))); check();
                    result = await api.poll(token); check();
                    if (result.token !== token) throw new Error("Block edit reply belongs to another request.");
                }
                if (result.state !== "done" || typeof result.revision !== "string")
                    throw new Error("Block edit " + result.state + ". Refresh before retrying.");
                this.reset(); api.done(result); return;
            }
            if (alive()) this.pumping = false;
        } catch (failure) {
            const token = this.token;
            if (alive()) {
                // Keep ownership until native cancellation has restored its
                // captured baseline. A new gesture must not race that restore.
                this.queued = null;
                if (token !== null && api.current()) {
                    try {
                        let cancelled = await api.cancel(token);
                        const deadline = Date.now() + 5000;
                        while (alive() && (cancelled.state === "queued" || cancelled.state === "listening")) {
                            if (Date.now() > deadline) break;
                            await (api.pause?.() ?? new Promise<void>(resolve => setTimeout(resolve, 25)));
                            if (!alive()) break;
                            cancelled = await api.poll(token);
                        }
                    } catch { /* Preserve the original failure for the user. */ }
                }
                if (alive()) { this.reset(); api.fail(String(failure)); }
            } else if (generation === this.generation && this.api === api) this.reset();
        }
    }
}
