// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
import { tone3000SameDraftNumber } from "./Tone3000MobileLayout";
import type { Tone3000CurrentState, Tone3000DefaultsResult, Tone3000Defaults, Tone3000Summary } from "./Tone3000Rig";

/** Compare draft data without JSON erasing invalid numeric input. Nonfinite values
 * always remain pending; round-trip floating point noise uses the field contract.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOUR-REFINEMENTS] [7.29]
 */
export function tone3000DraftEqual(left: unknown, right: unknown): boolean {
    if (typeof left === "number" || typeof right === "number")
        return typeof left === "number" && typeof right === "number" && Number.isFinite(left) && Number.isFinite(right)
            && tone3000SameDraftNumber(left, right);
    if (left === right && (left === null || typeof left !== "object")) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) || Array.isArray(right))
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length
            && left.every((value, index) => tone3000DraftEqual(value, right[index]));
    const before = left as Record<string, unknown>, after = right as Record<string, unknown>;
    const keys = Object.keys(before);
    return keys.length === Object.keys(after).length && keys.every(key => Object.prototype.hasOwnProperty.call(after, key) && tone3000DraftEqual(before[key], after[key]));
}

/** The processing policy belongs to the rig; global profile drafts stay separate.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOUR-REFINEMENTS] [7.29]
 */
export function tone3000RigDraftChanged(baseline: Tone3000CurrentState | null, draft: Tone3000Summary | null, follow: boolean): boolean {
    return !!baseline && (!!draft && (!tone3000DraftEqual(baseline.summary, draft) || baseline.followDefaults !== follow));
}

/** Restoring both the selected profile and its fields clears global pending edits.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOUR-REFINEMENTS] [7.29]
 */
export function tone3000ProfileDraftChanged(baseline: Tone3000DefaultsResult | null, profileId: string, draft: Tone3000Defaults | null): boolean {
    return !!baseline && (!!draft && (baseline.activeProfile !== profileId || !tone3000DraftEqual(baseline.defaults, draft)));
}

/** Transient pending flags for mounted tabs; no plugin state or persistence.
 * Each token belongs to one exact instance/bank/preset/snapshot owner.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOUR-REFINEMENTS] [7.29]
 */
export class Tone3000EditDrafts {
    private entries = new Map<symbol, { owner: string; section: string }>();
    private listeners = new Set<() => void>();
    set(token: symbol, owner: string, section: string, pending: boolean): void {
        const before = this.entries.get(token);
        if (!pending) { this.remove(token); return; }
        if (before?.owner === owner && before.section === section) return;
        this.entries.set(token, { owner, section }); this.listeners.forEach(listener => listener());
    }
    remove(token: symbol): void {
        if (this.entries.delete(token)) this.listeners.forEach(listener => listener());
    }
    sections(owner: string): string[] {
        return [...new Set([...this.entries.values()].filter(entry => entry.owner === owner).map(entry => entry.section))].sort();
    }
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener); listener();
        return () => { this.listeners.delete(listener); };
    }
}
const registries = new WeakMap<object, Tone3000EditDrafts>();
/** Share tab flags only within the current model connection owner.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FOUR-REFINEMENTS] [7.29]
 */
export function tone3000EditDrafts(model: object): Tone3000EditDrafts {
    let registry = registries.get(model);
    if (!registry) { registry = new Tone3000EditDrafts(); registries.set(model, registry); }
    return registry;
}
