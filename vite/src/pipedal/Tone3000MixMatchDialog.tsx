// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DialogEx from "./DialogEx";
import Tone3000ChainView from "./Tone3000ChainView";
import { PiPedalModelFactory, State } from "./PiPedalModel";
import type { Tone3000Import, Tone3000LibraryEntry } from "./Tone3000Library";
import { Tone3000MixMatchSession } from "./Tone3000MixMatch";
import type { Tone3000MixMatchRead } from "./Tone3000MixMatch";

/** Saved-source authoring only. Creation never loads; uncertain requests never retry.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-26] [FR-27] [DES-PITCH-LV2] [7.36] */
export default function Tone3000MixMatchDialog({ selection, onClose }: {
    selection: { entry: Tone3000LibraryEntry; target: Tone3000Import } | null;
    onClose: () => void;
}) {
    const model = PiPedalModelFactory.getInstance();
    const [read, setRead] = useState<Tone3000MixMatchRead>(new Tone3000MixMatchSession(() => {}).state);
    const session = useRef(new Tone3000MixMatchSession(setRead));
    const [name, setName] = useState(""), [pitch, setPitch] = useState(true), [confirmed, setConfirmed] = useState(false);
    const [connected, setConnected] = useState(model.state.get() === State.Ready);
    const [loaded, setLoaded] = useState(false), [loadError, setLoadError] = useState(""), [loading, setLoading] = useState(false);
    const [ownerChanged, setOwnerChanged] = useState(false);
    const loadFlight = useRef<{ session: Tone3000MixMatchSession } | null>(null);
    const owner = useRef<{ bank: number; preset: number; snapshot: number; board: unknown } | null>(null);
    const ownerCurrent = () => !!owner.current && owner.current.bank === model.banks.get().selectedBank
        && owner.current.preset === model.presets.get().selectedInstanceId
        && owner.current.snapshot === model.selectedSnapshot.get() && owner.current.board === model.pedalboard.get()
        && !model.presets.get().presetChanged;
    useEffect(() => {
        session.current = new Tone3000MixMatchSession(setRead);
        setRead(session.current.state); setName(selection ? selection.target.name + " mix & match" : "");
        setPitch(true); setConfirmed(false); setLoaded(false); setLoading(false); setLoadError(""); owner.current = null; setOwnerChanged(false);
        if (!selection) return;
        const current = session.current;
        const connection = (state: State) => {
            setConnected(state === State.Ready);
            if (state !== State.Ready) {
                current.invalidate(); setOwnerChanged(true);
                if (loadFlight.current?.session === current) {
                    loadFlight.current = null; setLoading(false);
                    model.showAlert("Loading may have completed. Check which rig is playing before loading again.");
                }
                setLoadError("Connection interrupted. Inspect the experimental bank before trying again.");
            }
        };
        const changed = () => { if (owner.current && !ownerCurrent()) setOwnerChanged(true); };
        model.state.addOnChangedHandler(connection); model.banks.addOnChangedHandler(changed);
        model.presets.addOnChangedHandler(changed); model.selectedSnapshot.addOnChangedHandler(changed); model.pedalboard.addOnChangedHandler(changed);
        return () => {
            if (loadFlight.current?.session === current) {
                loadFlight.current = null;
                model.showAlert("Loading may have completed. Check which rig is playing before loading again.");
            }
            if (current.invalidate()) model.showAlert("Creation may have completed. Inspect TONE3000 Experiments banks before creating another copy.");
            model.state.removeOnChangedHandler(connection); model.banks.removeOnChangedHandler(changed);
            model.presets.removeOnChangedHandler(changed); model.selectedSnapshot.removeOnChangedHandler(changed); model.pedalboard.removeOnChangedHandler(changed);
        };
    }, [selection, model]);
    const review = () => {
        if (!selection || !connected || !name.trim()) return;
        setConfirmed(false);
        void session.current.read(async () => {
            const [sources, saved] = await Promise.all([model.getTone3000PerformanceSources(), model.getTone3000PresetPreview(selection.entry, selection.target)]);
            const source = sources.find(item => item.bankId === selection.target.bankId && item.presetId === selection.target.presetId);
            if (!source || !saved.targetState) throw new Error("Saved copy changed. Refresh the library and select it again.");
            const blocks = saved.targetState.summary.blocks.filter(block => block.type !== "insert");
            const amps = blocks.filter(block => block.type === "nam"), cabs = blocks.filter(block => block.type === "ir");
            if (amps.length !== 1 || cabs.length !== 1) throw new Error("This first version needs exactly one separate NAM amp head and one cabinet IR. Baked amp + cab and extra internal blocks stay in the original T3K rig.");
            const request = { bankId: source.bankId, presetId: source.presetId, instanceId: selection.target.instanceId,
                expectedRevision: source.revision, ampBlockId: amps[0].blockId, cabBlockId: cabs[0].blockId,
                name: name.trim(), includePitch: pitch, confirmAmpHead: false };
            return { request, preview: await model.getTone3000MixMatchPreview(request) };
        });
    };
    const create = () => {
        const current = session.current;
        if (!confirmed || model.state.get() !== State.Ready || current.state.loading || current.state.creating
            || current.state.uncertain || current.state.receipt || !current.state.preview || loadFlight.current) return;
        owner.current = { bank: model.banks.get().selectedBank, preset: model.presets.get().selectedInstanceId,
            snapshot: model.selectedSnapshot.get(), board: model.pedalboard.get() };
        setOwnerChanged(model.presets.get().presetChanged);
        void current.create(confirmed, request => model.createTone3000MixMatch(request));
    };
    const load = async () => {
        const current = session.current, receipt = current.state.receipt;
        if (!receipt || receipt !== read.receipt || model.state.get() !== State.Ready
            || loadFlight.current || loaded || ownerChanged || !ownerCurrent()) return;
        const flight = { session: current };
        loadFlight.current = flight; setLoading(true); setLoadError("");
        try {
            await model.loadTone3000Preset(receipt.bankId, receipt.presetId,
                { requireClean: true, expectedBankId: owner.current!.bank, expectedPresetId: owner.current!.preset });
            if (loadFlight.current === flight && session.current === current) setLoaded(true);
        } catch (error) {
            if (loadFlight.current === flight && session.current === current)
                setLoadError(String(error) + " Check which rig is playing before loading again.");
        } finally {
            if (loadFlight.current === flight) { loadFlight.current = null; setLoading(false); }
        }
    };
    const close = () => { if (!loadFlight.current) onClose(); };
    const locked = read.creating || read.uncertain || !!read.receipt;
    return <DialogEx tag="tone3000MixMatch" open={!!selection} onClose={close} fullWidth maxWidth="md"
        sx={{ "& .MuiDialog-paper": { m: { xs: 0, sm: 4 }, width: { xs: "100%", sm: "calc(100% - 64px)" }, maxHeight: { xs: "100%", sm: "calc(100% - 64px)" } },
            "& .MuiButton-root": { minHeight: 44, whiteSpace: "normal" } }}>
        <DialogTitle>Mix & match · Experimental copy</DialogTitle>
        <DialogContent><Stack spacing={2} sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <Typography>Use PiPedal effects around separate T3K pitch, amp and cab stages. Your original saved rig stays intact. Creating the copy does not start playing it.</Typography>
            <Typography variant="body2" color="text.secondary">Uses the latest saved PiPedal copy. Save your current changes first. Only a single mono amp head followed by a separate cabinet IR is supported initially; oversampling and stereo processing must be off. Extra instances use more CPU and add processing boundaries.</Typography>
            {!connected && <Alert severity="warning">Reconnect to read a fresh preview.</Alert>}
            {read.error && <Alert severity="error">{read.error}</Alert>}
            {loadError && <Alert severity="warning">{loadError}</Alert>}
            <TextField label="New rig name" size="small" value={name} disabled={locked} onChange={event => { session.current.invalidate(); setConfirmed(false); setName(event.target.value); }} />
            <FormControlLabel control={<Checkbox checked={pitch} disabled={locked} onChange={event => { session.current.invalidate(); setConfirmed(false); setPitch(event.target.checked); }} />} label="Include separate T3K Pitch (stackable)" />
            <Button variant="outlined" disabled={!connected || locked || read.loading || !name.trim()} onClick={review}>{read.loading ? "Reading saved rig…" : "Review saved rig"}</Button>
            {read.preview && <>
                <Typography variant="subtitle1">{read.preview.sourceName} → {read.preview.name}</Typography>
                <Typography>{read.preview.items.map(item => item.name || item.role).join(" → ")}</Typography>
                <Tone3000ChainView summary={read.preview.ampSummary} heading="Amp stage · Read only" ariaLabel="Proposed amp stage" />
                <Tone3000ChainView summary={read.preview.cabSummary} heading="Cab stage · Read only" ariaLabel="Proposed cab stage" />
                {read.preview.warnings.map((warning, index) => <Alert key={index} severity="warning">{warning}</Alert>)}
                <FormControlLabel sx={{ alignItems: "flex-start" }} control={<Checkbox checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} />}
                    label="I confirm this NAM is an amp head without a baked cabinet." />
            </>}
            {read.receipt && <Alert severity="success">Saved {read.receipt.name} in TONE3000 Experiments. Listen and qualify this copy before using it live. Use the normal PiPedal + button to add effects between its stages.</Alert>}
            {read.receipt && ownerChanged && !loaded && <Typography>Keep your current edits. Find the new copy in the normal bank selector when you are ready to load it.</Typography>}
            {loaded && <Alert severity="info">Experimental copy loaded. Test at your usual sample rate and buffers before taking it to a gig.</Alert>}
        </Stack></DialogContent>
        <DialogActions sx={{ flexWrap: "wrap", gap: 1, px: 2 }}>
            <Button disabled={loading} onClick={close}>Close</Button>
            {read.receipt ? <Button variant="contained" disabled={!connected || loading || loaded || ownerChanged || !ownerCurrent()} onClick={() => { void load(); }}>{loading ? "Loading…" : "Load experimental copy"}</Button>
                : <Button variant="contained" disabled={!connected || !confirmed || !read.preview || read.loading || locked} onClick={create}>{read.creating ? "Creating…" : "Create separate copy"}</Button>}
        </DialogActions>
    </DialogEx>;
}
