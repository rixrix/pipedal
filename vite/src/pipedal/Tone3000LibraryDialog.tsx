// Copyright (c) 2026 Thomas Rapolani
// SPDX-License-Identifier: MIT

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
import { PiPedalModelFactory } from "./PiPedalModel";
import type { Tone3000Import, Tone3000LibraryEntry, Tone3000LibraryResult } from "./Tone3000Library";

/** Discover and explicitly apply complete rigs without operator file copying.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [3.10]
 */
export default function Tone3000LibraryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const model = PiPedalModelFactory.getInstance();
    const [library, setLibrary] = useState<Tone3000LibraryResult>({ entries: [], warnings: [] });
    const [busy, setBusy] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [search, setSearch] = useState("");
    const [pendingLoad, setPendingLoad] = useState<Tone3000Import | null>(null);
    const uploadInput = useRef<HTMLInputElement>(null);
    const alive = useRef(false);
    const working = useRef(false);
    const generation = useRef(0);

    const refresh = useCallback(async (clearError = false) => {
        if (working.current || !alive.current) return;
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
        if (!open) return;
        void refresh(true);
        const poll = window.setInterval(() => { void refresh(); }, 15000);
        return () => {
            alive.current = false;
            ++generation.current;
            window.clearInterval(poll);
        };
    }, [open, refresh]);

    const run = async (action: () => Promise<string>) => {
        if (working.current) return;
        working.current = true;
        ++generation.current;
        setRefreshing(false);
        setBusy(true);
        setError("");
        setNotice("");
        try {
            const message = await action();
            if (alive.current) setNotice(message);
        } catch (failure) {
            if (alive.current) setError(String(failure));
        } finally {
            working.current = false;
            if (alive.current) {
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
        return entry.name + " added to TONE3000 Library. Select Load to play it.";
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
    const upload = (files: File[]) => run(async () => {
        let count = 0;
        for (const file of files) {
            await model.uploadTone3000Preset(file);
            ++count;
            if (alive.current) setNotice(count + " of " + files.length + " uploaded.");
        }
        return count + (count === 1 ? " rig uploaded. Select Add to save it in PiPedal." : " rigs uploaded. Select Add to save them in PiPedal.");
    });
    const entries = library.entries.filter(entry =>
        (entry.name + " " + entry.source).toLocaleLowerCase().includes(search.toLocaleLowerCase()));

    return <>
        <DialogEx tag="tone3000Library" open={open} fullWidth maxWidth="md"
            onClose={() => { if (!working.current) onClose(); }}>
            <DialogTitle>TONE3000 Library</DialogTitle>
            <DialogContent dividers onDragOver={event => { event.preventDefault(); }}
                onDrop={event => {
                    event.preventDefault();
                    if (!working.current && event.dataTransfer.files.length) void upload(Array.from(event.dataTransfer.files));
                }}>
                <Stack spacing={2}>
                    <Typography variant="body2" color="text.secondary">
                        Rigs saved in the Pi's TONE3000 app appear here automatically. Add saves a PiPedal rig; Load plays it.
                    </Typography>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}>
                        <Button variant="outlined" disabled={busy || refreshing} onClick={() => { void refresh(true); }}>Refresh</Button>
                        <Button variant="contained" disabled={busy || refreshing} onClick={() => uploadInput.current?.click()}>Upload presets</Button>
                        {(busy || refreshing) && <CircularProgress size={20} aria-label={busy ? "Applying rig" : "Finding rigs"} />}
                        <input ref={uploadInput} type="file" accept=".t3kpreset" multiple hidden
                            aria-label="Choose TONE3000 preset files" onChange={event => {
                                const files = Array.from(event.currentTarget.files ?? []);
                                event.currentTarget.value = "";
                                if (files.length) void upload(files);
                            }} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                        Upload complete .t3kpreset rigs. For NAM models or IRs, add them in TONE3000 and save a preset first.
                    </Typography>
                    {error && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}
                    {notice && <Alert severity="success" onClose={() => setNotice("")}>{notice}</Alert>}
                    {library.warnings.map((warning, index) => <Alert severity="warning" key={index}>{warning}</Alert>)}
                    <TextField label="Find a rig" value={search} onChange={event => setSearch(event.target.value)} size="small" fullWidth />
                    {!entries.length && !refreshing && <Typography color="text.secondary">
                        {library.entries.length ? "No matching rigs." : "No rigs found. Save a preset in TONE3000 or upload a .t3kpreset file."}
                    </Typography>}
                    {entries.map(entry => <Paper variant="outlined" key={entry.key} sx={{ p: 2 }}>
                        <Stack spacing={1}>
                            <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
                                <Box sx={{ minWidth: 0 }}>
                                    <Typography variant="subtitle1" sx={{ overflowWrap: "anywhere" }}>{entry.name}</Typography>
                                    <Typography variant="caption" color="text.secondary">{entry.source}</Typography>
                                </Box>
                                <Stack direction="row" spacing={1}>
                                    <Chip size="small" label={!entry.imports.length ? "New" : entry.imports.some(target => target.sha256 !== entry.sha256) ? "Update available" : "Added"}
                                        color={entry.imports.some(target => target.sha256 !== entry.sha256) ? "warning" : "default"} />
                                    <Button disabled={busy || refreshing} onClick={() => { void add(entry, entry.imports.length > 0); }}>
                                        {entry.imports.length ? "Add as new" : "Add"}
                                    </Button>
                                </Stack>
                            </Stack>
                            {entry.imports.map(target => <Box key={target.bankId + "/" + target.presetId + "/" + target.instanceId}
                                sx={{ borderTop: 1, borderColor: "divider", pt: 1 }}>
                                <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
                                    <Typography variant="body2">{target.name}{target.active ? " · Current rig" : ""}</Typography>
                                    <Stack direction="row" spacing={1}>
                                        {target.sha256 !== entry.sha256 && <Button disabled={busy || refreshing}
                                            onClick={() => { void update(entry, target); }}>{target.active ? "Update & load" : "Update"}</Button>}
                                        <Button variant="outlined" disabled={busy || refreshing} onClick={() => load(target)}>Load</Button>
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
            <DialogActions><Button disabled={busy} onClick={onClose}>Close</Button></DialogActions>
        </DialogEx>
        <DialogEx tag="tone3000LibraryUnsaved" open={pendingLoad !== null} onClose={() => setPendingLoad(null)}>
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
