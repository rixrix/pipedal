import test from "node:test";
import assert from "node:assert/strict";
import { Tone3000StageRunner, Tone3000MeasurementSession, tone3000ValidMeasurement, tone3000QuietestTarget, tone3000LevelProposalAllowed,
    tone3000StageBlockName, tone3000StageRequestedSize, tone3000StageCalibration } from "../src/pipedal/Tone3000Stage.ts";
const receipt = { state:"done", token:1, valid:true, receiptValid:true, finite:true, clipped:false, silent:false, rmsDb:-18, peakDb:-6, seconds:3, samples:144000, channels:2, savedRevision:"a".repeat(64) };
test("Native invalid observations never become a target and headroom/trim proposals are bounded", () => {
    assert.equal(tone3000ValidMeasurement(receipt),true);
    for(const changes of [{silent:true},{clipped:true},{finite:false},{valid:false},{receiptValid:false},{receiptValid:undefined},{rmsDb:null},{peakDb:NaN},{rmsDb:-61},{savedRevision:"old"},{token:0},{seconds:0},{seconds:Infinity},{samples:Infinity},{peakDb:-19}]) assert.equal(tone3000ValidMeasurement({...receipt,...changes}),false);
    const rows=[{result:receipt,name:"loud",applied:false},{result:{...receipt,token:2,rmsDb:-24},name:"quiet",applied:true}];
    assert.equal(tone3000QuietestTarget(rows),-24);assert.equal(tone3000QuietestTarget([]),null);
    assert.equal(tone3000LevelProposalAllowed(rows[0],-24),true);assert.equal(tone3000LevelProposalAllowed(rows[0],-30.1),false);
    assert.equal(tone3000LevelProposalAllowed(rows[0],-12),false);assert.equal(tone3000LevelProposalAllowed(rows[1],-24),false);
});
test("Model-session observations survive view remounts, remain bounded and explicitly expire", () => {
    const session=new Tone3000MeasurementSession();let renders=0;const unmount=session.subscribe(()=>++renders);
    session.add({...receipt,bankId:6,presetId:26,instanceId:1},"Rx one");unmount();assert.equal(session.get().length,1);
    session.add({...receipt,token:2,bankId:6,presetId:25,instanceId:1},"Rx two");assert.equal(renders,1);assert.equal(session.get().length,2);
    let nextRenders=0;const cleanup=session.subscribe(()=>++nextRenders);session.applied(1);assert.equal(session.get()[0].applied,true);
    for(let i=0;i<40;++i)session.add({...receipt,token:i+10,bankId:7,presetId:i,instanceId:1},"Rig");assert.equal(session.get().length,32);
    session.clear();assert.deepEqual(session.get(),[]);assert.ok(nextRenders>1);cleanup();
});
test("Cancelled late acknowledgement is cancelled once and never polled or displayed", async () => {
    const runner=new Tone3000StageRunner(), cancelled=[], received=[];let ack;
    assert.equal(runner.running,false);
    const done=runner.run(()=>new Promise(resolve=>ack=resolve),async()=>{throw Error("must not poll");},async token=>cancelled.push(token),value=>received.push(value),()=>{throw Error("obsolete failure");});
    assert.equal(runner.running,true);runner.stop();assert.equal(runner.running,false);ack({state:"queued",token:9});await done;
    assert.deepEqual(cancelled,[9]);assert.deepEqual(received,[]);
});
test("Runtime labels use captured names and exact requested endpoints, never guess effective size", () => {
    const blocks=[{blockId:"amp",title:"Owner's amp",type:"nam",gear:"amp"},{blockId:"cab",title:"",type:"ir",gear:"cab"}];
    assert.equal(tone3000StageBlockName("amp",blocks),"Owner's amp");assert.equal(tone3000StageBlockName("cab",blocks),"cab");assert.equal(tone3000StageBlockName("missing",blocks),"Unknown block");
    assert.equal(tone3000StageRequestedSize(0),"A2-Lite");assert.equal(tone3000StageRequestedSize(1),"A2-Full");
    assert.equal(tone3000StageRequestedSize(.25),"intermediate request (25%)");assert.equal(tone3000StageRequestedSize(NaN),"unknown");
    assert.equal(tone3000StageCalibration({inputLevelDbu:12,outputLevelDbu:-8}),"calibration metadata: input 12.0 dBu · output -8.0 dBu");
    assert.equal(tone3000StageCalibration({inputLevelDbu:null,outputLevelDbu:Infinity}),"calibration metadata unknown");
});
test("Stop during polling discards old result and a terminal native result is not auto-replayed", async () => {
    const runner=new Tone3000StageRunner(), cancelled=[], received=[];let reply;
    const done=runner.run(async()=>({state:"queued",token:8}),()=>new Promise(resolve=>reply=resolve),async token=>cancelled.push(token),value=>received.push(value.state),()=>{throw Error("obsolete failure");});
    await new Promise(resolve=>setTimeout(resolve,230));runner.stop();reply({state:"done",token:8,runtime:{unknown:true}});await done;
    assert.deepEqual(cancelled,[8]);assert.deepEqual(received,["queued"]);
    await runner.run(async()=>({state:"done",token:10}),async()=>{throw Error("must not poll");},async token=>cancelled.push(token),value=>received.push(value.state),()=>{throw Error("must not fail");});
    assert.equal(runner.running,false);runner.stop();assert.deepEqual(cancelled,[8]);assert.deepEqual(received,["queued","done"]);
});
