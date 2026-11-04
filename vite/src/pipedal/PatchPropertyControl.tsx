// Copyright (c) 2026 Thomas Rapolani
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useRef, useState } from "react";
import { Lv2PatchPropertyInfo } from "./Lv2Plugin";
import { tone3000TouchLive, tone3000TouchStep } from "./Tone3000TouchSettings";
import { ListenHandle, PiPedalModelFactory, State } from "./PiPedalModel";
import PluginControl from "./PluginControl";
import { presentPatchNumber, rawPatchNumber } from "./Tone3000ControlUnits";
import type { PatchNumberPresentation } from "./Tone3000ControlUnits";

interface PatchPropertyControlProps {
    instanceId: number;
    property: Lv2PatchPropertyInfo;
    displayLabel?: string;
    numberPresentation?: PatchNumberPresentation;
    /** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.3] */
    onRawSet?: (value: number) => Promise<unknown>;
    readbackRevision?: number;
    /** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-VISUAL-ALIGN] [7.16] */
    uniformLayout?: boolean;
}

/**
 * Optional presentation names retain the property's discovered numeric contract.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.10]
 */
export default function PatchPropertyControl(props: PatchPropertyControlProps) {
    const model = PiPedalModelFactory.getInstance();
    const rawControl = useMemo(() => {
        const control = props.property.toUiControl();
        if (props.displayLabel) control.name = props.displayLabel;
        return control;
    }, [props.property, props.displayLabel]);
    const uiControl = useMemo(() => presentPatchNumber(rawControl, props.numberPresentation), [rawControl, props.numberPresentation]);
    const [value, setValue] = useState(rawControl.default_value);
    const [pitchStep, setPitchStep] = useState<boolean | undefined>(undefined);
    const [readReady, setReadReady] = useState(false);
    const [readEpoch, setReadEpoch] = useState(0);
    const readOwner = useRef(0);
    const lifetime = useRef(0);
    const writeGeneration = useRef(0);

    /** Readiness belongs to this exact connection/selection, not guessed defaults.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TOUCH-EDITOR] [7.27] */
    useEffect(() => {
        if (!props.uniformLayout) return;
        const key = () => JSON.stringify([model.state.get(), model.banks.get().selectedBank,
            model.presets.get().selectedInstanceId, model.selectedSnapshot.get()]);
        let selected = key();
        const invalidate = () => { ++readOwner.current; setReadReady(false); setReadEpoch(value => value + 1); };
        const changed = () => { const next = key(); if (next !== selected) { selected = next; invalidate(); } };
        model.state.addOnChangedHandler(changed); model.banks.addOnChangedHandler(changed);
        model.presets.addOnChangedHandler(changed); model.selectedSnapshot.addOnChangedHandler(changed);
        let initial = true;
        const boardChanged = () => { if (initial) { initial = false; return; } invalidate(); };
        model.pedalboard.addOnChangedHandler(boardChanged);
        return () => {
            ++readOwner.current;
            model.state.removeOnChangedHandler(changed); model.banks.removeOnChangedHandler(changed);
            model.presets.removeOnChangedHandler(changed); model.selectedSnapshot.removeOnChangedHandler(changed);
            model.pedalboard.removeOnChangedHandler(boardChanged);
        };
    }, [model, props.uniformLayout, props.instanceId, props.property.uri]);

    useEffect(() => {
        ++lifetime.current;
        let mounted = true;
        let listenHandle: ListenHandle | undefined;
        const owner = readOwner.current;
        setReadReady(false);
        const accept = (nextValue: unknown) => {
            if (!mounted || owner !== readOwner.current || typeof nextValue !== "number" || !Number.isFinite(nextValue)) return;
            setValue(nextValue);
            setReadReady(nextValue >= rawControl.min_value && nextValue <= rawControl.max_value);
        };

        if (props.property.readable && (!props.uniformLayout || model.state.get() === State.Ready)) {
            listenHandle = model.monitorPatchProperty(
                props.instanceId,
                props.property.uri,
                (_instanceId, _propertyUri, nextValue) => {
                    accept(nextValue);
                }
            );
            model.getPatchProperty<number>(props.instanceId, props.property.uri)
                .then((nextValue) => {
                    accept(nextValue);
                })
                .catch(() => {
                    // Some plugins only report a value after the first patch:Set.
                });
        }

        return () => {
            ++lifetime.current;
            mounted = false;
            if (listenHandle) {
                model.cancelMonitorPatchProperty(listenHandle);
            }
        };
    }, [model, props.instanceId, props.property.readable, props.property.uri, props.readbackRevision, readEpoch]);

    /** The pitch switch is authoritative; no inferred semitone rounding from labels.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-16] [DES-TOUCH-EDITOR] [7.27] */
    useEffect(() => {
        if (!props.uniformLayout || props.property.uri !== "https://www.tone3000.com/plugin:pitchSemitones") return;
        let current = true;
        const owner = readOwner.current;
        setPitchStep(undefined);
        const accept = (value: unknown) => { if (current && owner === readOwner.current && typeof value === "number" && Number.isFinite(value)) setPitchStep(value >= .5); };
        const uri = "https://www.tone3000.com/plugin:pitchStep";
        if (model.state.get() !== State.Ready) return () => { current = false; };
        const handle = model.monitorPatchProperty(props.instanceId, uri, (_id, _uri, value) => accept(value));
        void model.getPatchProperty<number>(props.instanceId, uri).then(accept).catch(() => {});
        return () => { current = false; model.cancelMonitorPatchProperty(handle); };
    }, [model, props.uniformLayout, props.property.uri, props.instanceId, props.readbackRevision, readEpoch]);

    const setPatchValue = (nextValue: number) => {
        const rawValue = props.numberPresentation ? rawPatchNumber(nextValue, rawControl, props.numberPresentation) : nextValue;
        const generation = lifetime.current;
        const owner = readOwner.current;
        const write = ++writeGeneration.current;
        const current = () => generation === lifetime.current && owner === readOwner.current && write === writeGeneration.current;
        const refresh = () => {
            if (!current() || !props.property.readable) return;
            void model.getPatchProperty<number>(props.instanceId, props.property.uri)
                .then(currentValue => { if (current() && typeof currentValue === "number") setValue(currentValue); })
                .catch(() => {});
        };
        setValue(rawValue);
        const request = props.onRawSet ? props.onRawSet(rawValue)
            : model.setPatchProperty(props.instanceId, props.property.uri, rawValue);
        void request
            .then(() => { if (props.onRawSet) refresh(); })
            .catch((error) => {
                if (!current()) return;
                console.error(`Failed to set LV2 patch property ${props.property.uri}:`, error);
                if (props.uniformLayout && !props.onRawSet)
                    model.showAlert("This change could not be applied. Check your connection, then reopen this control.");
                refresh();
            });
    };

    return (
        <PluginControl
            uniformLayout={props.uniformLayout}
            touchEdit={props.uniformLayout && props.property.uri.startsWith("https://www.tone3000.com/plugin:") ? {
                step: tone3000TouchStep(props.property.uri, uiControl.min_value, uiControl.max_value, uiControl.integer_property, pitchStep),
                logarithmic: props.property.uri === "https://www.tone3000.com/plugin:pitchTonality"
                    && uiControl.min_value === 1000 && uiControl.max_value === 20000,
                live: tone3000TouchLive(props.property.uri, !!props.onRawSet) && !uiControl.is_expensive,
                ready: readReady && props.property.writable && (props.property.uri !== "https://www.tone3000.com/plugin:pitchSemitones" || pitchStep !== undefined)
            } : undefined}
            instanceId={props.instanceId}
            uiControl={uiControl}
            value={props.numberPresentation ? props.numberPresentation.toDisplay(value) : value}
            onChange={setPatchValue}
            onResetToDefault={setPatchValue}
            onPreviewChange={() => { }}
            requestIMEEdit={() => { }}
        />
    );
}
