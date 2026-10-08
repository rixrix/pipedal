// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Checkbox from "@mui/material/Checkbox";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import DialogEx from "./DialogEx";
import { PiPedalModelFactory, State } from "./PiPedalModel";
import { Tone3000BundleReader, tone3000BundleImportAllowed, tone3000BundleMaxBytes } from "./Tone3000Bundle";
import type { Tone3000BundleReport } from "./Tone3000Bundle";

/** Inspect the exact export/upload bytes; importing is a separate explicit new-bank action.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-22] [DES-STAGE-BUNDLE] [7.7]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-STABILITY-REVIEW] [7.22]
 */
export default function Tone3000BundleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const model = PiPedalModelFactory.getInstance();
    const reader = useRef(new Tone3000BundleReader()), input = useRef<HTMLInputElement>(null), generation = useRef(0), importing = useRef(false);
    const [file, setFile] = useState<File | null>(null), [report, setReport] = useState<Tone3000BundleReport | null>(null);
    const [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [acknowledged, setAcknowledged] = useState(false);
    const [error, setError] = useState(""), [notice, setNotice] = useState("");
    useEffect(() => {
        if (!open) return;
        setBusy(false); setReport(null); setFile(null); setAcknowledged(false);
        const changed = (state: State) => {
            setReady(state === State.Ready);
            if (state !== State.Ready) {
                ++generation.current; reader.current.invalidate(); setBusy(false); setReport(null);
                if (importing.current) setNotice("Connection interrupted. Import may have completed; inspect banks before retrying.");
                importing.current = false;
            }
        };
        model.state.addOnChangedHandler(changed);
        return () => {
            ++generation.current; reader.current.invalidate(); model.state.removeOnChangedHandler(changed);
            if (importing.current) {
                const message = "Import may have completed. Inspect banks before retrying.";
                setNotice(message);
                model.showAlert(message); // A true unmount would otherwise discard this notice.
            }
            importing.current = false;
        };
    }, [open, model]);
    const check = (load: (signal: AbortSignal) => Promise<File>) => {
        if (!ready || importing.current) return;
        setBusy(true); setError(""); setReport(null); setFile(null); setAcknowledged(false);
        void reader.current.read(async signal => {
            const source = await load(signal);
            if (!source.size || source.size > tone3000BundleMaxBytes) throw new Error("Choose a nonempty bundle up to 128 MiB.");
            const response = await fetch(model.varServerUrl + "checkRigBundle", { method: "POST", body: source, headers: { "Content-Type": "application/octet-stream" }, signal });
            const result = await response.json(); if (!response.ok) throw new Error(result.error || "Bundle check failed.");
            return { source, result: result as Tone3000BundleReport };
        }, value => { setFile(value.source); setReport(value.result); setBusy(false); }, failure => { setError(failure); setBusy(false); });
    };
    const savedBank = () => {
        const bankId = model.banks.get().selectedBank;
        check(async signal => {
            const response = await fetch(model.varServerUrl + "downloadBank?id=" + encodeURIComponent(bankId), { signal });
            if (!response.ok) throw new Error("Saved bank export failed.");
            return new File([await response.blob()], "saved-bank.piBank", { type: "application/octet-stream" });
        });
    };
    const download = () => {
        if (!file) return; const url = URL.createObjectURL(file), link = document.createElement("a"); link.href = url; link.download = file.name;
        document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const importBank = async () => {
        if (importing.current || !open || model.state.get() !== State.Ready
            || !file || busy || !ready || !tone3000BundleImportAllowed(report, acknowledged)) return;
        if (file.size > model.maxPresetUploadSize) { setError("This bundle exceeds the server's import size limit."); return; }
        importing.current = true; setBusy(true); const token = ++generation.current;
        try {
            const id = await model.uploadBank(file, model.banks.get().selectedBank);
            if (token === generation.current) setNotice("New bank " + id + " imported. The current playing rig is unchanged; use the Banks dialog to load it.");
        } catch (failure) { if (token === generation.current) setError(String(failure)); }
        finally { if (token === generation.current) { importing.current = false; setBusy(false); } }
    };
    return <DialogEx tag="tone3000Bundle" open={open} onClose={() => { if (!importing.current) onClose(); }} fullWidth maxWidth="sm">
        <DialogTitle>Check rig bundle</DialogTitle>
        <DialogContent dividers><Stack spacing={2}>
            <Typography variant="body2">Check a .piPreset, .piBank or legacy JSON export without loading or saving it. Current saved bank excludes unsaved edits.</Typography>
            {!ready && <Alert severity="warning">Disconnected. Reconnect before checking or importing.</Alert>}
            <Stack direction="row" spacing={1}><Button disabled={!ready || busy} onClick={() => input.current?.click()}>Choose bundle</Button><Button disabled={!ready || busy} onClick={savedBank}>Check current saved bank</Button></Stack>
            <input ref={input} type="file" accept=".piPreset,.piBank,.json" hidden onChange={event => { const selected = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (selected) check(async () => selected); }} />
            {busy && <Typography>Working…</Typography>}{error && <Alert severity="error">{error}</Alert>}{notice && <Alert severity="info" onClose={() => setNotice("")}>{notice}</Alert>}
            {report && <>
                <Typography variant="subtitle1">{report.name}</Typography>
                <Typography variant="body2">{report.presetCount} saved rigs · {report.namCount} cached NAMs · {report.irCount} cached IRs · {report.embeddedBytes.toLocaleString()} embedded bytes</Typography>
                <Alert severity={report.completenessKnown ? "info" : "warning"}>{report.completenessKnown ? "Known declared assets are present." : "Self-contained completeness is not established."} Audio readiness is not proven.</Alert>
                {report.plugins.map(plugin => <Typography key={plugin.uri} variant="body2" sx={{ overflowWrap: "anywhere" }}>{plugin.name || plugin.uri}: {plugin.versionStatus === "match" ? "LV2 version match" : plugin.versionStatus === "missing" ? "not installed" : plugin.versionStatus === "mismatch" ? "LV2 version differs" : "version unknown"}</Typography>)}
                {report.missingMedia.length > 0 && <Alert severity="error">Missing or empty declared media: {report.missingMedia.join(", ")}</Alert>}
                {report.warnings.map((warning, index) => <Typography key={index} variant="body2" color="text.secondary">{warning}</Typography>)}
                <FormControlLabel control={<Checkbox checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />} label="I understand unknown dependencies/version differences and will verify this rig before use." />
                <Stack direction="row" spacing={1}><Button disabled={busy} onClick={download}>Download checked bytes</Button><Button disabled={!ready || busy || !tone3000BundleImportAllowed(report, acknowledged)} onClick={() => { void importBank(); }}>Import as new bank</Button></Stack>
            </>}
        </Stack></DialogContent>
        <DialogActions><Button disabled={importing.current} onClick={() => { if (!importing.current) onClose(); }}>Close</Button></DialogActions>
    </DialogEx>;
}
