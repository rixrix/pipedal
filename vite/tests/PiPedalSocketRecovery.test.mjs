import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../package.json", import.meta.url));
const { build } = require("esbuild");
const compiled = await build({ entryPoints: [fileURLToPath(new URL("../src/pipedal/PiPedalSocket.tsx", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent" });
const flush = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };

/** Exercise the actual transport with controlled WebSocket events, not a copy of its logic.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
 */
function fixture(overrides = {}) {
    const sockets = [], timers = new Map(), events = [];
    let nextTimer = 0;
    class FakeWebSocket {
        static OPEN = 1;
        readyState = 0;
        sent = [];
        constructor() { sockets.push(this); }
        send(message) { this.sent.push(JSON.parse(message)); }
        close() { this.readyState = 3; }
        open() { this.readyState = 1; this.onopen?.({}); }
        message(header, body) { this.onmessage?.({ data: JSON.stringify([header, body]) }); }
        lose() { this.readyState = 3; this.onclose?.({}); }
        fail() { this.onerror?.({}); }
    }
    const context = { module: { exports: {} }, exports: {}, console, WebSocket: FakeWebSocket,
        setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: id => timers.delete(id) };
    context.exports = context.module.exports;
    vm.runInNewContext(compiled.outputFiles[0].text, context);
    const socket = new context.module.exports.default("ws://test.invalid/pipedal", {
        onMessageReceived: (header, body) => events.push(["notification", header, body]),
        onError: (message, error) => events.push(["error", message, error]),
        onConnectionLost: () => events.push(["lost"]), onReconnect: () => events.push(["ready"]),
        onReconnecting: () => true, ...overrides
    });
    return { socket, sockets, timers, events, async connect() {
        const connected = socket.connect(); sockets.at(-1).open(); await connected; socket.canReconnect = true;
    } };
}

test("successful/error replies release reservations and duplicate replies are harmless", async () => {
    const f = fixture(); await f.connect();
    const result = f.socket.request("hello");
    const reply = f.sockets[0].sent[0][0].replyTo;
    f.sockets[0].message({ message: "hello", reply }, 42);
    assert.equal(await result, 42); assert.equal(f.socket._replyMap.size, 0);
    f.sockets[0].message({ message: "error", reply }, "late duplicate");
    const failure = f.socket.request("invalid");
    const rejected = assert.rejects(failure, /invalid/);
    f.sockets[0].message({ message: "error", reply: f.sockets[0].sent[1][0].replyTo }, "invalid");
    await rejected; assert.equal(f.socket._replyMap.size, 0); f.socket.close();
});

test("loss settles outstanding mutations; reconnect ignores old replies/events and never replays writes", async () => {
    const f = fixture(); await f.connect();
    const oldMessage = f.sockets[0].onmessage;
    const mutation = f.socket.request("importTone3000Preset", { asNew: true });
    const rejected = assert.rejects(mutation, /outcome is unknown/);
    f.sockets[0].lose(); await rejected;
    assert.equal(f.socket._replyMap.size, 0);
    await assert.rejects(f.socket.request("setTone3000CurrentState"), /not sent/);
    f.sockets[1].open(); await flush();
    assert.equal(f.sockets[1].sent.length, 0, "reconnection must not replay mutations");
    oldMessage({ data: JSON.stringify([{ message: "onLv2StateChanged" }, { instanceId: 1 }]) });
    oldMessage({ data: JSON.stringify([{ message: "importTone3000Preset", reply: 1 }, { presetId: 9 }]) });
    assert.equal(f.events.filter(e => e[0] === "notification").length, 0);
    const read = f.socket.request("getTone3000Library");
    f.sockets[1].message({ message: "getTone3000Library", reply: f.sockets[1].sent[0][0].replyTo }, { entries: [] });
    assert.deepEqual(JSON.parse(JSON.stringify(await read)), { entries: [] }); f.socket.close();
});

test("dispose rejects open/pending requests, cancels pending connection and suppresses queued retry", async () => {
    const f = fixture(); await f.connect();
    const read = f.socket.request("getTone3000CurrentState");
    const rejected = assert.rejects(read, /outcome is unknown/);
    f.socket.close(); await rejected;
    await assert.rejects(f.socket.request("hello"), /not sent/);
    const pending = f.socket.connect();
    const cancelled = assert.rejects(pending, /cancelled/);
    const staleOpen = f.sockets[1].onopen;
    f.socket.close(); staleOpen({}); await cancelled;
    assert.equal(f.socket.socket, undefined);
    const g = fixture(); await g.connect(); g.sockets[0].lose(); g.sockets[1].fail(); await flush();
    assert.equal(g.timers.size, 1);
    const queuedRetry = [...g.timers.values()][0];
    g.socket.close(); assert.equal(g.timers.size, 0); queuedRetry();
    assert.equal(g.sockets.length, 2, "disposed socket must not reconnect from a queued old callback");
});

test("background suspension and send/serialization failures settle without leaking reservations", async () => {
    const f = fixture(); await f.connect();
    const read = f.socket.request("hello");
    const rejected = assert.rejects(read, /outcome is unknown/);
    f.socket.enterBackgroundState(); await rejected;
    f.socket.exitBackgroundState(); f.sockets[1].open(); await flush();
    assert.equal(f.sockets[1].sent.length, 0);
    const circular = {}; circular.self = circular;
    await assert.rejects(f.socket.request("test", circular));
    assert.equal(f.socket._replyMap.size, 0);
    f.sockets[1].send = () => { throw new Error("write failed"); };
    await assert.rejects(f.socket.request("test"), /write failed/);
    assert.equal(f.socket._replyMap.size, 0); f.socket.close();
});

test("async model callbacks are caught; directly ignored interrupted requests do not raise unhandled rejections", async () => {
    const unhandled = [];
    const listener = reason => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
        const f = fixture({ onConnectionLost: async () => { throw new Error("lost callback failed"); },
            onReconnect: async () => { throw new Error("bootstrap failed"); } });
        await f.connect(); f.socket.request("setOnboarding", true); f.sockets[0].lose();
        f.sockets[1].open(); await flush();
        assert.equal(f.events.filter(e => e[0] === "error").length, 2);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(unhandled, []); f.socket.close();
    } finally { process.removeListener("unhandledRejection", listener); }
});
