// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import type { Tone3000BlockFocus } from "./Tone3000BlockFocus";
import JackHostStatus from "./JackHostStatus";
import { PiPedalModelFactory } from "./PiPedalModel";
import { ObservableProperty } from "./ObservableProperty";
import { tone3000BlockChanges, tone3000ValidBlocks } from "./Tone3000Rig";
import type { Tone3000Block, Tone3000CurrentState, Tone3000Defaults, Tone3000DefaultsResult,
    Tone3000EqBand, Tone3000StatePatch, Tone3000Summary } from "./Tone3000Rig";

const gearLabels: Record<string, string> = {
    amp: "Amp Head", "amp-cab": "Amp + Cab", "full-rig": "Full Rig", cab: "Cabinet",
    pedal: "Pedal", outboard: "Outboard", ir: "IR", space: "Space", experimental: "Experimental"
};
const rowStyle = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2 };

/** Subscribe to the existing host settings without introducing duplicate setters.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [DES-OPERATE] [3.13]
 */
function useHostValue<T>(property: ObservableProperty<T>): T {
    const [value, setValue] = useState(property.get());
    useEffect(() => {
        property.addOnChangedHandler(setValue);
        return () => property.removeOnChangedHandler(setValue);
    }, [property]);
    return value;
}

/** Reject incomplete or out-of-range numeric drafts.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.13]
 */
function NumberField({ label, value, min, max, step = .01, onChange }: {
    label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void;
}) {
    return <TextField size="small" type="number" label={label}
        value={Number.isFinite(value) ? Number(value.toFixed(Math.max(0, Math.ceil(-Math.log10(step))))) : ""}
        onChange={event => onChange(event.target.value === "" ? NaN : Number(event.target.value))}
        error={!Number.isFinite(value) || value < min || value > max}
        inputProps={{ min, max, step }} sx={{ width: 160, maxWidth: "100%" }} />;
}

/** Four session parameters also act as processing defaults; they are never tone fields.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [DES-OPERATE] [3.13]
 */
function ProcessingFields({ value, onChange }: { value: Pick<Tone3000Defaults,
    "calibrateInput" | "inputCalibrationLevel" | "osEnabled" | "osFactor">;
    onChange: (patch: Partial<Tone3000Defaults>) => void }) {
    return <Box sx={rowStyle}>
        <FormControlLabel label="Calibration" control={<Switch checked={value.calibrateInput}
            onChange={(_event, checked) => onChange({ calibrateInput: checked })} />} />
        <NumberField label="Input calibration (dBu)" value={value.inputCalibrationLevel} min={-60} max={60}
            step={.1} onChange={inputCalibrationLevel => onChange({ inputCalibrationLevel })} />
        <FormControlLabel label="Oversampling" control={<Switch checked={value.osEnabled}
            onChange={(_event, checked) => onChange({ osEnabled: checked })} />} />
        <TextField select size="small" label="Oversampling rate" value={value.osFactor} sx={{ width: 180 }}
            onChange={event => onChange({ osFactor: Number(event.target.value) })}>
            {[2, 4, 8].map((rate, index) => <MenuItem key={rate} value={index}>{rate}×</MenuItem>)}
        </TextField>
    </Box>;
}

/** Model names and saved block controls use a bounded server-side state projection.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.13]
 */
function BlockCard({ block, onChange }: { block: Tone3000Block; onChange: (block: Tone3000Block) => void }) {
    const change = (patch: Partial<Tone3000Block>) => onChange({ ...block, ...patch });
    const changeBand = (index: number, patch: Partial<Tone3000EqBand>) =>
        change({ eq: { ...block.eq, bands: block.eq.bands.map((band, i) => i === index ? { ...band, ...patch } : band) } });
    return <Paper variant="outlined" component="section" aria-label={block.title || "Empty slot"}
        sx={{ p: 2, minWidth: 0, borderRadius: 2 }}>
        <Stack spacing={2}>
            <Box sx={rowStyle}>
                <Typography variant="subtitle1" component="h3">{block.title || (block.type === "insert" ? "Empty slot" : "Unnamed block")}</Typography>
                <Chip size="small" label={gearLabels[block.gear] || block.gear || block.type.toUpperCase()} />
                <Typography variant="caption">{block.lane === "right" ? "Right" : "Left"} · {block.index + 1}
                    {block.activeModelId !== null && " · Model " + block.activeModelId}</Typography>
            </Box>
            {block.type === "insert" ? <Typography variant="body2" color="text.secondary">
                Add or replace blocks in TONE3000, then update this rig from Library.
            </Typography> : <>
                <Box sx={rowStyle}>
                    <FormControlLabel label="Block enabled" control={<Switch checked={block.enabled}
                        onChange={(_event, enabled) => change({ enabled })} />} />
                    {block.type === "nam" && <>
                        <FormControlLabel label="Normalize" control={<Switch checked={block.normalize}
                            onChange={(_event, normalize) => change({ normalize })} />} />
                        <TextField select size="small" label="Requested NAM size" value={block.slimSize >= .5 ? 1 : 0}
                            sx={{ width: 210 }} onChange={event => change({ slimSize: Number(event.target.value) })}>
                            <MenuItem value={0}>A2-Lite</MenuItem><MenuItem value={1}>A2-Full</MenuItem>
                        </TextField>
                    </>}
                    <NumberField label="Input gain (dB)" value={(block.inputGain - .5) * 48} min={-24} max={24} step={.1}
                        onChange={gainDb => change({ inputGain: gainDb / 48 + .5 })} />
                    <NumberField label="Output gain (dB)" value={(block.outputGain - .5) * 48} min={-24} max={24} step={.1}
                        onChange={gainDb => change({ outputGain: gainDb / 48 + .5 })} />
                    <NumberField label="Mix (%)" value={block.mix * 100} min={0} max={100} step={1} onChange={percent => change({ mix: percent / 100 })} />
                </Box>
                {block.type === "nam" && block.capabilityUnknown && <Typography variant="caption" color="text.secondary">
                    Size is the saved request. Models without switchable tiers may ignore it.
                </Typography>}
                <Accordion disableGutters variant="outlined" sx={{ boxShadow: "none" }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography>Block EQ</Typography></AccordionSummary>
                    <AccordionDetails>
                        <Stack spacing={2}>
                            <Box sx={rowStyle}>
                                <FormControlLabel label="EQ enabled" control={<Switch checked={block.eq.enabled}
                                    onChange={(_event, enabled) => change({ eq: { ...block.eq, enabled } })} />} />
                                <FormControlLabel label="EQ before model" control={<Switch checked={block.eq.pre}
                                    onChange={(_event, pre) => change({ eq: { ...block.eq, pre } })} />} />
                            </Box>
                            {block.eq.bands.map((band, index) => <Box key={index} sx={rowStyle}>
                                <Typography variant="body2" sx={{ width: 52 }}>Band {index + 1}</Typography>
                                <TextField select size="small" label={"Band " + (index + 1) + " type"}
                                    value={band.type} sx={{ width: 150 }} onChange={event => changeBand(index, { type: event.target.value })}>
                                    {(index === 0 ? ["lowcut", "lowshelf"] : index === 5 ? ["highshelf", "highcut"] : ["bell"])
                                        .map(type => <MenuItem key={type} value={type}>{type}</MenuItem>)}
                                </TextField>
                                <NumberField label={"Band " + (index + 1) + " frequency (Hz)"} value={band.freqHz} min={20} max={20000}
                                    step={1} onChange={freqHz => changeBand(index, { freqHz })} />
                                <NumberField label={"Band " + (index + 1) + " gain (dB)"} value={band.gainDb} min={-15} max={15}
                                    step={.1} onChange={gainDb => changeBand(index, { gainDb })} />
                                <NumberField label={"Band " + (index + 1) + " Q"} value={band.q} min={.1} max={10}
                                    onChange={q => changeBand(index, { q })} />
                            </Box>)}
                        </Stack>
                    </AccordionDetails>
                </Accordion>
            </>}
        </Stack>
    </Paper>;
}

/** The host already owns these fields. This surface only subscribes and reads.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [DES-OPERATE] [3.13]
 */
function SystemSettings({ status }: { status: JackHostStatus | null }) {
    const model = PiPedalModelFactory.getInstance();
    const audio = useHostValue(model.jackConfiguration);
    const server = useHostValue(model.jackServerSettings);
    const selection = useHostValue(model.jackSettings);
    const midi = useHostValue(model.alsaSequencerConfiguration);
    const rows = [
        ["Audio device", server.valid ? server.getSummaryText() : "Unavailable"],
        ["Audio backend", server.valid ? server.isJackAudio ? "JACK" : "ALSA" : "Unavailable"],
        ["Audio status", audio.isRestarting || status?.restarting ? "Restarting"
            : status ? status.active ? "Running" : status.errorMessage || "Stopped" : "Unknown"],
        ["Sample rate", audio.isValid ? audio.sampleRate + " Hz" : "Unavailable"],
        ["Block length", audio.isValid ? audio.blockLength + " frames" : "Unavailable"],
        ["Configured buffers", server.valid ? server.bufferSize + " × " + server.numberOfBuffers : "Unavailable"],
        ["Input channels", selection.inputAudioPorts.join(", ") || "None"],
        ["Output channels", selection.outputAudioPorts.join(", ") || "None"],
        ["Enabled MIDI inputs", midi.connections.map(port => port.name).join(", ") || "None"],
        ["CPU / xruns", status?.active ? status.cpuUsage.toFixed(1) + "% / " + status.underruns : "Unavailable"]
    ];
    return <Paper variant="outlined" component="section" sx={{ p: 2 }}>
        <Typography variant="h6" component="h3">System settings</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Read-only. Managed by PiPedal's existing settings.</Typography>
        <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "minmax(100px, 1fr) minmax(0, 2fr)", gap: 1 }}>
            {rows.map(([label, value]) => <Box key={label} sx={{ display: "contents" }}>
                <Typography component="dt" variant="body2">{label}</Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: "anywhere" }}>{value}</Typography>
            </Box>)}
        </Box>
    </Paper>;
}

/** Drafted block/settings edits are explicit; profiles never auto-change playing audio.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [FR-14] [DES-OPERATE] [3.13]
 */
export default function Tone3000RigPanel({ instanceId, section, active, focusedBlock }: {
    instanceId: number; section: "Blocks" | "Settings"; active: boolean; focusedBlock?: Tone3000BlockFocus | null;
}) {
    const model = PiPedalModelFactory.getInstance();
    const [rig, setRig] = useState<Tone3000CurrentState | null>(null);
    const [draft, setDraft] = useState<Tone3000Summary | null>(null);
    const [follow, setFollow] = useState(false);
    const [defaults, setDefaults] = useState<Tone3000DefaultsResult | null>(null);
    const [profileId, setProfileId] = useState("");
    const [profileDraft, setProfileDraft] = useState<Tone3000Defaults | null>(null);
    const [status, setStatus] = useState<JackHostStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [stale, setStale] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const blockCards = useRef(new Map<string, HTMLDivElement>());
    const lastFocused = useRef<Tone3000BlockFocus | null>(null);
    useEffect(() => {
        if (!active || section !== "Blocks" || !focusedBlock || lastFocused.current === focusedBlock) return;
        const card = blockCards.current.get(focusedBlock.blockId);
        if (card) {
            card.scrollIntoView({ block: "start", inline: "nearest", behavior: "smooth" });
            card.focus({ preventScroll: true });
            lastFocused.current = focusedBlock;
        }
    }, [active, section, focusedBlock, draft]);
    const alive = useRef(true);
    const working = useRef(false);
    const generation = useRef(0);
    const waitingRef = useRef(waiting);
    waitingRef.current = waiting;
    const rigDirty = useRef(false);
    const profileDirty = useRef(false);
    const rigRef = useRef(rig);
    rigRef.current = rig;

    const acceptRig = useCallback((value: Tone3000CurrentState) => {
        setRig(value); setDraft(value.summary); setFollow(value.followDefaults);
        rigDirty.current = false; setStale(false); setWaiting(false);
    }, []);
    const acceptDefaults = useCallback((value: Tone3000DefaultsResult) => {
        setDefaults(value); setProfileId(value.activeProfile); setProfileDraft(value.defaults);
        profileDirty.current = false;
    }, []);
    useEffect(() => {
        setRig(null); setDraft(null); setWaiting(false); setStale(false); setError(""); setNotice("");
        rigDirty.current = false;
    }, [instanceId]);
    const refresh = useCallback(async (reset = false) => {
        if (!alive.current || working.current) return;
        const request = ++generation.current;
        try {
            const value = await model.getTone3000CurrentState(instanceId);
            if (!alive.current || request !== generation.current) return;
            if (reset || !rigDirty.current) {
                if (waitingRef.current) setNotice("Changes applied to this rig. Use PiPedal Save to keep them.");
                acceptRig(value);
            }
            else setStale(value.revision !== rigRef.current?.revision);
            if (section === "Settings") {
                const [profiles, currentStatus] = await Promise.all([model.getTone3000Defaults(), model.getJackStatus()]);
                if (!alive.current || request !== generation.current) return;
                if (reset || !profileDirty.current) acceptDefaults(profiles);
                setStatus(currentStatus);
            }
            if (reset) setError("");
        } catch (failure) {
            if (alive.current && request === generation.current) {
                if (String(failure).includes("Apply accepted;")) {
                    setWaiting(true);
                    setNotice("Changes accepted. Waiting for captured settings before Save; this is not an audio-readiness check.");
                } else setError(String(failure));
            }
        }
    }, [model, instanceId, section, acceptRig, acceptDefaults]);
    useEffect(() => {
        alive.current = true;
        if (active) void refresh();
        const timer = active ? window.setInterval(() => { void refresh(); }, 5000) : undefined;
        return () => { alive.current = false; ++generation.current; window.clearInterval(timer); };
    }, [active, refresh]);

    const run = async (action: (isCurrent: () => boolean) => Promise<string>) => {
        if (working.current) return;
        working.current = true; const request = ++generation.current;
        const isCurrent = () => alive.current && request === generation.current;
        setBusy(true); setError(""); setNotice("");
        try {
            const message = await action(isCurrent);
            if (isCurrent()) setNotice(message);
        } catch (failure) {
            if (isCurrent()) setError(String(failure));
        } finally {
            working.current = false;
            if (alive.current) setBusy(false);
        }
    };
    const edit = (patch: Partial<Tone3000Summary>, processing = false) => {
        rigDirty.current = true;
        setDraft(value => value ? { ...value, ...patch } : value);
        if (processing) setFollow(false);
    };
    const changeProfile = (patch: Partial<Tone3000Defaults>) => {
        profileDirty.current = true;
        setProfileDraft(value => value ? { ...value, ...patch } : value);
    };
    const apply = (onlyDefaults = false) => run(async isCurrent => {
        if (!rig || !draft) throw new Error("Refresh the current rig first.");
        const patch: Tone3000StatePatch = {};
        if (!onlyDefaults && section === "Blocks") patch.blocks = tone3000BlockChanges(rig.summary.blocks, draft.blocks);
        if (!onlyDefaults && section === "Settings") {
            for (const field of ["inputMode", "calibrateInput", "inputCalibrationLevel", "osEnabled", "osFactor"] as const)
                if (rig.summary[field] !== draft[field]) Object.assign(patch, { [field]: draft[field] });
        }
        await model.setTone3000CurrentState(instanceId, rig.revision, patch,
            section === "Settings" ? { followDefaults: onlyDefaults || follow, applyDefaults: onlyDefaults || follow } : {});
        if (!isCurrent()) return "";
        rigDirty.current = false;
        setWaiting(true);
        try {
            const value = await model.getTone3000CurrentState(instanceId);
            if (isCurrent()) acceptRig(value);
        } catch (failure) {
            if (String(failure).includes("Apply accepted;"))
                return "Changes accepted. Waiting for captured settings before Save; this is not an audio-readiness check.";
            throw failure;
        }
        return "Changes applied to this rig. Use PiPedal Save to keep them.";
    });
    const saveDefaults = () => run(async isCurrent => {
        if (!defaults || !profileDraft) throw new Error("Refresh the processing profiles first.");
        const value = await model.setTone3000Defaults(defaults.revision, profileId, profileDraft);
        if (isCurrent()) acceptDefaults(value);
        return "Device defaults saved. Playing audio is unchanged; apply them to this rig when ready.";
    });
    const validCalibration = (value: number) => Number.isFinite(value) && value >= -60 && value <= 60;

    return <Stack spacing={2} sx={{ px: 1, maxWidth: 1100 }}>
        <Box sx={rowStyle}>
            <Typography component="h2" variant="h6">{section === "Blocks" ? "Rig blocks" : "TONE3000 settings"}</Typography>
            <Button disabled={busy} onClick={() => { void refresh(true); }}>Refresh</Button>
        </Box>
        {error && <Alert severity="error">{error}</Alert>}
        {notice && <Alert severity="success">{notice}</Alert>}
        {stale && <Alert severity="warning">The rig changed elsewhere. Refresh to discard this draft and get its latest settings.</Alert>}
        {!rig || !draft ? <Typography>Reading current TONE3000 state…</Typography> : <>
            <Typography variant="body2">{rig.summary.activePresetName || "Unsaved TONE3000 rig"}
                {rig.summary.stereoEnabled ? " · Stereo chain" : " · Single chain"}</Typography>
            {rig.hasSnapshotOverrides && <Alert severity="info">Snapshots retain their saved tone versions. These edits do not replace other snapshots.</Alert>}
            <Typography variant="body2" color="text.secondary">
                Apply may briefly reload this TONE3000 instance. Library Update replaces local tone/block tweaks from your T3K source.
            </Typography>
            <Box component="fieldset" disabled={busy || waiting} sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
                {section === "Blocks" ? <Stack spacing={2}>
                    {draft.blocks.filter(block => block.type !== "insert").map(block => <Box key={block.blockId}
                        ref={(card: HTMLDivElement | null) => { if (card) blockCards.current.set(block.blockId, card); else blockCards.current.delete(block.blockId); }}
                        tabIndex={-1} aria-label={"Settings for " + (block.title || "block")}
                        sx={{ minWidth: 0, outline: "none" }}>
                        <BlockCard block={block}
                            onChange={updated => edit({ blocks: draft.blocks.map(before => before.blockId === updated.blockId ? updated : before) })} />
                    </Box>)}
                    {draft.blocks.some(block => block.type === "insert") && <Typography variant="caption" color="text.secondary">
                        Empty slots are omitted. Add, replace or reorder blocks in TONE3000, then use Library Update.
                    </Typography>}
                    {!draft.blocks.length && <Typography>No blocks loaded. Author a rig in TONE3000 and add it through Library.</Typography>}
                    <Button variant="contained" disabled={busy || stale || !rigDirty.current || !tone3000ValidBlocks(draft.blocks)}
                        onClick={() => { void apply(); }}>Apply block changes</Button>
                </Stack> : <Stack spacing={3}>
                    <SystemSettings status={status} />
                    <Paper component="section" variant="outlined" sx={{ p: 2 }}>
                        <Stack spacing={2}>
                            <Typography component="h3" variant="h6">Plugin settings · Current rig</Typography>
                            <TextField select size="small" label="Processing policy" value={follow ? "follow" : "saved"}
                                onChange={event => { rigDirty.current = true; setFollow(event.target.value === "follow"); }}>
                                <MenuItem value="follow">Follow device defaults</MenuItem>
                                <MenuItem value="saved">Keep saved settings</MenuItem>
                            </TextField>
                            <ProcessingFields value={draft} onChange={patch => edit(patch, true)} />
                            <TextField select size="small" label="Plugin input mode" value={draft.inputMode} sx={{ maxWidth: 260 }}
                                onChange={event => edit({ inputMode: event.target.value })}>
                                {["stereo", "left", "right", "dual"].map(mode => <MenuItem key={mode} value={mode}>{mode}</MenuItem>)}
                            </TextField>
                            <Box sx={rowStyle}>
                                <Button variant="contained" disabled={busy || stale || !rigDirty.current || !validCalibration(draft.inputCalibrationLevel)}
                                    onClick={() => { void apply(); }}>Apply rig settings</Button>
                                <Button variant="outlined" disabled={busy || stale || rigDirty.current}
                                    onClick={() => { void apply(true); }}>Apply device defaults to this rig</Button>
                            </Box>
                            <Typography variant="caption" color="text.secondary">Follow applies calibration/oversampling on saved-rig recall.
                                Editing either selects Keep saved settings. Input routing and block sizes remain rig settings.</Typography>
                        </Stack>
                    </Paper>
                    {defaults && profileDraft && <Paper component="section" variant="outlined" sx={{ p: 2 }}>
                        <Stack spacing={2}>
                            <Typography component="h3" variant="h6">Plugin settings · Device defaults</Typography>
                            <Typography variant="body2" color="text.secondary">Saving defaults stages them for later load/apply.
                                Multi-core and default NAM size take effect in newly reloaded instances; saved block sizes remain unchanged.</Typography>
                            <TextField select size="small" label="Processing profile" value={profileId}
                                onChange={event => {
                                    const profile = defaults.profiles.find(candidate => candidate.id === event.target.value);
                                    if (profile) { profileDirty.current = true; setProfileId(profile.id); setProfileDraft(profile.defaults); }
                                }}>
                                {defaults.profiles.map(profile => <MenuItem key={profile.id} value={profile.id}>{profile.name}
                                    {profile.id === defaults.activeProfile ? " · Active defaults" : ""}</MenuItem>)}
                            </TextField>
                            <ProcessingFields value={profileDraft} onChange={changeProfile} />
                            <Box sx={rowStyle}>
                                <FormControlLabel label="Multi-core processing" control={<Switch checked={profileDraft.multiCore}
                                    onChange={(_event, multiCore) => changeProfile({ multiCore })} />} />
                                <TextField select size="small" label="Default size for new NAM blocks" value={profileDraft.namSlimSizeDefault}
                                    sx={{ minWidth: 260 }} onChange={event => changeProfile({ namSlimSizeDefault: Number(event.target.value) })}>
                                    <MenuItem value={0}>A2-Lite</MenuItem><MenuItem value={1}>A2-Full</MenuItem>
                                </TextField>
                            </Box>
                            <Typography variant="caption" color="text.secondary">{{ "service-profile": "Saved PiPedal processing profiles", "app-seed": "Initial values from this Pi’s T3K app", "service-seed": "Initial values from plugin service preferences", "pinned-defaults": "Initial values from T3K defaults" }[defaults.sourceStatus] || defaults.sourceStatus}</Typography>
                            {defaults.warnings.map((warning, index) => <Alert key={index} severity="warning">{warning}</Alert>)}
                            <Box sx={rowStyle}>
                                <Button variant="contained" disabled={busy || !profileDirty.current || !validCalibration(profileDraft.inputCalibrationLevel)}
                                    onClick={() => { void saveDefaults(); }}>Save defaults</Button>
                                <Button disabled={busy || !defaults.appDefaults} onClick={() => {
                                    if (defaults.appDefaults) { profileDirty.current = true; setProfileDraft(defaults.appDefaults); }
                                }}>Use T3K app defaults</Button>
                            </Box>
                        </Stack>
                    </Paper>}
                </Stack>}
            </Box>
        </>}
    </Stack>;
}
