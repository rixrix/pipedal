import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(new URL("../package.json", import.meta.url));
const ts = require("typescript");
const source = ts.createSourceFile("PiPedalModel.tsx",
    readFileSync(new URL("../src/pipedal/PiPedalModel.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let reconnect;
function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === "onSocketReconnected") reconnect = node;
    ts.forEachChild(node, visit);
}
visit(source);
assert.ok(reconnect, "production reconnect method exists");
const code = ts.transpileModule("class RecoveryModel {" + reconnect.getText(source) + "}\nglobalThis.RecoveryModel = RecoveryModel;",
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

/** Execute the real model handshake: retain the old version until comparison.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
 */
function fixture(previous, next) {
    const context = { VisibilityState: { Hidden: 9 } };
    vm.runInNewContext(code, context);
    const model = new context.RecoveryModel();
    const requests = [];
    Object.assign(model, {
        serverVersion: previous, reloads: 0, loads: 0,
        cancelOnNetworkChanging() {}, cancelAndroidReconnectTimer() {},
        isAndroidHosted: () => false, visibilityState: { get: () => 0 },
        getWebSocket: () => ({ request: async message => {
            requests.push(message);
            if (message === "hello") return 27;
            if (message === "version") return next;
            throw new Error("Unexpected request");
        } }),
        reloadPage() { ++this.reloads; },
        async loadServerState() { ++this.loads; return true; }
    });
    return { model, requests };
}

test("reconnect reloads a client with a changed server version before loading state", async () => {
    const f = fixture({ serverVersion: "old" }, { serverVersion: "new" });
    await f.model.onSocketReconnected();
    assert.deepEqual(f.requests, ["hello", "version"]);
    assert.equal(f.model.reloads, 1); assert.equal(f.model.loads, 0);
    assert.equal(f.model.serverVersion.serverVersion, "old");
});

test("same-version and initially unknown clients complete the handshake and restore state", async () => {
    for (const previous of [{ serverVersion: "same" }, undefined]) {
        const next = { serverVersion: "same", minorVersion: 2 };
        const f = fixture(previous, next);
        await f.model.onSocketReconnected();
        assert.equal(f.model.reloads, 0); assert.equal(f.model.loads, 1);
        assert.equal(f.model.serverVersion, next); assert.equal(f.model.clientId, 27);
    }
});

test("a lost handshake rejects rather than publishing a new version or loading state", async () => {
    const f = fixture({ serverVersion: "old" }, { serverVersion: "new" });
    f.model.getWebSocket = () => ({ request: async () => { throw new Error("connection lost"); } });
    await assert.rejects(f.model.onSocketReconnected(), /connection lost/);
    assert.equal(f.model.loads, 0); assert.equal(f.model.reloads, 0);
    assert.equal(f.model.serverVersion.serverVersion, "old");
});
