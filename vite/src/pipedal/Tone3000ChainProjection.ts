// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
import type { Tone3000Block, Tone3000Summary } from "./Tone3000Rig";

/** Local drawing data, never a saved board or a host-plugin registration.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15]
 */
export type Tone3000DisplayEntry =
    { kind: "block"; block: Tone3000Block } |
    { kind: "direct"; lane: "left" | "right" } |
    { kind: "split"; left: Tone3000DisplayEntry[]; right: Tone3000DisplayEntry[] };

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15] */
export interface Tone3000ChainProjection {
    entries: Tone3000DisplayEntry[];
    routing: string;
    emptySlots: number;
    inactiveRightBlocks: number;
    stereo: boolean;
}

/** Measured child layout positioned on an unchanged outer host signal line.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15]
 */
export function tone3000ChainFootprint(x: number, signalY: number,
    measured: { width: number; height: number; inputY: number; outputY: number }, cellWidth: number) {
    if (![x, signalY, measured.width, measured.height, measured.inputY, measured.outputY].every(Number.isFinite)
        || measured.width < cellWidth || measured.width > 260 * cellWidth || measured.height < 64 || measured.height > 4096
        || measured.inputY < 0 || measured.inputY > measured.height || measured.outputY < 0 || measured.outputY > measured.height)
        throw new Error("Unsupported embedded chain dimensions.");
    // The stock renderer already adds 14 px for labels. The outer renderer
    // reserves those same labels once; no group/header/padding is introduced.
    return { x, y: signalY - measured.inputY, width: measured.width,
        height: Math.max(64, measured.height - 14), inputX: x + cellWidth / 2, inputY: signalY,
        outputX: x + measured.width - cellWidth / 2, outputY: signalY + measured.outputY - measured.inputY };
}

/** Match pinned refreshBranchTapIndex: only a tone in the trunk is a tap.
 * The existing renderer's L/R splitter joins the two mono lanes as stereo.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15]
 */
export function projectTone3000Chain(summary: Tone3000Summary): Tone3000ChainProjection {
    if (!Array.isArray(summary.blocks) || summary.blocks.length > 256
        || !["left", "right"].includes(summary.branchSide)
        || !["stereo", "left", "right", "dual"].includes(summary.inputMode))
        throw new Error("This captured routing cannot be represented.");
    const ids = new Set<string>();
    const positions = new Set<string>();
    for (const block of summary.blocks) {
        const position = `${block.lane}:${block.index}`;
        if (!block.blockId || ids.has(block.blockId) || positions.has(position)
            || !["left", "right"].includes(block.lane) || !Number.isSafeInteger(block.index) || block.index < 0
            || !["nam", "ir", "insert"].includes(block.type))
            throw new Error("This captured block list cannot be represented.");
        ids.add(block.blockId); positions.add(position);
    }
    const lane = (side: string) => summary.blocks.filter(block => block.lane === side).sort((a, b) => a.index - b.index);
    const left = lane("left"), right = lane("right");
    const entries = (blocks: Tone3000Block[], side: "left" | "right"): Tone3000DisplayEntry[] => {
        const tones: Tone3000DisplayEntry[] = blocks.filter(block => block.type !== "insert").map(block => ({ kind: "block", block }));
        return tones.length ? tones : [{ kind: "direct", lane: side }];
    };
    const result: Tone3000ChainProjection = {
        entries: [], routing: "Left chain", emptySlots: summary.blocks.filter(block => block.type === "insert").length,
        inactiveRightBlocks: summary.stereoEnabled ? 0 : right.filter(block => block.type !== "insert").length,
        stereo: summary.stereoEnabled
    };
    if (!summary.stereoEnabled) { result.entries = entries(left, "left"); return result; }
    const trunk = summary.branchSide === "right" ? right : left;
    const tap = trunk.findIndex(block => block.blockId === summary.branchAfterBlockId && block.type !== "insert");
    if (tap < 0) {
        result.routing = "Independent left / right chains";
        result.entries = [{ kind: "split", left: entries(left, "left"), right: entries(right, "right") }];
    } else {
        const prefix: Tone3000DisplayEntry[] = trunk.slice(0, tap + 1).filter(block => block.type !== "insert")
            .map(block => ({ kind: "block", block }));
        result.routing = `${summary.branchSide === "right" ? "Right" : "Left"} chain branches after ${trunk[tap].title || "unnamed block"}`;
        result.entries = [...prefix, { kind: "split",
            left: entries(summary.branchSide === "left" ? left.slice(tap + 1) : left, "left"),
            right: entries(summary.branchSide === "right" ? right.slice(tap + 1) : right, "right") }];
    }
    return result;
}
