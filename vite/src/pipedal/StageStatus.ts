// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT

export type StageConnection = "connected" | "connecting" | "reconnecting" | "disconnected" | "busy";
export interface StageAudioSnapshot {
    active?: boolean; restarting?: boolean; errorMessage?: string;
    engineRunning?: boolean; usingFallback?: boolean;
    audioDriver?: string; actualInputDevice?: string; actualOutputDevice?: string; actualSampleRate?: number;
    underruns?: number; msSinceLastUnderrun?: number; cpuUsage?: number; temperaturemC?: number;
}
export interface StageAudioView {
    kind: "running" | "fallback" | "stopped" | "restarting" | "unknown" | "disconnected";
    label: string; detail: string; dirty: boolean; recentUnderrun: boolean;
}

/** Driver/connection evidence only; never infer loaded assets or audible readiness.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-19] [DES-STAGE] [7.2]
 */
export function stageAudioView(connection: StageConnection, status?: StageAudioSnapshot,
    dirty = false, readFailed = false): StageAudioView {
    const result: StageAudioView = { kind: "unknown", label: "Checking audio status", detail: "",
        dirty: connection === "connected" && dirty, recentUnderrun: false };
    if (connection !== "connected") {
        result.kind = "disconnected";
        result.label = connection === "reconnecting" ? "Reconnecting" : connection === "connecting" ? "Connecting"
            : connection === "busy" ? "Host is updating" : "Disconnected";
        result.detail = "Live audio status unavailable";
        return result;
    }
    if (!status) { if (readFailed) result.label = "Audio status unavailable"; return result; }
    if (status.restarting === true) { result.kind = "restarting"; result.label = "Audio restarting"; return result; }
    if (status.engineRunning === false) {
        result.kind = "stopped"; result.label = "Audio stopped"; result.detail = status.errorMessage || ""; return result;
    }
    const running = status.engineRunning === true || status.active === true;
    if (!running) {
        result.label = "Audio unavailable; device unknown"; result.detail = status.errorMessage || ""; return result;
    }
    const driver = status.audioDriver?.trim(), input = status.actualInputDevice?.trim(), output = status.actualOutputDevice?.trim();
    const rate = status.actualSampleRate;
    const details = [driver, `In: ${input || "unknown"}`, `Out: ${output || "unknown"}`];
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) details.push(`${rate / 1000} kHz`);
    result.detail = details.filter(Boolean).join(" · ");
    if (status.engineRunning === true && status.usingFallback === true) {
        result.kind = "fallback"; result.label = "Silent fallback";
    } else if (status.usingFallback === false && driver && input && output) {
        result.kind = "running"; result.label = "Audio running";
    } else {
        result.label = status.usingFallback === undefined ? "Audio running; device status unknown" : "Audio running; device details incomplete";
    }
    result.recentUnderrun = typeof status.underruns === "number" && Number.isFinite(status.underruns) && status.underruns > 0
        && typeof status.msSinceLastUnderrun === "number" && Number.isFinite(status.msSinceLastUnderrun)
        && status.msSinceLastUnderrun >= 0 && status.msSinceLastUnderrun < 15000;
    return result;
}

export interface StagePollOptions {
    intervalMs?: number; timeoutMs?: number;
    schedule?: (callback: () => void, delay: number) => () => void;
}

/** Serialized read-only polling. Timeout clears displayed evidence; the next
 * request waits for settlement, so a slow server cannot accumulate reads.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE] [7.2]
 */
export class StageStatusPoller<T> {
    private ready = false;
    private disposed = false;
    private generation = 0;
    private pending = false;
    private cancelNext?: () => void;
    private cancelDeadline?: () => void;
    private read: () => Promise<T>;
    private publish: (value?: T, error?: string) => void;
    private schedule: (callback: () => void, delay: number) => () => void;
    private intervalMs: number;
    private timeoutMs: number;

    constructor(read: () => Promise<T>, publish: (value?: T, error?: string) => void, options: StagePollOptions = {}) {
        this.read = read; this.publish = publish;
        this.intervalMs = options.intervalMs ?? 1000; this.timeoutMs = options.timeoutMs ?? 5000;
        this.schedule = options.schedule ?? ((callback, delay) => { const id = setTimeout(callback, delay); return () => clearTimeout(id); });
    }
    setReady(ready: boolean): void {
        if (this.disposed || this.ready === ready) return;
        this.ready = ready; ++this.generation; this.cancelNext?.(); this.cancelDeadline?.();
        this.cancelNext = this.cancelDeadline = undefined;
        this.publish(undefined);
        if (ready) this.poll();
    }
    dispose(): void {
        this.disposed = true; ++this.generation; this.cancelNext?.(); this.cancelDeadline?.();
        this.cancelNext = this.cancelDeadline = undefined;
    }
    private poll(): void {
        if (this.disposed || !this.ready || this.pending) return;
        this.pending = true; const generation = this.generation; let timedOut = false;
        const current = () => !this.disposed && this.ready && this.generation === generation;
        const cancelDeadline = this.schedule(() => {
            if (current()) { timedOut = true; this.publish(undefined, "Audio status request timed out"); }
        }, this.timeoutMs);
        this.cancelDeadline = cancelDeadline;
        Promise.resolve().then(() => {
            if (!current()) throw new Error("Obsolete audio-status read");
            return this.read();
        }).then(value => {
            if (current() && !timedOut) this.publish(value);
        }).catch(() => {
            if (current() && !timedOut) this.publish(undefined, "Audio status unavailable");
        }).finally(() => {
            cancelDeadline(); if (this.cancelDeadline === cancelDeadline) this.cancelDeadline = undefined;
            this.pending = false;
            if (this.disposed || !this.ready) return;
            if (this.generation !== generation) this.poll();
            else this.cancelNext = this.schedule(() => { this.cancelNext = undefined; this.poll(); }, this.intervalMs);
        });
    }
}
