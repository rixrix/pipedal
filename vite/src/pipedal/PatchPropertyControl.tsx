// Copyright (c) 2026 Thomas Rapolani
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useRef, useState } from "react";
import { Lv2PatchPropertyInfo } from "./Lv2Plugin";
import { ListenHandle, PiPedalModelFactory } from "./PiPedalModel";
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
    const lifetime = useRef(0);
    const writeGeneration = useRef(0);

    useEffect(() => {
        ++lifetime.current;
        let mounted = true;
        let listenHandle: ListenHandle | undefined;
        if (props.property.readable) {
            listenHandle = model.monitorPatchProperty(
                props.instanceId,
                props.property.uri,
                (_instanceId, _propertyUri, nextValue) => {
                    if (mounted && typeof nextValue === "number" && Number.isFinite(nextValue)) setValue(nextValue);
                }
            );
            model.getPatchProperty<number>(props.instanceId, props.property.uri)
                .then((nextValue) => {
                    if (mounted && typeof nextValue === "number" && Number.isFinite(nextValue)) setValue(nextValue);
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
    }, [model, props.instanceId, props.property.readable, props.property.uri, props.readbackRevision]);

    const setPatchValue = (nextValue: number) => {
        const rawValue = props.numberPresentation ? rawPatchNumber(nextValue, rawControl, props.numberPresentation) : nextValue;
        const generation = lifetime.current;
        const write = ++writeGeneration.current;
        const current = () => generation === lifetime.current && write === writeGeneration.current;
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
                refresh();
            });
    };

    return (
        <PluginControl
            uniformLayout={props.uniformLayout}
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
