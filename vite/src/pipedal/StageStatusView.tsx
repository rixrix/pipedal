// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import { PiPedalModelFactory, State } from './PiPedalModel';
import type JackHostStatus from './JackHostStatus';
import { stageAudioView, StageStatusPoller } from './StageStatus';
import type { StageConnection } from './StageStatus';

function connectionFor(state: State): StageConnection {
    if (state === State.Ready) return "connected";
    if (state === State.Reconnecting) return "reconnecting";
    if (state === State.Loading) return "connecting";
    if (state === State.Background || state === State.Error) return "disconnected";
    return "busy";
}

/** Compact standard host status; reads never alter audio settings or a rig.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-19] [DES-STAGE] [7.2]
 */
export default function StageStatusView({ active, showMetrics }: { active: boolean; showMetrics: boolean }) {
    const model = PiPedalModelFactory.getInstance();
    const [connection, setConnection] = useState<StageConnection>(connectionFor(model.state.get()));
    const [status, setStatus] = useState<JackHostStatus>();
    const [readFailed, setReadFailed] = useState(false);
    const [dirty, setDirty] = useState(model.presetChanged.get());
    useEffect(() => {
        if (!active) { setStatus(undefined); setReadFailed(false); return; }
        const poller = new StageStatusPoller(() => model.getJackStatus(), (value, error) => {
            setStatus(value); setReadFailed(!!error);
        });
        const onState = (state: State) => { setConnection(connectionFor(state)); poller.setReady(state === State.Ready); };
        const onDirty = (value: boolean) => setDirty(value);
        model.state.addOnChangedHandler(onState); model.presetChanged.addOnChangedHandler(onDirty);
        return () => { poller.dispose(); model.state.removeOnChangedHandler(onState); model.presetChanged.removeOnChangedHandler(onDirty); };
    }, [active, model]);
    if (!active) return null;
    const view = stageAudioView(connection, status, dirty, readFailed);
    const color = view.kind === "fallback" || view.kind === "stopped" ? "error.main"
        : view.kind === "restarting" || view.recentUnderrun ? "warning.main" : "text.primary";
    return <Box aria-label="Live audio status" sx={{ flex: "0 0 auto", px: 2, py: .75, borderTop: 1,
        borderColor: "divider", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1 }}>
        <Tooltip title="Engine status does not confirm a rig has loaded or sounds correct.">
            <Typography role="status" variant="body2" sx={{ color, fontWeight: 600 }}>{view.label}</Typography>
        </Tooltip>
        {view.detail && <Typography variant="caption" sx={{ flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" }}>{view.detail}</Typography>}
        {view.dirty && <Chip label="Unsaved rig" size="small" color="warning" variant="outlined" />}
        {view.recentUnderrun && <Chip label="Recent underrun" size="small" color="warning" variant="outlined" />}
        {showMetrics && status && connection === "connected" && <Typography variant="caption" aria-live="off">
            {Number.isFinite(status.cpuUsage) && `CPU ${status.cpuUsage.toFixed(1)}% · `}
            {Number.isFinite(status.underruns) && `XRuns ${status.underruns}`}
            {Number.isFinite(status.temperaturemC) && status.temperaturemC > -40000 && ` · ${(status.temperaturemC / 1000).toFixed(1)}°C`}
        </Typography>}
    </Box>;
}
