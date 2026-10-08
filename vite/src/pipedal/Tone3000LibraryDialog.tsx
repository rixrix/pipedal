// Copyright (c) 2026 Thomas Rapolani
// SPDX-License-Identifier: MIT

import "./Tone3000Actions.css";
import { useCallback, useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DialogEx from "./DialogEx";
import Tone3000PresetPreviewDialog from "./Tone3000PresetPreviewDialog";
import Tone3000PerformanceDialog from "./Tone3000PerformanceDialog";
import Tone3000BundleDialog from "./Tone3000BundleDialog";
import Tone3000MixMatchDialog from "./Tone3000MixMatchDialog";
import { PiPedalModelFactory, State } from "./PiPedalModel";
import { tone3000BankLocation, tone3000FilterLibrary, tone3000SavedCopies } from "./Tone3000Library";
import type { Tone3000Import, Tone3000LibraryEntry, Tone3000LibraryResult, Tone3000PreviewSelection, Tone3000LibraryFilter } from "./Tone3000Library";

/** Discover and explicitly apply complete rigs without operator file copying.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [3.10]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-CONTROL-SCOPE] [7.18]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-STABILITY-REVIEW] [7.22]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-11] [DES-PLAIN-TOOLS] [7.25]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-11] [DES-FOUR-REFINEMENTS] [7.30]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-26] [DES-PITCH-LV2] [7.36]
 */
export default function Tone3000LibraryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const model = PiPedalModelFactory.getInstance();
    const [library, setLibrary] = useState<Tone3000LibraryResult>({ entries: [], warnings: [] });
    const [busy, setBusy] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<Tone3000LibraryFilter>("all");
    const [banks, setBanks] = useState(model.banks.get());
    const [preview, setPreview] = useState<Tone3000PreviewSelection | null>(null);
    const [mixMatch, setMixMatch] = useState<{ entry: Tone3000LibraryEntry; target: Tone3000Import } | null>(null);
    const [performanceOpen, setPerformanceOpen] = useState(false);
    const [bundleOpen, setBundleOpen] = useState(false);
    const [pendingLoad, setPendingLoad] = useState<Tone3000Import | null>(null);
    const [connected, setConnected] = useState(model.state.get() === State.Ready);
    const [recoveryNotice, setRecoveryNotice] = useState("");
    const uploadInput = useRef<HTMLInputElement>(null);
    const alive = useRef(false);
    const working = useRef(false);
    const generation = useRef(0);

    useEffect(() => {
        if (!open) return;
        model.banks.addOnChangedHandler(setBanks);
        return () => model.banks.removeOnChangedHandler(setBanks);
    }, [open, model]);

    const refresh = useCallback(async (clearError = false) => {
        if (working.current || !alive.current || model.state.get() !== State.Ready) return;
        const request = ++generation.current;
        setRefreshing(true);
        try {
            const result = await model.getTone3000Library();
            if (alive.current && request === generation.current) {
                setLibrary(result);
                if (clearError) setError("");
            }
        } catch (failure) {
            if (alive.current && request === generation.current) setError(String(failure));
        } finally {
            if (alive.current && request === generation.current) setRefreshing(false);
        }
    }, [model]);

    useEffect(() => {
        alive.current = open;
        setBusy(false); setRefreshing(false); setPreview(null); setPerformanceOpen(false); setBundleOpen(false); setMixMatch(null);
        if (!open) return;
        /** Invalidate old work; reconciliation is read-only and never replays it.
         * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
         */
        const connectionChanged = (state: State) => {
            const ready = state === State.Ready;
            setConnected(ready);
            if (!ready) {
                ++generation.current;
                if (working.current) setRecoveryNotice("Connection interrupted. The operation may have completed; verify the refreshed library before retrying.");
                working.current = false;
                setBusy(false); setRefreshing(false); setPendingLoad(null); setPreview(null);
            } else void refresh();
        };
        // ObservableProperty immediately calls new listeners with current state.
        model.state.addOnChangedHandler(connectionChanged);
        const poll = window.setInterval(() => { void refresh(); }, 15000);
        return () => {
            if (working.current) {
                const message = "The operation may have completed. Inspect the refreshed library before retrying.";
                setRecoveryNotice(message);
                model.showAlert(message); // Retain uncertainty even if the parent unmounts this dialog.
            }
            alive.current = false;
            ++generation.current;
            working.current = false;
            model.state.removeOnChangedHandler(connectionChanged);
            window.clearInterval(poll);
        };
    }, [open, refresh, model]);

    /** Results belong to one connected operation generation, including upload batches.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
     */
    const run = async (action: (isCurrent: () => boolean) => Promise<string>) => {
        if (working.current || !alive.current || model.state.get() !== State.Ready) return;
        working.current = true;
        const request = ++generation.current;
        const isCurrent = () => alive.current && request === generation.current && model.state.get() === State.Ready;
        setRefreshing(false);
        setBusy(true);
        setError("");
        setNotice("");
        try {
            const message = await action(isCurrent);
            if (isCurrent()) setNotice(message);
        } catch (failure) {
            if (isCurrent()) setError(String(failure));
        } finally {
            if (isCurrent()) {
                working.current = false;
                setBusy(false);
                // Preserve a mutation failure while refreshing stale source metadata.
                const request = ++generation.current;
                try {
                    const result = await model.getTone3000Library();
                    if (alive.current && request === generation.current) setLibrary(result);
                } catch (failure) {
                    if (alive.current && request === generation.current) setError(String(failure));
                }
            }
        }
    };

    const add = (entry: Tone3000LibraryEntry, asNew = false) => run(async () => {
        await model.importTone3000Preset(entry, undefined, asNew);
        return entry.name + " saved in PiPedal. Select Load to play it.";
    });
    const update = (entry: Tone3000LibraryEntry, target: Tone3000Import) => run(async () => {
        await model.importTone3000Preset(entry, target);
        return target.active ? target.name + " updated and loaded." : target.name + " updated. Select Load to play it.";
    });
    const load = (target: Tone3000Import) => {
        if (model.presets.get().presetChanged) {
            setPendingLoad(target);
            return;
        }
        void performLoad(target);
    };
    const performLoad = (target: Tone3000Import) => run(async () => {
        await model.loadTone3000Preset(target.bankId, target.presetId);
        return target.name + " loaded.";
    });
    const upload = (files: File[]) => run(async isCurrent => {
        let count = 0;
        for (const file of files) {
            if (!isCurrent()) return "";
            await model.uploadTone3000Preset(file);
            ++count;
            if (isCurrent()) setNotice(count + " of " + files.length + " uploaded.");
        }
        return count + (count === 1 ? " rig uploaded. Select Add to save it in PiPedal." : " rigs uploaded. Select Add to save them in PiPedal.");
    });
    const entries = tone3000FilterLibrary(library.entries, filter, search, banks);
    const savedCopies = tone3000SavedCopies(library.entries, search, banks);

    return <>
        <DialogEx className="t3k-controls" tag="tone3000Library" open={open} fullWidth maxWidth="md"
            sx={{ "& .MuiDialog-paper": { m: { xs: 0, sm: 4 }, width: { xs: "100%", sm: "calc(100% - 64px)" },
                maxWidth: { xs: "100%", sm: 900 }, height: { xs: "100%", sm: "auto" },
                maxHeight: { xs: "100%", sm: "calc(100% - 64px)" }, borderRadius: { xs: 0, sm: 1 } },
                "& .MuiButton-root": { minHeight: 44, whiteSpace: "normal" } }}
            onClose={() => { if (!working.current) onClose(); }}>
            <DialogTitle sx={{ px: { xs: 1.5, sm: 3 } }}>TONE3000 Library</DialogTitle>
            <DialogContent dividers sx={{ p: { xs: 1.5, sm: 3 } }} onDragOver={event => { event.preventDefault(); }}
                onDrop={event => {
                    event.preventDefault();
                    if (!working.current && event.dataTransfer.files.length) void upload(Array.from(event.dataTransfer.files));
                }}>
                <Stack spacing={2}>
                    <Typography variant="body2" color="text.secondary">
                        T3K presets on this Pi appear automatically. Saved shows your PiPedal rigs.
                    </Typography>
                    <Stack direction="row" sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}>
                        <Button variant="outlined" disabled={busy || refreshing || !connected} onClick={() => { void refresh(true); }}>Refresh</Button>
                        <Button variant="outlined" aria-label="Upload presets" disabled={busy || refreshing || !connected} onClick={() => uploadInput.current?.click()}>Upload</Button>
                        <Button variant="outlined" disabled={busy || refreshing || !connected}
                            onClick={() => { setFilter("saved"); setSearch(""); }}>Mix &amp; Match</Button>
                        {(busy || refreshing) && <CircularProgress size={20} aria-label={busy ? "Applying rig" : "Finding rigs"} />}
                        <input ref={uploadInput} type="file" accept=".t3kpreset" multiple hidden
                            aria-label="Choose TONE3000 preset files" onChange={event => {
                                const files = Array.from(event.currentTarget.files ?? []);
                                event.currentTarget.value = "";
                                if (files.length) void upload(files);
                            }} />
                    </Stack>
                    {error && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}
                    {recoveryNotice && <Alert severity="warning" onClose={() => setRecoveryNotice("")}>{recoveryNotice}</Alert>}
                    {notice && <Alert severity="success" onClose={() => setNotice("")}>{notice}</Alert>}
                    {library.warnings.map((warning, index) => <Alert severity="warning" key={index}>{warning}</Alert>)}
                    <TextField label="Find a rig or bank" value={search} onChange={event => setSearch(event.target.value)} size="small" fullWidth />
                    <Box className="t3k-library-filters" role="group" aria-label="Filter TONE3000 Library">
                        {([['all', 'All'], ['saved', 'Saved'], ['new', 'New'], ['updates', 'Updates']] as const).map(([value, label]) =>
                            <Button key={value} variant={filter === value ? "contained" : "outlined"} aria-pressed={filter === value}
                                onClick={() => setFilter(value)}>{label}</Button>)}
                    </Box>
                    {filter === "saved" && <Typography variant="body2" color="text.secondary">
                        Mix &amp; Match makes a separate experimental copy of a saved rig.
                    </Typography>}
                    {filter !== "saved" && <Typography variant="body2" color="text.secondary">
                        Status refers to each T3K source file. Exporting creates another file; it does not remove your saved PiPedal rig.
                    </Typography>}
                    {!(filter === "saved" ? savedCopies.length : entries.length) && !refreshing && <Typography color="text.secondary">
                        {library.entries.length ? "No matching rigs." : "No rigs found. Save a preset in TONE3000 or upload a .t3kpreset file."}
                    </Typography>}
                    {filter === "saved" && savedCopies.map(({ entry, target }) => <Paper variant="outlined"
                        key={entry.key + "/" + target.bankId + "/" + target.presetId + "/" + target.instanceId} sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
                        <Stack spacing={1}>
                            <Typography variant="subtitle1" sx={{ overflowWrap: "anywhere" }}>{target.name}</Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>Bank: {tone3000BankLocation(target.bankId, banks)}{target.active ? " · Current rig" : ""}</Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>T3K source: {entry.name}</Typography>
                            {target.sha256 !== entry.sha256 && <Typography variant="caption" color="warning.main">Source changed. Update replaces this saved copy.</Typography>}
                            <Stack direction="row" sx={{ flexWrap: "wrap", gap: .5 }}>
                                <Button variant="outlined" disabled={busy || refreshing || !connected} onClick={() => setMixMatch({ entry, target })}>Mix &amp; Match</Button>
                                <Button variant="outlined" disabled={busy || refreshing || !connected} onClick={() => load(target)}>Load</Button>
                                <Button aria-label="Compare with source" disabled={busy || refreshing || !connected} onClick={() => setPreview({ entry, target, action: "preview" })}>Compare</Button>
                                {target.sha256 !== entry.sha256 && <Button disabled={busy || refreshing || !connected}
                                    onClick={() => setPreview({ entry, target, action: "update" })}>{target.active ? "Update & load" : "Update"}</Button>}
                            </Stack>
                            {target.hasSnapshotOverrides && <Typography variant="caption" color="text.secondary">Snapshots keep their saved tone versions when this rig is updated.</Typography>}
                        </Stack>
                    </Paper>)}
                    {filter !== "saved" && entries.map(entry => <Paper variant="outlined" key={entry.key} sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
                        <Stack spacing={1}>
                            <Box sx={{ minWidth: 0 }}>
                                <Typography variant="subtitle1" sx={{ overflowWrap: "anywhere" }}>{entry.name}</Typography>
                                <Typography variant="caption" component="p" color="text.secondary">TONE3000 source · {entry.source}</Typography>
                            </Box>
                            <Chip size="small" sx={{ alignSelf: "flex-start", maxWidth: "100%", height: "auto", py: .5,
                                "& .MuiChip-label": { whiteSpace: "normal" } }}
                                label={!entry.imports.length ? "Available to add" : entry.imports.some(target => target.sha256 !== entry.sha256) ? "Update available" : "Saved in PiPedal"}
                                color={entry.imports.some(target => target.sha256 !== entry.sha256) ? "warning" : "default"} />
                            <Stack direction="row" sx={{ flexWrap: "wrap", gap: .5 }}>
                                <Button aria-label="Preview source" disabled={busy || refreshing || !connected} onClick={() => setPreview({ entry, action: "preview" })}>Preview</Button>
                                <Button aria-label={entry.imports.length ? "Add another copy" : "Add to PiPedal"} disabled={busy || refreshing || !connected} onClick={() => setPreview({ entry, action: entry.imports.length ? "addNew" : "add" })}>
                                    {entry.imports.length ? "Add copy" : "Add"}
                                </Button>
                            </Stack>
                            {entry.imports.length > 0 && <Typography variant="subtitle2">Saved PiPedal {entry.imports.length === 1 ? "copy" : "copies"}</Typography>}
                            {entry.imports.map(target => <Box key={target.bankId + "/" + target.presetId + "/" + target.instanceId}
                                sx={{ borderTop: 1, borderColor: "divider", pt: 1 }}>
                                <Stack spacing={.5}>
                                    <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{target.name}{target.active ? " · Current rig" : ""}</Typography>
                                    <Typography variant="caption" component="p" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>Bank: {tone3000BankLocation(target.bankId, banks)}</Typography>
                                    {target.sha256 !== entry.sha256 && <Typography variant="caption" color="warning.main">Source changed. Update replaces this saved copy.</Typography>}
                                    <Stack direction="row" sx={{ flexWrap: "wrap", gap: .5 }}>
                                        <Button aria-label="Compare with source" disabled={busy || refreshing || !connected} onClick={() => setPreview({ entry, target, action: "preview" })}>Compare</Button>
                                        {target.sha256 !== entry.sha256 && <Button disabled={busy || refreshing || !connected}
                                            onClick={() => setPreview({ entry, target, action: "update" })}>{target.active ? "Update & load" : "Update"}</Button>}
                                        <Button disabled={busy || refreshing || !connected} onClick={() => setMixMatch({ entry, target })}>Mix &amp; match</Button>
                                        <Button variant="outlined" disabled={busy || refreshing || !connected} onClick={() => load(target)}>Load</Button>
                                    </Stack>
                                </Stack>
                                {target.hasSnapshotOverrides && <Typography variant="caption" color="text.secondary">
                                    Snapshots keep their saved tone versions when this rig is updated.
                                </Typography>}
                            </Box>)}
                        </Stack>
                    </Paper>)}
                </Stack>
            </DialogContent>
            <DialogActions sx={{ px: { xs: 1.5, sm: 3 }, alignItems: "flex-start", gap: 1 }}>
                <Box component="details" sx={{ flex: 1, minWidth: 0 }}>
                    <Box component="summary" sx={{ minHeight: 44, cursor: "pointer", py: 1, boxSizing: "border-box" }}>More tools</Box>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        Add saves a new copy; Load plays it; Update replaces it from T3K.
                        Upload complete .t3kpreset rigs. For separate NAM models or IRs, add them in TONE3000 and save a preset first.
                    </Typography>
                    <Stack direction="row" sx={{ flexWrap: "wrap", gap: .5 }}>
                        <Button disabled={busy || !connected} onClick={() => setBundleOpen(true)}>Check rig bundle</Button>
                        <Button disabled={busy || !connected} onClick={() => setPerformanceOpen(true)}>Four-switch setup</Button>
                    </Stack>
                </Box>
                <Button disabled={busy} onClick={() => { if (!working.current) onClose(); }}>Close</Button>
            </DialogActions>
        </DialogEx>
        <Tone3000MixMatchDialog selection={open ? mixMatch : null} onClose={() => setMixMatch(null)} />
        <Tone3000PerformanceDialog open={open && performanceOpen} onClose={() => setPerformanceOpen(false)} />
        <Tone3000BundleDialog open={open && bundleOpen} onClose={() => setBundleOpen(false)} />
        <Tone3000PresetPreviewDialog selection={open ? preview : null} onClose={() => setPreview(null)} onConfirm={selection => {
            setPreview(null);
            if (selection.action === "update" && selection.target) void update(selection.entry, selection.target);
            else if (selection.action === "add" || selection.action === "addNew") void add(selection.entry, selection.action === "addNew");
        }} />
        <DialogEx className="t3k-controls" tag="tone3000LibraryUnsaved" open={pendingLoad !== null} onClose={() => setPendingLoad(null)}>
            <DialogTitle>Load this rig?</DialogTitle>
            <DialogContent><DialogContentText>Your current rig has unsaved changes. Loading replaces those changes.</DialogContentText></DialogContent>
            <DialogActions>
                <Button onClick={() => setPendingLoad(null)}>Cancel</Button>
                <Button onClick={() => {
                    const target = pendingLoad;
                    setPendingLoad(null);
                    if (target) void performLoad(target);
                }}>Discard changes and load</Button>
            </DialogActions>
        </DialogEx>
    </>;
}
