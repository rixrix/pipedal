// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
import "./Tone3000Actions.css";
import { useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import DialogEx from "./DialogEx";
import { PiPedalModelFactory, State } from "./PiPedalModel";
import type { Tone3000PreviewSelection, Tone3000PreviewState } from "./Tone3000Library";
import { Tone3000PreviewReader } from "./Tone3000PreviewReader";
import type { Tone3000PreviewRead } from "./Tone3000PreviewReader";
import { tone3000GearLabel } from "./Tone3000Gear";
import { tone3000NumberPresentation } from "./Tone3000ControlUnits";
import Tone3000ChainView from "./Tone3000ChainView";

// Stored block gain uses the same native normalized -24..24 dB scale as Input/Output.
const blockGain = tone3000NumberPresentation("https://www.tone3000.com/plugin:inputLevel", 0, 1)!;

/** Stored blocks and real-unit EQ only; opaque assets remain on the server.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [7.1]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-STABILITY-REVIEW] [7.24]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [FR-17] [DES-FOUR-REFINEMENTS] [7.31]
 */
function StoredChain({ title, state }: { title: string; state: Tone3000PreviewState }) {
    const summary = state.summary;
    return <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0, overflowWrap: "anywhere" }}>
        <Typography variant="subtitle1">{title}</Typography>
        <Typography variant="body2">{summary.activePresetName || "Unnamed rig"}</Typography>
        <Typography variant="body2">{state.namCount} NAM · {state.irCount} IR · {state.embeddedBytes.toLocaleString()} embedded bytes</Typography>
        <Typography variant="caption" component="p">Counts include all cached variants and disabled blocks; asset presence does not prove audio readiness.</Typography>
        <Typography variant="body2" sx={{ mt: 1 }}>Routing: {summary.stereoEnabled ? "two lanes" : "single lane"}
            {summary.branchAfterBlockId ? ", branch on " + summary.branchSide + " after " + summary.branchAfterBlockId : ""}</Typography>
        <Box component="details" aria-label={title + " routing"} sx={{ mt: .5 }}>
            <Box component="summary" sx={{ minHeight: 44, cursor: "pointer", py: 1, boxSizing: "border-box" }}>Show routing</Box>
            <Box sx={{ minWidth: 0, maxWidth: "100%", overflowX: "auto" }}>
                <Tone3000ChainView summary={summary} heading={title + " routing · Read only"} ariaLabel={title + " routing diagram"} />
            </Box>
        </Box>
        {summary.blocks.length === 0 && <Typography variant="body2">Empty chain</Typography>}
        {summary.blocks.map(block => <Stack key={block.blockId} spacing={.5} sx={{ mt: 1.5 }}>
            <Typography variant="body2" fontWeight={600}>{block.lane} {block.index + 1}: {block.title || (block.type === "insert" ? "Insert slot" : block.type.toUpperCase())}
                {block.enabled ? "" : " (bypassed)"}</Typography>
            {block.type !== "insert" && <>
                <Typography variant="caption" component="p">{[tone3000GearLabel(block.gear, block.format || block.type), block.format.toUpperCase(), block.activeModelId === null ? "" : "Model " + block.activeModelId].filter(Boolean).join(" · ")}</Typography>
                <Typography variant="caption" component="p">Input {blockGain.format(blockGain.toDisplay(block.inputGain))} · Output {blockGain.format(blockGain.toDisplay(block.outputGain))} · Mix {(block.mix * 100).toFixed(1)}%
                    {block.type === "nam" ? " · Normalize " + (block.normalize ? "on" : "off") + " · Size request " + (block.slimSize === 0 ? "Lite" : block.slimSize === 1 ? "Full" : block.slimSize) : ""}</Typography>
                <Typography variant="caption" component="p">EQ {block.eq.enabled ? "on" : "off"}, {block.eq.pre ? "pre" : "post"}
                    {block.eq.bands.map((band, index) => " · " + (index + 1) + " " + band.type + " "
                        + blockGain.editText(Math.round(band.freqHz)) + " Hz / " + blockGain.format(band.gainDb)
                        + " / Q " + blockGain.editText(Number(band.q.toFixed(2)))).join("")}</Typography>
                {block.type === "nam" && block.capabilityUnknown && <Typography variant="caption" component="p">Model capability is unverified; size is a saved request.</Typography>}
            </>}
        </Stack>)}
    </Paper>;
}

/** Explicit confirmation after a bounded, read-only preview; disconnect invalidates it.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [DES-RECOVERY] [7.1]
 */
export default function Tone3000PresetPreviewDialog({ selection, onClose, onConfirm }: {
    selection: Tone3000PreviewSelection | null;
    onClose: () => void;
    onConfirm: (selection: Tone3000PreviewSelection) => void;
}) {
    const model = PiPedalModelFactory.getInstance();
    const reader = useRef(new Tone3000PreviewReader());
    const [read, setRead] = useState<Tone3000PreviewRead>({ loading: false, result: null, error: "" });
    const [readOwner, setReadOwner] = useState<Tone3000PreviewSelection | null>(null);
    const [connected, setConnected] = useState(model.state.get() === State.Ready);
    useEffect(() => {
        if (!selection) return;
        const connectionChanged = (state: State) => {
            const ready = state === State.Ready;
            setConnected(ready);
            reader.current.invalidate();
            if (ready) void reader.current.read(() => model.getTone3000PresetPreview(selection.entry, selection.target), value => { setReadOwner(selection); setRead(value); });
            else setRead({ loading: false, result: null, error: "Connection interrupted. Reconnect to read the saved preview." });
        };
        model.state.addOnChangedHandler(connectionChanged);
        return () => {
            reader.current.invalidate();
            model.state.removeOnChangedHandler(connectionChanged);
        };
    }, [selection, model]);
    const result = readOwner === selection ? read.result : null;
    const updating = selection?.action === "update";
    const actionLabel = updating ? ((result?.active ?? selection?.target?.active) ? "Update & load" : "Update")
        : selection?.action === "addNew" ? "Add as new" : "Add";
    const canConfirm = connected && !read.loading && !!result && !!selection
        && result.sha256 === selection.entry.sha256 && (!updating || !result.hasUnsavedChanges);
    return <DialogEx className="t3k-controls" tag="tone3000PresetPreview" open={selection !== null} onClose={onClose} fullWidth maxWidth="md"
        sx={{ "& .MuiDialog-paper": { m: { xs: 0, sm: 4 }, width: { xs: "100%", sm: "calc(100% - 64px)" },
            minWidth: 0, maxWidth: { xs: "100%", sm: 900 }, maxHeight: { xs: "100%", sm: "calc(100% - 64px)" } },
            "& .MuiButton-root": { minHeight: 44 } }}>
        <DialogTitle sx={{ px: { xs: 1.5, sm: 3 }, overflowWrap: "anywhere" }}>{updating ? "Review Update" : "Preview rig"}: {selection?.entry.name}</DialogTitle>
        <DialogContent dividers sx={{ p: { xs: 1.5, sm: 3 }, minWidth: 0 }}>
            <Stack spacing={2} sx={{ minWidth: 0 }}>
                <Alert severity="info">Preview reads saved data only. It does not play audio, load a rig or save changes.</Alert>
                {read.loading && <CircularProgress size={24} aria-label="Reading saved preview" />}
                {read.error && <Alert severity="error">{read.error}</Alert>}
                {result && <>
                    {updating ? <>
                        <Typography variant="body2">Update replaces local tone and block edits in this saved TONE3000 instance with the source below.</Typography>
                        <Typography variant="body2">Replaces: {result.replaces.join("; ")}.</Typography>
                        <Typography variant="body2">Preserves: {result.preserves.join("; ")}.</Typography>
                        <Alert severity={result.hasUnsavedChanges ? "warning" : "info"}>The target below is saved state; unsaved active edits are not included.
                            {result.hasUnsavedChanges ? " Save or discard the active rig's changes before Update & load." : result.active ? " Update will also load the active rig." : " Update will save the target without loading it."}</Alert>
                        {result.hasSnapshotOverrides && <Alert severity="warning">Snapshots retain their saved tone versions and may override the updated tone when recalled.</Alert>}
                    </> : selection?.action !== "preview" && <Typography variant="body2">Add saves a complete new rig in TONE3000 Library without loading it. Device processing defaults apply; source tone, routing and embedded blocks are retained.</Typography>}
                    {result.targetState && !updating && <Alert severity="info">The target is saved state. Unsaved active edits are not included in this preview.</Alert>}
                    <StoredChain key={"source/" + result.key + "/" + result.sha256} title="Source" state={result.sourceState} />
                    {result.targetState && <StoredChain key={"target/" + result.key + "/" + result.sha256 + "/" + selection?.target?.bankId
                        + "/" + selection?.target?.presetId + "/" + selection?.target?.instanceId + "/" + selection?.target?.sha256}
                        title={"Saved target: " + result.targetName} state={result.targetState} />}
                </>}
            </Stack>
        </DialogContent>
        <DialogActions>
            <Button onClick={onClose}>{selection?.action === "preview" ? "Close" : "Cancel"}</Button>
            {selection && selection.action !== "preview" && <Button variant="contained" disabled={!canConfirm}
                onClick={() => { if (canConfirm && model.state.get() === State.Ready) onConfirm(selection.target && result ? { ...selection, target: { ...selection.target, active: result.active } } : selection); }}>{actionLabel}</Button>}
        </DialogActions>
    </DialogEx>;
}
