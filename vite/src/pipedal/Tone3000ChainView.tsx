// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import PedalboardView from "./PedalboardView";
import type { PedalboardDisplayNode, PedalboardDisplayLayout } from "./PedalboardView";
import { ControlValue, Pedalboard, PedalboardItem, PedalboardSplitItem, SplitType } from "./Pedalboard";
import { PluginType } from "./Lv2Plugin";
import { projectTone3000Chain } from "./Tone3000ChainProjection";
import type { Tone3000DisplayEntry } from "./Tone3000ChainProjection";
import type { Tone3000Summary } from "./Tone3000Rig";
import { tone3000GearIcon, tone3000LogoIcon } from "./Tone3000Gear";

/** Reuse PiPedal's renderer on an isolated local board; no RPCs or setters.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-FOLD-GEAR] [7.13]
 */
export default function Tone3000ChainView({ summary, embedded = false, onLayout, onBlockClick, focusedBlockId, parent }: {
    summary: Tone3000Summary; embedded?: boolean; onLayout?: (layout: PedalboardDisplayLayout) => void;
    onBlockClick?: (blockId: string) => void;
    focusedBlockId?: string;
    parent?: { pluginType: PluginType; selected: boolean; onClick: () => void };
}) {
    try {
        const projection = projectTone3000Chain(summary);
        const board = new Pedalboard();
        const nodes: Record<number, PedalboardDisplayNode> = {};
        const blockIds = new Map<number, string>();
        let nextDisplayId = -1000; // Scoped only to this read-only renderer.
        const items = (entries: Tone3000DisplayEntry[]): PedalboardItem[] => entries.map(entry => {
            const item = entry.kind === "split" ? new PedalboardSplitItem() : new PedalboardItem();
            item.instanceId = nextDisplayId--; item.isEnabled = true;
            if (entry.kind === "split") {
                const split = item as PedalboardSplitItem;
                split.uri = "uri://two-play/pipedal/pedalboard#Split";
                split.controlValues = [new ControlValue(PedalboardSplitItem.TYPE_KEY, SplitType.Lr)];
                split.topChain = items(entry.left); split.bottomChain = items(entry.right);
            } else {
                // No plugin URI: descriptors are consumed only by the renderer.
                item.uri = "";
                item.isEnabled = entry.kind === "direct" || entry.block.enabled;
                const block = entry.kind === "block" ? entry.block : null;
                const type = !block ? PluginType.UtilityPlugin : block.type === "ir" ? PluginType.SimulatorPlugin
                    : block.gear === "amp" || block.gear === "amp-cab" || block.gear === "full-rig"
                        ? PluginType.AmplifierPlugin : PluginType.NamPlugin;
                const name = block ? `${block.title || (block.type === "ir" ? "IR" : "NAM")}${block.enabled ? "" : " (bypassed)"}`
                    : `${entry.kind === "direct" && entry.lane === "right" ? "Right" : "Left"} pass-through`;
                nodes[item.instanceId] = { name, pluginType: type, numberOfInputs: 1, numberOfOutputs: 1,
                    ...(block ? { icon: tone3000GearIcon(block.gear, block.format || block.type) } : {}),
                    clickable: block !== null && onBlockClick !== undefined };
                if (block) blockIds.set(item.instanceId, block.blockId);
            }
            return item;
        });
        const inputChannels = projection.stereo && summary.inputMode === "stereo" ? 2 : 1;
        const parentMarker = parent && embedded ? new PedalboardItem() : undefined;
        if (parentMarker) {
            // The marker lives only in this local diagram; the real host still
            // contains one TONE3000 processor and the unchanged internal state.
            parentMarker.instanceId = nextDisplayId--;
            parentMarker.uri = "";
            parentMarker.isEnabled = true;
            // @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-T3K-LOGO] [7.17]
            nodes[parentMarker.instanceId] = { name: "TONE3000", icon: tone3000LogoIcon, pluginType: parent!.pluginType,
                numberOfInputs: inputChannels, numberOfOutputs: inputChannels, clickable: true };
        }
        board.items = [...(parentMarker ? [parentMarker] : []), ...items(projection.entries)];
        const selectedBlockId = [...blockIds].find(([, blockId]) => blockId === focusedBlockId)?.[0];
        const selectedId = selectedBlockId ?? (parent?.selected ? parentMarker?.instanceId : undefined);
        const diagram = <PedalboardView displayBoard={board} displayNodes={nodes} readOnly enableStructureEditing={false}
            omitDisplayTerminals={embedded} selectedId={selectedId}
            hasTinyToolBar={false} displayInputChannels={inputChannels}
            displayOutputChannels={projection.stereo ? 2 : 1} onDisplayLayout={onLayout}
            onDisplayNodeClick={onBlockClick || parentMarker ? localId => {
                if (parentMarker && localId === parentMarker.instanceId) { parent!.onClick(); return; }
                const blockId = blockIds.get(localId);
                if (blockId !== undefined) onBlockClick?.(blockId);
            } : undefined} />;
        if (embedded) return <Box aria-label="Read-only embedded blocks" sx={{ width: "max-content" }}>{diagram}</Box>;
        return <Box component="section" aria-label="Current TONE3000 embedded chain" sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1">Current embedded chain · Read only</Typography>
            <Typography variant="body2" color="text.secondary">{projection.routing} · Input: {summary.inputMode}</Typography>
            <Box sx={{ overflowX: "auto", maxWidth: "100%" }}>
                {diagram}
            </Box>
            <Typography variant="caption" color="text.secondary">
                Embedded blocks only; global tone controls remain separate. Bypassed blocks retain their signal path.
                {projection.emptySlots > 0 && ` ${projection.emptySlots} empty insert slots omitted.`}
                {projection.inactiveRightBlocks > 0 && ` ${projection.inactiveRightBlocks} saved right-lane blocks are inactive in single-chain mode.`}
            </Typography>
        </Box>;
    } catch (error) {
        return <Alert severity="info">Embedded chain unavailable: {error instanceof Error ? error.message : "Unsupported captured routing."}</Alert>;
    }
}
