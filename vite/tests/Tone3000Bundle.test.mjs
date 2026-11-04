import test from "node:test";
import assert from "node:assert/strict";
import { Tone3000BundleReader, tone3000BundleImportAllowed } from "../src/pipedal/Tone3000Bundle.ts";
const report = { completenessKnown: true, missingMedia: [], plugins: [{ installed: true, versionStatus: "match" }] };
test("Missing known dependencies cannot be acknowledged away; unknown compatibility is explicit", () => {
    assert.equal(tone3000BundleImportAllowed(null,true),false);
    assert.equal(tone3000BundleImportAllowed(report,false),true);
    assert.equal(tone3000BundleImportAllowed({...report, missingMedia:["cab.wav"]},true),false);
    assert.equal(tone3000BundleImportAllowed({...report, plugins:[{installed:false,versionStatus:"missing"}]},true),false);
    for(const versionStatus of ["unknown","mismatch"]){
        const unknown={...report,plugins:[{installed:true,versionStatus}]};
        assert.equal(tone3000BundleImportAllowed(unknown,false),false);assert.equal(tone3000BundleImportAllowed(unknown,true),true);
    }
    assert.equal(tone3000BundleImportAllowed({...report,completenessKnown:false},false),false);
});
test("Switching files and disconnect invalidate delayed successful and rejected checks", async () => {
    const reader=new Tone3000BundleReader(), values=[], failures=[];let first,signal;
    const pending=reader.read(s=>{signal=s;return new Promise(resolve=>first=resolve);},v=>values.push(v),e=>failures.push(e));
    await reader.read(async()=>"new",v=>values.push(v),e=>failures.push(e));assert.equal(signal.aborted,true);first("old");await pending;
    assert.deepEqual(values,["new"]);
    let reject;const failed=reader.read(()=>new Promise((_,no)=>reject=no),v=>values.push(v),e=>failures.push(e));reader.invalidate();reject(new Error("offline"));await failed;
    assert.deepEqual(failures,[]);
    await reader.read(async()=>{throw new Error("malformed");},()=>{},e=>failures.push(e));assert.match(failures[0],/malformed/);
});
