// Copyright (c) 2026 Thomas Rapolani
// SPDX-License-Identifier: MIT

import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Typography from "@mui/material/Typography";
import { getTone3000BlockFocus, subscribeTone3000BlockFocus } from "./Tone3000BlockFocus";
import Tone3000RigPanel from "./Tone3000RigPanel";
import Tone3000SoundcheckPanel from "./Tone3000SoundcheckPanel";
import IControlViewFactory from "./IControlViewFactory";
import { PiPedalModel, PiPedalModelFactory, State } from "./PiPedalModel";
import { PedalboardItem } from "./Pedalboard";
import PluginControlView, { ControlGroup, ControlNodes, ControlViewCustomization, ICustomizationHost } from "./PluginControlView";
import PatchPropertyControl from "./PatchPropertyControl";
import { findTone3000Control, tone3000ControlLayout } from "./Tone3000ControlLayout";
import { tone3000NumberPresentation } from "./Tone3000ControlUnits";
import { Tone3000CoupledGestures, tone3000CoupledControl, tone3000CoupledPrefix } from "./Tone3000CoupledControls";
import type { Tone3000CoupledApi, Tone3000CoupledControl } from "./Tone3000CoupledControls";

/**
 * Organize existing property controls while keeping every subscription mounted.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.10]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-VISUAL-ALIGN] [7.16]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-CONTROL-SCOPE] [7.18]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY-TOOLBAR] [7.19]
 */
function Tone3000Panel({ host, controls, instanceId }: { host: ICustomizationHost; controls: ControlNodes; instanceId: number }) {
    const model = PiPedalModelFactory.getInstance();
    const gestures = useRef(new Tone3000CoupledGestures());
    const lifetime = useRef({ active: false, generation: 0, connection: 0 });
    const [readbackRevision, setReadbackRevision] = useState(0);
    useEffect(() => {
        const session = lifetime.current;
        session.active = true;
        ++session.generation;
        let bank = model.banks.get().selectedBank;
        let preset = model.presets.get().selectedInstanceId;
        let snapshot = model.selectedSnapshot.get();
        const invalidate = () => { ++session.generation; gestures.current.stop(); };
        const stateChanged = (state: State) => {
            ++session.connection; invalidate();
            if (state === State.Ready) setReadbackRevision(value => value + 1);
        };
        const bankChanged = () => {
            const selected = model.banks.get().selectedBank;
            if (selected !== bank) { bank = selected; invalidate(); }
        };
        const presetChanged = () => {
            const selected = model.presets.get().selectedInstanceId;
            if (selected !== preset) { preset = selected; invalidate(); }
        };
        const snapshotChanged = (selected: number) => {
            if (selected !== snapshot) { snapshot = selected; invalidate(); }
        };
        const boardChanged = () => {
            if (model.pedalboard.get().tryGetItem(instanceId)?.uri !== "https://www.tone3000.com/plugin") invalidate();
        };
        model.state.addOnChangedHandler(stateChanged);
        model.banks.addOnChangedHandler(bankChanged);
        model.presets.addOnChangedHandler(presetChanged);
        model.selectedSnapshot.addOnChangedHandler(snapshotChanged);
        model.pedalboard.addOnChangedHandler(boardChanged);
        return () => {
            session.active = false; invalidate();
            model.state.removeOnChangedHandler(stateChanged);
            model.banks.removeOnChangedHandler(bankChanged);
            model.presets.removeOnChangedHandler(presetChanged);
            model.selectedSnapshot.removeOnChangedHandler(snapshotChanged);
            model.pedalboard.removeOnChangedHandler(boardChanged);
        };
    }, [model, instanceId]);
    /** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.3] */
    const coupledSet = async (id: Tone3000CoupledControl, value: number) => {
        const session = lifetime.current;
        const generation = session.generation;
        const connection = session.connection;
        const bank = model.banks.get().selectedBank;
        const preset = model.presets.get().selectedInstanceId;
        const snapshot = model.selectedSnapshot.get();
        const sameConnection = () => connection === session.connection && model.state.get() === State.Ready;
        const isCurrent = () => session.active && generation === session.generation && sameConnection()
            && model.banks.get().selectedBank === bank && model.presets.get().selectedInstanceId === preset
            && model.selectedSnapshot.get() === snapshot
            && model.pedalboard.get().tryGetItem(instanceId)?.uri === "https://www.tone3000.com/plugin";
        const api: Tone3000CoupledApi = {
            current: () => model.getTone3000CurrentState(instanceId),
            getRaw: property => model.getPatchProperty<number>(instanceId, tone3000CoupledPrefix + property),
            setRaw: (property, raw) => model.setPatchProperty(instanceId, tone3000CoupledPrefix + property, raw),
            start: (revision, command, payload) => model.startTone3000Stage(instanceId, revision, command, payload),
            poll: token => model.pollTone3000Stage(instanceId, token),
            cancel: token => model.cancelTone3000Stage(instanceId, token),
            isCurrent, canCancel: sameConnection
        };
        try { await gestures.current.set(id, value, api); }
        catch (failure) {
            if (isCurrent()) model.showAlert(String(failure));
            throw failure;
        } finally {
            // Native coupling changes both controls; refresh all five from actual
            // plugin readback, including a rejected or partially completed edit.
            if (isCurrent()) setReadbackRevision(revision => revision + 1);
        }
    };
    const [selected, setSelected] = useState("Blocks");
    const blockFocus = useSyncExternalStore(subscribeTone3000BlockFocus, getTone3000BlockFocus);
    const focusedBlock = blockFocus?.instanceId === instanceId ? blockFocus : null;
    useEffect(() => { if (focusedBlock) setSelected("Blocks"); }, [focusedBlock]);
    const id = useId();
    const scrollContainer = useRef<HTMLDivElement>(null);
    const groups = new Map<string, { order: number; node: React.ReactNode }[]>();
    const other: React.ReactNode[] = [];
    controls.forEach((node, index) => {
        if (React.isValidElement<React.ComponentProps<typeof PatchPropertyControl>>(node)
                && node.type === PatchPropertyControl) {
            const presentation = findTone3000Control(node.props.property.uri);
            if (presentation) {
                const coupled = node.props.instanceId === instanceId && node.props.property.minValue === 0
                    && node.props.property.maxValue === 1 ? tone3000CoupledControl(node.props.property.uri) : undefined;
                const key = presentation.tab + "/" + presentation.section;
                const group = groups.get(key) ?? [];
                group.push({ order: presentation.order,
                    node: React.cloneElement(node, { displayLabel: presentation.label, uniformLayout: true,
                        numberPresentation: tone3000NumberPresentation(node.props.property.uri,
                            node.props.property.minValue, node.props.property.maxValue),
                        ...(coupled ? { onRawSet: (value: number) => coupledSet(coupled, value), readbackRevision } : {}) }) });
                groups.set(key, group);
                return;
            }
        }
        other.push(node instanceof ControlGroup ? host.renderControlGroup(node, "other-group-" + index) : node);
    });
    const tabNames = ["Blocks", ...tone3000ControlLayout.map(tab => tab.title), "Soundcheck"];
    if (other.length) tabNames.push("Other");
    const active = tabNames.includes(selected) ? selected : "Tone";
    return (
        <Box sx={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", minWidth: 0, pt: 1, pb: 3, boxSizing: "border-box", containerType: "inline-size",
            "& .MuiButton-root": { minHeight: 44 },
            "@container (max-width: 440px)": {
                "& .t3k-section": { flexBasis: "100%", p: 1 },
                "& .t3k-field-row > .MuiTextField-root": { flex: "1 1 140px", minWidth: 0, maxWidth: "100%" },
                "& .t3k-field-row > .MuiFormControlLabel-root": { marginLeft: 0, marginRight: 0 },
                "& .t3k-rig-panel": { px: 0.5 },
                "& .MuiAccordionDetails-root": { px: 1 },
                "& .MuiAccordionSummary-root": { px: 1 },
                "& .MuiInputBase-root": { minHeight: 44 },
                "& .MuiFormControlLabel-root": { minHeight: 44 },
                "& .MuiInputBase-input": { fontSize: 16 }
            } }}>
            <Box sx={{ display: "flex", alignItems: "center", minWidth: 0, flexShrink: 0, gap: 0.5, px: 0.5 }}>
            <Tabs value={active} onChange={(_event, next: string) => {
                setSelected(next);
                if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
            }}
                aria-label="TONE3000 controls" variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
                sx={{ flex: 1, minWidth: 0, borderBottom: 1, borderColor: "divider", "& .MuiTabs-scrollButtons.Mui-disabled": { display: "none" }, "& .MuiTab-root": { minHeight: 44, minWidth: 72, px: 1.5, textTransform: "none" } }}>
                {tabNames.map(title => <Tab key={title} value={title} label={title}
                    id={id + "-tab-" + title} aria-controls={id + "-panel-" + title} />)}
            </Tabs>
            </Box>
            <Box ref={scrollContainer} sx={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", py: 1, pb: 6, overscrollBehavior: "contain" }}>
                {tabNames.map(title => (
                    <Box key={title} role="tabpanel" id={id + "-panel-" + title}
                        aria-labelledby={id + "-tab-" + title} hidden={active !== title}>
                        {title === "Soundcheck" && <Tone3000SoundcheckPanel instanceId={instanceId} active={active === title} />}
                        {title !== "Soundcheck" && title !== "Settings" && <Typography variant="body2" color="text.secondary" sx={{ px: 1, mb: 1 }}>
                            Current rig · This TONE3000 instance only. {title === "Blocks"
                                ? "Apply block changes, then use PiPedal Save to keep them."
                                : "Live controls take effect immediately; use PiPedal Save to keep changes."}
                        </Typography>}
                        {title === "Other" && <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>{other}</Box>}
                        {title === "Settings" && <Typography variant="caption" sx={{ display: "block", px: 1, mb: 1 }}>
                            Calibration and oversampling here affect the current rig immediately; use PiPedal Save to keep changes. Global system settings and device defaults are labelled separately below.
                        </Typography>}
                        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 1, px: 0.5 }}>
                            {tone3000ControlLayout.find(tab => tab.title === title)?.sections.map(section => {
                                const nodes = groups.get(title + "/" + section.title);
                                if (!nodes?.length) return null;
                                return (
                                    <Paper component="section" variant="outlined" key={section.title}
                                        className="t3k-section" aria-label={section.title}
                                        sx={{ minWidth: 0, maxWidth: "100%", flex: "1 1 280px", p: 1.5, borderRadius: 1 }}>
                                        <Typography component="h3" variant="subtitle2" sx={{ mb: 1, px: 0.5 }}>
                                            {section.title}
                                        </Typography>
                                        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                                            {nodes.sort((left, right) => left.order - right.order).map(item => item.node)}
                                        </Box>
                                    </Paper>
                                );
                            })}
                        </Box>
                        {(title === "Blocks" || title === "Settings") && <Box sx={{ mt: title === "Settings" ? 2 : 0 }}>
                            <Tone3000RigPanel instanceId={instanceId} section={title}
                                active={active === title} focusedBlock={focusedBlock} />
                        </Box>}
                    </Box>
                ))}
            </Box>
        </Box>
    );
}

/**
 * Keep PluginControlView's meters and existing controls; replace only its layout.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.10]
 */
const tone3000Customization = (instanceId: number): ControlViewCustomization => ({
    fullScreen: () => true,
    modifyControls: (host, controls) => [<Tone3000Panel key="tone3000-panel" host={host} controls={controls} instanceId={instanceId} />]
});

/**
 * Register only the reviewed TONE3000 plugin, leaving other plugin views intact.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.10]
 */
export default class Tone3000ViewFactory implements IControlViewFactory {
    uri = "https://www.tone3000.com/plugin";

    /**
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.10]
     */
    Create(_model: PiPedalModel, item: PedalboardItem): React.ReactNode {
        return <PluginControlView key={item.instanceId} instanceId={item.instanceId} item={item}
            customization={tone3000Customization(item.instanceId)} showModGui={false} onSetShowModGui={() => { }} />;
    }
}
