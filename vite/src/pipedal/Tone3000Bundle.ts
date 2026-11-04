// SPDX-License-Identifier: MIT
export interface Tone3000BundlePlugin {
    uri: string; name: string; installed: boolean; versionStatus: "unknown" | "match" | "mismatch" | "missing";
    requiredMinor?: number | null; requiredMicro?: number | null; installedMinor?: number | null; installedMicro?: number | null;
}
export interface Tone3000BundleReport {
    name: string; sha256: string; archive: boolean; knownAssetsPresent: boolean; completenessKnown: boolean; readinessProven: boolean;
    presetCount: number; namCount: number; irCount: number; embeddedBytes: number; opaqueStates: number; incompleteToneStates: number;
    plugins: Tone3000BundlePlugin[]; missingMedia: string[]; warnings: string[];
}
export const tone3000BundleMaxBytes = 128 * 1024 * 1024;
/** Missing declared dependencies block this shortcut; unknown compatibility needs acknowledgement.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-22] [DES-STAGE-BUNDLE] [7.7]
 */
export function tone3000BundleImportAllowed(report: Tone3000BundleReport | null, acknowledged: boolean): boolean {
    if (!report || report.missingMedia.length || report.plugins.some(plugin => !plugin.installed)) return false;
    return acknowledged || (report.completenessKnown && report.plugins.every(plugin => plugin.versionStatus === "match"));
}
/** Abort obsolete reads and discard late responses, including servers ignoring abort.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BUNDLE] [DES-RECOVERY] [7.7]
 */
export class Tone3000BundleReader {
    private generation = 0;
    private controller: AbortController | null = null;
    invalidate(): void { ++this.generation; this.controller?.abort(); this.controller = null; }
    async read<T>(load: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void, fail: (error: string) => void): Promise<void> {
        this.invalidate(); const generation = this.generation, controller = new AbortController(); this.controller = controller;
        try { const result = await load(controller.signal); if (generation === this.generation) accept(result); }
        catch (failure) { if (generation === this.generation) fail(String(failure)); }
        finally { if (generation === this.generation) this.controller = null; }
    }
}
