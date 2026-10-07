// Copyright (c) 2026 Thomas Rapolani
// SPDX-License-Identifier: MIT

import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Tone3000LibraryDialog from "./Tone3000LibraryDialog";
import { getTone3000BlockFocus, subscribeTone3000BlockFocus } from "./Tone3000BlockFocus";
import Tone3000RigPanel from "./Tone3000RigPanel";
import IControlViewFactory from "./IControlViewFactory";
import { PiPedalModel } from "./PiPedalModel";
import { PedalboardItem } from "./Pedalboard";
import PluginControlView, { ControlGroup, ControlNodes, ControlViewCustomization, ICustomizationHost } from "./PluginControlView";
import PatchPropertyControl from "./PatchPropertyControl";
import { findTone3000Control, tone3000ControlLayout } from "./Tone3000ControlLayout";

/**
 * Organize existing property controls while keeping every subscription mounted.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.10]
 */
function Tone3000Panel({ host, controls, instanceId }: { host: ICustomizationHost; controls: ControlNodes; instanceId: number }) {
    const [selected, setSelected] = useState("Blocks");
    const [libraryOpen, setLibraryOpen] = useState(false);
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
                const key = presentation.tab + "/" + presentation.section;
                const group = groups.get(key) ?? [];
                group.push({ order: presentation.order,
                    node: React.cloneElement(node, { displayLabel: presentation.label }) });
                groups.set(key, group);
                return;
            }
        }
        other.push(node instanceof ControlGroup ? host.renderControlGroup(node, "other-group-" + index) : node);
    });
    const tabNames = ["Blocks", ...tone3000ControlLayout.map(tab => tab.title), "Settings"];
    if (other.length) tabNames.push("Other");
    const active = tabNames.includes(selected) ? selected : "Tone";
    return (
        <Box sx={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", pt: 3 }}>
            <Box sx={{ px: 1, pb: 1, flexShrink: 0 }}>
                <Button variant="outlined" onClick={() => setLibraryOpen(true)}>TONE3000 Library</Button>
            </Box>
            <Tone3000LibraryDialog open={libraryOpen} onClose={() => setLibraryOpen(false)} />
            <Tabs value={active} onChange={(_event, next: string) => {
                setSelected(next);
                if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
            }}
                aria-label="TONE3000 controls" variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
                sx={{ flexShrink: 0, borderBottom: 1, borderColor: "divider" }}>
                {tabNames.map(title => <Tab key={title} value={title} label={title}
                    id={id + "-tab-" + title} aria-controls={id + "-panel-" + title} />)}
            </Tabs>
            <Box ref={scrollContainer} sx={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", py: 2, pb: 8 }}>
                {tabNames.map(title => (
                    <Box key={title} role="tabpanel" id={id + "-panel-" + title}
                        aria-labelledby={id + "-tab-" + title} hidden={active !== title}>
                        {title === "Blocks" || title === "Settings" ? <Tone3000RigPanel instanceId={instanceId}
                            section={title} active={active === title} focusedBlock={focusedBlock} /> : title === "Other" ? (
                            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>{other}</Box>
                        ) : (
                            <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 2 }}>
                                {tone3000ControlLayout.find(tab => tab.title === title)?.sections.map(section => {
                                    const nodes = groups.get(title + "/" + section.title);
                                    if (!nodes?.length) return null;
                                    return (
                                        <Paper component="section" variant="outlined" key={section.title}
                                            aria-label={section.title}
                                            sx={{ minWidth: 0, maxWidth: "100%", p: 1.5, borderRadius: 2 }}>
                                            <Typography component="h3" variant="subtitle2" sx={{ mb: 1, px: 0.5 }}>
                                                {section.title}
                                            </Typography>
                                            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
                                                {nodes.sort((left, right) => left.order - right.order).map(item => item.node)}
                                            </Box>
                                        </Paper>
                                    );
                                })}
                            </Box>
                        )}
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
