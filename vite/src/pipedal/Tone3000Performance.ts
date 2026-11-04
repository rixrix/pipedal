// SPDX-License-Identifier: MIT
/** Saved copies and independent observed MIDI/selected-preset evidence.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-18] [DES-STAGE-BANK] [7.4]
 */
export interface Tone3000PerformanceSource { bankId: number; presetId: number; name: string; bankName: string; revision: string; }
export interface Tone3000PerformanceSlot { label: string; name: string; program: number; presetId: number; }
export interface Tone3000PerformanceResult { bankId: number; name: string; revision: string; slots: Tone3000PerformanceSlot[]; }
export interface Tone3000SwitchEvidence { program: number; observed: boolean; selected: boolean; duplicateCount: number; }
export class Tone3000ProgramEvidence {
    readonly bank: Tone3000PerformanceResult;
    private lastProgram: number | null = null;
    rows: Tone3000SwitchEvidence[];
    message = "Waiting for Program Changes. Audio success requires listening.";
    constructor(bank: Tone3000PerformanceResult) {
        this.bank = bank; this.rows = bank.slots.map(slot => ({ program: slot.program, observed: false, selected: false, duplicateCount: 0 }));
    }
    reset(message: string): void {
        this.lastProgram = null;
        this.rows = this.rows.map(row => ({ ...row, observed: false, selected: false, duplicateCount: 0 }));
        this.message = message;
    }
    observe(status: number, program: number, expectedChannel: number): void {
        if ((status & 0xf0) !== 0xc0 || !Number.isInteger(program) || program < 0 || program > 127) {
            this.lastProgram = null; this.message = "Not a valid Program Change."; return;
        }
        const channel = (status & 15) + 1;
        if (channel !== expectedChannel) { this.lastProgram = null; this.message = "Observed channel " + channel + "; expected " + expectedChannel + "."; return; }
        const row = this.rows.find(row => row.program === program);
        if (!row) { this.lastProgram = null; this.message = "PC " + program + " is outside A/B/C/D (0–3); host recall may clamp it."; return; }
        if (row.observed) ++row.duplicateCount;
        row.observed = true; this.lastProgram = program;
        this.message = "Observed channel " + channel + ", PC " + program + ". Check saved selection and listen.";
    }
    selection(bankId: number, presetId: number, orderedIds: number[]): void {
        if (bankId !== this.bank.bankId) { this.reset("Load the performance bank before observing recall."); return; }
        if (orderedIds.length !== 4 || orderedIds.some((id, index) => id !== this.bank.slots[index].presetId)) {
            this.reset("The performance bank order changed. Create a fresh bank before verification."); return;
        }
        const index = this.bank.slots.findIndex(slot => slot.program === this.lastProgram && slot.presetId === presetId);
        if (index >= 0 && this.rows[index].observed) this.rows[index].selected = true;
    }
}
