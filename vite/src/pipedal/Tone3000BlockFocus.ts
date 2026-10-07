// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
/** UI-only focus request.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15]
 */
export interface Tone3000BlockFocus { instanceId: number; blockId: string; }
let current: Tone3000BlockFocus | null = null;
const listeners = new Set<() => void>();

/** UI navigation only: focus a captured block's existing bounded editor.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [FR-15] [DES-OPERATE] [3.15]
 */
export function focusTone3000Block(instanceId: number, blockId: string): void {
    current = { instanceId, blockId };
    for (const listener of listeners) listener();
}
/** Select the actual parent icon without leaving an internal node highlighted.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15]
 */
export function clearTone3000BlockFocus(): void {
    current = null;
    for (const listener of listeners) listener();
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15] */
export const getTone3000BlockFocus = () => current;
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15] */
export function subscribeTone3000BlockFocus(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
