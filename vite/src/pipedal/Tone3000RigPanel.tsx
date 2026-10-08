// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT

import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
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
import useMediaQuery from "@mui/material/useMediaQuery";
import Tone3000TouchEditor from "./Tone3000TouchEditor";
import type { Tone3000BlockFocus } from "./Tone3000BlockFocus";
import JackHostStatus from "./JackHostStatus";
import { PiPedalModelFactory, State } from "./PiPedalModel";
import { ObservableProperty } from "./ObservableProperty";
import { tone3000BlockChanges, tone3000ValidBlocks } from "./Tone3000Rig";
import type { Tone3000Block, Tone3000CurrentState, Tone3000Defaults, Tone3000DefaultsResult,
    Tone3000EqBand, Tone3000StatePatch, Tone3000Summary } from "./Tone3000Rig";

import { tone3000GearLabel } from "./Tone3000Gear";
import { tone3000DraftNumber, tone3000FormatNumber, tone3000SameDraftNumber } from "./Tone3000MobileLayout";
import { tone3000RigDraftChanged, tone3000ProfileDraftChanged, tone3000EditDrafts } from "./Tone3000EditState";

const rowStyle = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2 };

/** Equal cells keep drafted fields and switch targets aligned without changing their events.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-VISUAL-ALIGN] [7.16]
 */
const fieldGridStyle = {
    display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
    alignItems: "start", gap: 2, minWidth: 0,
    "& > .MuiFormControl-root": { width: "100%", minWidth: 0, maxWidth: "100%" },
    "& > .MuiFormControlLabel-root": {
        width: "100%", minHeight: 44, margin: 0, alignSelf: "start",
        "& .MuiFormControlLabel-label": { whiteSpace: "normal", overflowWrap: "anywhere", lineHeight: 1.4 }
    },
    "& .MuiInputBase-root": { minHeight: 44 }
};

/** Six block controls use at most three columns, retaining two on unfolded phones.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-VISUAL-ALIGN] [7.16]
 */
const blockGridStyle = {
    ...fieldGridStyle,
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, max(220px, calc((100% - 32px) / 3))), 1fr))"
};

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
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOLD-GEAR] [7.14]
 */
const DraftTouchContext = createContext({ enabled: false, scopeKey: "" });

/** Draft-only touch dispatch retains the original Apply boundary.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-TOUCH-EDITOR] [7.27] */
function NumberField({ label, value, min, max, step = .01, logarithmic = false, onChange }: {
    label: string; value: number; min: number; max: number; step?: number; logarithmic?: boolean; onChange: (value: number) => void;
}) {
    const [text, setText] = useState(() => tone3000FormatNumber(value, step));
    const [touchOpen, setTouchOpen] = useState(false);
    const touch = useMediaQuery("(any-pointer: coarse), (max-width: 600px)");
    const owner = useContext(DraftTouchContext);
    const model = PiPedalModelFactory.getInstance();
    const ownerRef = useRef(owner); ownerRef.current = owner;
    const opening = useRef<string | null>(null);
    const key = () => JSON.stringify([ownerRef.current.scopeKey, model.banks.get().selectedBank,
        model.presets.get().selectedInstanceId, model.selectedSnapshot.get(), model.state.get()]);
    const close = () => { opening.current = null; setTouchOpen(false); };
    const touchChange = (next: number) => {
        if (!ownerRef.current.enabled || opening.current !== key() || model.state.get() !== State.Ready) return;
        emitted.current = next;
        setText(tone3000FormatNumber(next, step));
        onChange(next);
    };
    useEffect(() => { close(); }, [owner.scopeKey, owner.enabled]);
    useEffect(() => {
        if (!touchOpen) return;
        const changed = () => { if (opening.current !== key()) close(); };
        model.state.addOnChangedHandler(changed);
        model.banks.addOnChangedHandler(changed);
        model.presets.addOnChangedHandler(changed);
        model.selectedSnapshot.addOnChangedHandler(changed);
        let initial = true;
        const boardChanged = () => { if (initial) { initial = false; return; } close(); };
        model.pedalboard.addOnChangedHandler(boardChanged);
        return () => {
            model.state.removeOnChangedHandler(changed); model.banks.removeOnChangedHandler(changed);
            model.presets.removeOnChangedHandler(changed); model.selectedSnapshot.removeOnChangedHandler(changed);
            model.pedalboard.removeOnChangedHandler(boardChanged);
        };
    }, [touchOpen, model]);
    const focused = useRef(false);
    const emitted = useRef(value);
    useEffect(() => {
        // An authoritative Refresh/replacement must discard even a focused local draft.
        if (!focused.current || !tone3000SameDraftNumber(value, emitted.current)) {
            setText(tone3000FormatNumber(value, step));
            if (!tone3000SameDraftNumber(value, emitted.current)) close();
            emitted.current = value;
        }
    }, [value, step]);
    if (touch) return <Box sx={{ minWidth: 0, width: "100%" }}>
        <Typography component="span" variant="caption" color="text.secondary">{label}</Typography>
        <Button variant="outlined" aria-label={"Adjust " + label} disabled={!owner.enabled || !Number.isFinite(value)}
            onClick={() => { opening.current = key(); setTouchOpen(true); }}
            sx={{ display: "flex", justifyContent: "space-between", width: "100%", minHeight: 44, textTransform: "none", color: "text.primary", borderColor: "divider" }}>
            {tone3000FormatNumber(value, step)}<Typography component="span" variant="caption" color="text.secondary">Adjust</Typography>
        </Button>
        <Tone3000TouchEditor open={touchOpen} label={label} value={value} min={min} max={max} step={step}
            scopeKey={owner.scopeKey} disabled={!owner.enabled}
            format={v => tone3000FormatNumber(v, step)}
            {...(logarithmic && min > 0 ? {
                valueToRange: (v: number) => Math.log(v / min) / Math.log(max / min),
                rangeToValue: (r: number) => min * Math.pow(max / min, r)
            } : {})}
            scope="Tap Apply to hear changes, then Save preset."
            onChange={touchChange} onCommit={touchChange} onClose={close} />
    </Box>;
    return <TextField size="small" type="text" label={label} value={text}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; }}
        onKeyDown={event => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault(); (event.target as HTMLInputElement).blur();
            }
        }}
        onChange={event => {
            setText(event.target.value);
            // Only edit the local rig/profile draft. Apply remains the server mutation boundary.
            const number = tone3000DraftNumber(event.target.value);
            emitted.current = number;
            onChange(number);
        }}
        error={!Number.isFinite(value) || value < min || value > max}
        inputProps={{ inputMode: min < 0 ? "text" : step >= 1 ? "numeric" : "decimal", enterKeyHint: "done" }}
        sx={{ width: "100%", minWidth: 0, maxWidth: "100%", "& .MuiInputBase-root": { minHeight: 44 }, "& input": { fontSize: 16, minHeight: 24 } }} />;
}

/** Four session parameters also act as processing defaults; they are never tone fields.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [DES-OPERATE] [3.13]
 */
function ProcessingFields({ value, onChange }: { value: Pick<Tone3000Defaults,
    "calibrateInput" | "inputCalibrationLevel" | "osEnabled" | "osFactor">;
    onChange: (patch: Partial<Tone3000Defaults>) => void }) {
    return <Box className="t3k-field-grid" sx={fieldGridStyle}>
        <FormControlLabel label="Calibration" control={<Switch checked={value.calibrateInput}
            onChange={(_event, checked) => onChange({ calibrateInput: checked })} />} />
        <NumberField label="Calibration level (dBu)" value={value.inputCalibrationLevel} min={-60} max={60}
            step={.1} onChange={inputCalibrationLevel => onChange({ inputCalibrationLevel })} />
        <FormControlLabel label="Oversampling" control={<Switch checked={value.osEnabled}
            onChange={(_event, checked) => onChange({ osEnabled: checked })} />} />
        <TextField select size="small" label="Rate" value={value.osFactor}
            onChange={event => onChange({ osFactor: Number(event.target.value) })}>
            {[2, 4, 8].map((rate, index) => <MenuItem key={rate} value={index}>{rate}×</MenuItem>)}
        </TextField>
    </Box>;
}

/** Model names and saved block controls use a bounded server-side state projection.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.13]
 */
function BlockCard({ block, onChange, expanded, onToggle }: { block: Tone3000Block;
    onChange: (block: Tone3000Block) => void; expanded: boolean; onToggle: (expanded: boolean) => void }) {
    const change = (patch: Partial<Tone3000Block>) => onChange({ ...block, ...patch });
    const changeBand = (index: number, patch: Partial<Tone3000EqBand>) =>
        change({ eq: { ...block.eq, bands: block.eq.bands.map((band, i) => i === index ? { ...band, ...patch } : band) } });
    return <Accordion disableGutters variant="outlined" expanded={expanded}
        onChange={(_event, open) => onToggle(open)} TransitionProps={{ unmountOnExit: false }}
        sx={{ minWidth: 0, borderRadius: 1, boxShadow: "none", "&:before": { display: "none" } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 56 }}
            aria-label={"View settings for " + (block.title || "block")} >
            <Box className="t3k-field-row" sx={{ ...rowStyle, gap: 1, minWidth: 0 }}>
                <Typography variant="subtitle1" component="h3" sx={{ overflowWrap: "anywhere" }}>{block.title || (block.type === "insert" ? "Empty slot" : "Unnamed block")}</Typography>
                <Chip size="small" label={tone3000GearLabel(block.gear, block.type)} />
                <Typography variant="caption">{block.lane === "right" ? "Right" : "Left"} · {block.index + 1}
                    {block.activeModelId !== null && " · Model " + block.activeModelId}</Typography>
            </Box>
        </AccordionSummary>
        <AccordionDetails>
        <Stack spacing={2}>
            {block.type === "insert" ? <Typography variant="body2" color="text.secondary">
                Add or replace blocks in TONE3000, then update this rig from Library.
            </Typography> : <>
                <Box className="t3k-field-grid" sx={blockGridStyle}>
                    <FormControlLabel label="Block enabled" control={<Switch checked={block.enabled}
                        onChange={(_event, enabled) => change({ enabled })} />} />
                    {block.type === "nam" && <>
                        <FormControlLabel label="Normalize" control={<Switch checked={block.normalize}
                            onChange={(_event, normalize) => change({ normalize })} />} />
                        <TextField select size="small" label="Requested NAM size" value={block.slimSize >= .5 ? 1 : 0}
                            onChange={event => change({ slimSize: Number(event.target.value) })}>
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
                            <Box className="t3k-field-grid" sx={fieldGridStyle}>
                                <FormControlLabel label="EQ enabled" control={<Switch checked={block.eq.enabled}
                                    onChange={(_event, enabled) => change({ eq: { ...block.eq, enabled } })} />} />
                                <FormControlLabel label="EQ before model" control={<Switch checked={block.eq.pre}
                                    onChange={(_event, pre) => change({ eq: { ...block.eq, pre } })} />} />
                            </Box>
                            {block.eq.bands.map((band, index) => <Box key={index} className="t3k-field-grid" sx={fieldGridStyle}>
                                <Typography variant="body2" sx={{ gridColumn: "1 / -1" }}>Band {index + 1}</Typography>
                                <TextField select size="small" label={"Band " + (index + 1) + " type"}
                                    value={band.type} onChange={event => changeBand(index, { type: event.target.value })}>
                                    {(index === 0 ? ["lowcut", "lowshelf"] : index === 5 ? ["highshelf", "highcut"] : ["bell"])
                                        .map(type => <MenuItem key={type} value={type}>{type}</MenuItem>)}
                                </TextField>
                                <NumberField label={"Band " + (index + 1) + " frequency (Hz)"} value={band.freqHz} min={20} max={20000}
                                    step={1} logarithmic onChange={freqHz => changeBand(index, { freqHz })} />
                                <NumberField label={"Band " + (index + 1) + " gain (dB)"} value={band.gainDb} min={-15} max={15}
                                    step={.1} onChange={gainDb => changeBand(index, { gainDb })} />
                                <NumberField label={"Band " + (index + 1) + " Q"} value={band.q} min={.1} max={10} logarithmic
                                    onChange={q => changeBand(index, { q })} />
                            </Box>)}
                        </Stack>
                    </AccordionDetails>
                </Accordion>
            </>}
        </Stack>
        </AccordionDetails>
    </Accordion>;
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
        <Typography variant="h6" component="h3">System settings · Global</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Read-only here. Audio and MIDI settings apply across all rigs on this Pi. Change them in PiPedal Settings.</Typography>
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
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-CONTROL-SCOPE] [7.18]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PLAIN-TOOLS] [7.25]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-VISIBLE-APPLY] [7.26]
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
    const [busyLabel, setBusyLabel] = useState("Applying changes");
    const [captureReady, setCaptureReady] = useState(false);
    const presets = useHostValue(model.presets);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [stale, setStale] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const [connected, setConnected] = useState(model.state.get() === State.Ready);
    const [recoveryNotice, setRecoveryNotice] = useState("");
    const blockCards = useRef(new Map<string, HTMLDivElement>());
    const actionBar = useRef<HTMLDivElement>(null);
    const lastFocused = useRef<Tone3000BlockFocus | null>(null);
    const [expandedBlock, setExpandedBlock] = useState<string | null>(null);
    useEffect(() => {
        if (!active || section !== "Blocks" || !focusedBlock || lastFocused.current === focusedBlock) return;
        if (expandedBlock !== focusedBlock.blockId) {
            setExpandedBlock(focusedBlock.blockId);
            return;
        }
        const card = blockCards.current.get(focusedBlock.blockId);
        if (card) {
            card.style.scrollMarginTop = ((actionBar.current?.offsetHeight ?? 0) + 8) + "px";
            card.scrollIntoView({ block: "start", inline: "nearest", behavior: "smooth" });
            card.focus({ preventScroll: true });
            lastFocused.current = focusedBlock;
        }
    }, [active, section, focusedBlock, draft, expandedBlock]);
    const alive = useRef(true);
    const working = useRef(false);
    const generation = useRef(0);
    const operationGeneration = useRef(0);
    const waitingRef = useRef(waiting);
    waitingRef.current = waiting;
    const rigDirty = useRef(false);
    const profileDirty = useRef(false);
    const rigRef = useRef(rig);
    rigRef.current = rig;
    const draftRef = useRef(draft); draftRef.current = draft;
    const followRef = useRef(follow); followRef.current = follow;
    const defaultsRef = useRef(defaults); defaultsRef.current = defaults;
    const profileDraftRef = useRef(profileDraft); profileDraftRef.current = profileDraft;
    const profileIdRef = useRef(profileId); profileIdRef.current = profileId;
    const staleRef = useRef(stale); staleRef.current = stale;
    const activeRef = useRef(active); activeRef.current = active;
    const captureReadyRef = useRef(false);
    const captureOwner = useRef<{ key: string; epoch: number } | null>(null);
    const registry = tone3000EditDrafts(model);
    const draftToken = useRef(Symbol("T3K panel draft"));
    const [pendingSections, setPendingSections] = useState<string[]>([]);
    const saveCancellation = useRef<(() => void) | null>(null);
    const operationLabel = useRef("");
    const rigRecovery = useRef(false);
    const ownerKey = useCallback(() => JSON.stringify([instanceId, model.banks.get().selectedBank,
        model.presets.get().selectedInstanceId, model.selectedSnapshot.get()]), [instanceId, model]);
    const ownership = useRef({ key: ownerKey(), epoch: 0 });
    const renderedOwner = { key: ownerKey(), epoch: ownership.current.epoch };
    const publishDraft = useCallback(() => registry.set(draftToken.current, ownerKey(), section,
        rigDirty.current || profileDirty.current), [registry, ownerKey, section]);
    /** Selection identity and an observed generation prevent A→B→A resurrection.
     * The generic Save transport retains its existing server receipt semantics.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOUR-REFINEMENTS] [7.29] */
    const ownerCurrent = useCallback((key: string, epoch: number) => alive.current && model.state.get() === State.Ready
        && ownership.current.key === key && ownerKey() === key && ownership.current.epoch === epoch
        && model.pedalboard.get().tryGetItem(instanceId)?.uri === "https://www.tone3000.com/plugin", [model, instanceId, ownerKey]);
    const invalidateCapture = useCallback(() => {
        ++ownership.current.epoch; ++generation.current; ++operationGeneration.current;
        captureReadyRef.current = false; captureOwner.current = null; setCaptureReady(false);
        saveCancellation.current?.();
        if (working.current) {
            rigRecovery.current = operationLabel.current === "Applying changes";
            setRecoveryNotice("The rig or connection changed. The operation may have completed; check the current preset before retrying.");
        }
        working.current = false; setBusy(false); setWaiting(false);
    }, []);

    const acceptRig = useCallback((value: Tone3000CurrentState) => {
        const matchesPendingDraft = rigDirty.current && !!draftRef.current
            && !tone3000RigDraftChanged(value, draftRef.current, followRef.current);
        rigRef.current = value; draftRef.current = value.summary; followRef.current = value.followDefaults;
        setRig(value); setDraft(value.summary); setFollow(value.followDefaults);
        rigDirty.current = false; setStale(false); setWaiting(false);
        if (matchesPendingDraft && rigRecovery.current) { setRecoveryNotice(""); rigRecovery.current = false; }
        staleRef.current = false; waitingRef.current = false;
        publishDraft();
    }, [publishDraft]);
    const acceptDefaults = useCallback((value: Tone3000DefaultsResult) => {
        defaultsRef.current = value; profileIdRef.current = value.activeProfile; profileDraftRef.current = value.defaults;
        setDefaults(value); setProfileId(value.activeProfile); setProfileDraft(value.defaults);
        profileDirty.current = false;
        publishDraft();
    }, [publishDraft]);
    useEffect(() => {
        const unsubscribe = registry.subscribe(() => setPendingSections(registry.sections(ownerKey())));
        publishDraft();
        return () => { unsubscribe(); registry.remove(draftToken.current); };
    }, [registry, ownerKey, publishDraft]);
    useEffect(() => {
        ++operationGeneration.current;
        working.current = false; setBusy(false);
        setRig(null); setDraft(null); setWaiting(false); setStale(false); setError(""); setNotice("");
        rigDirty.current = false;
    }, [instanceId]);
    const refresh = useCallback(async (reset = false) => {
        if (!alive.current || working.current || model.state.get() !== State.Ready) return;
        const request = ++generation.current;
        const key = ownerKey(), epoch = ownership.current.epoch;
        const current = () => request === generation.current && ownerCurrent(key, epoch);
        try {
            const value = await model.getTone3000CurrentState(instanceId);
            if (!current()) return;
            captureReadyRef.current = true; captureOwner.current = { key, epoch }; setCaptureReady(true);
            if (reset || !rigDirty.current || !tone3000RigDraftChanged(value, draftRef.current, followRef.current)) {
                if (waitingRef.current) setNotice("Changes applied to this rig. Use PiPedal Save to keep them.");
                acceptRig(value);
            }
            else { staleRef.current = value.revision !== rigRef.current?.revision; setStale(staleRef.current); }
            if (section === "Settings") {
                const [profiles, currentStatus] = await Promise.all([model.getTone3000Defaults(), model.getJackStatus()]);
                if (!current()) return;
                if (reset || !profileDirty.current) acceptDefaults(profiles);
                setStatus(currentStatus);
            }
            if (reset) setError("");
        } catch (failure) {
            if (current()) {
                captureReadyRef.current = false; captureOwner.current = null; setCaptureReady(false);
                if (String(failure).includes("Apply accepted;")) {
                    setWaiting(true);
                    setNotice("Changes accepted. Waiting for captured settings before Save; this is not an audio-readiness check.");
                } else setError(String(failure));
            }
        }
    }, [model, instanceId, section, acceptRig, acceptDefaults, ownerKey, ownerCurrent]);
    /** Same-owner replacements reconcile read-only; new selections discard old drafts.
     * Every invalidation occurs synchronously before stale callbacks can dispatch.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOUR-REFINEMENTS] [7.29] */
    useEffect(() => {
        const changed = () => {
            const next = ownerKey();
            if (next === ownership.current.key) {
                if (!model.presets.get().presetChanged) setNotice(message =>
                    message.startsWith("Changes applied") || message.startsWith("Changes accepted") ? "" : message);
                return;
            }
            invalidateCapture(); ownership.current.key = next;
            registry.remove(draftToken.current);
            rigRef.current = null; draftRef.current = null; rigDirty.current = false;
            setRig(null); setDraft(null); setStale(false); staleRef.current = false; setNotice(""); setError("");
            publishDraft();
            if (activeRef.current) void refresh();
        };
        model.banks.addOnChangedHandler(changed); model.presets.addOnChangedHandler(changed);
        model.selectedSnapshot.addOnChangedHandler(changed);
        let initial = true;
        const boardChanged = () => {
            if (initial) { initial = false; return; }
            if (ownerKey() !== ownership.current.key) { changed(); return; }
            invalidateCapture();
            if (activeRef.current) void refresh();
        };
        model.pedalboard.addOnChangedHandler(boardChanged);
        return () => {
            model.banks.removeOnChangedHandler(changed); model.presets.removeOnChangedHandler(changed);
            model.selectedSnapshot.removeOnChangedHandler(changed); model.pedalboard.removeOnChangedHandler(boardChanged);
        };
    }, [model, ownerKey, refresh, invalidateCapture, registry, publishDraft]);
    useEffect(() => {
        alive.current = true;
        /** Preserve local drafts, release interrupted work, and reconcile only reads.
         * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
         */
        const connectionChanged = (state: State) => {
            const ready = state === State.Ready;
            setConnected(ready);
            if (!ready) {
                invalidateCapture();
                if (working.current) setRecoveryNotice("Connection interrupted. The operation may have completed; verify captured settings and saved defaults before retrying.");
                working.current = false;
                setBusy(false); setWaiting(false);
            } else if (active) void refresh();
        };
        model.state.addOnChangedHandler(connectionChanged);
        const timer = active ? window.setInterval(() => { void refresh(); }, 5000) : undefined;
        return () => {
            alive.current = false; ++generation.current;
            model.state.removeOnChangedHandler(connectionChanged);
            window.clearInterval(timer);
        };
    }, [active, refresh, model, invalidateCapture]);
    useEffect(() => () => { ++operationGeneration.current; working.current = false; saveCancellation.current?.(); }, []);

    /** Interrupted generations cannot accept replies or release a newer action's guard.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
     */
    const run = async (action: (isCurrent: () => boolean) => Promise<string>, label = "Applying changes") => {
        if (working.current || !activeRef.current || !ownerCurrent(renderedOwner.key, renderedOwner.epoch)) return;
        const key = ownerKey(), epoch = ownership.current.epoch;
        if (!ownerCurrent(key, epoch)) return;
        working.current = true; ++generation.current;
        const request = ++operationGeneration.current;
        const isCurrent = () => request === operationGeneration.current && ownerCurrent(key, epoch);
        operationLabel.current = label;
        setBusyLabel(label); setBusy(true); setError(""); setNotice("");
        try {
            const message = await action(isCurrent);
            if (isCurrent()) setNotice(message);
        } catch (failure) {
            if (isCurrent()) setError(String(failure));
        } finally {
            if (request === operationGeneration.current) {
                working.current = false;
                if (alive.current) setBusy(false);
            }
        }
    };
    const edit = (patch: Partial<Tone3000Summary>, processing = false) => {
        if (working.current || !ownerCurrent(renderedOwner.key, renderedOwner.epoch) || !draftRef.current) return;
        const value = { ...draftRef.current, ...patch };
        const policy = processing ? false : followRef.current;
        draftRef.current = value; followRef.current = policy;
        rigDirty.current = tone3000RigDraftChanged(rigRef.current, value, policy);
        publishDraft();
        setDraft(value); setFollow(policy);
    };
    const changeFollow = (policy: boolean) => {
        if (working.current || !ownerCurrent(renderedOwner.key, renderedOwner.epoch)) return;
        followRef.current = policy; setFollow(policy);
        rigDirty.current = tone3000RigDraftChanged(rigRef.current, draftRef.current, policy);
        publishDraft();
    };
    const chooseProfile = (id: string, value: Tone3000Defaults) => {
        if (working.current || !ownerCurrent(renderedOwner.key, renderedOwner.epoch)) return;
        profileIdRef.current = id; profileDraftRef.current = value;
        profileDirty.current = tone3000ProfileDraftChanged(defaultsRef.current, id, value);
        publishDraft();
        setProfileId(id); setProfileDraft(value);
    };
    const changeProfile = (patch: Partial<Tone3000Defaults>) => {
        if (profileDraftRef.current) chooseProfile(profileIdRef.current, { ...profileDraftRef.current, ...patch });
    };
    const derivedStage = model.pedalboard.get().tryGetItem(instanceId)?.tone3000DerivedSource?.stage;
    const apply = (onlyDefaults = false) => run(async isCurrent => {
        if (derivedStage && (onlyDefaults || followRef.current)) throw new Error("Split stages keep saved processing settings. Device defaults could change their handoff.");
        const baseline = rigRef.current, desired = draftRef.current;
        if (!baseline || !desired) throw new Error("Refresh the current rig first.");
        if (staleRef.current || waitingRef.current || !captureReadyRef.current) throw new Error("Refresh the current rig before applying changes.");
        const patch: Tone3000StatePatch = {};
        if (!onlyDefaults && section === "Blocks") patch.blocks = tone3000BlockChanges(baseline.summary.blocks, desired.blocks);
        if (!onlyDefaults && section === "Settings") {
            for (const field of ["inputMode", "calibrateInput", "inputCalibrationLevel", "osEnabled", "osFactor"] as const)
                if (baseline.summary[field] !== desired[field]) Object.assign(patch, { [field]: desired[field] });
        }
        await model.setTone3000CurrentState(instanceId, baseline.revision, patch,
            section === "Settings" ? { followDefaults: onlyDefaults || followRef.current, applyDefaults: onlyDefaults || followRef.current } : {});
        if (!isCurrent()) return "";
        rigDirty.current = false;
        waitingRef.current = true; setWaiting(true);
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
        if (!defaultsRef.current || !profileDraftRef.current) throw new Error("Refresh the processing profiles first.");
        const value = await model.setTone3000Defaults(defaultsRef.current.revision, profileIdRef.current, profileDraftRef.current);
        if (isCurrent()) acceptDefaults(value);
        return "Device defaults saved. Playing audio is unchanged; apply them to this rig when ready.";
    }, "Saving device defaults");
    /** Existing Save is a notification, so observe its authoritative clean event
     * before dispatch and never invent a successful acknowledgement or replay it.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOUR-REFINEMENTS] [7.29] */
    const savePreset = () => run(async isCurrent => {
        if (registry.sections(ownerKey()).length || rigDirty.current || profileDirty.current || staleRef.current || waitingRef.current || !captureReadyRef.current)
            throw new Error("Apply or restore your drafts, then refresh before saving the preset.");
        const value = await model.getTone3000CurrentState(instanceId);
        if (!isCurrent()) return "";
        if (registry.sections(ownerKey()).length || rigDirty.current || profileDirty.current || staleRef.current || waitingRef.current) return "";
        acceptRig(value);
        if (!model.presets.get().presetChanged) return "The current PiPedal preset is saved.";
        await new Promise<void>((resolve, reject) => {
            let dispatched = false, timer: ReturnType<typeof window.setTimeout> | undefined;
            const finish = (error?: Error) => {
                model.presets.removeOnChangedHandler(changed);
                if (timer !== undefined) window.clearTimeout(timer);
                if (saveCancellation.current === cancel) saveCancellation.current = null;
                error ? reject(error) : resolve();
            };
            const cancel = () => finish(new Error("The rig or connection changed; preset Save is not confirmed."));
            const changed = () => {
                if (!isCurrent()) cancel();
                else if (dispatched && !model.presets.get().presetChanged) finish();
            };
            saveCancellation.current = cancel;
            model.presets.addOnChangedHandler(changed);
            if (!isCurrent()) { cancel(); return; }
            timer = window.setTimeout(() => finish(new Error("Preset Save has not been confirmed. Check the preset before retrying.")), 10000);
            dispatched = true;
            try { model.saveCurrentPreset(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        });
        return "The whole current PiPedal preset is saved.";
    }, "Saving preset");
    const validCalibration = (value: number) => Number.isFinite(value) && value >= -60 && value <= 60;
    const capturedHere = captureReady && !!captureOwner.current && ownerCurrent(captureOwner.current.key, captureOwner.current.epoch);

    return <DraftTouchContext.Provider value={{ enabled: active && connected && !busy && !waiting && !stale,
        scopeKey: JSON.stringify([instanceId, section, rig?.revision, profileId, defaults?.revision]) }}>
        <Stack className="t3k-rig-panel t3k-controls" spacing={1.5} sx={{ px: 1, minWidth: 0, maxWidth: 1100,
        "& .MuiButton-root": { whiteSpace: "normal", minHeight: 44 },
        "& .MuiFormControl-root": { maxWidth: "100%", minWidth: 0 } }}>
        {rig && draft && <Box ref={actionBar} role="region" aria-label={section === "Blocks" ? "Apply block changes" : "Apply rig settings"}
            sx={{ position: "sticky", top: 0, zIndex: 2, bgcolor: "background.paper",
                borderBottom: 1, borderColor: "divider", p: 1, minWidth: 0 }}>
            <Stack spacing={.5}>
                <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1 }}>
                <Button variant="contained" aria-label={section === "Blocks" ? "Apply block changes" : "Apply rig settings"} sx={{ alignSelf: "flex-start" }}
                    disabled={busy || waiting || !connected || stale || !capturedHere || !rigDirty.current
                        || (section === "Blocks" ? !tone3000ValidBlocks(draft.blocks) : !validCalibration(draft.inputCalibrationLevel))}
                    onClick={() => { void apply(); }}>Apply</Button>
                <Button variant="outlined" aria-label="Save preset" disabled={busy || waiting || !connected || stale || !capturedHere
                    || pendingSections.length > 0 || rigDirty.current || profileDirty.current || !presets.presetChanged}
                    onClick={() => { void savePreset(); }}>Save</Button>
                </Stack>
                <Typography role="status" variant="body2" color="text.secondary">
                    {!connected ? "Reconnect to the Pi before applying changes."
                        : busy ? busyLabel + "…"
                        : waiting ? "Checking your changes. Wait before saving."
                        : stale ? "This rig changed elsewhere. Refresh before applying."
                        : rigDirty.current ? "Unapplied edits. Tap Apply, or restore the starting values."
                        : profileDirty.current ? "Device defaults have unapplied edits. Save or restore those defaults separately."
                        : pendingSections.length ? "Unapplied edits in " + pendingSections.join(" and ") + ". Apply or restore them before Save preset."
                        : !capturedHere ? "Checking the current rig before Save."
                        : presets.presetChanged ? "Applied or changed, not saved. Save preset keeps the whole PiPedal preset."
                        : "Saved. The whole current PiPedal preset is saved."}
                </Typography>
            </Stack>
        </Box>}
        <Box className="t3k-field-row" sx={rowStyle}>
            <Typography component="h2" variant="h6">{section === "Blocks" ? "Rig blocks" : "TONE3000 settings"}</Typography>
            <Button disabled={busy || !connected} onClick={() => { void refresh(true); }}>Refresh</Button>
        </Box>
        {error && <Alert severity="error">{error}</Alert>}
        {recoveryNotice && <Alert severity="warning" onClose={() => setRecoveryNotice("")}>{recoveryNotice}</Alert>}
        {notice && <Alert severity="success">{notice}</Alert>}
        {stale && <Alert severity="warning">The rig changed elsewhere. Refresh to discard this draft and get its latest settings.</Alert>}
        {!rig || !draft ? <Typography>Reading current TONE3000 state…</Typography> : <>
            <Typography variant="body2">{rig.summary.activePresetName || "Unsaved TONE3000 rig"}
                {rig.summary.stereoEnabled ? " · Stereo chain" : " · Single chain"}</Typography>
            {rig.hasSnapshotOverrides && <Alert severity="info">Snapshots retain their saved tone versions. These edits do not replace other snapshots.</Alert>}
            <Typography variant="body2" color="text.secondary">
                Apply may briefly reload this TONE3000 instance. Library Update replaces local tone/block tweaks from your T3K source.
            </Typography>
            <Box component="fieldset" disabled={busy || waiting || !connected} sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
                {section === "Blocks" ? <Stack spacing={2}>
                    {draft.blocks.filter(block => block.type !== "insert").map(block => <Box key={block.blockId}
                        ref={(card: HTMLDivElement | null) => { if (card) blockCards.current.set(block.blockId, card); else blockCards.current.delete(block.blockId); }}
                        tabIndex={-1} aria-label={"Settings for " + (block.title || "block")}
                        sx={{ minWidth: 0, outline: "none" }}>
                        <BlockCard block={block} expanded={expandedBlock === block.blockId}
                            onToggle={open => setExpandedBlock(open ? block.blockId : null)}
                            onChange={updated => edit({ blocks: draft.blocks.map(before => before.blockId === updated.blockId ? updated : before) })} />
                    </Box>)}
                    {draft.blocks.some(block => block.type === "insert") && <Typography variant="caption" color="text.secondary">
                        Empty slots are omitted. Add, replace or reorder blocks in TONE3000, then use Library Update.
                    </Typography>}
                    {!draft.blocks.length && <Typography>No blocks loaded. Author a rig in TONE3000 and add it through Library.</Typography>}
                </Stack> : <Stack spacing={3}>
                    <SystemSettings status={status} />
                    <Paper component="section" variant="outlined" sx={{ p: 2 }}>
                        <Stack spacing={2}>
                            <Typography component="h3" variant="h6">Plugin settings · Current rig{derivedStage ? " · " + derivedStage + " stage" : ""}</Typography>
                            {derivedStage && <Typography variant="body2">This experimental split stage keeps its saved settings. Shared defaults do not change its processing handoff; manual edits still need testing.</Typography>}
                            <Typography variant="body2" color="text.secondary">These captured settings belong to this TONE3000 instance in the current rig. Apply changes, then use PiPedal Save to keep them.</Typography>
                            <TextField select size="small" label="Processing policy" disabled={!!derivedStage} value={derivedStage ? "saved" : follow ? "follow" : "saved"}
                                onChange={event => changeFollow(event.target.value === "follow")}>
                                <MenuItem value="follow">Follow device defaults</MenuItem>
                                <MenuItem value="saved">Keep saved settings</MenuItem>
                            </TextField>
                            <ProcessingFields value={draft} onChange={patch => edit(patch, true)} />
                            <Typography component="h4" variant="subtitle2">Input routing · This rig</Typography>
                            <Typography variant="body2" color="text.secondary">Choose which signal TONE3000 receives from the PiPedal blocks before it. Choose the physical interface inputs in PiPedal Audio settings.</Typography>
                            <TextField select size="small" label="TONE3000 input"
                                helperText={draft.inputMode === "left" ? "Use the left input signal on both sides."
                                    : draft.inputMode === "right" ? "Use the right input signal on both sides."
                                    : draft.inputMode === "dual" ? draft.stereoEnabled
                                        ? "With two chains, this works like Stereo: left input to the left chain, right input to the right."
                                        : "Run this chain separately for left and right inputs. Needs stereo input and output; otherwise works like Stereo SUM. Uses more processing power."
                                    : draft.stereoEnabled ? "Send the left input to the left chain and the right input to the right chain."
                                    : "Combine the left and right inputs into one signal for this chain."} value={draft.inputMode} sx={{ width: "100%", minWidth: 0 }}
                                onChange={event => edit({ inputMode: event.target.value })}>
                                {["stereo", "left", "right", "dual"].map(mode => <MenuItem key={mode} value={mode}>
                                    {mode === "stereo" ? draft.stereoEnabled ? "Stereo" : "Stereo SUM (L+R)"
                                        : mode === "dual" ? "Stereo Dual Mono (L&R)" : mode === "left" ? "Left" : "Right"}
                                </MenuItem>)}
                            </TextField>
                            <Box className="t3k-field-row" sx={rowStyle}>
                                <Button variant="outlined" disabled={!!derivedStage || busy || stale || rigDirty.current}
                                    onClick={() => { void apply(true); }}>Apply device defaults to this rig</Button>
                            </Box>
                            <Typography variant="caption" color="text.secondary">Follow applies calibration/oversampling on saved-rig recall.
                                Editing either selects Keep saved settings. Input routing and block sizes are saved per rig. Rigs with a shared branch must use Left or Right input.</Typography>
                        </Stack>
                    </Paper>
                    {defaults && profileDraft && <Paper component="section" variant="outlined" sx={{ p: 2 }}>
                        <Stack spacing={2}>
                            <Typography component="h3" variant="h6">Plugin defaults · Global</Typography>
                            <Typography variant="body2" color="text.secondary">Shared PiPedal defaults for this device. Saving stages them for later load/apply; it does not change the playing rig or the standalone T3K app.
                                Multi-core and default NAM size take effect in newly reloaded instances; saved block sizes remain unchanged.</Typography>
                            <TextField select size="small" label="Processing profile" value={profileId}
                                onChange={event => {
                                    const profile = defaults.profiles.find(candidate => candidate.id === event.target.value);
                                    if (profile) chooseProfile(profile.id, profile.defaults);
                                }}>
                                {defaults.profiles.map(profile => <MenuItem key={profile.id} value={profile.id}>{profile.name}
                                    {profile.id === defaults.activeProfile ? " · Active defaults" : ""}</MenuItem>)}
                            </TextField>
                            <ProcessingFields value={profileDraft} onChange={changeProfile} />
                            <Box className="t3k-field-grid" sx={fieldGridStyle}>
                                <FormControlLabel label="Multi-core processing" control={<Switch checked={profileDraft.multiCore}
                                    onChange={(_event, multiCore) => changeProfile({ multiCore })} />} />
                                <TextField select size="small" label="Default size for new NAM blocks" value={profileDraft.namSlimSizeDefault}
                                    onChange={event => changeProfile({ namSlimSizeDefault: Number(event.target.value) })}>
                                    <MenuItem value={0}>A2-Lite</MenuItem><MenuItem value={1}>A2-Full</MenuItem>
                                </TextField>
                            </Box>
                            <Typography variant="caption" color="text.secondary">{{ "service-profile": "Saved PiPedal processing profiles", "app-seed": "Initial values from this Pi’s T3K app", "service-seed": "Initial values from plugin service preferences", "pinned-defaults": "Initial values from T3K defaults" }[defaults.sourceStatus] || defaults.sourceStatus}</Typography>
                            {defaults.warnings.map((warning, index) => <Alert key={index} severity="warning">{warning}</Alert>)}
                            <Box className="t3k-field-row" sx={rowStyle}>
                                <Button variant="contained" disabled={busy || !profileDirty.current || !validCalibration(profileDraft.inputCalibrationLevel)}
                                    onClick={() => { void saveDefaults(); }}>Save defaults</Button>
                                <Button disabled={busy || !defaults.appDefaults} onClick={() => {
                                    if (defaults.appDefaults) chooseProfile(profileIdRef.current, defaults.appDefaults);
                                }}>Use T3K app defaults</Button>
                            </Box>
                        </Stack>
                    </Paper>}
                </Stack>}
            </Box>
        </>}
    </Stack></DraftTouchContext.Provider>;
}
