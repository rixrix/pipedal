// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Box from "@mui/material/Box";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { PiPedalModelFactory, State } from "./PiPedalModel";
import { Tone3000StageRunner, tone3000ValidMeasurement, tone3000QuietestTarget, tone3000LevelProposalAllowed,
    tone3000StageBlockName, tone3000StageRequestedSize, tone3000StageCalibration } from "./Tone3000Stage";
import type { Tone3000StageCommand, Tone3000StageResult, Tone3000StageMeasurement } from "./Tone3000Stage";
import type { Tone3000Block } from "./Tone3000Rig";
import { tone3000DraftNumber } from "./Tone3000MobileLayout";

/** Native live observations and explicit actions, never inferred engine readiness.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [DES-STAGE-EXPORT] [7.5] [7.6] [7.11]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-CONTROL-SCOPE] [7.18]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-STABILITY-REVIEW] [7.24]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PLAIN-TOOLS] [7.25]
 */
export default function Tone3000SoundcheckPanel({ instanceId, active }: { instanceId: number; active: boolean }) {
    const model = PiPedalModelFactory.getInstance(), runner = useRef(new Tone3000StageRunner()), generation = useRef(0);
    const measurements = model.getTone3000MeasurementSession();
    const rows = useSyncExternalStore(measurements.subscribe, measurements.get);
    const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(model.presets.get().presetChanged);
    const [error, setError] = useState(""), [notice, setNotice] = useState(""), [result, setResult] = useState<Tone3000StageResult | null>(null);
    const [leadText, setLeadText] = useState("0");
    const leadDb = tone3000DraftNumber(leadText);
    const boostValid = Number.isFinite(leadDb) && leadDb >= 0 && leadDb <= 6;
    const [blocks, setBlocks] = useState<Tone3000Block[]>([]);
    const working = useRef(false);
    useEffect(() => {
        setBusy(false); setResult(null); setBlocks([]);
        const connection = (state: State) => {
            setReady(state === State.Ready);
            if (state !== State.Ready) {
                ++generation.current; runner.current.stop(); setResult(null); setBlocks([]); setBusy(false);
                if (working.current) setNotice("Connection lost. Check the rig before trying again: a change may have finished. Measure your rigs again after reconnecting.");
                working.current = false;
            }
        };
        const selected = () => {
            setDirty(model.presets.get().presetChanged);
            setResult(null);
            setBlocks([]);
            // Cancel an active listen on selection change; keep prior server receipts for comparisons.
            if (working.current) { ++generation.current; runner.current.stop(); working.current = false; setBusy(false); setNotice("You switched rigs, so the current check stopped."); }
        };
        let selectedKey = model.banks.get().selectedBank + "/" + model.presets.get().selectedInstanceId;
        const changed = () => { const next = model.banks.get().selectedBank + "/" + model.presets.get().selectedInstanceId; if (next !== selectedKey) { selectedKey = next; selected(); } else setDirty(model.presets.get().presetChanged); };
        model.state.addOnChangedHandler(connection); model.presets.addOnChangedHandler(changed); model.banks.addOnChangedHandler(changed);
        connection(model.state.get());
        return () => { ++generation.current; runner.current.stop(); working.current = false; model.state.removeOnChangedHandler(connection); model.presets.removeOnChangedHandler(changed); model.banks.removeOnChangedHandler(changed); };
    }, [model, instanceId]);
    useEffect(() => { if (!active) { ++generation.current; runner.current.stop(); working.current = false; setBusy(false); } }, [active]);
    const derivedStage = model.pedalboard.get().tryGetItem(instanceId)?.tone3000DerivedSource?.stage;
    const run = (command: Tone3000StageCommand, payload?: object) => {
        if (!active || !ready || working.current || (command === "level" && derivedStage === "amp")) return;
        working.current = true; setBusy(true); setError(""); setNotice(""); const token = ++generation.current;
        const name = model.pedalboard.get().name;
        void runner.current.run(async () => {
            const current = await model.getTone3000CurrentState(instanceId);
            if (token !== generation.current) throw new Error("Soundcheck cancelled before submit.");
            setBlocks(current.summary.blocks);
            return model.startTone3000Stage(instanceId, current.revision, command, payload);
        }, nativeToken => model.pollTone3000Stage(instanceId, nativeToken), nativeToken => model.cancelTone3000Stage(instanceId, nativeToken),
        value => {
            if (token !== generation.current) return; setResult(value);
            if (value.state !== "queued" && value.state !== "listening") {
                working.current = false; setBusy(false);
                if (command === "level") measurements.add(value, name);
                if (["balance", "align", "pan", "solo"].includes(command) && value.state === "done") setNotice("Done. Listen to the result, then tap PiPedal Save to keep it in this rig.");
            }
        }, failure => { if (token === generation.current) { setError(failure); working.current = false; setBusy(false); } });
    };
    const apply = async (row: Tone3000StageMeasurement) => {
        const quietest = tone3000QuietestTarget(rows), target = quietest === null ? NaN : quietest + leadDb;
        if (!ready || working.current || !boostValid || !tone3000LevelProposalAllowed(row, target)) return;
        const token = ++generation.current; working.current = true; setBusy(true); setError("");
        try {
            const receipt = await model.applyTone3000Level(row.result.token, row.result.savedRevision!, target);
            if (token === generation.current) {
                measurements.applied(row.result.token);
                setNotice("Volume saved for this rig: " + receipt.trimDb.toFixed(1) + " dB. Your drive and tone settings stay the same.");
            }
        } catch (failure) { if (token === generation.current) setError(String(failure)); }
        finally { if (token === generation.current) { working.current = false; setBusy(false); } }
    };
    const exportPreset = async () => {
        if (!ready || dirty || busy) return;
        const bankId = model.banks.get().selectedBank, presetId = model.presets.get().selectedInstanceId;
        working.current = true; setBusy(true); const token = ++generation.current;
        try {
            const response = await fetch(model.varServerUrl + "exportTone3000Preset?bankId=" + bankId + "&presetId=" + presetId + "&instanceId=" + instanceId);
            if (!response.ok) throw new Error("Saved T3K export refused. Save first and use a rig without snapshot overrides.");
            const blob = await response.blob(); if (token !== generation.current) return;
            const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = "pipedal-" + bankId + "-" + presetId + ".t3kpreset"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (failure) { if (token === generation.current) setError(String(failure)); }
        finally { if (token === generation.current) { working.current = false; setBusy(false); } }
    };
    const quietest = tone3000QuietestTarget(rows), target = quietest === null || !boostValid ? null : quietest + leadDb;
    return <Stack spacing={2} sx={{ px: 1, minWidth: 0,
        "& .MuiButton-root": { minHeight: 44, whiteSpace: "normal" },
        "& summary": { cursor: "pointer", minHeight: 44, display: "list-item", alignContent: "center" } }}>
        {!ready && <Alert severity="warning">Not connected to the Pi. Reconnect before using these tools.</Alert>}
        {error && <Alert severity="error">{error}</Alert>}{notice && <Alert severity="info" onClose={() => setNotice("")}>{notice}</Alert>}
        {result && <Typography role="status" variant="body2">{({ queued: "Getting ready…", listening: "Play now…", done: "Check complete.", cancelled: "Check stopped.", failed: "Check could not finish." } as Record<string, string>)[result.state] || result.state}</Typography>}
        {busy && runner.current.running && <Button disabled={!busy || !runner.current.running} onClick={() => { if (!runner.current.running) return; ++generation.current; runner.current.stop(); working.current = false; setBusy(false); setNotice("Stopping the check. Listen to the rig before trying again."); }}>Stop</Button>}
        <Typography component="h3" variant="subtitle1">Match preset volumes</Typography>
        {derivedStage && <Alert severity="info">{derivedStage === "amp" ? "Measure volume from the T3K cab stage instead. The amp output is kept at unity for the next effects and cabinet." : "This measures the cab stage output, before any PiPedal effects after it. Check the final speaker volume by ear."}</Alert>}
        <Typography variant="body2">Reduce volume jumps when you switch rigs. You choose which rigs to change; this is not a global volume setting.</Typography>
        <Box component="ol" sx={{ pl: 3, my: 0, "& li": { mb: .5 } }}>
            <li><Typography variant="body2">Save your rig first. Use a rig without saved TONE3000 variations in its snapshots.</Typography></li>
            <li><Typography variant="body2">Tap Measure, then play a short phrase for 3 seconds.</Typography></li>
            <li><Typography variant="body2">Switch rigs and repeat with the same phrase and playing strength.</Typography></li>
            <li><Typography variant="body2">Tap Save matched volume beside each rig you want to change.</Typography></li>
        </Box>
        <Typography variant="body2" color="text.secondary">We compare the TONE3000 output, before any effects after it. Check the final loudness by ear through your speaker.</Typography>
        {dirty && <Alert severity="warning">You have unsaved changes. Tap PiPedal Save before measuring or exporting.</Alert>}
        <Button variant="outlined" disabled={derivedStage === "amp" || !ready || busy || dirty} onClick={() => run("level", { seconds: 3 })}>Measure this rig · 3 seconds</Button>
        {result?.state === "done" && result.valid !== undefined && !tone3000ValidMeasurement(result) && <Alert severity="warning">{result.valid && !result.receiptValid
            ? "The saved rig changed. Save it and measure again."
            : result.silent ? "No usable sound was heard. Play your phrase and measure again."
            : result.clipped ? "The signal was too loud. Lower the level and measure again."
            : "The measurement did not finish correctly. Play your phrase and measure again."}</Alert>}
        <TextField type="text" size="small" label="Extra volume (dB)" error={!boostValid}
            helperText={boostValid ? "Leave at 0 to match the quietest measured rig. For a louder lead, enter up to 6 before saving that rig’s matched volume." : "Enter a number from 0 to 6 dB."}
            value={leadText} inputProps={{ inputMode: "decimal", enterKeyHint: "done" }}
            onChange={event => setLeadText(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault(); (event.target as HTMLInputElement).blur();
            } }} />
        {!rows.length && <Typography variant="body2" color="text.secondary">Your measured rigs will appear here.</Typography>}
        {rows.map(row => <Stack key={row.result.token} spacing={.5} sx={{ borderTop: 1, borderColor: "divider", pt: 1, minWidth: 0 }}>
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{row.name}{row.applied ? " · Volume saved — measure again to compare" : ""}</Typography>
            <Button sx={{ alignSelf: "flex-start" }} disabled={!ready || busy || target === null || !tone3000LevelProposalAllowed(row, target)} onClick={() => { void apply(row); }}>Save matched volume</Button>
            {!row.applied && target !== null && !tone3000LevelProposalAllowed(row, target) && <Typography variant="caption" color="text.secondary">This result cannot be applied safely. Save the rig and measure again, or try a smaller extra volume.</Typography>}
        </Stack>)}
        <Typography variant="body2" color="text.secondary">Each Save matched volume changes only that saved rig’s TONE3000 output level. It may briefly interrupt sound if that rig is playing.</Typography>
        <Typography variant="caption" color="text.secondary">Measurements stay on this screen as you switch rigs. Refreshing the page or losing the connection clears them. Other phones do not share these measurements.</Typography>
        <Box component="details">
            <Typography component="summary" variant="subtitle1">Balance left and right · This rig only</Typography>
            <Stack spacing={1} sx={{ pt: 1 }}>
                <Typography variant="body2">For a rig with left and right TONE3000 chains. This balances the two sides inside this rig; it does not match different presets.</Typography>
                <Typography variant="body2">Tap Auto Balance and play your usual phrase. Auto Align lines up the timing of the two sides and may briefly mute the sound. Listen afterwards, then tap PiPedal Save to keep the result.</Typography>
                <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap" }}><Button disabled={!ready || busy} onClick={() => run("balance")}>Auto Balance</Button><Button disabled={!ready || busy} onClick={() => run("align")}>Auto Align</Button></Stack>
                <Typography variant="body2" color="text.secondary">Listen to one side at a time, then return to both.</Typography>
                <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap" }}><Button disabled={!ready || busy} onClick={() => run("solo", { side: "left" })}>Listen left</Button><Button disabled={!ready || busy} onClick={() => run("solo", { side: "right" })}>Listen right</Button><Button disabled={!ready || busy} onClick={() => run("solo", { side: "none" })}>Listen to both</Button></Stack>
            </Stack>
        </Box>
        <Box component="details">
            <Typography component="summary" variant="subtitle1">Check loaded sounds · This rig only</Typography>
            <Stack spacing={1} sx={{ pt: 1 }}>
                <Typography variant="body2">See whether the models have loaded and which A2 size you requested.</Typography>
                <Button disabled={!ready || busy} onClick={() => run("runtime")}>Check loaded sounds</Button>
        {result?.runtime && <>
            <Typography variant="body2">{result.runtime.unknown ? "Native runtime unavailable." : "Native routing: " + (result.runtime.stereoEnabled ? "L/R enabled" : "single lane") + " · audio " + (result.runtime.audioActive ? "active" : "inactive")}</Typography>
            {result.runtime.blocks?.map(block => <Stack key={block.blockId} spacing={.25}>
                <Typography variant="body2">{block.lane} · {tone3000StageBlockName(block.blockId, blocks)}: {block.loadFailed ? "load failed" : block.modelLoading ? "loading" : block.loaded ? "loaded" : "not loaded"}{!block.enabled ? " · bypassed" : ""}</Typography>
                {blocks.find(item => item.blockId === block.blockId)?.type !== "ir" && <Typography variant="caption" color="text.secondary">A2 {block.a2Known ? block.a2Supported ? "supported" : "not supported" : "unknown"} · requested {tone3000StageRequestedSize(block.requestedSlimSize)} · effective size unknown</Typography>}
                <Typography variant="caption" color="text.secondary">{tone3000StageCalibration(block)}</Typography>
            </Stack>)}
            {result.runtime.truncated && <Alert severity="warning">Runtime list was truncated; remaining blocks are unknown.</Alert>}
        </>}
            </Stack>
        </Box>
        <Box component="details">
            <Typography component="summary" variant="subtitle1">Measurement details</Typography>
            <Stack spacing={1} sx={{ pt: 1 }}>
                {target !== null && <Typography variant="body2">Target: {target.toFixed(1)} dB RMS. A change needs at least 1 dB of peak headroom and an output adjustment within ±12 dB.</Typography>}
                {rows.map(row => <Typography key={row.result.token} variant="caption" sx={{ overflowWrap: "anywhere" }}>{row.name} · bank {row.result.bankId}/rig {row.result.presetId} · TONE3000 {row.result.instanceId} · average {row.result.rmsDb?.toFixed(1)} · peak {row.result.peakDb?.toFixed(1)} dB</Typography>)}
            </Stack>
        </Box>
        <Box component="details">
            <Typography component="summary" variant="subtitle1">Download for TONE3000</Typography>
            <Stack spacing={1} sx={{ pt: 1 }}>
                <Typography variant="body2">Download the saved TONE3000 blocks and tone settings as a .t3kpreset file to open in T3K. Save your changes first and use a rig without TONE3000 snapshot variations. This does not update the T3K app automatically.</Typography>
                <Typography variant="caption" color="text.secondary">PiPedal effects and snapshots are not included. Calibration, oversampling and other T3K session settings are also left out.</Typography>
                <Button disabled={!ready || busy || dirty} onClick={() => { void exportPreset(); }}>Download saved T3K preset</Button>
            </Stack>
        </Box>
    </Stack>;
}
