// SPDX-License-Identifier: MIT
import "./Tone3000Actions.css";
import { useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DialogEx from "./DialogEx";
import { PiPedalModelFactory, State } from "./PiPedalModel";
import type { ListenHandle } from "./PiPedalModel";
import { Tone3000ProgramEvidence } from "./Tone3000Performance";
import type { Tone3000PerformanceResult, Tone3000PerformanceSource } from "./Tone3000Performance";

/** Explicit saved copies and passive MIDI evidence; no automatic load/replay.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-18] [DES-STAGE-BANK] [7.4]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-STABILITY-REVIEW] [7.22]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-STABILITY-REVIEW] [7.24]
 */
export default function Tone3000PerformanceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const model = PiPedalModelFactory.getInstance();
    const [sources, setSources] = useState<Tone3000PerformanceSource[]>([]);
    const [choices, setChoices] = useState(["", "", "", ""]), [name, setName] = useState("Stage");
    const [created, setCreated] = useState<Tone3000PerformanceResult | null>(null);
    const [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
    const [error, setError] = useState(""), [notice, setNotice] = useState("");
    const configuredChannel = model.alsaSequencerConfiguration.get().midiChannel;
    const [observing, setObserving] = useState(false), [channel, setChannel] = useState(configuredChannel >= 0 && configuredChannel < 16 ? configuredChannel + 1 : 1);
    const [pendingLoad, setPendingLoad] = useState(false);
    const [evidence, setEvidence] = useState<Tone3000ProgramEvidence | null>(null);
    const [, redraw] = useState(0);
    const generation = useRef(0), working = useRef(false);
    const id = (source: Tone3000PerformanceSource) => source.bankId + "/" + source.presetId;
    useEffect(() => {
        if (!open) return;
        const connected = (state: State) => {
            ++generation.current; setReady(state === State.Ready);
            if (working.current) setNotice("Connection interrupted. Creation/load may have completed; inspect banks before retrying.");
            working.current = false; setBusy(false); setObserving(false); setPendingLoad(false);
            if (state !== State.Ready) return;
            const token = generation.current;
            void model.getTone3000PerformanceSources().then(value => { if (token === generation.current) setSources(value); })
                .catch(failure => { if (token === generation.current) setError(String(failure)); });
        };
        model.state.addOnChangedHandler(connected);
        return () => {
            if (working.current) {
                const message = "Creation/load may have completed. Inspect banks and the current rig before retrying.";
                setNotice(message);
                // Forced closure can destroy this component; the existing model
                // alert survives it. Disconnect already released work, so cleanup
                // does not repeat that warning or report ordinary no-work teardown.
                model.showAlert(message);
            }
            ++generation.current; working.current = false;
            model.state.removeOnChangedHandler(connected);
        };
    }, [open, model]);
    useEffect(() => {
        if (!open || !ready || !observing || !created) return;
        let alive = true, handle: ListenHandle | null = null, checking = false;
        const current = new Tone3000ProgramEvidence(created); setEvidence(current);
        const selected = () => {
            if (!alive) return;
            const presets = model.presets.get();
            if (presets.presetChanged) current.reset("Active rig has unsaved edits; save/discard before verifying saved recall.");
            else current.selection(model.banks.get().selectedBank, presets.selectedInstanceId, presets.presets.map(preset => preset.instanceId));
            redraw(value => value + 1);
        };
        model.presets.addOnChangedHandler(selected); model.banks.addOnChangedHandler(selected);
        void model.listenForMidiProgramEvent(message => { if (alive) { current.observe(message.cc0, message.cc1, channel); selected(); } })
            .then(value => { if (alive) handle = value; else model.cancelListenForMidiEvent(value); })
            .catch(failure => { if (alive) { setError(String(failure)); setObserving(false); } });
        const check = async () => {
            if (!alive || checking) return; checking = true;
            try {
                const fresh = await model.getTone3000PerformanceBank(created.bankId);
                if (alive && fresh.revision !== created.revision) {
                    current.reset("Saved bank content/order changed; create a fresh setup before verification.");
                    redraw(value => value + 1); setObserving(false);
                }
            } catch (failure) { if (alive) { setError(String(failure)); setObserving(false); } }
            finally { checking = false; }
        };
        void check(); const timer = window.setInterval(() => { void check(); }, 2000);
        return () => {
            alive = false; window.clearInterval(timer); if (handle) model.cancelListenForMidiEvent(handle);
            current.reset("Observation stopped; start again for fresh evidence.");
            setEvidence(null);
            model.presets.removeOnChangedHandler(selected); model.banks.removeOnChangedHandler(selected);
        };
    }, [open, ready, observing, created, channel, model]);
    const run = async (action: () => Promise<void>) => {
        if (working.current || !open || model.state.get() !== State.Ready) return;
        working.current = true; setBusy(true); setError(""); const token = ++generation.current;
        try { await action(); } catch (failure) { if (token === generation.current) setError(String(failure)); }
        finally { if (token === generation.current) { working.current = false; setBusy(false); } }
    };
    const create = () => {
        const selected = choices.map(choice => sources.find(source => id(source) === choice));
        if (selected.some(source => !source) || new Set(choices).size !== 4) return;
        void run(async () => {
            const token = generation.current;
            const result = await model.createTone3000PerformanceBank(name, selected as Tone3000PerformanceSource[]);
            if (token === generation.current) { setCreated(result); setObserving(false); setEvidence(null); setNotice("Saved copies created. The current bank and playing rig remain selected."); }
        });
    };
    const load = () => void run(async () => { if (created) await model.loadTone3000Preset(created.bankId, created.slots[0].presetId); });
    const canCreate = ready && !busy && name.trim().length > 0 && choices.every(choice => sources.some(source => id(source) === choice)) && new Set(choices).size === 4;
    /** The ref closes the render-to-state gap for Escape, backdrop and Back.
     * Read-only observation remains dismissible; durable requests cannot be undone here.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-STABILITY-REVIEW] [7.22]
     */
    const close = () => { if (!working.current) onClose(); };
    return <>
        <DialogEx className="t3k-controls" tag="tone3000Performance" open={open} onClose={close} fullWidth maxWidth="sm">
            <DialogTitle>Four-switch performance bank</DialogTitle>
            <DialogContent dividers><Stack spacing={2}>
                <Alert severity="info">Choose four distinct saved rigs in A/B/C/D order. Original banks, effects, snapshots and trims are preserved. Unsaved edits are not copied. Normal follow-defaults processing still applies on Load.</Alert>
                {!ready && <Alert severity="warning">Disconnected. Reconnect before creating or observing.</Alert>}
                {error && <Alert severity="error">{error}</Alert>}
                {notice && <Alert severity="info" onClose={() => setNotice("")}>{notice}</Alert>}
                <TextField label="New bank name" value={name} disabled={busy || observing} onChange={event => setName(event.target.value)} inputProps={{ maxLength: 96 }} />
                {choices.map((choice, index) => <TextField key={index} select label={String.fromCharCode(65 + index) + " · PC " + index + " (display " + (index + 1) + ")"}
                    value={sources.some(source => id(source) === choice) ? choice : ""} disabled={busy || observing} onChange={event => setChoices(values => values.map((value, at) => at === index ? event.target.value : value))}>
                    <MenuItem value="">Choose a saved rig</MenuItem>
                    {sources.map(source => <MenuItem key={id(source)} value={id(source)}>{source.name} · {source.bankName}</MenuItem>)}
                </TextField>)}
                <Button variant="contained" disabled={!canCreate} onClick={create}>Create four saved copies</Button>
                {created && <>
                    <Typography>{created.name}</Typography>
                    <Button variant="outlined" disabled={!ready || busy || observing} onClick={() => { if (model.presets.get().presetChanged) setPendingLoad(true); else load(); }}>Load performance bank</Button>
                    <TextField select label="Expected controller channel" value={channel} disabled={observing} onChange={event => setChannel(Number(event.target.value))}>
                        {Array.from({ length: 16 }, (_, i) => <MenuItem key={i} value={i + 1}>{i + 1}</MenuItem>)}
                    </TextField>
                    <Button disabled={!ready || busy} onClick={() => setObserving(value => !value)}>{observing ? "Stop observation" : "Observe Program Changes"}</Button>
                    <Typography variant="caption">This does not change MIDI settings. Wrong-channel events filtered by the driver are not observed. CC-only controllers do not select these programs. Hearing the correct sound remains a separate check.</Typography>
                    {evidence && <>
                        <Typography variant="body2">{evidence.message}</Typography>
                        {evidence.rows.map((row, index) => <Typography key={index} variant="body2">{created.slots[index].label}: PC {row.program} {row.observed ? "observed" : "waiting"} · saved selection {row.selected ? "matched" : "waiting"}{row.duplicateCount ? " · " + row.duplicateCount + " repeat(s)" : ""}</Typography>)}
                    </>}
                </>}
            </Stack></DialogContent>
            <DialogActions><Button disabled={busy} onClick={close}>Close</Button></DialogActions>
        </DialogEx>
        <DialogEx className="t3k-controls" tag="tone3000PerformanceUnsaved" open={pendingLoad} onClose={() => setPendingLoad(false)}>
            <DialogTitle>Discard unsaved changes and load?</DialogTitle>
            <DialogContent>Loading replaces the current playing rig and unsaved edits.</DialogContent>
            <DialogActions><Button onClick={() => setPendingLoad(false)}>Cancel</Button><Button onClick={() => { setPendingLoad(false); load(); }}>Discard and load</Button></DialogActions>
        </DialogEx>
    </>;
}
