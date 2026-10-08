// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DialogEx from "./DialogEx";
import { tone3000DraftNumber } from "./Tone3000MobileLayout";
import { tone3000TouchDrag, tone3000TouchRange, tone3000TouchSameValue, tone3000TouchValue } from "./Tone3000TouchMath";
import type { Tone3000TouchScale } from "./Tone3000TouchMath";

/** Preview is optional: omit onChange for expensive release-only controls.
 * scopeKey identifies the bank/preset/snapshot/instance/control ownership.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-13] [FR-16] [DES-TOUCH-EDITOR] [7.27]
 */
export interface Tone3000TouchEditorProps extends Tone3000TouchScale {
    open: boolean; value: number; label: string; scope?: string; scopeKey?: string | number; disabled?: boolean;
    format?: (value: number) => string;
    onChange?: (value: number) => void;
    onCommit: (value: number) => void;
    onClose: () => void;
}

type Gesture = { pointer: number; x: number; width: number; sensitivity: number; start: number; element: HTMLDivElement; changed: boolean; previewed: boolean };

/** Keyboard-free adjustment with relative drag and owned, coalesced previews.
 * All transport and local-draft guards remain in the owning control callbacks.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [FR-13] [FR-16] [DES-TOUCH-EDITOR] [7.27]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOUR-REFINEMENTS] [7.28]
 */
export default function Tone3000TouchEditor(props: Tone3000TouchEditorProps) {
    const live = useRef(props); live.current = props;
    const ownerKey = JSON.stringify([props.open, props.disabled, props.scopeKey, props.label, props.min, props.max, props.step]);
    const lifecycle = useRef({ key: ownerKey, generation: 0 });
    if (lifecycle.current.key !== ownerKey) lifecycle.current = { key: ownerKey, generation: lifecycle.current.generation + 1 };
    const generation = lifecycle.current.generation;
    const [shown, setShown] = useState(props.value), [typing, setTyping] = useState(false), [text, setText] = useState("");
    const [fine, setFine] = useState(false);
    const current = useRef(props.value), baseline = useRef(props.value), gesture = useRef<Gesture | null>(null);
    const echoes = useRef<number[]>([]), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const queued = useRef<number | null>(null), lastPreview = useRef(-Infinity), alive = useRef(false);
    const scope = useRef(props.scopeKey);
    const clearPreview = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; queued.current = null; };
    const release = () => {
        const active = gesture.current; gesture.current = null;
        if (active?.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
    };
    const owns = () => alive.current && live.current.open && lifecycle.current.generation === generation && scope.current === live.current.scopeKey;
    const allowed = () => owns() && !live.current.disabled;
    const show = (value: number) => { current.current = value; setShown(value); };
    const remember = (value: number) => { echoes.current.push(value); if (echoes.current.length > 64) echoes.current.shift(); };
    const emit = (value: number) => {
        if (!allowed() || !Number.isFinite(value) || !live.current.onChange) return;
        lastPreview.current = Date.now(); remember(value);
        if (gesture.current) gesture.current.previewed = true;
        live.current.onChange(value);
    };
    const preview = (value: number) => {
        if (!allowed() || !live.current.onChange) return;
        queued.current = value;
        const remaining = Math.max(0, 34 - (Date.now() - lastPreview.current));
        if (remaining === 0) { queued.current = null; emit(value); }
        else if (timer.current === null) timer.current = setTimeout(() => {
            timer.current = null; const value = queued.current; queued.current = null;
            if (value !== null) emit(value);
        }, remaining);
    };
    const commit = (value: number, exact = false) => {
        if (!allowed()) return;
        clearPreview();
        const next = exact ? value : tone3000TouchValue(value, live.current);
        if (exact && (value < live.current.min || value > live.current.max)) return;
        if (!Number.isFinite(next)) return;
        remember(next); show(next); live.current.onCommit(next);
    };
    const cancelGesture = () => {
        if (!owns()) return;
        const active = gesture.current; clearPreview(); release();
        if (active && allowed()) { show(active.start); if (active.previewed) emit(active.start); }
    };
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; clearPreview(); release(); };
    }, []);
    useEffect(() => {
        clearPreview(); release(); scope.current = props.scopeKey;
        baseline.current = props.value; echoes.current = []; lastPreview.current = -Infinity;
        show(props.value); setTyping(false); setText(""); setFine(false);
        return () => { clearPreview(); release(); };
    }, [props.open, props.scopeKey, props.label, props.min, props.max, props.step]);
    useEffect(() => {
        if (props.disabled) { clearPreview(); release(); setTyping(false); }
    }, [props.disabled]);
    useEffect(() => {
        if (!props.open || gesture.current) return;
        const ownEcho = echoes.current.some(value => tone3000TouchSameValue(value, props.value));
        if (!ownEcho) { show(props.value); baseline.current = props.value; setTyping(false); }
    }, [props.value, props.open]);
    const changeDrag = (event: PointerEvent<HTMLDivElement>) => {
        const active = gesture.current;
        if (!active || active.pointer !== event.pointerId || !allowed()) return;
        event.preventDefault(); event.stopPropagation();
        const next = tone3000TouchDrag(active.start, (event.clientX - active.x) * active.sensitivity, active.width, live.current);
        if (Number.isFinite(next) && next !== current.current) { active.changed = true; show(next); preview(next); }
    };
    const range = tone3000TouchRange(shown, props), valid = Number.isFinite(range) && shown >= props.min && shown <= props.max && !props.disabled;
    const zero = props.min < 0 && props.max > 0 ? tone3000TouchRange(0, props) : NaN;
    const display = (value: number) => props.format ? props.format(value) : String(Number(value.toFixed(6)));
    const typed = tone3000DraftNumber(text), typedValid = Number.isFinite(typed) && typed >= props.min && typed <= props.max;
    const close = () => { if (!owns()) return; cancelGesture(); clearPreview(); props.onClose(); };
    return <DialogEx tag="tone3000TouchEditor" open={props.open} onClose={close} fullWidth maxWidth="sm"
        sx={{ "& .MuiDialog-container": { alignItems: "flex-end" }, "& .MuiDialog-paper": { m: 1, width: "calc(100% - 16px)", maxHeight: "calc(100% - 16px)" },
            "& .MuiButton-root": { minHeight: 44 }, "& .MuiDialogTitle-root": { px: 2, py: 1 } }}>
        <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
            <Typography component="span" variant="subtitle1" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>{props.label}</Typography>
            <Typography component="output" variant="h6" sx={{ flexShrink: 0 }}>{Number.isFinite(shown) ? display(shown) : "Unavailable"}</Typography>
        </DialogTitle>
        <DialogContent sx={{ px: 2, pb: 1 }}>
            {props.scope && <Typography variant="caption" component="p" color="text.secondary">{props.scope}</Typography>}
            {!valid && <Alert severity="warning">This setting is unavailable. Close and refresh the rig.</Alert>}
            <Box role="slider" tabIndex={valid ? 0 : -1} aria-label={props.label} aria-valuemin={props.min} aria-valuemax={props.max}
                aria-valuenow={Number.isFinite(shown) ? shown : undefined} aria-valuetext={Number.isFinite(shown) ? display(shown) : "Unavailable"} aria-disabled={!valid}
                sx={{ position: "relative", minHeight: 64, touchAction: "none", cursor: valid ? "ew-resize" : "default", borderRadius: 1,
                    "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" } }}
                onPointerDown={event => {
                    if (!valid || !allowed() || gesture.current || event.button !== 0) return;
                    event.preventDefault(); event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    gesture.current = { pointer: event.pointerId, x: event.clientX, width: Math.max(1, event.currentTarget.getBoundingClientRect().width - 32),
                        sensitivity: fine ? .1 : 1, start: current.current, element: event.currentTarget, changed: false, previewed: false };
                }} onPointerMove={changeDrag}
                onPointerUp={event => {
                    if (!allowed() || gesture.current?.pointer !== event.pointerId) return;
                    changeDrag(event); const active = gesture.current; release();
                    if (active?.changed) commit(current.current); else clearPreview();
                }} onPointerCancel={event => { if (allowed() && gesture.current?.pointer === event.pointerId) cancelGesture(); }}
                onLostPointerCapture={event => { if (allowed() && gesture.current?.pointer === event.pointerId) cancelGesture(); }}
                onKeyDown={event => {
                    if (!valid || gesture.current) return;
                    const next = event.key === "ArrowLeft" || event.key === "ArrowDown" ? shown - props.step
                        : event.key === "ArrowRight" || event.key === "ArrowUp" ? shown + props.step
                        : event.key === "Home" ? props.min : event.key === "End" ? props.max : NaN;
                    if (Number.isFinite(next)) { event.preventDefault(); event.stopPropagation(); commit(next); }
                }}>
                <Box sx={{ position: "absolute", left: 16, right: 16, top: 30, height: 4, bgcolor: "action.disabledBackground", borderRadius: 2 }}>
                    <Box sx={{ position: "absolute", width: `${valid ? range * 100 : 0}%`, height: 4, bgcolor: "primary.main", borderRadius: 2 }} />
                    {Number.isFinite(zero) && <Box aria-hidden="true" title="Zero" sx={{ position: "absolute", left: `${zero * 100}%`, top: -4, height: 12, width: 2, bgcolor: "text.secondary" }} />}
                    <Box sx={{ position: "absolute", left: `${valid ? range * 100 : 0}%`, top: -10, width: 24, height: 24, transform: "translateX(-50%)", bgcolor: "primary.main", borderRadius: "50%" }} />
                </Box>
            </Box>
            <Stack direction="row" sx={{ justifyContent: "space-between" }}>
                <Typography variant="caption">{display(props.min)}</Typography><Typography variant="caption">{display(props.max)}</Typography>
            </Stack>
            <Stack direction="row" spacing={1} sx={{ justifyContent: "center", my: .5 }}>
                <Button variant="outlined" disabled={!valid} aria-label={`Decrease ${props.label}`} onClick={() => { cancelGesture(); commit(current.current - props.step); }}>−</Button>
                <Button variant="outlined" disabled={!valid} aria-label={`Increase ${props.label}`} onClick={() => { cancelGesture(); commit(current.current + props.step); }}>+</Button>
                <Button variant={fine ? "contained" : "outlined"} disabled={!valid} aria-pressed={fine}
                    title="Fine mode makes the next drag ten times slower."
                    onClick={() => { if (allowed()) setFine(!fine); }}>Fine</Button>
            </Stack>
            <Button fullWidth disabled={!valid} onClick={() => { cancelGesture(); commit(baseline.current, true); }}>Restore starting value</Button>
            {typing && <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start", mt: 1 }}>
                    <TextField size="small" label={props.label} value={text} error={!typedValid} autoFocus
                        inputProps={{ inputMode: props.min < 0 ? "text" : props.step >= 1 ? "numeric" : "decimal", enterKeyHint: "done" }} helperText={!typedValid ? "Enter a complete value within the range." : " "}
                        onChange={event => { if (allowed()) setText(event.target.value); }} onKeyDown={event => {
                            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation();
                                if (allowed() && typedValid) { commit(typed, true); setTyping(false); } }
                        }} />
                    <Button disabled={!typedValid || !valid} onClick={() => { if (!allowed()) return; commit(typed, true); setTyping(false); }}>Set value</Button>
                </Stack>}
        </DialogContent>
        <DialogActions>
            {!typing && <Button disabled={!valid} onClick={() => { if (!allowed()) return; cancelGesture(); setText(String(Number(current.current.toFixed(6)))); setTyping(true); }}>Enter value</Button>}
            <Button autoFocus onClick={close}>Done</Button>
        </DialogActions>
    </DialogEx>;
}
