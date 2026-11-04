import assert from "node:assert/strict";
import test from "node:test";
import { Tone3000BlockLiveEdit } from "../src/pipedal/Tone3000BlockLiveEdit.ts";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve=yes;reject=no; }); return {promise,resolve,reject}; };
const flush = async () => { for(let i=0;i<12;++i)await Promise.resolve(); };
const payload = value => ({blockId:"amp",kind:"param",param:"mix",value});

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIVE-BLOCK] [7.39] */
test("preview transport coalesces and release performs one terminal commit", async () => {
    const edit=new Tone3000BlockLiveEdit(), start=deferred(), starts=[],updates=[],polls=[],done=[],fail=[];
    let current=true;
    const api={revision:()=>"a".repeat(64),current:()=>current,
        start:(revision,body)=>{starts.push({revision,body});return start.promise;},
        update:async(token,body)=>{updates.push({token,body});return {state:"queued",token};},
        poll:async token=>{polls.push(token);return {state:"done",token,revision:"b".repeat(64)};},
        cancel:async()=>({}),done:value=>done.push(value),fail:value=>fail.push(value),pause:async()=>{}};
    assert.equal(edit.dispatch("amp:mix",payload(.4),false,api),true);
    assert.equal(edit.dispatch("amp:mix",payload(.5),false,api),true);
    start.resolve({state:"queued",token:7});await flush();
    assert.deepEqual(starts,[{revision:"a".repeat(64),body:{...payload(.4),phase:"preview"}}]);
    assert.deepEqual(updates,[{token:7,body:{...payload(.5),phase:"preview"}}]);
    assert.equal(edit.dispatch("amp:mix",payload(.6),true,api),true);await flush();
    assert.deepEqual(updates.at(-1),{token:7,body:{...payload(.6),phase:"commit"}});
    assert.deepEqual(polls,[7]);assert.equal(done.length,1);assert.deepEqual(fail,[]);assert.equal(edit.active,false);
    current=false;
});

test("different controls are refused during a gesture and stop cancels its token once", async () => {
    const edit=new Tone3000BlockLiveEdit(), cancelled=[];let failures=0;
    const api={revision:()=>"a".repeat(64),current:()=>true,
        start:async()=>({state:"queued",token:9}),update:async()=>({state:"queued",token:9}),poll:async()=>({state:"listening",token:9}),
        cancel:async token=>{cancelled.push(token);return {state:"cancelled",token};},done:()=>{},fail:()=>{++failures;}};
    assert.equal(edit.dispatch("amp:mix",payload(.4),false,api),true);await flush();
    assert.equal(edit.dispatch("amp:output",{blockId:"amp",kind:"param",param:"outputGain",value:.5},true,api),false);
    assert.equal(failures,0);edit.stop();await flush();assert.deepEqual(cancelled,[9]);assert.equal(edit.active,false);
});

test("obsolete ownership suppresses terminal UI callbacks", async () => {
    const edit=new Tone3000BlockLiveEdit(), start=deferred(), cancelled=[],done=[],fail=[];let current=true;
    const api={revision:()=>"a".repeat(64),current:()=>current,start:()=>start.promise,
        update:async()=>({state:"queued",token:3}),poll:async()=>({state:"done",token:3,revision:"b".repeat(64)}),
        cancel:async token=>{cancelled.push(token);return {state:"cancelled",token};},done:value=>done.push(value),fail:value=>fail.push(value)};
    edit.dispatch("amp:mix",payload(.4),true,api);current=false;start.resolve({state:"queued",token:3});await flush();
    assert.deepEqual(done,[]);assert.deepEqual(fail,[]);assert.deepEqual(cancelled,[]);
});

test("transport failure waits for native cancellation before surfacing recovery", async () => {
    const edit=new Tone3000BlockLiveEdit(), cancel=deferred(), events=[];
    const api={revision:()=>"a".repeat(64),current:()=>true,
        start:async()=>({state:"queued",token:11}),update:async()=>{throw new Error("transport failed");},
        poll:async token=>({state:"cancelled",token}),cancel:token=>{events.push(["cancel",token]);return cancel.promise;},
        done:()=>events.push(["done"]),fail:value=>events.push(["fail",value]),pause:async()=>{}};
    edit.dispatch("amp:mix",payload(.4),false,api);await flush();
    edit.dispatch("amp:mix",payload(.5),false,api);await flush();
    assert.equal(edit.active,true);assert.deepEqual(events,[["cancel",11]]);
    cancel.resolve({state:"listening",token:11});await flush();
    assert.equal(edit.active,false);assert.equal(events.at(-1)[0],"fail");
});
