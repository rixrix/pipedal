// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
import type { Tone3000StageResult } from "./Tone3000Stage";

export type Tone3000CoupledControl = "chainPanLeft" | "chainPanRight" | "chainPanLinked" | "chainSoloLeft" | "chainSoloRight";
const controls: Tone3000CoupledControl[] = ["chainPanLeft", "chainPanRight", "chainPanLinked", "chainSoloLeft", "chainSoloRight"];
export const tone3000CoupledPrefix = "https://www.tone3000.com/plugin:";

/** Only the exact reviewed properties opt into native coupled gestures.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.3]
 */
export function tone3000CoupledControl(uri: string): Tone3000CoupledControl | undefined {
    return controls.find(id => uri === tone3000CoupledPrefix + id);
}

/** Per-gesture ownership is checked after every asynchronous boundary.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.3]
 */
export interface Tone3000CoupledApi {
    current: () => Promise<{ revision: string }>;
    getRaw: (id: Tone3000CoupledControl) => Promise<number>;
    setRaw: (id: Tone3000CoupledControl, value: number) => Promise<unknown>;
    start: (revision: string, command: "pan" | "solo", payload: object) => Promise<Tone3000StageResult>;
    poll: (token: number) => Promise<Tone3000StageResult>;
    cancel: (token: number) => Promise<unknown>;
    isCurrent: () => boolean;
    canCancel: () => boolean;
}

/** A single bounded gesture; obsolete replies cannot issue follow-up writes.
 * The server owns revision validation, native completion capture and dirty state.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.3]
 */
export class Tone3000CoupledGestures {
    private generation = 0;
    private busy = false;
    private pending: { token: number; api: Tone3000CoupledApi } | null = null;

    private cancel(token: number, api: Tone3000CoupledApi): void {
        if (api.canCancel()) void api.cancel(token).catch(() => {});
    }

    stop(): void {
        ++this.generation;
        this.busy = false;
        if (this.pending) this.cancel(this.pending.token, this.pending.api);
        this.pending = null;
    }

    async set(id: Tone3000CoupledControl, value: number, api: Tone3000CoupledApi,
        options: { timeoutMs?: number; pause?: () => Promise<void> } = {}): Promise<void> {
        if (!Number.isFinite(value) || value < 0 || value > 1 || (!id.startsWith("chainPan") && value !== 0 && value !== 1)
                || (id === "chainPanLinked" && value !== 0 && value !== 1)) throw new Error("Invalid coupled control value.");
        if (this.busy) throw new Error("The previous stereo gesture is still finishing. Retry after its readback.");
        this.busy = true;
        const generation = ++this.generation;
        const deadline = Date.now() + (options.timeoutMs ?? 10000);
        let expired = false;
        const alive = () => generation === this.generation && !expired && api.isCurrent();
        const check = () => { if (!alive()) throw new Error("The rig or connection changed; stereo gesture cancelled."); };
        const wait = async <T>(request: () => Promise<T>): Promise<T> => {
            check();
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error("Stereo gesture timed out. Check the rig and retry.");
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const result = await Promise.race([request(), new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => { expired = true; reject(new Error("Stereo gesture timed out. Check the rig and retry.")); }, remaining);
                })]);
                check();
                return result;
            } finally { if (timer !== undefined) clearTimeout(timer); }
        };
        const current = async () => {
            const result = await wait(api.current);
            if (typeof result.revision !== "string" || !result.revision) throw new Error("The rig revision is unavailable.");
            return result.revision;
        };
        const stableRaw = async (property: Tone3000CoupledControl) => {
            const before = await current();
            const raw = await wait(() => api.getRaw(property));
            const after = await current();
            if (before !== after) throw new Error("The rig changed while reading stereo controls. Retry the gesture.");
            if (!Number.isFinite(raw) || raw < 0 || raw > 1) throw new Error("The plugin returned an invalid stereo control value.");
            return { raw, revision: after };
        };
        try {
            let revision: string;
            let command: "pan" | "solo";
            let payload: object;
            if (id === "chainPanLinked") {
                // Native UI writes the link flag, then snaps the right pan from the
                // current left pan only when linking is enabled.
                await current();
                await wait(() => api.setRaw(id, value));
                if (value === 0) return;
                const left = await stableRaw("chainPanLeft");
                revision = left.revision; command = "pan"; payload = { side: "left", value: left.raw };
            } else if (id === "chainPanLeft" || id === "chainPanRight") {
                revision = await current(); command = "pan";
                payload = { side: id === "chainPanLeft" ? "left" : "right", value };
            } else {
                const side = id === "chainSoloLeft" ? "left" : "right";
                let selected = side;
                if (value === 0) {
                    const other = await stableRaw(id === "chainSoloLeft" ? "chainSoloRight" : "chainSoloLeft");
                    revision = other.revision;
                    selected = other.raw > .5 ? (side === "left" ? "right" : "left") : "none";
                } else revision = await current();
                command = "solo"; payload = { side: selected };
            }
            const start = api.start;
            let result = await wait(() => start(revision, command, payload).then(reply => {
                // A delayed acknowledgement must still be cancelled after timeout,
                // unmount or a newer generation, without using a reconnected socket.
                if (!alive() && Number.isSafeInteger(reply.token) && reply.token > 0) this.cancel(reply.token, api);
                return reply;
            }));
            if (!Number.isSafeInteger(result.token) || result.token <= 0) throw new Error("Invalid stereo gesture token.");
            const token = result.token;
            this.pending = { token, api };
            while (result.state === "queued" || result.state === "listening") {
                await wait(options.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 100))));
                result = await wait(() => api.poll(token));
                if (result.token !== token) throw new Error("The stereo gesture reply belongs to another request.");
            }
            if (result.state !== "done") throw new Error("Stereo gesture " + result.state + ". Check stereo routing and plugin support.");
            this.pending = null;
        } finally {
            if (generation === this.generation) {
                if (this.pending) this.cancel(this.pending.token, this.pending.api);
                this.pending = null; this.busy = false;
            }
        }
    }
}
