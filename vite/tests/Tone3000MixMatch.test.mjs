import assert from "node:assert/strict";
import test from "node:test";
import { Tone3000MixMatchSession, tone3000CreationId } from "../src/pipedal/Tone3000MixMatch.ts";
const id = "12345678-1234-4234-8234-123456789abc";
const request = { bankId: 6, presetId: 24, instanceId: 1, expectedRevision: "saved", ampBlockId: "amp", cabBlockId: "cab", name: "Copy", includePitch: true, confirmAmpHead: false };
const preview = { sourceRevision: "saved", ampBlockId: "amp", cabBlockId: "cab", name: "Copy", includePitch: true, qualified: false };
const receipt = { bankId: 42, presetId: 1, sourceRevision: "saved", name: "Copy", ampInstanceId: 8, cabInstanceId: 9, pitchInstanceId: 7, qualified: false };
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const read = session => session.read(async () => ({ request, preview }));

/** Exercise the controller used by the real dialog through racing transports.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [DES-RECOVERY] [7.36] */
test("No creation without current preview and explicit amp-head confirmation; one exact request only", async () => {
    const session = new Tone3000MixMatchSession(() => {}, () => id), calls = [];
    const save = async value => { calls.push(value); return receipt; };
    await session.create(true, save); await read(session); await session.create(false, save);
    assert.equal(calls.length, 0);
    await session.create(true, save); await session.create(true, save);
    assert.deepEqual(calls, [{ ...request, confirmAmpHead: true, creationId: id }]);
    assert.equal(session.state.receipt, receipt);
});
test("Obsolete and invalid previews cannot enable Create", async () => {
    const session = new Tone3000MixMatchSession(() => {}, () => id), old = pending();
    const first = session.read(() => old.promise); await read(session);
    old.resolve({ request, preview: { ...preview, sourceRevision: "old" } }); await first;
    assert.equal(session.state.preview, preview);
    session.invalidate(); await session.read(async () => ({ request, preview: { ...preview, cabBlockId: "changed" } }));
    assert.equal(session.state.preview, null); assert.match(session.state.error, /changed/i);
    let writes = 0; await session.create(true, async () => { ++writes; return receipt; }); assert.equal(writes, 0);
});
test("Close/disconnect during creation remains uncertain and never replays after reconnect", async () => {
    const session = new Tone3000MixMatchSession(() => {}, () => id), wire = pending();
    await read(session); let writes = 0;
    const creation = session.create(true, () => { ++writes; return wire.promise; });
    await session.create(true, async () => { ++writes; return receipt; });
    assert.equal(session.invalidate(), true); wire.resolve(receipt); await creation;
    await read(session); await session.create(true, async () => { ++writes; return receipt; });
    assert.equal(writes, 1); assert.equal(session.state.receipt, null); assert.equal(session.state.uncertain, true);
});
test("Rejected/partial/ambiguous creation receipts keep uncertainty rather than claiming success", async () => {
    for (const invalid of [{ ...receipt, pitchInstanceId: 8 }, { ...receipt, ampInstanceId: NaN }, { ...receipt, sourceRevision: "other" }, { ...receipt, name: "other" }]) {
        const session = new Tone3000MixMatchSession(() => {}, () => id); await read(session);
        await session.create(true, async () => invalid);
        assert.equal(session.state.receipt, null); assert.equal(session.state.uncertain, true);
    }
    const session = new Tone3000MixMatchSession(() => {}, () => id); await read(session);
    await session.create(true, async () => { throw new Error("Lost reply"); });
    assert.match(session.state.error, /Inspect TONE3000 Experiments/); assert.equal(session.state.uncertain, true);
});
test("Local HTTP UUID uses injectable secure random bytes and valid v4/variant bits", () => {
    const value = tone3000CreationId(bytes => { bytes.fill(255); return bytes; });
    assert.equal(value, "ffffffff-ffff-4fff-bfff-ffffffffffff");
});
