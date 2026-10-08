// Copyright (c) 2026 Thomas Rapolani
// SPDX-License-Identifier: MIT
#pragma once
#include "json.hpp"
#include "Pedalboard.hpp"
#include "Tone3000Preset.hpp"
#include <filesystem>
#include <vector>

namespace pipedal {
class Storage;

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
struct Tone3000LibraryImport {
    int64_t bankId_ = -1, presetId_ = -1, instanceId_ = -1;
    std::string name_, sha256_;
    bool active_ = false, hasSnapshotOverrides_ = false;
    DECLARE_JSON_MAP(Tone3000LibraryImport);
};
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
struct Tone3000LibraryEntry {
    std::string key_, name_, source_, sha256_;
    std::vector<Tone3000LibraryImport> imports_;
    DECLARE_JSON_MAP(Tone3000LibraryEntry);
};
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
struct Tone3000LibraryResult {
    std::vector<Tone3000LibraryEntry> entries_;
    std::vector<std::string> warnings_;
    DECLARE_JSON_MAP(Tone3000LibraryResult);
};
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
struct Tone3000ImportRequest {
    std::string key_, sha256_, expectedImportSha256_;
    int64_t bankId_ = -1, presetId_ = -1, instanceId_ = -1;
    bool asNew_ = false;
    DECLARE_JSON_MAP(Tone3000ImportRequest);
};
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
struct Tone3000ImportResult {
    int64_t bankId_ = -1, presetId_ = -1, instanceId_ = -1;
    DECLARE_JSON_MAP(Tone3000ImportResult);
};
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
struct Tone3000LoadRequest {
    int64_t bankId_ = -1, presetId_ = -1;
    DECLARE_JSON_MAP(Tone3000LoadRequest);
};
/** A read-only request identifies sources and saved targets, never paths.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [7.1]
 */
struct Tone3000PreviewRequest {
    std::string key_, sha256_, expectedImportSha256_;
    int64_t bankId_ = -1, presetId_ = -1, instanceId_ = -1;
    DECLARE_JSON_MAP(Tone3000PreviewRequest);
};
/** Counts include every embedded cached variant, also in disabled blocks.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [7.1]
 */
struct Tone3000PreviewState {
    Tone3000StateSummary summary_;
    uint64_t namCount_ = 0, irCount_ = 0, embeddedBytes_ = 0;
    DECLARE_JSON_MAP(Tone3000PreviewState);
};
/** Stored observations, never an exhaustive diff or DSP-readiness verdict.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [7.1]
 */
struct Tone3000PreviewResult {
    std::string key_, sha256_, name_, source_, targetName_;
    Tone3000PreviewState sourceState_;
    std::optional<Tone3000PreviewState> targetState_;
    bool active_ = false, hasUnsavedChanges_ = false, hasSnapshotOverrides_ = false;
    std::vector<std::string> replaces_, preserves_;
    DECLARE_JSON_MAP(Tone3000PreviewResult);
};
/**
 * Fixed-root preset discovery and atomic uploads; no audio or model execution.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [DES-SEC] [3.9]
 */
class Tone3000Library {
public:
    struct Root { std::filesystem::path path; std::string key, source, section; };
    struct Source { Tone3000LibraryEntry entry; std::filesystem::path path; std::string section; std::vector<std::string> aliases; };
    Tone3000Library(const std::filesystem::path& dataRoot, const std::vector<std::string>& appRoots);
    // Explicit roots support isolated fixture tests; never exposed to browser requests.
    Tone3000Library(const std::filesystem::path& dataRoot, std::vector<Root> roots);
    std::vector<Source> Scan(std::vector<std::string>* warnings) const;
    Source Resolve(const std::string& key, const std::string& sha256) const;
    Tone3000LibraryEntry Upload(const std::string& filename, const std::filesystem::path& temporary);
    /** Resolve/hash-check source and optional saved board without publishing or loading.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [7.1]
     */
    Tone3000PreviewResult Preview(const Tone3000PreviewRequest& request, const Pedalboard* savedTarget = nullptr) const;
    static void ValidatePreviewRequestJson(const json_variant& request);
    static bool ValidFilename(const std::string& filename);
    static bool IsToneBank(const std::string& name);
    static bool HasSnapshotOverrides(const Pedalboard& board, int64_t instanceId);
    static void ApplyState(PedalboardItem& item, const Lv2PluginState& state,
                           const std::string& key, const std::string& sha256);
    static std::vector<uint8_t> ReadFile(const std::filesystem::path& path, size_t limit = 64*1024*1024);
    static void BackupFile(const std::filesystem::path& dataRoot, const std::filesystem::path& path);
private:
    std::filesystem::path dataRoot;
    std::vector<Root> roots;
};
}
