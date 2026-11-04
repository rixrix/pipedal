import test from "node:test";
import assert from "node:assert/strict";
import { Tone3000ProgramEvidence } from "../src/pipedal/Tone3000Performance.ts";
const bank = { bankId: 11, revision: "saved", name: "Test", slots: [0,1,2,3].map(program => ({ program, label: "ABCD"[program], name: "Rig", presetId: 10 + program })) };
/** Actual production evidence never substitutes selection for an observed exact PC.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BANK] [7.4]
 */
test("Exact PC and matching selection are independent gates; other events cannot qualify switches", () => {
    const value = new Tone3000ProgramEvidence(bank), ids = [10,11,12,13];
    value.selection(11,10,ids);assert.equal(value.rows[0].selected,false);
    value.observe(0xb0,0,1);value.selection(11,10,ids);assert.equal(value.rows[0].observed,false);
    value.observe(0xc1,0,1);value.selection(11,10,ids);assert.equal(value.rows[0].observed,false);
    value.observe(0xc0,127,1);value.selection(11,13,ids);assert.equal(value.rows[3].selected,false);
    value.observe(0xc0,0,1);value.selection(11,11,ids);assert.equal(value.rows[0].observed,true);assert.equal(value.rows[0].selected,false);
    value.selection(11,10,ids);assert.equal(value.rows[0].selected,true);
    value.observe(0xc0,0,1);value.selection(11,10,ids);assert.equal(value.rows[0].duplicateCount,1);
    assert.equal(value.rows.slice(1).some(row => row.observed || row.selected),false);
});
test("Wrong bank, reordered presets and reconnect discard prior evidence", () => {
    const value = new Tone3000ProgramEvidence(bank);
    for(let i=0;i<4;++i){value.observe(0xc0,i,1);value.selection(11,10+i,[10,11,12,13]);}
    assert.equal(value.rows.every(row => row.observed && row.selected),true);
    value.selection(11,10,[13,11,12,10]);assert.equal(value.rows.some(row => row.observed || row.selected),false);
    value.observe(0xc0,0,1);value.selection(12,10,[10,11,12,13]);assert.equal(value.rows.some(row => row.observed),false);
    value.observe(0xc0,0,1);value.reset("Disconnected");assert.equal(value.rows.some(row => row.observed),false);
    value.selection(11,10,[10,11,12,13]);assert.equal(value.rows[0].selected,false);
});
