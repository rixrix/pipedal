// Run: node --experimental-strip-types --test tests/StageStatus.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { stageAudioView, StageStatusPoller } from "../src/pipedal/StageStatus.ts";

const actual = () => ({ active: true, engineRunning: true, usingFallback: false, audioDriver: "ALSA",
    actualInputDevice: "hw:ActualInput", actualOutputDevice: "hw:ActualOutput", actualSampleRate: 48000,
    underruns: 0, msSinceLastUnderrun: 30000 });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 10; ++i) await Promise.resolve(); };
function clock() {
    let now = 0; const tasks = new Set();
    return { schedule(callback, delay) { const task = { at: now + delay, callback }; tasks.add(task); return () => tasks.delete(task); },
        advance(ms) { now += ms; for (const task of [...tasks].sort((a, b) => a.at - b.at)) if (task.at <= now && tasks.delete(task)) task.callback(); },
        get pending() { return tasks.size; } };
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-19] [DES-STAGE] [7.2] */
test("connection, restart, stopped and running-fallback precedence is explicit", () => {
    const fallback = { ...actual(), active: false, usingFallback: true, actualInputDevice: "null", actualOutputDevice: "null" };
    assert.equal(stageAudioView("connected", fallback).kind, "fallback");
    assert.equal(stageAudioView("connected", { ...fallback, engineRunning: false }).kind, "stopped");
    assert.equal(stageAudioView("connected", { ...fallback, engineRunning: false, restarting: true }).kind, "restarting");
    const disconnected = stageAudioView("reconnecting", { ...fallback, restarting: true }, true);
    assert.equal(disconnected.label, "Reconnecting"); assert.equal(disconnected.kind, "disconnected");
    assert.equal(disconnected.dirty, false); assert.equal(disconnected.recentUnderrun, false);
    const running = stageAudioView("connected", actual(), true);
    assert.equal(running.kind, "running"); assert.equal(running.dirty, true);
    assert.match(running.detail, /hw:ActualInput/); assert.match(running.detail, /hw:ActualOutput/); assert.match(running.detail, /48 kHz/);
});

test("old or incomplete status never becomes a verified actual-device claim", () => {
    assert.equal(stageAudioView("connected", { active: true }).kind, "unknown");
    assert.equal(stageAudioView("connected", { active: false }).kind, "unknown");
    assert.equal(stageAudioView("connected", { ...actual(), usingFallback: undefined }).kind, "unknown");
    assert.equal(stageAudioView("connected", { ...actual(), actualOutputDevice: "" }).kind, "unknown");
    assert.equal(stageAudioView("connected", undefined, false, true).label, "Audio status unavailable");
    assert.doesNotMatch(stageAudioView("disconnected", actual()).detail, /hw:Actual/);
});

test("recent underruns are bounded observations with explicit dirty state", () => {
    assert.equal(stageAudioView("connected", { ...actual(), underruns: 1, msSinceLastUnderrun: 14999 }).recentUnderrun, true);
    for (const age of [15000, -1, NaN, Infinity])
        assert.equal(stageAudioView("connected", { ...actual(), underruns: 1, msSinceLastUnderrun: age }).recentUnderrun, false);
    assert.equal(stageAudioView("connected", { ...actual(), underruns: 0, msSinceLastUnderrun: 0 }).recentUnderrun, false);
    assert.equal(stageAudioView("connected", { ...actual(), engineRunning: false, underruns: 1, msSinceLastUnderrun: 0 }).recentUnderrun, false);
});

test("polling starts immediately then serializes reads instead of overlapping slow replies", async () => {
    const time = clock(), reads = [], events = [];
    const poller = new StageStatusPoller(() => { const pending = deferred(); reads.push(pending); return pending.promise; },
        (value, error) => events.push({ value, error }), { schedule: time.schedule });
    poller.setReady(true); await flush(); assert.equal(reads.length, 1);
    time.advance(1000); await flush(); assert.equal(reads.length, 1);
    reads[0].resolve(actual()); await flush(); assert.equal(events.at(-1).value.audioDriver, "ALSA");
    time.advance(999); await flush(); assert.equal(reads.length, 1);
    time.advance(1); await flush(); assert.equal(reads.length, 2);
    poller.dispose(); reads[1].resolve(actual()); await flush(); assert.equal(time.pending, 0);
});

test("timeout clears evidence but cannot accumulate requests or accept a late sample", async () => {
    const time = clock(), pending = deferred(), events = []; let reads = 0;
    const poller = new StageStatusPoller(() => { ++reads; return pending.promise; },
        (value, error) => events.push({ value, error }), { schedule: time.schedule });
    poller.setReady(true); await flush(); time.advance(5000); await flush();
    assert.match(events.at(-1).error, /timed out/); assert.equal(events.at(-1).value, undefined);
    time.advance(60000); await flush(); assert.equal(reads, 1);
    pending.resolve(actual()); await flush(); assert.equal(events.at(-1).value, undefined);
    poller.dispose(); assert.equal(time.pending, 0);
});

test("disconnect/reconnect ignores obsolete completion and samples the new session", async () => {
    const time = clock(), reads = [], events = [];
    const poller = new StageStatusPoller(() => { const pending = deferred(); reads.push(pending); return pending.promise; },
        (value, error) => events.push({ value, error }), { schedule: time.schedule });
    poller.setReady(true); await flush(); poller.setReady(false); poller.setReady(true); await flush();
    assert.equal(events.at(-1).value, undefined); assert.equal(reads.length, 1);
    reads[0].resolve({ oldSession: true }); await flush(); assert.equal(reads.length, 2);
    assert.equal(events.some(event => event.value?.oldSession), false);
    reads[1].resolve(actual()); await flush(); assert.equal(events.at(-1).value.audioDriver, "ALSA");
    poller.dispose(); assert.equal(time.pending, 0);
});

test("dispose removes timers, suppresses late errors and prevents new reads", async () => {
    const time = clock(), pending = deferred(), events = []; let reads = 0;
    const poller = new StageStatusPoller(() => { ++reads; return pending.promise; },
        (value, error) => events.push({ value, error }), { schedule: time.schedule });
    poller.setReady(true); await flush(); poller.dispose(); const count = events.length;
    pending.reject(new Error("old connection")); await flush(); time.advance(60000); poller.setReady(true); await flush();
    assert.equal(events.length, count); assert.equal(reads, 1); assert.equal(time.pending, 0);
});

test("read failure clears status and retries once after the polling interval", async () => {
    const time = clock(), events = []; let reads = 0;
    const poller = new StageStatusPoller(() => { ++reads; return reads === 1 ? Promise.reject(new Error("read failed")) : Promise.resolve(actual()); },
        (value, error) => events.push({ value, error }), { schedule: time.schedule });
    poller.setReady(true); await flush(); assert.equal(events.at(-1).value, undefined); assert.match(events.at(-1).error, /unavailable/);
    time.advance(1000); await flush(); assert.equal(reads, 2); assert.equal(events.at(-1).value.audioDriver, "ALSA");
    poller.dispose();
});
