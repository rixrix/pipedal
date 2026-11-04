// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
import { useEffect, useState, useSyncExternalStore } from "react";
import PedalboardView from "./PedalboardView";
import type { Tone3000ChainCapture } from "./PedalboardView";
import { PiPedalModelFactory, State } from "./PiPedalModel";
import type { StateChangedHandle } from "./PiPedalModel";
import type { PedalboardItem } from "./Pedalboard";

import { clearTone3000BlockFocus, focusTone3000Block, getTone3000BlockFocus, subscribeTone3000BlockFocus } from "./Tone3000BlockFocus";

const TONE3000_URI = "https://www.tone3000.com/plugin";
type Entry = {
    itemState: PedalboardItem["lv2State"]; count: number; version: number;
    handle: StateChangedHandle; loading: boolean; transientRetries: number; timer?: number;
};

/** Capture real host instances for their read-only main-chain groups. No display
 * ID reaches a model setter, and ordinary host graph actions keep their IDs.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LANDSCAPE] [7.38]
 */
export default function Tone3000PedalboardView(props: {
    selectedId?: number; onSelectionChanged?: (id: number) => void;
    onDoubleClick?: (id: number) => void; readOnly?: boolean; hasTinyToolBar: boolean; enableStructureEditing: boolean;
}) {
    const model = PiPedalModelFactory.getInstance();
    const focused = useSyncExternalStore(subscribeTone3000BlockFocus, getTone3000BlockFocus);
    const [chains, setChains] = useState<Record<number, Tone3000ChainCapture>>({});
    useEffect(() => {
        let alive = true;
        let context = "";
        const entries = new Map<number, Entry>();
        const session = () => `${model.banks.get().selectedBank}/${model.presets.get().selectedInstanceId}`;
        const currentItem = (id: number) => [...model.pedalboard.get().itemsGenerator()]
            .find(item => item.instanceId === id && item.uri === TONE3000_URI);
        const publish = (id: number, capture: Tone3000ChainCapture) => {
            if (alive) setChains(previous => ({ ...previous, [id]: capture }));
        };
        const release = (entry: Entry) => {
            window.clearTimeout(entry.timer);
            model.removeLv2StateChangedListener(entry.handle);
        };
        const capture = async (id: number, entry: Entry) => {
            if (!alive || entry.loading || model.state.get() !== State.Ready) return;
            window.clearTimeout(entry.timer); entry.timer = undefined;
            entry.loading = true;
            const version = entry.version, requestContext = context;
            try {
                const state = await model.getTone3000CurrentState(id);
                if (!alive || entries.get(id) !== entry || context !== requestContext || session() !== requestContext) return;
                if (entry.version !== version) return;
                const item = currentItem(id);
                if (!item) return;
                // Only this accepted generation covers the observed state identity.
                entry.itemState = item.lv2State; entry.count = item.stateUpdateCount;
                entry.transientRetries = 0;
                publish(id, { summary: state.summary });
            } catch (failure) {
                if (!alive || entries.get(id) !== entry || entry.version !== version || context !== requestContext) return;
                const message = failure instanceof Error ? failure.message : String(failure);
                publish(id, { error: message });
                if (message.includes("Apply accepted; plugin state has not reflected edit yet"))
                    entry.timer = window.setTimeout(() => void capture(id, entry), 1000);
                else if (message.includes("Current plugin state capture failed;") && entry.transientRetries < 3)
                    entry.timer = window.setTimeout(() => void capture(id, entry), 1000 * 2 ** entry.transientRetries++);
            } finally {
                entry.loading = false;
                if (alive && entries.get(id) === entry && entry.version !== version)
                    void capture(id, entry);
            }
        };
        const reconcile = () => {
            if (!alive) return;
            const nextContext = session();
            if (context !== nextContext || model.state.get() !== State.Ready) {
                for (const entry of entries.values()) release(entry);
                entries.clear(); setChains({}); context = nextContext;
            }
            if (model.state.get() !== State.Ready) return;
            const items = [...model.pedalboard.get().itemsGenerator()].filter(item => item.uri === TONE3000_URI);
            const ids = new Set(items.map(item => item.instanceId));
            for (const [id, entry] of entries) if (!ids.has(id)) {
                release(entry); entries.delete(id);
                setChains(previous => { const next = { ...previous }; delete next[id]; return next; });
            }
            for (const item of items) {
                let entry = entries.get(item.instanceId);
                if (!entry) {
                    const id = item.instanceId;
                    const handle = model.addLv2StateChangedListener(id, () => {
                        const current = entries.get(id);
                        // Coalesce events arriving during a capture into one follow-up.
                        // An unchanged follow-up does not broadcast another event.
                        if (current) {
                            ++current.version; current.transientRetries = 0; publish(id, {}); void capture(id, current);
                        }
                    });
                    entry = { itemState: item.lv2State, count: item.stateUpdateCount, version: 0, handle, loading: false, transientRetries: 0 };
                    entries.set(id, entry); publish(id, {}); void capture(id, entry);
                } else if (entry.itemState !== item.lv2State || entry.count !== item.stateUpdateCount) {
                    entry.itemState = item.lv2State; entry.count = item.stateUpdateCount;
                    ++entry.version; entry.transientRetries = 0; publish(item.instanceId, {}); void capture(item.instanceId, entry);
                }
            }
        };
        const audioChanged = () => {
            for (const [id, entry] of entries) {
                ++entry.version; entry.transientRetries = 0; publish(id, {}); void capture(id, entry);
            }
            reconcile();
        };
        model.jackConfiguration.addOnChangedHandler(audioChanged);
        model.pedalboard.addOnChangedHandler(reconcile);
        model.presets.addOnChangedHandler(reconcile);
        model.banks.addOnChangedHandler(reconcile);
        model.state.addOnChangedHandler(reconcile);
        reconcile();
        return () => {
            alive = false;
            model.jackConfiguration.removeOnChangedHandler(audioChanged);
            model.pedalboard.removeOnChangedHandler(reconcile);
            model.presets.removeOnChangedHandler(reconcile);
            model.banks.removeOnChangedHandler(reconcile);
            model.state.removeOnChangedHandler(reconcile);
            for (const entry of entries.values()) release(entry);
        };
    }, [model]);
    return <PedalboardView {...props} tone3000Chains={chains}
        onTone3000ParentClick={props.readOnly ? undefined : clearTone3000BlockFocus}
        tone3000FocusedBlock={!props.readOnly && focused?.instanceId === props.selectedId ? focused : undefined}
        onTone3000BlockClick={props.readOnly ? undefined : focusTone3000Block} />;
}
