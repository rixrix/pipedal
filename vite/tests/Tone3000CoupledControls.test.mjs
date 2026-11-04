import test from "node:test";
import assert from "node:assert/strict";
import { Tone3000CoupledGestures, tone3000CoupledControl, tone3000CoupledPrefix } from "../src/pipedal/Tone3000CoupledControls.ts";

// @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.3]
function fixture(overrides = {}) {
    const calls = [];
    const api = {
        current: async () => ({ revision: "captured" }),
        getRaw: async id => { calls.push(["get", id]); return .25; },
        setRaw: async (id, value) => { calls.push(["raw", id, value]); },
        start: async (revision, command, payload) => { calls.push(["start", revision, command, payload]); return { state: "done", token: 1 }; },
        poll: async token => ({ state: "done", token }),
        cancel: async token => { calls.push(["cancel", token]); },
        isCurrent: () => true,
        canCancel: () => true,
        ...overrides
    };
    return { api, calls, gestures: new Tone3000CoupledGestures() };
}
test("Only five exact property URIs opt in; pan gestures preserve side and raw value for native half-range semantics", async () => {
    for (const id of ["chainPanLeft", "chainPanRight", "chainPanLinked", "chainSoloLeft", "chainSoloRight"])
        assert.equal(tone3000CoupledControl(tone3000CoupledPrefix + id), id);
    for (const uri of ["chainPanLeft", "https://other/plugin:chainPanLeft", tone3000CoupledPrefix + "outputBalance", tone3000CoupledPrefix + "chainPanLeftExtra"])
        assert.equal(tone3000CoupledControl(uri), undefined);
    const { api, calls, gestures } = fixture();
    await gestures.set("chainPanLeft", .8, api);
    await gestures.set("chainPanRight", .2, api);
    assert.deepEqual(calls, [["start", "captured", "pan", { side: "left", value: .8 }], ["start", "captured", "pan", { side: "right", value: .2 }]]);
    for (const value of [NaN, Infinity, -1, 1.01]) await assert.rejects(gestures.set("chainPanLeft", value, api), /Invalid/);
});
test("Link enabling writes the raw flag then snaps from stable left readback; disabling only writes the flag", async () => {
    const { api, calls, gestures } = fixture();
    await gestures.set("chainPanLinked", 1, api);
    await gestures.set("chainPanLinked", 0, api);
    assert.deepEqual(calls, [["raw", "chainPanLinked", 1], ["get", "chainPanLeft"], ["start", "captured", "pan", { side: "left", value: .25 }], ["raw", "chainPanLinked", 0]]);
    await assert.rejects(gestures.set("chainPanLinked", .5, api), /Invalid/);
});
test("Exclusive solo enables one side and turning one side off preserves an active opposite side", async () => {
    for (const side of ["Left", "Right"]) {
        const { api, calls, gestures } = fixture({ getRaw: async () => 1 });
        await gestures.set("chainSolo" + side, 1, api);
        await gestures.set("chainSolo" + side, 0, api);
        assert.deepEqual(calls.map(call => call[3]), [{ side: side.toLowerCase() }, { side: side === "Left" ? "right" : "left" }]);
    }
    const { api, calls, gestures } = fixture({ getRaw: async () => 0 });
    await gestures.set("chainSoloLeft", 0, api);
    assert.deepEqual(calls[0][3], { side: "none" });
});
test("Changed revision during counterpart read rejects before any stage mutation", async () => {
    let current = 0;
    const { api, calls, gestures } = fixture({ current: async () => ({ revision: String(++current) }) });
    await assert.rejects(gestures.set("chainSoloLeft", 0, api), /rig changed/);
    assert.deepEqual(calls, [["get", "chainSoloRight"]]);
});
test("Unmount during a raw read prevents later stage writes; a late acknowledgement is cancelled without polling", async () => {
    let raw;
    const first = fixture({ getRaw: () => new Promise(resolve => { raw = resolve; }) });
    const request = first.gestures.set("chainSoloLeft", 0, first.api);
    while (!raw) await Promise.resolve();
    first.gestures.stop(); raw(1);
    await assert.rejects(request, /cancelled/);
    assert.deepEqual(first.calls, []);
    let ack;
    const second = fixture({ start: () => new Promise(resolve => { ack = resolve; }), poll: async () => { throw Error("must not poll"); } });
    const delayed = second.gestures.set("chainPanLeft", .2, second.api);
    while (!ack) await Promise.resolve();
    second.gestures.stop(); ack({ state: "queued", token: 9 });
    await assert.rejects(delayed, /cancelled/);
    assert.deepEqual(second.calls, [["cancel", 9]]);
});
test("Reconnection prevents old cancellation RPCs; pending failure cancels once and failures remain visible to the caller", async () => {
    let ack, connected = true;
    const first = fixture({ start: () => new Promise(resolve => { ack = resolve; }), canCancel: () => connected });
    const delayed = first.gestures.set("chainPanLeft", .2, first.api);
    while (!ack) await Promise.resolve();
    connected = false; first.gestures.stop(); ack({ state: "queued", token: 9 });
    await assert.rejects(delayed, /cancelled/);
    assert.deepEqual(first.calls, []);
    const second = fixture({ start: async () => ({ state: "queued", token: 3 }), poll: async () => { throw Error("plugin rejected"); } });
    await assert.rejects(second.gestures.set("chainPanRight", .7, second.api, { pause: async () => {} }), /plugin rejected/);
    assert.deepEqual(second.calls, [["cancel", 3]]);
    const third = fixture({ start: async () => ({ state: "notApplicable", token: 4 }) });
    await assert.rejects(third.gestures.set("chainPanLeft", .2, third.api), /notApplicable/);
});
test("Polling validates its token; request deadlines bound hangs and cancel late acknowledgement", async () => {
    const first = fixture({ start: async () => ({ state: "queued", token: 3 }), poll: async () => ({ state: "done", token: 4 }) });
    await assert.rejects(first.gestures.set("chainPanLeft", .2, first.api, { pause: async () => {} }), /another request/);
    assert.deepEqual(first.calls, [["cancel", 3]]);
    let ack;
    const second = fixture({ start: () => new Promise(resolve => { ack = resolve; }) });
    await assert.rejects(second.gestures.set("chainPanRight", .7, second.api, { timeoutMs: 20 }), /timed out/);
    ack({ state: "queued", token: 7 });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(second.calls, [["cancel", 7]]);
});
