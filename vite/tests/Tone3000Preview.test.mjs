import assert from "node:assert/strict";
import test from "node:test";
import { Tone3000PreviewReader } from "../src/pipedal/Tone3000PreviewReader.ts";

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

/** Execute the production reader with controlled transport completion, not DSP mocks.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [7.1]
 */
test("Source/target changes ignore obsolete preview successes and failures", async () => {
    const reader = new Tone3000PreviewReader(), first = deferred(), next = deferred(), reads = [];
    const old = reader.read(() => first.promise, state => reads.push(state));
    const current = reader.read(() => next.promise, state => reads.push(state));
    first.reject(new Error("old source is stale")); await old;
    assert.equal(reads.length, 2, "old error does not overwrite the new loading state");
    const result = { key: "new", sha256: "newhash", targetName: "Other saved target" };
    next.resolve(result); await current;
    assert.equal(reads.length, 3); assert.equal(reads.at(-1).result, result);
    const stale = deferred(), fresh = deferred();
    const staleRead = reader.read(() => stale.promise, state => reads.push(state));
    const freshRead = reader.read(() => fresh.promise, state => reads.push(state));
    fresh.resolve(result); await freshRead; const count = reads.length;
    stale.resolve({ key: "old", sha256: "oldhash" }); await staleRead;
    assert.equal(reads.length, count, "old source/target success cannot enable confirmation");
});

test("Closing or disconnecting invalidates pending preview and only a new explicit read resumes", async () => {
    const reader = new Tone3000PreviewReader(), pending = deferred(), reads = [];
    let loads = 0;
    const read = reader.read(() => { ++loads; return pending.promise; }, state => reads.push(state));
    reader.invalidate();
    pending.resolve({ key: "closed" }); await read;
    assert.equal(reads.length, 1); assert.equal(loads, 1);
    reader.invalidate(); assert.equal(loads, 1, "invalidation never replays a request or mutation");
    await reader.read(async () => { ++loads; return { key: "reconnected" }; }, state => reads.push(state));
    assert.equal(loads, 2); assert.equal(reads.at(-1).result.key, "reconnected");
});

test("A current preview refusal clears result and is handled without rejection leakage", async () => {
    const reader = new Tone3000PreviewReader(), reads = [];
    await reader.read(async () => ({ key: "original" }), state => reads.push(state));
    await reader.read(async () => { throw new Error("Saved target changed; refresh."); }, state => reads.push(state));
    assert.equal(reads.at(-1).loading, false); assert.equal(reads.at(-1).result, null);
    assert.match(reads.at(-1).error, /Saved target changed/);
});
